"""Relay - fin-hub proxy + SSE fan-out to PC clients"""

import json
import os
import httpx
from .room import Room, broadcast

FIN_HUB_URL = os.environ.get("FIN_HUB_URL", "http://localhost:8400")
FIN_HUB_TOKEN = os.environ.get("HUB_AUTH_TOKEN", "")


def _parse_sse_lines(chunk: str):
    """Parse SSE chunk into (event, data) pairs."""
    current_event = ""
    for line in chunk.split("\n"):
        line = line.rstrip("\r")
        if line.startswith("event:"):
            current_event = line[6:].strip()
        elif line.startswith("data:"):
            data = line[5:].strip()
            if current_event:
                yield current_event, data
                current_event = ""


async def relay_chat(body: dict, room: Room):
    """Stream chat from fin-hub, fan out to PC clients. Yields SSE chunks for mobile."""
    hub_body = {k: v for k, v in body.items() if k != "room_id"}
    # Send only the latest user message — fin-hub manages history via session_id
    msgs = hub_body.get("messages", [])
    if msgs:
        hub_body["messages"] = [msgs[-1]]

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
