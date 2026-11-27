"""Live prices for the watchlist.

QuoteBoard reads ticks, the day's range, the previous close and a short price
history from one MetaTrader 5 terminal. It is plain logic around the `mt5`
module that is handed in, so it can be tested without a terminal.
"""

from __future__ import annotations

import time

RATES_REFRESH_SECONDS = 60  # day range, previous close and sparkline are re-read this often per symbol
RATES_PER_PASS = 4  # at most this many symbols get their bars refreshed in one pass, so passes stay quick
UNKNOWN_RETRY_SECONDS = 30  # how long to wait before asking the terminal about a missing symbol again
NAMES_REFRESH_SECONDS = 300  # the list of symbol names (for case-insensitive matching) is cached this long
SPARK_BARS = 96  # 96 bars of 15 minutes = the last 24 hours of trading


class QuoteBoard:
    def __init__(self, mt5, clock=time.time):
        self.mt5 = mt5
        self.clock = clock
        self._resolved: dict[str, str] = {}  # requested name -> the terminal's exact symbol name
        self._meta: dict[str, dict] = {}  # exact name -> digits, point, group, description
        self._unknown_until: dict[str, float] = {}
        self._names: dict[str, str] = {}  # lower-case name -> exact name
        self._names_at = 0.0
        self._bars: dict[str, dict] = {}  # exact name -> day range, previous close, sparkline
        self._bars_at: dict[str, float] = {}
        self._last_tick: dict[str, tuple] = {}
        self._changed_at: dict[str, float] = {}
        self._last_quote: dict[str, dict] = {}

    def update(self, symbols: list[str]) -> dict:
        """Return {"quotes": {requested name: quote}, "missing": [names this terminal does not offer]}."""
        now = self.clock()
        quotes: dict[str, dict] = {}
        missing: list[str] = []
        wanted: list[tuple[str, str]] = []
        for requested in symbols:
            exact = self._resolve(requested, now)
            if exact is None:
                missing.append(requested)
            else:
                wanted.append((requested, exact))

        self._refresh_bars([exact for _, exact in wanted], now)

        for requested, exact in wanted:
            try:
                quote = self._quote(exact, now)
            except Exception:  # one bad symbol must not stop the others
                quote = self._last_quote.get(exact)
            if quote is None:
                continue
            quotes[requested] = quote
        return {"quotes": quotes, "missing": missing}

    # -- symbol lookup -------------------------------------------------------------------------

    def _resolve(self, requested: str, now: float) -> str | None:
        exact = self._resolved.get(requested)
        if exact is not None:
            return exact
        if now < self._unknown_until.get(requested, 0.0):
            return None
        exact = self._find(requested, now)
        if exact is None:
            self._unknown_until[requested] = now + UNKNOWN_RETRY_SECONDS
            return None
        info = self.mt5.symbol_info(exact)
        if info is None:
            self._unknown_until[requested] = now + UNKNOWN_RETRY_SECONDS
            return None
        if not getattr(info, "visible", True):
            # A symbol only streams ticks while it is in Market Watch.
            if not self.mt5.symbol_select(exact, True):
                self._unknown_until[requested] = now + UNKNOWN_RETRY_SECONDS
                return None
            info = self.mt5.symbol_info(exact) or info
        path = str(getattr(info, "path", "") or "").replace("/", "\\")
        parts = [part for part in path.split("\\") if part]
        self._meta[exact] = {
            "digits": int(getattr(info, "digits", 5) or 0),
            "point": float(getattr(info, "point", 0) or 0),
            "group": parts[0] if len(parts) > 1 else "",
            "description": str(getattr(info, "description", "") or ""),
        }
        self._resolved[requested] = exact
        return exact

    def _find(self, requested: str, now: float) -> str | None:
        if self.mt5.symbol_info(requested) is not None:
            return requested
        # Match ignoring case ("xauusd" -> "XAUUSD").
        if now - self._names_at > NAMES_REFRESH_SECONDS or not self._names:
            listed = self.mt5.symbols_get() or []
            self._names = {str(getattr(item, "name", "")).lower(): str(getattr(item, "name", "")) for item in listed}
            self._names_at = now
        return self._names.get(requested.lower())

    # -- day range, previous close, sparkline --------------------------------------------------

    def _refresh_bars(self, exact_names: list[str], now: float) -> None:
        due = [name for name in exact_names if now - self._bars_at.get(name, 0.0) >= RATES_REFRESH_SECONDS]
        # Symbols that have never had bars go first, then the stalest.
        due.sort(key=lambda name: self._bars_at.get(name, 0.0))
        for name in due[:RATES_PER_PASS]:
            self._bars_at[name] = now
            try:
                self._bars[name] = self._read_bars(name)
            except Exception:
                self._bars.setdefault(name, {})

    def _read_bars(self, name: str) -> dict:
        digits = self._meta.get(name, {}).get("digits", 5)
        out: dict = {}
        daily = self.mt5.copy_rates_from_pos(name, self.mt5.TIMEFRAME_D1, 0, 3)
        if daily is not None and len(daily) >= 1:
            latest = daily[len(daily) - 1]
            out["day_open"] = float(latest["open"])
            out["day_high"] = float(latest["high"])
            out["day_low"] = float(latest["low"])
            if len(daily) >= 2:
                out["prev_close"] = float(daily[len(daily) - 2]["close"])
        recent = self.mt5.copy_rates_from_pos(name, self.mt5.TIMEFRAME_M15, 0, SPARK_BARS)
        if recent is not None and len(recent) >= 2:
            out["spark"] = [round(float(bar["close"]), digits) for bar in recent]
        return out

    # -- one symbol ----------------------------------------------------------------------------

    def _quote(self, name: str, now: float) -> dict | None:
        tick = self.mt5.symbol_info_tick(name)
        if tick is None:
            return self._last_quote.get(name)
        meta = self._meta.get(name, {})
        bid = float(getattr(tick, "bid", 0) or 0)
        ask = float(getattr(tick, "ask", 0) or 0)
        last = float(getattr(tick, "last", 0) or 0)
        stamp = (bid, ask, last, int(getattr(tick, "time_msc", 0) or 0))
        if self._last_tick.get(name) != stamp:
            self._last_tick[name] = stamp
            self._changed_at[name] = now
        # The first time a symbol is seen there is no way to know how old its tick already is.
        changed_at = self._changed_at.get(name, now)
        first_seen = name not in self._last_quote
        price = bid if bid > 0 else last
        point = meta.get("point") or 0
        spread = round((ask - bid) / point) if point > 0 and ask > bid > 0 else None
        bars = self._bars.get(name, {})
        prev_close = bars.get("prev_close")
        change = change_pct = None
        if prev_close and price > 0:
            change = price - prev_close
            change_pct = change / prev_close * 100
        quote = {
            "bid": bid,
            "ask": ask,
            "last": last,
            "price": price,
            "spread": spread,
            "digits": meta.get("digits", 5),
            "group": meta.get("group", ""),
            "description": meta.get("description", ""),
            "tick_time": int(getattr(tick, "time", 0) or 0),
            "quiet_for": None if first_seen else round(max(0.0, now - changed_at), 1),
            "prev_close": prev_close,
            "day_open": bars.get("day_open"),
            "day_high": bars.get("day_high"),
            "day_low": bars.get("day_low"),
            "change": change,
            "change_pct": change_pct,
            "spark": bars.get("spark") or [],
        }
        self._last_quote[name] = quote
        return quote


def watch_symbols(deals: list[dict], positions: list[dict], config: dict, limit: int = 40) -> list[str]:
    """Which symbols this terminal should quote: pinned, added by hand, open positions, then recently traded."""
    hidden = set(config.get("hidden") or [])
    ordered: list[str] = []

    def add(symbol: str) -> None:
        if symbol and symbol not in hidden and symbol not in ordered:
            ordered.append(symbol)

    for symbol in config.get("pinned") or []:
        add(symbol)
    for symbol in config.get("extra") or []:
        add(symbol)
    for position in positions:
        add(str(position.get("symbol") or ""))
    latest: dict[str, int] = {}
    for deal in deals:
        symbol = str(deal.get("symbol") or "")
        if symbol:
            latest[symbol] = max(latest.get(symbol, 0), int(deal.get("time") or 0))
    for symbol, _ in sorted(latest.items(), key=lambda item: -item[1]):
        add(symbol)
    return ordered[:limit]
