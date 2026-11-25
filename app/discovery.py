"""Find every MetaTrader 5 terminal installed or running on this PC."""

from __future__ import annotations

import hashlib
import os
import subprocess
from pathlib import Path


def discover() -> list[dict]:
    candidates: list[str] = []
    candidates.extend(_from_origin_files())
    candidates.extend(_from_running_processes())
    candidates.extend(_from_program_files())

    found: list[dict] = []
    seen: set[str] = set()
    for raw in candidates:
        path = _as_terminal_exe(raw)
        if path is None or not path.exists():
            continue
        try:
            resolved = str(path.resolve())
        except OSError:
            resolved = str(path)
        key = resolved.lower()
        if key in seen:
            continue
        seen.add(key)
        found.append(
            {
                "id": hashlib.sha1(key.encode("utf-8")).hexdigest()[:12],
                "path": resolved,
                "label": path.parent.name,
            }
        )
    found.sort(key=lambda item: item["label"].lower())
    return found


def _as_terminal_exe(raw: str) -> Path | None:
    text = raw.strip().strip("\x00")
    if not text:
        return None
    path = Path(text)
    if path.is_dir():
        path = path / "terminal64.exe"
    if path.name.lower() != "terminal64.exe":
        return None
    return path


def _from_origin_files() -> list[str]:
    appdata = os.environ.get("APPDATA", "")
    root = Path(appdata) / "MetaQuotes" / "Terminal"
    if not root.exists():
        return []
    origins: list[str] = []
    for origin in root.glob("*/origin.txt"):
        try:
            origins.append(_decode(origin.read_bytes()))
        except OSError:
            continue
    return origins


def _from_running_processes() -> list[str]:
    command = (
        "Get-CimInstance Win32_Process -Filter \"name = 'terminal64.exe'\" "
        "| Select-Object -ExpandProperty ExecutablePath"
    )
    try:
        completed = subprocess.run(
            ["powershell", "-NoProfile", "-Command", command],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    return [line.strip() for line in completed.stdout.splitlines() if line.strip()]


def _from_program_files() -> list[str]:
    found: list[str] = []
    for base in (Path(r"C:\Program Files"), Path(r"C:\Program Files (x86)")):
        if not base.exists():
            continue
        for exe in base.glob("*/terminal64.exe"):
            found.append(str(exe))
    return found


def _decode(raw: bytes) -> str:
    if raw.startswith(b"\xff\xfe") or raw.startswith(b"\xfe\xff") or b"\x00" in raw[:40]:
        return raw.decode("utf-16", errors="replace")
    return raw.decode("utf-8", errors="replace")
