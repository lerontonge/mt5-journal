"""Turn raw terminal snapshots into accounts, round-trip trades, and one book."""

from __future__ import annotations

STALE_SECONDS = 30

ENTRY_IN = 0
ENTRY_INOUT = 2
ENTRY_OUT = 1
ENTRY_OUT_BY = 3

REASONS = {
    0: "client",
    1: "mobile",
    2: "web",
    3: "expert",
    4: "stop loss",
    5: "take profit",
    6: "stop out",
    7: "rollover",
    8: "variation margin",
    9: "split",
}

CASH_TYPES = {2, 3, 4, 5, 6, 12, 15, 16, 17}


def build_state(terminals: list[dict], snapshots: dict[str, dict], notes: dict[str, dict], now: float) -> dict:
    terminal_rows = []
    by_account: dict[tuple, dict] = {}

    for terminal in terminals:
        snap = snapshots.get(terminal["id"]) or {}
        age = None if not snap.get("updated_at") else now - float(snap["updated_at"])
        fresh = age is not None and age <= STALE_SECONDS
        connected = bool(snap.get("connected")) and fresh
        account = snap.get("account") if connected else None
        error = snap.get("error")
        if snap and not fresh:
            error = error or "Feed stalled"
        row = {
            "id": terminal["id"],
            "label": terminal["label"],
            "path": terminal["path"],
            "connected": connected,
            "error": None if connected else error,
            "updated_at": snap.get("updated_at"),
            "account": account,
        }
        terminal_rows.append(row)
        if not account:
            continue
        key = (int(account["login"]), str(account["server"]))
        current = by_account.get(key)
        labels = list(current["terminals"]) if current else []
        if terminal["label"] not in labels:
            labels.append(terminal["label"])
        newer = current is None or float(snap.get("updated_at") or 0) >= float(current["updated_at"] or 0)
        if newer:
            by_account[key] = {
                "updated_at": snap.get("updated_at"),
                "account": account,
                "deals": snap.get("deals") or [],
                "positions": snap.get("positions") or [],
                "terminals": labels,
            }
        else:
            current["terminals"] = labels

    accounts = []
    trades = []
    for (login, server), bundle in sorted(by_account.items(), key=lambda item: item[0]):
        account = bundle["account"]
        built, cashflows = group_account(account, bundle["deals"], bundle["positions"])
        for trade in built:
            journal = notes.get(trade["key"]) or {}
            trade["note"] = journal.get("note") or ""
            trade["tags"] = list(journal.get("tags") or [])
            trade["rating"] = journal.get("rating")
            trades.append(trade)
        accounts.append(
            {
                "login": login,
                "server": server,
                "name": account.get("name") or "",
                "company": account.get("company") or "",
                "currency": account.get("currency") or "",
                "balance": _money(account.get("balance")),
                "equity": _money(account.get("equity")),
                "profit": _money(account.get("profit")),
                "margin": _money(account.get("margin")),
                "margin_free": _money(account.get("margin_free")),
                "leverage": account.get("leverage"),
                "terminals": bundle["terminals"],
                "cashflows": cashflows,
            }
        )

    trades.sort(key=lambda trade: (trade["status"] != "open", -(trade["close_time"] or trade["open_time"] or 0)))
    return {"terminals": terminal_rows, "accounts": accounts, "trades": trades, "as_of": now}


def group_account(account: dict, deals: list[dict], positions: list[dict]) -> tuple[list[dict], list[dict]]:
    login = int(account["login"])
    server = str(account["server"])
    name = account.get("name") or ""
    currency = account.get("currency") or ""

    open_positions: dict[int, dict] = {}
    for position in positions:
        for raw_key in (position.get("identifier"), position.get("ticket")):
            if raw_key:
                open_positions[int(raw_key)] = position

    buckets: dict[int, list[dict]] = {}
    cashflows: list[dict] = []
    for deal in deals:
        deal_type = int(deal.get("type") or 0)
        if deal_type in (0, 1) and deal.get("position_id"):
            buckets.setdefault(int(deal["position_id"]), []).append(deal)
        elif deal_type in CASH_TYPES:
            cashflows.append(
                {
                    "time": int(deal.get("time") or 0),
                    "amount": _money(deal.get("profit")),
                    "comment": (deal.get("comment") or "").strip(),
                }
            )

    trades = []
    seen = set(buckets)
    for position_id in open_positions:
        seen.add(position_id)
    for position_id in seen:
        trade = _trade_from_bucket(
            login=login,
            server=server,
            name=name,
            currency=currency,
            position_id=position_id,
            deals=buckets.get(position_id, []),
            position=open_positions.get(position_id),
        )
        if trade is not None:
            trades.append(trade)
    cashflows.sort(key=lambda row: row["time"], reverse=True)
    return trades, cashflows


