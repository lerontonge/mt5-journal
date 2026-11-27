"""Local trading journal. Binds to localhost and reads terminals already logged in."""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator

from app.book import build_state
from app.discovery import discover
from app.store import JournalStore
from app.watchlist import WatchlistStore

ROOT = Path(__file__).resolve().parent.parent
STATIC = Path(__file__).resolve().parent / "static"
DATA = ROOT / "data"
SNAP_DIR = DATA / "snaps"
LOG_DIR = DATA / "logs"
QUOTES_DIR = DATA / "quotes"
WATCHLIST_PATH = DATA / "watchlist.json"
QUOTES_STALE_SECONDS = 15

log = logging.getLogger("journal")

app = FastAPI(title="Trading Journal")
store = JournalStore(DATA / "journal.sqlite")
watchlist = WatchlistStore(WATCHLIST_PATH)
_last_watch_touch = 0.0
supervisor = None


class WatchlistOp(BaseModel):
    op: str
    symbol: str | None = None


class NoteIn(BaseModel):
    note: str = ""
    tags: list[str] = Field(default_factory=list)
    rating: int | None = None

    @field_validator("note")
    @classmethod
    def clip_note(cls, value: str) -> str:
        return value[:8000]

    @field_validator("tags")
    @classmethod
    def clean_tags(cls, value: list[str]) -> list[str]:
        tags = []
        for raw in value:
            tag = " ".join(raw.strip().lower().split())
            if tag and tag not in tags:
                tags.append(tag[:32])
        return tags[:12]

    @field_validator("rating")
    @classmethod
    def check_rating(cls, value: int | None) -> int | None:
        if value is not None and value not in (1, 2, 3, 4, 5):
            raise ValueError("rating must be from 1 to 5")
        return value


class Supervisor:
    def __init__(self):
        self._stop = threading.Event()
        self._procs: dict[str, subprocess.Popen] = {}
        self._logs: dict[str, object] = {}
        self._thread = threading.Thread(target=self._loop, name="mt5-supervisor", daemon=True)

    def start(self) -> None:
        SNAP_DIR.mkdir(parents=True, exist_ok=True)
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        QUOTES_DIR.mkdir(parents=True, exist_ok=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        for proc in self._procs.values():
            proc.kill()
        for handle in self._logs.values():
            handle.close()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self._reconcile(discover())
            except Exception:
                log.exception("terminal discovery failed")
            self._stop.wait(15)

    def _reconcile(self, terminals: list[dict]) -> None:
        alive = {terminal["id"] for terminal in terminals}
        for terminal in terminals:
            proc = self._procs.get(terminal["id"])
            if proc is not None and proc.poll() is None:
                continue
            self._spawn(terminal)
        for terminal_id in list(self._procs):
            if terminal_id not in alive:
                self._procs.pop(terminal_id).kill()
                handle = self._logs.pop(terminal_id, None)
                if handle is not None:
                    handle.close()

    def _spawn(self, terminal: dict) -> None:
        log_path = LOG_DIR / f"{terminal['id']}.log"
        handle = open(log_path, "a", encoding="utf-8")
        flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        proc = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "app.worker",
                terminal["path"],
                str(SNAP_DIR / f"{terminal['id']}.json"),
                terminal["label"],
                str(QUOTES_DIR / f"{terminal['id']}.json"),
                str(WATCHLIST_PATH),
            ],
            cwd=str(ROOT),
            stdout=handle,
            stderr=subprocess.STDOUT,
            env=env,
            creationflags=flags,
        )
        self._procs[terminal["id"]] = proc
        self._logs[terminal["id"]] = handle
        log.info("attached %s (%s)", terminal["label"], terminal["path"])


def _snapshots() -> dict[str, dict]:
    snaps = {}
    if not SNAP_DIR.exists():
        return snaps
    for path in SNAP_DIR.glob("*.json"):
        try:
            snaps[path.stem] = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
    return snaps


@app.on_event("startup")
def startup() -> None:
    global supervisor
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    supervisor = Supervisor()
    supervisor.start()


@app.on_event("shutdown")
def shutdown() -> None:
    if supervisor is not None:
        supervisor.stop()


@app.get("/api/state")
def state() -> dict:
    return build_state(discover(), _snapshots(), store.all_notes(), time.time())


