"""Room management - in-memory dict"""

import secrets
import time
import asyncio
from dataclasses import dataclass, field

CHARS = "abcdefghijklmnopqrstuvwxyz0123456789"
EXPIRY_SEC = 43200  # 12 hours


@dataclass
class Room:
    id: str
    created: float
    clients: dict[str, asyncio.Queue] = field(default_factory=dict)
    mobile_connected: bool = False


_rooms: dict[str, Room] = {}


def generate_room_id() -> str:
    return "".join(secrets.choice(CHARS) for _ in range(7))


def create_room() -> Room:
    rid = generate_room_id()
    room = Room(id=rid, created=time.time())
    _rooms[rid] = room
    return room


def get_room(rid: str) -> Room | None:
    room = _rooms.get(rid)
    if room is None:
        return None
    if room.clients:
        return room
    if time.time() - room.created < EXPIRY_SEC:
        return room
    _rooms.pop(rid, None)
    return None


def broadcast(room: Room, event: str, data: str):
    msg = (event, data)
    dead = []
    for cid, q in room.clients.items():
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:
            dead.append(cid)
    for cid in dead:
        room.clients.pop(cid, None)


async def cleanup_loop():
    while True:
        await asyncio.sleep(600)
        now = time.time()
        expired = [
            rid for rid, room in _rooms.items()
            if not room.clients and now - room.created >= EXPIRY_SEC
        ]
        for rid in expired:
            _rooms.pop(rid, None)
