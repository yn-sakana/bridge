"""Relay - fin-hub proxy + SSE fan-out to PC clients"""

import json
import os
import httpx
from .room import Room, broadcast

FIN_HUB_URL = os.environ.get("FIN_HUB_URL", "http://localhost:8400")
FIN_HUB_TOKEN = os.environ.get("HUB_AUTH_TOKEN", "")

CLI_PROVIDERS = {"claude_code", "codex"}


def _parse_sse_lines(chunk: str):
    """Parse SSE chunk into (event, data) pairs.

    Per SSE spec, multiple data: lines are joined with \\n,
    and an event is dispatched on a blank line.
    """
    current_event = ""
    data_lines: list[str] = []
    for line in chunk.split("\n"):
        line = line.rstrip("\r")
        if line.startswith("event:"):
            current_event = line[6:].strip()
        elif line.startswith("data:"):
            data_lines.append(line[5:].strip())
        elif line == "":
            # Blank line = dispatch event
            if current_event and data_lines:
                yield current_event, "\n".join(data_lines)
            current_event = ""
            data_lines = []
    # Flush remaining (chunk may not end with blank line)
    if current_event and data_lines:
        yield current_event, "\n".join(data_lines)


def _build_history_prompt(messages: list[dict], system_prompt: str) -> str:
    """For CLI providers: embed conversation history into system prompt."""
    history_lines = []
    for msg in messages[:-1]:  # exclude the latest (sent as prompt)
        role = "user" if msg.get("role") == "user" else "assistant"
        history_lines.append(f"- {role}: {msg.get('content', '')}")

    parts = []
    if system_prompt:
        parts.append(system_prompt)
    if history_lines:
        parts.append("# Conversation History\n" + "\n".join(history_lines))
    return "\n\n".join(parts)


async def relay_chat(body: dict, room: Room):
    """Stream chat from fin-hub, fan out to PC clients. Yields SSE chunks for mobile."""
    hub_body = {k: v for k, v in body.items() if k != "room_id"}

    provider = hub_body.get("provider", "")
    all_msgs = hub_body.get("messages", [])

    if provider in CLI_PROVIDERS and len(all_msgs) > 1:
        # CLI providers are stateless — embed history in system prompt
        hub_body["system_prompt"] = _build_history_prompt(
            all_msgs, hub_body.get("system_prompt", "")
        )
        hub_body["messages"] = [all_msgs[-1]]
    elif all_msgs:
        # API providers — fin-hub manages history via session_id
        hub_body["messages"] = [all_msgs[-1]]

    room.mobile_connected = True
    broadcast(room, "status", '{"mobile":true}')

    # Send user message to PC
    messages = hub_body.get("messages", [])
    if messages:
        last = messages[-1]
        if last.get("role") == "user":
            broadcast(room, "message", json.dumps(
                {"role": "user", "content": last["content"]}, ensure_ascii=False
            ))

    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream(
            "POST",
            FIN_HUB_URL + "/api/chat/stream",
            headers={
                "Authorization": f"Bearer {FIN_HUB_TOKEN}",
                "Content-Type": "application/json",
            },
            json=hub_body,
        ) as resp:
            if resp.status_code != 200:
                err = await resp.aread()
                broadcast(room, "error", err.decode())
                raise Exception(f"fin-hub error: {resp.status_code}")

            async for chunk in resp.aiter_text():
                # Parse and forward events to PC
                for event, data in _parse_sse_lines(chunk):
                    if event == "text":
                        broadcast(room, "text", data)
                    elif event == "done":
                        broadcast(room, "done", "")
                    elif event == "error":
                        broadcast(room, "error", data)
                    # session, usage, tool_call etc. are not shown on PC

                # Yield raw chunk to mobile (mobile gets original SSE stream)
                yield chunk

    broadcast(room, "done", "")


async def relay_get(path: str) -> httpx.Response:
    async with httpx.AsyncClient(timeout=30) as client:
        return await client.get(
            FIN_HUB_URL + path,
            headers={"Authorization": f"Bearer {FIN_HUB_TOKEN}"},
        )


async def relay_delete(path: str) -> httpx.Response:
    async with httpx.AsyncClient(timeout=30) as client:
        return await client.delete(
            FIN_HUB_URL + path,
            headers={"Authorization": f"Bearer {FIN_HUB_TOKEN}"},
        )
