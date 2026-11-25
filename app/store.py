"""SQLite notes, tags, and ratings. Trade facts stay in MetaTrader."""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path


class JournalStore:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS notes (
                trade_key TEXT PRIMARY KEY,
                note TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '[]',
                rating INTEGER,
                updated_at TEXT NOT NULL
            )
            """
        )
        self._conn.commit()

    def all_notes(self) -> dict[str, dict]:
        with self._lock:
            rows = self._conn.execute("SELECT trade_key, note, tags, rating, updated_at FROM notes").fetchall()
        notes = {}
        for key, note, tags, rating, updated_at in rows:
            notes[key] = {
                "note": note,
                "tags": json.loads(tags or "[]"),
                "rating": rating,
                "updated_at": updated_at,
            }
        return notes

    def upsert(self, trade_key: str, note: str, tags: list[str], rating: int | None) -> dict:
        updated_at = datetime.now(timezone.utc).isoformat()
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO notes (trade_key, note, tags, rating, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(trade_key) DO UPDATE SET
                    note = excluded.note,
                    tags = excluded.tags,
                    rating = excluded.rating,
                    updated_at = excluded.updated_at
                """,
                (trade_key, note, json.dumps(tags), rating, updated_at),
            )
            self._conn.commit()
        return {"trade_key": trade_key, "note": note, "tags": tags, "rating": rating, "updated_at": updated_at}