def _trade_from_bucket(*, login, server, name, currency, position_id, deals, position) -> dict | None:
    deals = sorted(deals, key=lambda deal: (int(deal.get("time") or 0), int(deal.get("ticket") or 0)))
    ins = [deal for deal in deals if _is_in(deal)]
    outs = [deal for deal in deals if _is_out(deal)]
    if not ins and position is None:
        return None

    if ins:
        side = "long" if int(ins[0]["type"]) == 0 else "short"
        open_time = int(min(deal["time"] for deal in ins))
        open_price = _wavg(ins)
        volume_in = round(sum(_num(deal.get("volume")) for deal in ins), 2)
        magic = int(ins[0].get("magic") or 0)
    else:
        side = "long" if int(position.get("type") or 0) == 0 else "short"
        open_time = int(position.get("time") or 0)
        open_price = _num(position.get("price_open"))
        volume_in = round(_num(position.get("volume")), 2)
        magic = int(position.get("magic") or 0)

    realized = sum(_deal_net(deal) for deal in deals)
    comments = []
    for deal in ins:
        comment = (deal.get("comment") or "").strip()
        if comment and not _system_comment(comment) and comment not in comments:
            comments.append(comment)

    if position is not None:
        floating = _num(position.get("profit")) + _num(position.get("swap"))
        status = "open"
        close_time = None
        close_price = _num(position.get("price_current"))
        volume = round(_num(position.get("volume")), 2)
        exit_reason = ""
        sl = _num(position.get("sl")) or None
        tp = _num(position.get("tp")) or None
        if position.get("magic"):
            magic = int(position["magic"])
    else:
        floating = 0.0
        status = "closed"
        close_time = int(max(deal["time"] for deal in outs)) if outs else int(deals[-1]["time"])
        close_price = _wavg(outs) if outs else _num(deals[-1].get("price"))
        volume = round(sum(_num(deal.get("volume")) for deal in outs), 2) if outs else volume_in
        last_out = outs[-1] if outs else deals[-1]
        exit_reason = REASONS.get(int(last_out.get("reason") or 0), "")
        sl = None
        tp = None

    return {
        "key": f"{login}:{position_id}",
        "login": login,
        "server": server,
        "account": name,
        "currency": currency,
        "position_id": int(position_id),
        "symbol": (position or ins[0] or deals[0]).get("symbol") or "",
        "side": side,
        "volume": volume,
        "volume_in": volume_in,
        "open_time": open_time,
        "close_time": close_time,
        "open_price": round(open_price, 5),
        "close_price": round(close_price, 5),
        "profit": _money(sum(_num(deal.get("profit")) for deal in deals) + (_num(position.get("profit")) if position else 0)),
        "swap": _money(sum(_num(deal.get("swap")) for deal in deals) + (_num(position.get("swap")) if position else 0)),
        "commission": _money(sum(_num(deal.get("commission")) for deal in deals)),
        "fee": _money(sum(_num(deal.get("fee")) for deal in deals)),
        "realized": _money(realized),
        "floating": _money(floating),
        "net": _money(realized + floating),
        "magic": magic,
        "comment": " · ".join(comments),
        "exit": exit_reason,
        "status": status,
        "sl": sl,
        "tp": tp,
    }


def _is_in(deal: dict) -> bool:
    return int(deal.get("entry") if deal.get("entry") is not None else -1) in (ENTRY_IN, ENTRY_INOUT)


def _is_out(deal: dict) -> bool:
    return int(deal.get("entry") if deal.get("entry") is not None else -1) in (ENTRY_OUT, ENTRY_INOUT, ENTRY_OUT_BY)


def _system_comment(comment: str) -> bool:
    text = comment.strip().lower()
    return text.startswith("[sl") or text.startswith("[tp") or text.startswith("[so")


def _deal_net(deal: dict) -> float:
    return _num(deal.get("profit")) + _num(deal.get("swap")) + _num(deal.get("commission")) + _num(deal.get("fee"))


def _wavg(deals: list[dict]) -> float:
    volume = sum(_num(deal.get("volume")) for deal in deals)
    if volume <= 0:
        return 0.0
    return sum(_num(deal.get("price")) * _num(deal.get("volume")) for deal in deals) / volume


def _num(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _money(value) -> float:
    return round(_num(value), 2)
