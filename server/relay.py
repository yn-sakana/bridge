"""Relay - fin-hub proxy + SSE fan-out to PC clients"""

import os
import httpx
from .room import Room, broadcast

FIN_HUB_URL = os.environ.get("FIN_HUB_URL", "http://localhost:8400")


async def relay_chat(token: str, body: dict, room: Room):
    """Stream chat from fin-hub, fan out to PC clients. Yields SSE chunks for mobile."""
    hub_body = {k: v for k, v in body.items() if k != "room_id"}

    room.mobile_connected = True
    broadcast(room, "status", '{"mobile":true}')

    # Send user message to PC
    messages = hub_body.get("messages", [])
    if messages:
        last = messages[-1]
        if last.get("role") == "user":
            import json
            broadcast(room, "message", json.dumps({"role": "user", "content": last["content"]}))

    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream(
            "POST",
            FIN_HUB_URL + "/api/chat/stream",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            json=hub_body,
        ) as resp:
            if resp.status_code != 200:
                err = await resp.aread()
                broadcast(room, "error", err.decode())
                raise Exception(f"fin-hub error: {resp.status_code}")

            async for chunk in resp.aiter_text():
                # Forward to PC clients
                broadcast(room, "raw", chunk)
                # Yield to mobile
                yield chunk

    broadcast(room, "done", "{}")


async def relay_get(token: str, path: str) -> httpx.Response:
    async with httpx.AsyncClient(timeout=30) as client:
        return await client.get(
            FIN_HUB_URL + path,
            headers={"Authorization": f"Bearer {token}"},
        )


async def relay_delete(token: str, path: str) -> httpx.Response:
    async with httpx.AsyncClient(timeout=30) as client:
        return await client.delete(
            FIN_HUB_URL + path,
            headers={"Authorization": f"Bearer {token}"},
        )
