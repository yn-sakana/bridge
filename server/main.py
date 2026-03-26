"""Bridge Server - FastAPI"""

import asyncio
import json
import re
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import yaml
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import (
    HTMLResponse, JSONResponse, StreamingResponse, RedirectResponse,
)
from fastapi.staticfiles import StaticFiles

from .room import create_room, get_room, broadcast, cleanup_loop
from .relay import relay_chat, relay_get, relay_delete

STATIC_DIR = Path(__file__).parent.parent / "static"
ROOM_ID_RE = re.compile(r"^[a-z0-9]{7}$")
CONFIG_PATH = Path(__file__).parent.parent / "bridge.yaml"

REQUIRED_KEYS = {"provider", "model", "temperature", "app_id"}


def _load_config() -> dict:
    if not CONFIG_PATH.exists():
        raise FileNotFoundError(
            f"bridge.yaml not found: {CONFIG_PATH}\n"
            "Create bridge.yaml with: provider, model, temperature, app_id"
        )
    with open(CONFIG_PATH, encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    missing = REQUIRED_KEYS - set(data.keys())
    if missing:
        raise ValueError(f"bridge.yaml missing required keys: {missing}")
    return data


def _save_config(data: dict):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        yaml.dump(data, f, allow_unicode=True, default_flow_style=False)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Validate config on startup (fail fast)
    _load_config()
    asyncio.create_task(cleanup_loop())
    yield


app = FastAPI(lifespan=lifespan)


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

    cfg = _load_config()
    return StreamingResponse(
        relay_chat(
            body, room,
            app_id=cfg["app_id"],
            context_window=cfg.get("context_window"),
        ),
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
            # Initial event
            yield f"event: connected\ndata: {json.dumps({'mobile': room.mobile_connected})}\n\n"

            while True:
                try:
                    event, data = await asyncio.wait_for(queue.get(), timeout=30)
                    if event == "raw":
                        # Pre-formatted SSE from fin-hub, pass through
                        yield data
                    else:
                        # SSE spec: multi-line data needs each line prefixed with "data:"
                        data_lines = "\n".join(f"data: {line}" for line in data.split("\n"))
                        yield f"event: {event}\n{data_lines}\n\n"
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
            "Cache-Control": "no-cache, no-store, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


# --- API: PC polling ---
@app.get("/api/events/{room_id}")
async def api_events(room_id: str, after: int = 0):
    room = get_room(room_id)
    if not room:
        raise HTTPException(410, "Room not found or expired")
    events = room.events[after:]
    return {
        "mobile": room.mobile_connected,
        "events": [{"event": e, "data": d} for e, d in events],
        "next": len(room.events),
    }


# --- API: Config (mobile only) ---
@app.get("/api/config")
async def api_get_config():
    return _load_config()


MUTABLE_KEYS = {"provider", "model", "temperature", "system_prompt"}


@app.put("/api/config")
async def api_put_config(request: Request):
    body = await request.json()
    current = _load_config()
    for key in MUTABLE_KEYS:
        if key in body:
            current[key] = body[key]
    _save_config(current)
    return current


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
