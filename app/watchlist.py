"""The watchlist: which symbols are pinned, added by hand, or hidden.

The list lives in one small JSON file. The server edits it and every terminal
worker reads it, so a change made on the phone shows up on the PC and the
workers start (or stop) quoting the right symbols.
"""

from __future__ import annotations

import json
import re
import threading
from pathlib import Path

SYMBOL = re.compile(r"^[A-Za-z0-9._#@&+!\-]{1,32}$")
MAX_ITEMS = 200
KEYS = ("pinned", "extra", "hidden")
OPS = {"pin", "unpin", "add", "remove", "hide", "show", "up", "down", "show_all"}


def empty() -> dict:
    return {key: [] for key in KEYS}


def load(path: Path) -> dict:
    """Read the watchlist file; a missing or damaged file is an empty watchlist."""
    config = empty()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return config
    if not isinstance(raw, dict):
        return config
    for key in KEYS:
        values = raw.get(key)
        if not isinstance(values, list):
            continue
        for value in values:
            if isinstance(value, str) and SYMBOL.match(value) and value not in config[key]:
                config[key].append(value)
    return config


class WatchlistStore:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()

    def get(self) -> dict:
        with self._lock:
            return load(self.path)

    def apply(self, op: str, symbol: str | None = None) -> dict:
        if op not in OPS:
            raise ValueError("Unknown action")
        if op != "show_all":
            if symbol is None or not SYMBOL.match(symbol):
                raise ValueError("Invalid symbol")
        with self._lock:
            config = load(self.path)
            pinned, extra, hidden = config["pinned"], config["extra"], config["hidden"]
            if op == "pin":
                if symbol not in pinned:
                    pinned.append(symbol)
                _drop(hidden, symbol)
            elif op == "unpin":
                _drop(pinned, symbol)
            elif op == "add":
                if symbol not in extra and symbol not in pinned:
                    extra.append(symbol)
                _drop(hidden, symbol)
            elif op == "remove":
                _drop(extra, symbol)
                _drop(pinned, symbol)
            elif op == "hide":
                if symbol not in hidden:
                    hidden.append(symbol)
                _drop(pinned, symbol)
            elif op == "show":
                _drop(hidden, symbol)
            elif op == "show_all":
                hidden.clear()
            elif op in ("up", "down") and symbol in pinned:
                index = pinned.index(symbol)
                other = index - 1 if op == "up" else index + 1
                if 0 <= other < len(pinned):
                    pinned[index], pinned[other] = pinned[other], pinned[index]
            for key in KEYS:
                del config[key][MAX_ITEMS:]
            self._save(config)
            return config

    def _save(self, config: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps(config), encoding="utf-8")
        temporary.replace(self.path)


def _drop(values: list[str], symbol: str | None) -> None:
    while symbol in values:
        values.remove(symbol)
