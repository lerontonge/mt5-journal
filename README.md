# Trading Journal

A local journal for every MetaTrader 5 terminal on this computer. It reads accounts, open positions, and the last five years of deals from each running terminal, then keeps your notes, tags, and ratings in a SQLite file.

The dashboard shows a month calendar of each day's closed profit, a daily bar chart, a cumulative line, and symbol results. Click a day to list that day's trades.

Review has Day, Last week, Last month, 90 days, Past year, and a custom from–to range. Each view shows a growth and drawdown chart plus the gain, drawdown, profit factor, and trade statistics used by Myfxbook. Moving the cursor over the chart shows that point’s date and time. Gain leaves deposits out.

Terminals logged into the same account are one account. The switch at the top chooses All accounts or a single login, and the stats, calendar, and trade list follow that choice.

The page is served only on this machine at http://127.0.0.1:8765. Passwords are never stored. Each terminal must already be open and logged in.

Two terminals logged into the same account are both shown as connections. Their trades and balances are counted once.

## Run

```bat
run.bat
```

Or:

```bat
python -m pip install -r requirements.txt
python -m app.main
```

Notes live in `data/journal.sqlite`. Connection logs live in `data/logs`.
