"""Bridge Server - FastAPI"""

import asyncio
import json
import re
import uuid
from pathlib import Path

from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import (
    HTMLResponse, JSONResponse, StreamingResponse, RedirectResponse,
)
from fastapi.staticfiles import StaticFiles

from .room import create_room, get_room, broadcast, cleanup_loop
from .relay import relay_chat, relay_get, relay_delete

app = FastAPI()

STATIC_DIR = Path(__file__).parent.parent / "static"
ROOM_ID_RE = re.compile(r"^[a-z0-9]{7}$")


# --- Startup ---
@app.on_event("startup")
async def startup():
    asyncio.create_task(cleanup_loop())


# --- API: Create room ---
@app.post("/api/room")
async def api_create_room(request: Request):
    room = create_room()
    host = request.headers.get("x-forwarded-host", request.headers.get("host", "localhost"))
    proto = request.headers.get("x-forwarded-proto", "http")
    url = f"{proto}://{host}/{room.id}"
    return {"room_id": room.id, "url": url, "expires_in": 300}


# --- API: Chat relay ---
@app.post("/api/chat")
async def api_chat(request: Request):
    body = await request.json()
    room_id = body.get("room_id")
    if not room_id:
        raise HTTPException(400, "room_id required")
    room = get_room(room_id)
    if not room:
        raise HTTPException(404, "Room not found")

    return StreamingResponse(
        relay_chat(body, room),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# --- API: PC SSE stream ---
@app.get("/api/stream/{room_id}")
async def api_stream(room_id: str):
    room = get_room(room_id)
    if not room:
        raise HTTPException(410, "Room not found or expired")

    client_id = str(uuid.uuid4())
    queue: asyncio.Queue = asyncio.Queue(maxsize=256)
    room.clients[client_id] = queue

    async def event_generator():
        try:
            # Padding to flush proxy buffers (Cloudflare Tunnel etc.)
            yield ": " + " " * 2048 + "\n\n"
            # Initial event
            yield f"event: connected\ndata: {json.dumps({'mobile': room.mobile_connected})}\n\n"

            while True:
                try:
                    event, data = await asyncio.wait_for(queue.get(), timeout=30)
                    if event == "raw":
                        # Pre-formatted SSE from fin-hub, pass through
                        yield data
                    else:
                        yield f"event: {event}\ndata: {data}\n\n"
                except asyncio.TimeoutError:
                    yield "event: ping\ndata: {}\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            room.clients.pop(client_id, None)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-store",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
            "Transfer-Encoding": "chunked",
        },
    )


# --- API: Model list relay ---
@app.get("/api/models/{provider}")
async def api_models(provider: str):
    resp = await relay_get(f"/api/models/{provider}")
    return JSONResponse(resp.json(), status_code=resp.status_code)


# --- API: Session relay ---
@app.get("/api/sessions")
async def api_sessions():
    resp = await relay_get("/api/sessions")
    return JSONResponse(resp.json(), status_code=resp.status_code)


@app.delete("/api/sessions/{session_id}")
async def api_delete_session(session_id: str):
    resp = await relay_delete(f"/api/sessions/{session_id}")
    return JSONResponse(resp.json(), status_code=resp.status_code)


# --- Room page: /{room_id} ---
@app.get("/{room_id}")
async def room_page(room_id: str):
    if not ROOM_ID_RE.match(room_id):
        raise HTTPException(404)
    room = get_room(room_id)
    if not room:
        raise HTTPException(404, "Room not found or expired")

    html_path = STATIC_DIR / "pc" / "index.html"
    html = html_path.read_text(encoding="utf-8")
    html = html.replace("{{ROOM_ID}}", room_id)
    return HTMLResponse(html)


# --- Static files (must be last) ---
app.mount("/mobile", StaticFiles(directory=str(STATIC_DIR / "mobile"), html=True))
app.mount("/pc", StaticFiles(directory=str(STATIC_DIR / "pc"), html=True))


# --- Root → mobile ---
@app.get("/")
async def root():
    return RedirectResponse("/mobile/")