def _touch_watch() -> None:
    """Tell the terminal workers a page is watching prices, so they refresh every second instead of every few."""
    global _last_watch_touch
    moment = time.monotonic()
    if moment - _last_watch_touch < 1.0:
        return
    _last_watch_touch = moment
    try:
        QUOTES_DIR.mkdir(parents=True, exist_ok=True)
        (QUOTES_DIR / ".watching").touch()
    except OSError:
        pass


@app.get("/api/quotes")
def quotes() -> dict:
    _touch_watch()
    now = time.time()
    terminals = []
    if QUOTES_DIR.exists():
        for path in sorted(QUOTES_DIR.glob("*.json")):
            try:
                snap = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            fresh = now - float(snap.get("updated_at") or 0) <= QUOTES_STALE_SECONDS
            connected = bool(snap.get("connected")) and fresh
            terminals.append(
                {
                    "id": path.stem,
                    "label": snap.get("label") or path.stem,
                    "connected": connected,
                    "error": None if connected else (snap.get("error") or "Prices stalled"),
                    "updated_at": snap.get("updated_at"),
                    "account": snap.get("account") if connected else None,
                    "quotes": snap.get("quotes") or {} if connected else {},
                    "missing": snap.get("missing") or [] if connected else [],
                }
            )
    return {"as_of": now, "terminals": terminals}


@app.get("/api/watchlist")
def get_watchlist() -> dict:
    return watchlist.get()


@app.post("/api/watchlist")
def change_watchlist(body: WatchlistOp) -> dict:
    try:
        return watchlist.apply(body.op, body.symbol)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.put("/api/notes/{login}/{position_id}")
def save_note(login: int, position_id: int, body: NoteIn) -> dict:
    if login <= 0 or position_id <= 0:
        raise HTTPException(status_code=400, detail="Invalid trade")
    return store.upsert(f"{login}:{position_id}", body.note, body.tags, body.rating)


@app.get("/")
def home() -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.get("/styles.css")
def styles() -> FileResponse:
    return FileResponse(STATIC / "styles.css")


@app.get("/app.js")
def script() -> FileResponse:
    return FileResponse(STATIC / "app.js")


# Home-screen icons, web manifest and the bundled fonts. Only these exact names are served.
ASSETS = {
    "icon.svg": "image/svg+xml",
    "icon-192.png": "image/png",
    "icon-512.png": "image/png",
    "icon-maskable-512.png": "image/png",
    "apple-touch-icon.png": "image/png",
    "favicon-32.png": "image/png",
    "favicon.ico": "image/x-icon",
    "manifest.webmanifest": "application/manifest+json",
}
FONTS = {
    "Manrope-Variable.woff2",
    "PlusJakartaSans-Variable.woff2",
    "SpaceGrotesk-Variable.woff2",
    "Sora-Variable.woff2",
    "IBMPlexSans-Regular.woff2",
    "IBMPlexSans-Medium.woff2",
    "IBMPlexSans-SemiBold.woff2",
    "IBMPlexSans-Bold.woff2",
    "Inter-Regular.woff",
    "Inter-Medium.woff",
    "Inter-SemiBold.woff",
    "Inter-Bold.woff",
}


@app.get("/fonts/{name}")
def font(name: str) -> FileResponse:
    if name not in FONTS:
        raise HTTPException(status_code=404, detail="Not found")
    media_type = "font/woff2" if name.endswith(".woff2") else "font/woff"
    return FileResponse(STATIC / "fonts" / name, media_type=media_type)


# iOS looks for these names at the site root when a page is added to the Home Screen.
ICON_ALIASES = {
    "apple-touch-icon-precomposed.png": "apple-touch-icon.png",
    "apple-touch-icon-180x180.png": "apple-touch-icon.png",
    "apple-touch-icon-180x180-precomposed.png": "apple-touch-icon.png",
}


@app.api_route("/{name}", methods=["GET", "HEAD"])
def asset(name: str) -> FileResponse:
    name = ICON_ALIASES.get(name, name)
    media_type = ASSETS.get(name)
    if media_type is None:
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(STATIC / name, media_type=media_type, headers={"Cache-Control": "public, max-age=86400"})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=8765, reload=False)
