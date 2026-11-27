"""Stay attached to one terminal and write account, position, and deal snapshots.

The MetaTrader 5 library holds a single terminal per process, so the server
starts one of these workers for each terminal64.exe. The same worker also
keeps a small file of live prices for the watchlist.
"""

from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

from app.quotes import QuoteBoard, watch_symbols
from app.watchlist import load as load_watchlist

LOOKBACK_DAYS = 365 * 5
POLL_SECONDS = 2
HISTORY_SECONDS = 20
QUOTE_ACTIVE_SECONDS = 1.0  # prices refresh this often while the Watchlist page is open
QUOTE_IDLE_SECONDS = 4.0  # ...and this often when nobody is looking
WATCHING_SECONDS = 20  # the page counts as open if the server saw it ask for prices this recently

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
        print("usage: python -m app.worker TERMINAL_EXE SNAP_PATH LABEL [QUOTES_PATH [WATCHLIST_PATH]]", file=sys.stderr)
        sys.exit(2)
    quotes_path = Path(sys.argv[4]) if len(sys.argv) > 4 else None
    watchlist_path = Path(sys.argv[5]) if len(sys.argv) > 5 else None
    run(sys.argv[1], Path(sys.argv[2]), sys.argv[3], quotes_path, watchlist_path)


def run(terminal_path: str, snap_path: Path, label: str, quotes_path: Path | None = None, watchlist_path: Path | None = None) -> None:
    import MetaTrader5 as mt5

    deals: list[dict] = []
    positions: list[dict] = []
    last_history = 0.0
    last_snapshot = 0.0
    last_quotes = 0.0
    connected = False
    board = QuoteBoard(mt5) if quotes_path is not None else None
    heartbeat = quotes_path.parent / ".watching" if quotes_path is not None else None

    while True:
        error = None
        try:
            if not connected:
                if not mt5.initialize(path=terminal_path, timeout=20000):
                    _write(snap_path, _payload(label, terminal_path, False, _error(mt5.last_error()), None, [], deals))
                    _write_quotes(quotes_path, label, terminal_path, False, _error(mt5.last_error()), None, {})
                    time.sleep(3)
                    continue
                connected = True

            info = mt5.account_info()
            if info is None:
                connected = False
                mt5.shutdown()
                _write(snap_path, _payload(label, terminal_path, False, "Terminal is open but no account is logged in", None, [], deals))
                _write_quotes(quotes_path, label, terminal_path, False, "Terminal is open but no account is logged in", None, {})
                time.sleep(3)
                continue

            now = time.time()
            if now - last_snapshot >= POLL_SECONDS - 0.05:
                positions = [_pick(item, POSITION_FIELDS) for item in (mt5.positions_get() or [])]
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
                last_snapshot = now

            watching = False
            if board is not None:
                watching = _is_watching(heartbeat, now)
                gap = QUOTE_ACTIVE_SECONDS if watching else QUOTE_IDLE_SECONDS
                if now - last_quotes >= gap - 0.05:
                    last_quotes = now
                    try:
                        symbols = watch_symbols(deals, positions, load_watchlist(watchlist_path) if watchlist_path else {})
                        result = board.update(symbols)
                        _write_quotes(quotes_path, label, terminal_path, True, None, _pick(info, ACCOUNT_FIELDS), result["quotes"], result["missing"], len(symbols))
                    except Exception as exc:  # prices are optional; never let them disturb the journal data
                        print(f"quotes: {exc}", file=sys.stderr)
            time.sleep(QUOTE_ACTIVE_SECONDS if watching else POLL_SECONDS)
        except Exception as exc:
            connected = False
            try:
                mt5.shutdown()
            except Exception:
                pass
            _write(snap_path, _payload(label, terminal_path, False, str(exc), None, [], deals))
            _write_quotes(quotes_path, label, terminal_path, False, str(exc), None, {})
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


def _is_watching(heartbeat: Path | None, now: float) -> bool:
    """The server touches this file whenever a page asks for prices."""
    if heartbeat is None:
        return False
    try:
        return now - heartbeat.stat().st_mtime < WATCHING_SECONDS
    except OSError:
        return False


def _write_quotes(path: Path | None, label, terminal_path, connected, error, account, quotes, missing=None, watching=0) -> None:
    if path is None:
        return
    payload = {
        "label": label,
        "path": terminal_path,
        "connected": connected,
        "error": error,
        "updated_at": time.time(),
        "account": account,
        "quotes": quotes,
        "missing": missing or [],
        "watching": watching,
    }
    try:
        _write(path, payload)
    except OSError:
        pass  # the page is reading the file right now; the next pass writes it again


def _write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload), encoding="utf-8")
    temporary.replace(path)


if __name__ == "__main__":
    main()
