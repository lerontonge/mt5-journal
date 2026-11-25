"""Stay attached to one terminal and write account, position, and deal snapshots.

The MetaTrader 5 library holds a single terminal per process, so the server
starts one of these workers for each terminal64.exe.
"""

from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

LOOKBACK_DAYS = 365 * 5
POLL_SECONDS = 2
HISTORY_SECONDS = 20

DEAL_FIELDS = (
    "ticket",
    "time",
    "type",
    "entry",
    "magic",
    "position_id",
    "reason",
    "volume",
    "price",
    "commission",
    "swap",
    "profit",
    "fee",
    "symbol",
    "comment",
)
POSITION_FIELDS = (
    "ticket",
    "identifier",
    "time",
    "type",
    "magic",
    "volume",
    "price_open",
    "sl",
    "tp",
    "price_current",
    "swap",
    "profit",
    "symbol",
    "comment",
)
ACCOUNT_FIELDS = (
    "login",
    "server",
    "name",
    "company",
    "currency",
    "balance",
    "equity",
    "margin",
    "margin_free",
    "profit",
    "leverage",
)


def main() -> None:
    if len(sys.argv) < 4:
        print("usage: python -m app.worker TERMINAL_EXE SNAP_PATH LABEL", file=sys.stderr)
        sys.exit(2)
    run(sys.argv[1], Path(sys.argv[2]), sys.argv[3])


def run(terminal_path: str, snap_path: Path, label: str) -> None:
    import MetaTrader5 as mt5

    deals: list[dict] = []
    last_history = 0.0
    connected = False

    while True:
        error = None
        try:
            if not connected:
                if not mt5.initialize(path=terminal_path, timeout=20000):
                    _write(snap_path, _payload(label, terminal_path, False, _error(mt5.last_error()), None, [], deals))
                    time.sleep(3)
                    continue
                connected = True

            info = mt5.account_info()
            if info is None:
                connected = False
                mt5.shutdown()
                _write(snap_path, _payload(label, terminal_path, False, "Terminal is open but no account is logged in", None, [], deals))
                time.sleep(3)
                continue

            positions = [_pick(item, POSITION_FIELDS) for item in (mt5.positions_get() or [])]
            now = time.time()
            if now - last_history >= HISTORY_SECONDS:
                start = datetime.now() - timedelta(days=LOOKBACK_DAYS)
                end = datetime.now() + timedelta(days=1)
                history = mt5.history_deals_get(start, end)
                if history is not None:
                    deals = _unique_deals(history)
                    last_history = now
                else:
                    error = _error(mt5.last_error())

            _write(
                snap_path,
                _payload(label, terminal_path, True, error, _pick(info, ACCOUNT_FIELDS), positions, deals),
            )
            time.sleep(POLL_SECONDS)
        except Exception as exc:
            connected = False
            try:
                mt5.shutdown()
            except Exception:
                pass
            _write(snap_path, _payload(label, terminal_path, False, str(exc), None, [], deals))
            time.sleep(3)


def _unique_deals(history) -> list[dict]:
    deals = []
    seen: set[int] = set()
    for item in history:
        deal = _pick(item, DEAL_FIELDS)
        ticket = int(deal.get("ticket") or 0)
        if ticket and ticket in seen:
            continue
        if ticket:
            seen.add(ticket)
        if isinstance(deal.get("comment"), str):
            deal["comment"] = deal["comment"].strip()
        deals.append(deal)
    return deals


def _pick(obj, fields: tuple[str, ...]) -> dict:
    raw = obj._asdict() if hasattr(obj, "_asdict") else dict(obj)
    picked = {}
    for field in fields:
        if field in raw and raw[field] is not None:
            picked[field] = _plain(raw[field])
    return picked


def _plain(value):
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    item = getattr(value, "item", None)
    if callable(item):
        try:
            return item()
        except Exception:
            return value
    return value


def _error(err) -> str:
    if isinstance(err, tuple) and len(err) >= 2:
        return str(err[1])
    return str(err)


def _payload(label, path, connected, error, account, positions, deals) -> dict:
    return {
        "label": label,
        "path": path,
        "connected": connected,
        "error": error,
        "updated_at": time.time(),
        "account": account,
        "positions": positions,
        "deals": deals,
    }


def _write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload), encoding="utf-8")
    temporary.replace(path)


if __name__ == "__main__":
    main()
