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

ROOT = Path(__file__).resolve().parent.parent
STATIC = Path(__file__).resolve().parent / "static"
DATA = ROOT / "data"
SNAP_DIR = DATA / "snaps"
LOG_DIR = DATA / "logs"

log = logging.getLogger("journal")

app = FastAPI(title="Trading Journal")
store = JournalStore(DATA / "journal.sqlite")
supervisor = None


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


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=8765, reload=False)
