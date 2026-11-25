import unittest

from app.book import build_state, group_account


def deal(**kwargs):
    base = {
        "ticket": 1,
        "time": 1_700_000_000,
        "type": 1,
        "entry": 0,
        "magic": 26103,
        "position_id": 100,
        "reason": 3,
        "volume": 0.01,
        "price": 4016.219,
        "commission": -0.07,
        "swap": 0,
        "profit": 0,
        "fee": 0,
        "symbol": "XAUUSD",
        "comment": "Scrap C",
    }
    base.update(kwargs)
    return base


class GroupingTests(unittest.TestCase):
    def test_closed_short_includes_commission_and_stop(self):
        account = {"login": 75099405, "server": "Exness-MT5Real12", "name": "Scraper-Gold", "currency": "USD"}
        deals = [
            deal(),
            deal(
                ticket=2,
                time=1_700_000_015,
                type=0,
                entry=1,
                price=4012.254,
                profit=3.97,
                commission=0,
                reason=4,
                comment="[sl 4012.254]",
            ),
        ]
        trades, cash = group_account(account, deals, [])
        self.assertEqual(cash, [])
        self.assertEqual(len(trades), 1)
        trade = trades[0]
        self.assertEqual(trade["side"], "short")
        self.assertEqual(trade["status"], "closed")
        self.assertEqual(trade["exit"], "stop loss")
        self.assertEqual(trade["comment"], "Scrap C")
        self.assertEqual(trade["net"], 3.90)
        self.assertEqual(trade["open_price"], 4016.219)
        self.assertEqual(trade["close_price"], 4012.254)

    def test_open_position_adds_floating_to_realized(self):
        account = {"login": 1, "server": "demo", "name": "Demo", "currency": "USD"}
        deals = [deal(type=0, comment="")]
        position = {
            "ticket": 100,
            "identifier": 100,
            "time": 1_700_000_000,
            "type": 0,
            "magic": 10,
            "volume": 0.01,
            "price_open": 4016.219,
            "sl": 4000,
            "tp": 4050,
            "price_current": 4020,
            "swap": -0.2,
            "profit": 5,
            "symbol": "XAUUSD",
            "comment": "",
        }
        trades, _ = group_account(account, deals, [position])
        self.assertEqual(trades[0]["status"], "open")
        self.assertEqual(trades[0]["floating"], 4.8)
        self.assertEqual(trades[0]["net"], 4.73)
        self.assertEqual(trades[0]["close_price"], 4020)

    def test_interest_is_cashflow_not_a_trade(self):
        account = {"login": 1, "server": "demo", "name": "Demo", "currency": "USD"}
        deals = [deal(type=2, entry=0, profit=18.66, comment="D-ALLINT", position_id=0, volume=0, price=0)]
        trades, cash = group_account(account, deals, [])
        self.assertEqual(trades, [])
        self.assertEqual(cash[0]["amount"], 18.66)

    def test_same_login_on_two_terminals_is_one_account(self):
        terminals = [
            {"id": "a", "label": "MetaTrader 5", "path": r"C:\a\terminal64.exe"},
            {"id": "b", "label": "MetaTrader 5_2", "path": r"C:\b\terminal64.exe"},
        ]
        deal_row = deal()
        close_row = deal(ticket=2, time=1_700_000_100, type=0, entry=1, price=4010, profit=2, commission=0, reason=4, comment="[tp]")
        account = {"login": 42, "server": "Srv", "name": "Bot", "currency": "USD", "balance": 10, "equity": 10, "profit": 0, "margin": 0, "margin_free": 10, "leverage": 100, "company": "Ex"}
        snapshots = {
            "a": {"connected": True, "updated_at": 1_100, "account": account, "deals": [deal_row, close_row], "positions": []},
            "b": {"connected": True, "updated_at": 1_105, "account": dict(account, balance=11, equity=11), "deals": [deal_row, close_row], "positions": []},
        }
        state = build_state(terminals, snapshots, {}, now=1_110)
        self.assertEqual(len(state["accounts"]), 1)
        self.assertEqual(state["accounts"][0]["balance"], 11)
        self.assertEqual(state["accounts"][0]["terminals"], ["MetaTrader 5", "MetaTrader 5_2"])
        self.assertEqual(len(state["trades"]), 1)
        self.assertTrue(all(row["connected"] for row in state["terminals"]))


if __name__ == "__main__":
    unittest.main()
