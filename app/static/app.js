const filters = {
  range: "30",
  status: "all",
  account: "all",
  q: "",
  day: "",
};

const view = { year: new Date().getFullYear(), month: new Date().getMonth() };
let reviewPeriod = "month";
let chartModel = null;

function paint(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function chartInk() {
  return {
    gain: paint("--gain"),
    loss: paint("--loss"),
    muted: paint("--muted"),
    line: paint("--line"),
    growth: paint("--growth"),
    accent: paint("--brass"),
    flat: paint("--paper-2"),
  };
}

function syncAppearance() {
  const select = $("theme-select");
  if (!select) return;
  select.value = document.documentElement.dataset.theme || "dracula";
  document.querySelectorAll("#mode-switch button").forEach((button) => {
    const on = button.dataset.mode === (document.documentElement.dataset.mode || "dark");
    button.classList.toggle("on", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function setAppearance(theme, mode) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.mode = mode;
  localStorage.setItem("journal-theme", theme);
  localStorage.setItem("journal-mode", mode);
  dashStamp = "";
  reviewStamp = "";
  syncAppearance();
  renderDashboard();
  renderReview();
}
let curveModel = null;
let reviewStamp = "";

let state = { terminals: [], accounts: [], trades: [], as_of: 0 };
let selectedKey = null;
let dirty = false;
let rating = null;
let editorStamp = "";
let tableStamp = "";
let dashStamp = "";

const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function money(value) {
  const n = Number(value || 0);
  const sign = n < 0 ? "−" : "";
  return sign + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function price(value) {
  if (value == null || value === "") return "—";
  const n = Number(value);
  const digits = Math.abs(n) >= 50 ? 3 : 5;
  return n.toFixed(digits);
}

function when(unix) {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function hold(trade) {
  const end = trade.close_time || Date.now() / 1000;
  const seconds = Math.max(0, end - trade.open_time);
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

function tone(value) {
  return Number(value) > 0 ? "gain" : Number(value) < 0 ? "loss" : "";
}

function dayKey(unix) {
  const date = new Date(unix * 1000);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function accountKey(account) {
  return `${account.login}@${account.server}`;
}

function scopedAccounts() {
  if (filters.account === "all") return state.accounts;
  return state.accounts.filter((account) => accountKey(account) === filters.account);
}

function accountTrades() {
  return state.trades.filter((trade) => {
    if (filters.account === "all") return true;
    return `${trade.login}@${trade.server}` === filters.account;
  });
}

function filteredTrades() {
  const now = Date.now() / 1000;
  const window = Number(filters.range) * 86400;
  const query = filters.q.trim().toLowerCase();
  return state.trades.filter((trade) => {
    const stamp = trade.close_time || trade.open_time || 0;
    if (filters.day) {
      if (dayKey(stamp) !== filters.day) return false;
    } else if (filters.range !== "all" && now - stamp > window) return false;
    if (filters.status !== "all" && trade.status !== filters.status) return false;
    if (filters.account !== "all" && `${trade.login}@${trade.server}` !== filters.account) return false;
    if (!query) return true;
    const haystack = [trade.symbol, trade.comment, trade.note, trade.account, trade.magic, ...(trade.tags || [])]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
}

function renderStatus() {
  const live = state.terminals.filter((item) => item.connected).length;
  const whenText = state.as_of ? new Date(state.as_of * 1000).toLocaleTimeString() : "—";
  if (!state.terminals.length) {
    $("status").textContent = "No MetaTrader 5 terminals found";
    return;
  }
  const accounts = state.accounts.length;
  $("status").textContent = live
    ? `${accounts} account${accounts === 1 ? "" : "s"} · ${live} terminal${live === 1 ? "" : "s"} live · ${whenText}`
    : "Terminals found, waiting for a logged-in session";
}

function renderMetrics() {
  const groups = new Map();
  for (const account of scopedAccounts()) {
    const currency = account.currency || "USD";
    const row = groups.get(currency) || { balance: 0, equity: 0, floating: 0 };
    row.balance += account.balance;
    row.equity += account.equity;
    row.floating += account.profit;
    groups.set(currency, row);
  }
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const startUnix = start.getTime() / 1000;
  let closedToday = 0;
  let openCount = 0;
  for (const trade of accountTrades()) {
    if (trade.status === "open") openCount += 1;
    if (trade.status === "closed" && trade.close_time >= startUnix) closedToday += trade.net;
  }
  const bits = [];
  if (groups.size === 0) {
    bits.push(metric("Equity", "—"), metric("Balance", "—"), metric("Floating", "—"));
  } else {
    for (const [currency, row] of groups) {
      bits.push(
        metric("Equity", money(row.equity), currency),
        metric("Balance", money(row.balance), currency),
        metric("Floating", money(row.floating), currency, tone(row.floating)),
      );
    }
  }
  bits.push(metric("Closed today", money(closedToday), "", tone(closedToday)));
  bits.push(metric("Open trades", String(openCount)));
  $("metrics").innerHTML = bits.join("");
}

function metric(label, value, extra = "", className = "") {
  return `<article class="metric"><span>${esc(label)}</span><strong class="${className}">${esc(value)}</strong>${extra ? `<em>${esc(extra)}</em>` : ""}</article>`;
}

function instancesFor(account) {
  const matched = state.terminals.filter((terminal) => {
    const sameLogin = terminal.account && terminal.account.login === account.login && terminal.account.server === account.server;
    return sameLogin || (account.terminals || []).includes(terminal.label);
  });
  if (matched.length) return matched;
  return (account.terminals || []).map((label) => ({ label, connected: true }));
}

function renderTerminals() {
  const accounts = scopedAccounts();
  if (!accounts.length && !state.terminals.length) {
    $("terminals").innerHTML = `<article class="terminal"><strong>No terminals</strong><p>Start MetaTrader 5 on this PC. The journal picks up every terminal64.exe.</p></article>`;
    return;
  }
  const cards = accounts.map((account) => {
    const instances = instancesFor(account);
    const live = instances.filter((instance) => instance.connected).length;
    const lines = instances.map((instance) => {
      return `<li class="${instance.connected ? "live" : "offline"}"><i class="dot"></i>${esc(instance.label)} · ${instance.connected ? "live" : "offline"}</li>`;
    }).join("");
    return `<article class="terminal ${live ? "on" : "off"}">
      <span class="meta">${live ? "Live" : "Offline"} · ${instances.length} terminal${instances.length === 1 ? "" : "s"}</span>
      <strong>${esc(account.name || "Account")}</strong>
      <p>${esc(account.login)} · ${esc(account.server)}</p>
      <p>${esc(money(account.equity))} ${esc(account.currency)} equity</p>
      <ul class="instances">${lines}</ul>
    </article>`;
  });
  if (filters.account === "all") {
    const attached = new Set(accounts.flatMap((account) => (account.terminals || [])));
    for (const terminal of state.terminals) {
      if (terminal.connected || attached.has(terminal.label)) continue;
      cards.push(`<article class="terminal off"><span class="meta"><i class="dot"></i>${esc(terminal.label)}</span><strong>Not connected</strong><p>${esc(terminal.error || "Waiting for a login")}</p></article>`);
    }
  }
  $("terminals").innerHTML = cards.join("");
}

function renderAccountSwitch() {
  const el = $("account-switch");
  const keys = ["all", ...state.accounts.map(accountKey)];
  if (!keys.includes(filters.account)) filters.account = "all";
  const stamp = keys.join("|");
  if (el.dataset.stamp !== stamp) {
    el.dataset.stamp = stamp;
    const buttons = [`<button type="button" class="switch-btn" data-account="all" aria-pressed="false">All accounts</button>`];
    for (const account of state.accounts) {
      const key = accountKey(account);
      buttons.push(`<button type="button" class="switch-btn" data-account="${esc(key)}" aria-pressed="false">${esc(account.name || account.login)}</button>`);
    }
    el.innerHTML = buttons.join("");
  }
  el.querySelectorAll("button").forEach((button) => {
    const on = button.dataset.account === filters.account;
    button.classList.toggle("on", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function pageName() {
  return location.hash === "#log" ? "log" : "overview";
}

function showPage(name) {
  const log = name === "log";
  $("page-overview").hidden = log;
  $("page-log").hidden = !log;
  document.querySelectorAll("#pages a").forEach((link) => {
    const on = link.getAttribute("href") === (log ? "#log" : "#overview");
    link.classList.toggle("on", on);
    if (on) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  if (log) {
    renderTable();
    renderEditor();
  }
}

function applyAccount(key) {
  if (filters.account === key) return;
  filters.account = key;
  filters.day = "";
  dashStamp = "";
  tableStamp = "";
  renderAccountSwitch();
  renderMetrics();
  renderTerminals();
  renderDashboard();
  renderTable();
  renderReview();
}

function renderTable() {
  const scroller = $("table-scroll");
  const top = scroller.scrollTop;
  const trades = filteredTrades();
  $("count").textContent = `${trades.length} trade${trades.length === 1 ? "" : "s"}`;
  const showAccount = filters.account === "all";
  const stamp = `${filters.account}|${selectedKey}|${trades.map((trade) => `${trade.key}:${trade.net}:${trade.status}:${trade.note}:${trade.rating}`).join("|")}`;
  if (stamp === tableStamp && scroller.querySelector("tbody")) return;
  tableStamp = stamp;
  if (!trades.length) {
    scroller.innerHTML = `<p class="empty" style="padding:16px">No trades in this filter yet.</p>`;
    return;
  }
  const rows = trades.map((trade) => {
    const marked = trade.note || (trade.tags && trade.tags.length) || trade.rating ? `<span class="mark">●</span>` : "";
    const exit = trade.status === "open" ? `<span class="pill open">open</span>` : esc(trade.exit || "closed");
    const label = `${trade.account} ${trade.symbol} ${trade.side} ${money(trade.net)}`;
    return `<tr data-key="${esc(trade.key)}" class="${trade.key === selectedKey ? "selected" : ""}" tabindex="0" role="button" aria-label="${esc(label)}">
      <td>${when(trade.close_time || trade.open_time)}</td>
      ${showAccount ? `<td>${esc(trade.account)}</td>` : ""}
      <td>${esc(trade.symbol)} ${marked}</td>
      <td><span class="pill ${trade.side === "short" ? "short" : ""}">${esc(trade.side)}</span></td>
      <td class="num">${trade.volume.toFixed(2)}</td>
      <td class="num ${tone(trade.net)}">${money(trade.net)}</td>
      <td>${exit}</td>
    </tr>`;
  }).join("");
  scroller.innerHTML = `<table>
    <thead><tr><th>When</th>${showAccount ? "<th>Account</th>" : ""}<th>Symbol</th><th>Side</th><th class="num">Vol</th><th class="num">Net</th><th>Exit</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
  scroller.scrollTop = top;
  scroller.querySelectorAll("tr[data-key]").forEach((row) => {
    row.addEventListener("click", () => selectTrade(row.dataset.key));
  });
}

function selectedTrade() {
  return state.trades.find((trade) => trade.key === selectedKey) || null;
}

function renderEditor() {
  const trade = selectedTrade();
  $("editor-empty").hidden = Boolean(trade);
  $("editor-form").hidden = !trade;
  if (!trade || dirty) return;
  const stamp = [trade.key, trade.note, trade.rating, (trade.tags || []).join("|"), trade.net, trade.status, trade.close_price, trade.floating].join("~");
  if (stamp === editorStamp) return;
  editorStamp = stamp;
  rating = trade.rating || null;
  $("ed-kicker").textContent = `${trade.account} · ${trade.login}`;
  $("ed-title").textContent = `${trade.symbol} ${trade.side}`;
  $("ed-sub").textContent = trade.comment || "No entry comment";
  const rows = [
    ["Status", trade.status],
    ["Hold", hold(trade)],
    ["Volume", trade.volume.toFixed(2)],
    ["Magic", trade.magic || "—"],
    ["Entry", price(trade.open_price)],
    ["Exit", price(trade.close_price)],
    ["Realized", money(trade.realized)],
    ["Floating", money(trade.floating)],
    ["Commission", money(trade.commission)],
    ["Swap", money(trade.swap)],
    ["Net", money(trade.net) + (trade.currency ? ` ${trade.currency}` : "")],
    ["Exit reason", trade.exit || "—"],
  ];
  if (trade.sl) rows.push(["Stop", price(trade.sl)]);
  if (trade.tp) rows.push(["Target", price(trade.tp)]);
  $("ed-facts").innerHTML = rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd class="${label === "Net" ? tone(trade.net) : ""}">${esc(value)}</dd></div>`).join("");
  $("tags").value = (trade.tags || []).join(", ");
  $("note").value = trade.note || "";
  $("save-state").textContent = "";
  renderStars();
}

function renderStars() {
  $("stars").innerHTML = [1, 2, 3, 4, 5].map((value) => {
    return `<button type="button" data-star="${value}" class="${rating >= value ? "on" : ""}" aria-label="${value} star">${value}</button>`;
  }).join("");
  $("stars").querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      const value = Number(button.dataset.star);
      rating = rating === value ? null : value;
      dirty = true;
      $("save-state").textContent = "Unsaved";
      renderStars();
    });
  });
}

async function selectTrade(key) {
  if (dirty) await saveNote();
  selectedKey = key;
  dirty = false;
  renderTable();
  renderEditor();
}

async function saveNote() {
  const trade = selectedTrade();
  if (!trade) return;
  const body = {
    note: $("note").value,
    tags: $("tags").value.split(",").map((tag) => tag.trim()).filter(Boolean),
    rating,
  };
  $("save-state").textContent = "Saving…";
  const response = await fetch(`/api/notes/${trade.login}/${trade.position_id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    $("save-state").textContent = "Save failed";
    return;
  }
  trade.note = body.note;
  trade.tags = body.tags;
  trade.rating = body.rating;
  dirty = false;
  $("save-state").textContent = "Saved";
  renderTable();
}

function isoDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function dayStamp(value, end) {
  const [year, month, day] = String(value).split("-").map(Number);
  if (!year || !month || !day) return null;
  const date = end ? new Date(year, month - 1, day, 23, 59, 59) : new Date(year, month - 1, day);
  return date.getTime() / 1000;
}

function ensureCustomDates() {
  const today = new Date();
  const from = new Date();
  from.setDate(today.getDate() - 29);
  if (!$("review-from").value) $("review-from").value = isoDate(from);
  if (!$("review-to").value) $("review-to").value = isoDate(today);
}

function periodStart(period) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (period === "week") start.setDate(start.getDate() - 6);
  if (period === "month") start.setDate(start.getDate() - 29);
  if (period === "d90") start.setDate(start.getDate() - 89);
  if (period === "year") start.setDate(start.getDate() - 364);
  return start.getTime() / 1000;
}

function periodBounds() {
  const now = Date.now() / 1000;
  if (reviewPeriod !== "custom") return { start: periodStart(reviewPeriod), end: now };
  ensureCustomDates();
  let start = dayStamp($("review-from").value, false);
  let end = dayStamp($("review-to").value, true);
  if (start == null || end == null) return { start: periodStart("month"), end: now };
  if (start > end) {
    start = dayStamp($("review-to").value, false);
    end = dayStamp($("review-from").value, true);
  }
  return { start, end: Math.min(end, now) };
}

function periodLabel(period) {
  if (period === "day") return "Today";
  if (period === "week") return "the past 7 days";
  if (period === "month") return "the past 30 days";
  if (period === "d90") return "the past 90 days";
  if (period === "year") return "the past year";
  const start = dayStamp($("review-from").value, false);
  const end = dayStamp($("review-to").value, false);
  if (start == null || end == null) return "a custom range";
  const format = { month: "short", day: "numeric", year: "numeric" };
  const from = new Date(Math.min(start, end) * 1000).toLocaleDateString(undefined, format);
  const to = new Date(Math.max(start, end) * 1000).toLocaleDateString(undefined, format);
  return `${from} – ${to}`;
}

function scopedCashflows(start) {
  const rows = [];
  for (const account of scopedAccounts()) {
    for (const flow of account.cashflows || []) {
      if (flow.time >= start) rows.push(flow);
    }
  }
  return rows;
}

function sampleStdev(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function signedPct(value) {
  if (value == null || Number.isNaN(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}

function isInterest(flow) {
  const comment = String(flow.comment || "");
  if (/allint/i.test(comment)) return false;
  return /interest|dividend|tax/i.test(comment);
}

function buildCurve(trades, flows, startBalance, startTime) {
  const events = [
    ...trades.map((trade) => ({ time: trade.close_time, kind: "trade", amount: trade.net })),
    ...flows.map((flow) => ({ time: flow.time, kind: "flow", amount: flow.amount, comment: flow.comment })),
  ].sort((a, b) => a.time - b.time || (a.kind === "flow" ? -1 : 1));
  let equity = startBalance;
  let cash = 0;
  let deposits = Math.max(startBalance, 0);
  let hwm = Math.max(equity, 0);
  let minEquity = equity;
  let maxDd = 0;
  let maxDdMoney = 0;
  const points = [{ growth: 0, drawdown: 0, time: startTime }];
  for (const event of events) {
    if (event.kind === "flow" && !isInterest(event)) {
      equity += event.amount;
      cash += event.amount;
      if (event.amount > 0) deposits += event.amount;
      hwm += event.amount;
      if (hwm < equity) hwm = equity;
    } else {
      equity += event.amount;
    }
    minEquity = Math.min(minEquity, equity);
    if (equity > hwm) hwm = equity;
    const profit = equity - startBalance - cash;
    const growth = deposits > 0.5 ? (profit / deposits) * 100 : 0;
    const ddMoney = Math.max(0, hwm - equity);
    const drawdown = hwm > 0.5 ? (ddMoney / hwm) * 100 : 0;
    maxDd = Math.max(maxDd, drawdown);
    maxDdMoney = Math.max(maxDdMoney, ddMoney);
    points.push({ growth, drawdown, time: event.time });
  }
  const last = points[points.length - 1];
  return {
    points,
    maxDd,
    maxDdMoney,
    endBalance: equity,
    absoluteDd: Math.max(0, Math.max(startBalance, 0) - minEquity),
    gain: last ? last.growth : 0,
    deposits,
  };
}

function myfxbookStats(trades, flows, curve) {
  const wins = trades.filter((trade) => trade.net > 0);
  const losses = trades.filter((trade) => trade.net < 0);
  const longs = trades.filter((trade) => trade.side === "long");
  const shorts = trades.filter((trade) => trade.side === "short");
  const grossProfit = wins.reduce((sum, trade) => sum + trade.net, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.net, 0));
  const net = trades.reduce((sum, trade) => sum + trade.net, 0);
  const decided = wins.length + losses.length;
  let streak = 0;
  let maxWins = 0;
  let maxLosses = 0;
  let runs = 0;
  let previous = "";
  for (const trade of trades) {
    if (trade.net === 0) continue;
    const side = trade.net > 0 ? "w" : "l";
    if (side !== previous) {
      runs += 1;
      previous = side;
      streak = 0;
    }
    streak += 1;
    if (side === "w") maxWins = Math.max(maxWins, streak);
    else maxLosses = Math.max(maxLosses, streak);
  }
  const winCount = wins.length;
  const lossCount = losses.length;
  let zScore = null;
  const total = winCount + lossCount;
  if (winCount > 0 && lossCount > 0 && total > 1) {
    const expected = (2 * winCount * lossCount) / total + 1;
    const variance = (2 * winCount * lossCount * (2 * winCount * lossCount - total)) / (total * total * (total - 1));
    if (variance > 0) zScore = (runs - expected) / Math.sqrt(variance);
  }
  let balance = Math.max(curve.deposits, 0) || 1;
  const returns = [];
  for (const trade of trades) {
    if (Math.abs(balance) > 0.5) returns.push(trade.net / balance);
    balance += trade.net;
  }
  const ahpr = returns.length ? returns.reduce((sum, value) => sum + (1 + value), 0) / returns.length : null;
  let ghpr = null;
  if (returns.length && returns.every((value) => 1 + value > 0)) {
    const logMean = returns.reduce((sum, value) => sum + Math.log(1 + value), 0) / returns.length;
    ghpr = Math.exp(logMean);
  }
  const daily = new Map();
  for (const trade of trades) {
    const key = dayKey(trade.close_time);
    daily.set(key, (daily.get(key) || 0) + trade.net);
  }
  const dailyReturns = [];
  let dayBalance = Math.max(curve.deposits, 1);
  for (const amount of daily.values()) {
    if (Math.abs(dayBalance) > 0.5) dailyReturns.push(amount / dayBalance);
    dayBalance += amount;
  }
  const dailyStdev = sampleStdev(dailyReturns);
  const dailyMean = dailyReturns.length ? dailyReturns.reduce((sum, value) => sum + value, 0) / dailyReturns.length : null;
  const sharpe = dailyStdev ? (dailyMean / dailyStdev) * Math.sqrt(252) : null;
  const deposits = flows.filter((flow) => flow.amount > 0 && !isInterest(flow)).reduce((sum, flow) => sum + flow.amount, 0);
  const withdrawals = flows.filter((flow) => flow.amount < 0 && !isInterest(flow)).reduce((sum, flow) => sum + flow.amount, 0);
  const interest = flows.filter((flow) => isInterest(flow)).reduce((sum, flow) => sum + flow.amount, 0);
  const holdSeconds = trades.length ? trades.reduce((sum, trade) => sum + Math.max(0, trade.close_time - trade.open_time), 0) / trades.length : 0;
  const gain = curve.deposits > 0.5 ? curve.gain : null;
  const best = trades.reduce((bestTrade, trade) => (bestTrade == null || trade.net > bestTrade.net ? trade : bestTrade), null);
  const worst = trades.reduce((worstTrade, trade) => (worstTrade == null || trade.net < worstTrade.net ? trade : worstTrade), null);
  return {
    gain,
    net,
    trades: trades.length,
    profitability: decided ? (wins.length / decided) * 100 : null,
    lots: trades.reduce((sum, trade) => sum + trade.volume, 0),
    commissions: trades.reduce((sum, trade) => sum + trade.commission, 0),
    swap: trades.reduce((sum, trade) => sum + trade.swap, 0),
    avgWin: wins.length ? grossProfit / wins.length : null,
    avgLoss: losses.length ? -grossLoss / losses.length : null,
    longs: longs.length,
    longsWon: longs.length ? (longs.filter((trade) => trade.net > 0).length / longs.length) * 100 : null,
    shorts: shorts.length,
    shortsWon: shorts.length ? (shorts.filter((trade) => trade.net > 0).length / shorts.length) * 100 : null,
    profitFactor: grossLoss ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : null),
    expectancy: trades.length ? net / trades.length : null,
    best,
    worst,
    maxWins,
    maxLosses,
    grossProfit,
    grossLoss,
    maxDd: curve.maxDd,
    maxDdMoney: curve.maxDdMoney,
    recovery: curve.maxDdMoney > 0 ? net / curve.maxDdMoney : null,
    stdev: sampleStdev(trades.map((trade) => trade.net)),
    sharpe,
    zScore,
    ahpr,
    ghpr,
    holdSeconds,
    deposits,
    withdrawals,
    interest,
  };
}

function fxRow(label, value, className = "") {
  return `<div class="fx-row"><span>${esc(label)}</span><strong class="${className}">${esc(value)}</strong></div>`;
}

function factorText(value) {
  if (value == null) return "—";
  if (!Number.isFinite(value)) return "∞";
  return value.toFixed(2);
}

function durationText(seconds) {
  if (!seconds) return "—";
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

function chartWhen(unix) {
  return new Date(unix * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function growthChart(points) {
  chartModel = null;
  if (points.length < 2) return `<p class="sub">This view needs at least one closed trade before the growth line can be drawn.</p>`;
  const width = 760;
  const height = 250;
  const padL = 52;
  const padR = 14;
  const padT = 16;
  const padB = 16;
  chartModel = { points, width, height, padL, padR, padT, padB };
  const lows = points.map((point) => -point.drawdown);
  const highs = points.map((point) => point.growth);
  let min = Math.min(0, ...lows, ...highs);
  let max = Math.max(0, ...highs);
  if (min === max) { min -= 1; max += 1; }
  const x = (index) => padL + (index / (points.length - 1)) * (width - padL - padR);
  const y = (value) => padT + (1 - (value - min) / (max - min)) * (height - padT - padB);
  const line = (pick) => points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(pick(point)).toFixed(1)}`).join(" ");
  const growth = line((point) => point.growth);
  const drawdown = line((point) => -point.drawdown);
  const fill = `${drawdown} L${x(points.length - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;
  const ticks = [max, 0, min];
  const ink = chartInk();
  const labels = ticks.map((tick) => `<text x="4" y="${(y(tick) + 4).toFixed(1)}" fill="${ink.muted}" font-size="11">${tick.toFixed(1)}%</text>`).join("");
  return `<svg class="chart growth-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Growth and drawdown">
    <line x1="${padL}" x2="${width - padR}" y1="${y(0)}" y2="${y(0)}" stroke="${ink.line}"></line>
    ${labels}
    <path d="${fill}" fill="${ink.loss}" opacity="0.35"></path>
    <path d="${drawdown}" fill="none" stroke="${ink.loss}" stroke-width="1.5"></path>
    <path d="${growth}" fill="none" stroke="${ink.growth}" stroke-width="2.4"></path>
    <line id="chart-guide" visibility="hidden" stroke="${ink.accent}" stroke-width="1" y1="${padT}" y2="${height - padB}"></line>
  </svg>`;
}

function chartPointer(event) {
  return (event.touches && event.touches[0]) || event;
}

function onChartMove(event) {
  const tip = $("chart-tip");
  const svg = event.currentTarget.querySelector("svg");
  const pointer = chartPointer(event);
  if (!svg || !chartModel || chartModel.points.length < 2 || pointer.clientX == null) {
    tip.hidden = true;
    return;
  }
  const rect = svg.getBoundingClientRect();
  const viewX = ((pointer.clientX - rect.left) / rect.width) * chartModel.width;
  const plot = chartModel.width - chartModel.padL - chartModel.padR;
  let index = Math.round(((viewX - chartModel.padL) / plot) * (chartModel.points.length - 1));
  index = Math.max(0, Math.min(chartModel.points.length - 1, index));
  const point = chartModel.points[index];
  const x = chartModel.padL + (index / (chartModel.points.length - 1)) * plot;
  const guide = svg.querySelector("#chart-guide");
  guide.setAttribute("x1", x.toFixed(1));
  guide.setAttribute("x2", x.toFixed(1));
  guide.setAttribute("visibility", "visible");
  tip.hidden = false;
  tip.innerHTML = `<strong>${esc(chartWhen(point.time))}</strong><span>Growth ${esc(signedPct(point.growth))}</span><span>Drawdown ${esc(signedPct(-point.drawdown))}</span>`;
  const wrap = event.currentTarget.parentElement.getBoundingClientRect();
  let left = pointer.clientX - wrap.left + 14;
  let top = pointer.clientY - wrap.top - 28;
  if (left + tip.offsetWidth > wrap.width) left = Math.max(8, left - tip.offsetWidth - 28);
  tip.style.left = `${left}px`;
  tip.style.top = `${Math.max(4, top)}px`;
}

function hideChartTip() {
  $("chart-tip").hidden = true;
  const guide = document.querySelector("#chart-guide");
  if (guide) guide.setAttribute("visibility", "hidden");
}

function renderReview() {
  document.querySelectorAll("#review-period button").forEach((button) => {
    const on = button.dataset.period === reviewPeriod;
    button.classList.toggle("on", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  });
  $("custom-period").hidden = reviewPeriod !== "custom";
  const chosen = state.accounts.find((account) => accountKey(account) === filters.account);
  const who = chosen ? chosen.name : "All accounts";
  $("review-note").textContent = `${who} · ${periodLabel(reviewPeriod)}. Gain excludes deposits. Drawdown is the drop from the high of this view.`;
  const { start, end } = periodBounds();
  const closedSince = accountTrades().filter((trade) => trade.status === "closed" && trade.close_time >= start);
  const flowsSince = scopedCashflows(start);
  const trades = closedSince.filter((trade) => trade.close_time <= end).sort((a, b) => a.close_time - b.close_time);
  const flows = flowsSince.filter((flow) => flow.time <= end);
  const balance = scopedAccounts().reduce((sum, account) => sum + account.balance, 0);
  const equity = scopedAccounts().reduce((sum, account) => sum + account.equity, 0);
  const flowNet = flowsSince.reduce((sum, flow) => sum + flow.amount, 0);
  const tradingNet = closedSince.reduce((sum, trade) => sum + trade.net, 0);
  const startBalance = balance - tradingNet - flowNet;
  const stamp = [
    reviewPeriod,
    start.toFixed(0),
    end.toFixed(0),
    filters.account,
    balance.toFixed(2),
    trades.map((trade) => `${trade.key}:${trade.net.toFixed(2)}`).join(","),
    flows.map((flow) => `${flow.time}:${flow.amount.toFixed(2)}`).join(","),
  ].join("|");
  if (stamp === reviewStamp && $("growth-chart").childElementCount) return;
  reviewStamp = stamp;
  const curve = buildCurve(trades, flows, startBalance, start);
  const stats = myfxbookStats(trades, flows, curve);
  const won = (count, rate) => (count ? `${count} (${rate == null ? "—" : `${rate.toFixed(0)}%`} won)` : "—");
  $("growth-chart").innerHTML = growthChart(curve.points);
  $("review-stats").innerHTML = [
    `<div class="fx-label">Summary</div>`,
    fxRow("Gain", signedPct(stats.gain), tone(stats.gain)),
    fxRow("Profit", money(stats.net), tone(stats.net)),
    fxRow("Balance", money(balance)),
    fxRow("Equity", money(equity), tone(equity - balance)),
    fxRow("Deposits", money(stats.deposits)),
    fxRow("Withdrawals", money(stats.withdrawals), tone(stats.withdrawals)),
    fxRow("Interest", money(stats.interest), tone(stats.interest)),
    `<div class="fx-label">Drawdown</div>`,
    fxRow("Max drawdown", signedPct(-stats.maxDd), stats.maxDd ? "loss" : ""),
    fxRow("Max drawdown $", money(-stats.maxDdMoney), stats.maxDdMoney ? "loss" : ""),
    fxRow("Recovery factor", factorText(stats.recovery)),
    fxRow("Absolute drawdown", money(curve.absoluteDd), curve.absoluteDd ? "loss" : ""),
    `<div class="fx-label">Trades</div>`,
    fxRow("Trades", String(stats.trades)),
    fxRow("Profitability", stats.profitability == null ? "—" : `${stats.profitability.toFixed(1)}%`),
    fxRow("Lots", stats.lots.toFixed(2)),
    fxRow("Commissions", money(stats.commissions), tone(stats.commissions)),
    fxRow("Swap", money(stats.swap), tone(stats.swap)),
    fxRow("Gross profit", money(stats.grossProfit), "gain"),
    fxRow("Gross loss", money(-stats.grossLoss), stats.grossLoss ? "loss" : ""),
    fxRow("Profit factor", factorText(stats.profitFactor)),
    fxRow("Expected payoff", stats.expectancy == null ? "—" : money(stats.expectancy), tone(stats.expectancy)),
    fxRow("Average win", stats.avgWin == null ? "—" : money(stats.avgWin), "gain"),
    fxRow("Average loss", stats.avgLoss == null ? "—" : money(stats.avgLoss), "loss"),
    fxRow("Longs won", won(stats.longs, stats.longsWon)),
    fxRow("Shorts won", won(stats.shorts, stats.shortsWon)),
    fxRow("Best trade", stats.best ? `${stats.best.symbol} ${money(stats.best.net)}` : "—", "gain"),
    fxRow("Worst trade", stats.worst ? `${stats.worst.symbol} ${money(stats.worst.net)}` : "—", "loss"),
    fxRow("Max consecutive wins", String(stats.maxWins)),
    fxRow("Max consecutive losses", String(stats.maxLosses)),
    fxRow("Average trade length", durationText(stats.holdSeconds)),
    `<div class="fx-label">Ratios</div>`,
    fxRow("Standard deviation", stats.stdev == null ? "—" : money(stats.stdev)),
    fxRow("Sharpe ratio", stats.sharpe == null ? "—" : stats.sharpe.toFixed(2), tone(stats.sharpe)),
    fxRow("Z-score", stats.zScore == null ? "—" : stats.zScore.toFixed(2)),
    fxRow("AHPR", stats.ahpr == null ? "—" : stats.ahpr.toFixed(4)),
    fxRow("GHPR", stats.ghpr == null ? "—" : stats.ghpr.toFixed(4)),
  ].join("");
  $("by-symbol").innerHTML = breakdown(trades, (trade) => trade.symbol);
  $("by-magic").innerHTML = breakdown(trades, (trade) => String(trade.magic || "none"));
}

function monthDays() {
  const totals = new Map();
  for (const trade of accountTrades()) {
    if (trade.status !== "closed" || !trade.close_time) continue;
    const key = dayKey(trade.close_time);
    const row = totals.get(key) || { net: 0, count: 0 };
    row.net += trade.net;
    row.count += 1;
    totals.set(key, row);
  }
  const count = new Date(view.year, view.month + 1, 0).getDate();
  const days = [];
  for (let day = 1; day <= count; day += 1) {
    const key = `${view.year}-${String(view.month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const row = totals.get(key) || { net: 0, count: 0 };
    days.push({ day, key, net: row.net, count: row.count });
  }
  return days;
}

function renderDashboard() {
  const days = monthDays();
  const stamp = `${view.year}-${view.month}|${filters.account}|${filters.day}|${days.map((day) => `${day.net.toFixed(2)}:${day.count}`).join(",")}`;
  if (stamp === dashStamp) return;
  dashStamp = stamp;
  const monthNet = days.reduce((sum, day) => sum + day.net, 0);
  const label = new Date(view.year, view.month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  $("month-label").textContent = label;
  $("month-net").textContent = money(monthNet);
  $("month-net").className = `month-net ${tone(monthNet)}`;
  const now = new Date();
  $("month-next").disabled = view.year > now.getFullYear() || (view.year === now.getFullYear() && view.month >= now.getMonth());
  $("calendar").innerHTML = calendarHtml(days);
  $("daily-bars").innerHTML = dailyBars(days);
  $("curve").innerHTML = curveSvg(days);
  $("symbol-bars").innerHTML = symbolBars(days);
  renderDayChip();
}

function calendarHtml(days) {
  const headers = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    .map((name) => `<div class="dow">${name}</div>`)
    .join("");
  const lead = new Date(view.year, view.month, 1).getDay();
  const pads = Array.from({ length: lead }, () => `<div class="day-pad"></div>`).join("");
  const maxAbs = Math.max(...days.map((day) => Math.abs(day.net)), 1);
  const today = dayKey(Date.now() / 1000);
  const cells = days.map((day) => {
    const traded = day.count > 0;
    const alpha = traded ? (0.22 + 0.62 * (Math.abs(day.net) / maxAbs)).toFixed(2) : "0";
    const classes = ["day", traded ? tone(day.net) : "", day.key === today ? "today" : "", day.key === filters.day ? "selected" : ""]
      .filter(Boolean)
      .join(" ");
    const profit = traded ? `<span class="p ${tone(day.net)}">${day.net > 0 ? "+" : ""}${money(day.net)}</span><span class="c">${day.count} trade${day.count === 1 ? "" : "s"}</span>` : "";
    const spoken = traded ? `${day.key} ${money(day.net)}` : day.key;
    return `<button type="button" class="${classes}" data-day="${day.key}" style="--a:${alpha}" aria-label="${esc(spoken)}" ${traded ? "" : "disabled"}>${`<span class="d">${day.day}</span>`}${profit}</button>`;
  }).join("");
  return `<div class="cal">${headers}${pads}${cells}</div>`;
}

function runningTotal(days) {
  let equity = 0;
  return days.map((day) => {
    equity += day.net;
    return equity;
  });
}

function chartSize(ratio) {
  const width = 360;
  const height = Math.round(width * ratio);
  return { width, height };
}

function axisMoney(value) {
  if (Math.abs(value) < 0.005) return "0";
  const sign = value < 0 ? "−" : "+";
  const abs = Math.abs(value);
  const body = abs >= 100 ? abs.toFixed(0) : abs.toFixed(2);
  return sign + body;
}

function dailyBars(days) {
  if (!days.some((day) => day.count)) return `<p class="sub">No closed trades this month.</p>`;
  const { width, height } = chartSize(0.46);
  const padX = 8;
  const padTop = 12;
  const padBottom = 22;
  const max = Math.max(...days.map((day) => Math.abs(day.net)), 1);
  const innerH = height - padTop - padBottom;
  const zero = padTop + innerH / 2;
  const slot = (width - padX * 2) / days.length;
  const labelStep = slot < 16 ? Math.ceil(days.length / 6) : 1;
  const ink = chartInk();
  const bars = days.map((day, index) => {
    const barH = (Math.abs(day.net) / max) * (innerH / 2);
    const x = padX + index * slot + slot * 0.18;
    const barW = Math.max(slot * 0.64, 1);
    const y = day.net >= 0 ? zero - barH : zero;
    const color = day.net > 0 ? ink.gain : day.net < 0 ? ink.loss : ink.flat;
    const heightPx = day.net === 0 ? 1 : Math.max(barH, 1);
    const tick = index % labelStep === 0
      ? `<text x="${(x + barW / 2).toFixed(1)}" y="${height - 6}" text-anchor="middle" fill="${ink.muted}" font-size="11">${day.day}</text>`
      : "";
    return `<g><title>${day.key}: ${money(day.net)}</title><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${heightPx.toFixed(1)}" rx="2" fill="${color}"></rect>${tick}</g>`;
  }).join("");
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Profit for each day of the month">
    <line x1="${padX}" x2="${width - padX}" y1="${zero}" y2="${zero}" stroke="${ink.line}"></line>
    ${bars}
  </svg>`;
}

function curveSvg(days) {
  const points = runningTotal(days);
  if (points.length < 2 || points.every((point) => point === 0)) {
    curveModel = null;
    return `<p class="sub">The cumulative line fills in as the month gets closed trades.</p>`;
  }
  const { width, height } = chartSize(0.56);
  const padL = 54;
  const padR = 12;
  const padT = 18;
  const padB = 26;
  let min = Math.min(0, ...points);
  let max = Math.max(0, ...points);
  if (min === max) { min -= 1; max += 1; }
  const x = (index) => padL + (index / (points.length - 1)) * (width - padL - padR);
  const y = (value) => padT + (1 - (value - min) / (max - min)) * (height - padT - padB);
  const line = points.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  const fill = `${line} L${x(points.length - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;
  const ink = chartInk();
  const color = points[points.length - 1] >= 0 ? ink.gain : ink.loss;
  const yLabels = [max, 0, min].filter((value, index, all) => all.findIndex((item) => Math.abs(item - value) < 0.01) === index).map((value) => {
    return `<text x="${padL - 8}" y="${(y(value) + 4).toFixed(1)}" text-anchor="end" fill="${ink.muted}" font-size="12">${axisMoney(value)}</text>`;
  }).join("");
  const marks = [0, Math.round((days.length - 1) / 2), days.length - 1];
  const xLabels = [...new Set(marks)].map((index) => {
    return `<text x="${x(index).toFixed(1)}" y="${height - 6}" text-anchor="${index === 0 ? "start" : index === days.length - 1 ? "end" : "middle"}" fill="${ink.muted}" font-size="12">${days[index].day}</text>`;
  }).join("");
  const last = points[points.length - 1];
  const endY = Math.min(height - padB - 4, Math.max(padT + 4, y(last) - 8));
  curveModel = { days, points, width, height, padL, padR, padT, padB };
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Cumulative closed profit, ending at ${axisMoney(last)}">
    <line x1="${padL}" x2="${width - padR}" y1="${y(0)}" y2="${y(0)}" stroke="${ink.line}"></line>
    ${yLabels}
    ${xLabels}
    <path d="${fill}" fill="${color}" opacity="0.18"></path>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2.5"></path>
    <circle cx="${x(points.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="3.5" fill="${color}"></circle>
    <text x="${(x(points.length - 1) - 8).toFixed(1)}" y="${endY.toFixed(1)}" text-anchor="end" fill="${color}" font-size="12">${axisMoney(last)}</text>
    <line id="curve-guide" visibility="hidden" stroke="${ink.accent}" stroke-width="1" y1="${padT}" y2="${height - padB}"></line>
  </svg>`;
}

function onCurveMove(event) {
  const tip = $("curve-tip");
  const svg = event.currentTarget.querySelector("svg");
  const pointer = chartPointer(event);
  if (!svg || !curveModel || pointer.clientX == null) {
    tip.hidden = true;
    return;
  }
  const rect = svg.getBoundingClientRect();
  const viewX = ((pointer.clientX - rect.left) / rect.width) * curveModel.width;
  const plot = curveModel.width - curveModel.padL - curveModel.padR;
  let index = Math.round(((viewX - curveModel.padL) / plot) * (curveModel.points.length - 1));
  index = Math.max(0, Math.min(curveModel.points.length - 1, index));
  const day = curveModel.days[index];
  const value = curveModel.points[index];
  const x = curveModel.padL + (index / (curveModel.points.length - 1)) * plot;
  const guide = svg.querySelector("#curve-guide");
  if (guide) {
    guide.setAttribute("x1", x.toFixed(1));
    guide.setAttribute("x2", x.toFixed(1));
    guide.setAttribute("visibility", "visible");
  }
  const whenLabel = new Date(day.key + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
  tip.hidden = false;
  tip.innerHTML = `<strong>${esc(whenLabel)}</strong><span>Cumulative ${esc(money(value))}</span><span>Day ${esc(money(day.net))}</span>`;
  const wrap = event.currentTarget.parentElement.getBoundingClientRect();
  let left = pointer.clientX - wrap.left + 12;
  let top = pointer.clientY - wrap.top - 36;
  if (left + tip.offsetWidth > wrap.width) left = Math.max(8, left - tip.offsetWidth - 24);
  tip.style.left = `${left}px`;
  tip.style.top = `${Math.max(4, top)}px`;
}

function hideCurveTip() {
  const tip = $("curve-tip");
  if (tip) tip.hidden = true;
  const guide = document.querySelector("#curve-guide");
  if (guide) guide.setAttribute("visibility", "hidden");
}

function symbolBars(days) {
  const keys = new Set(days.map((day) => day.key));
  const groups = new Map();
  for (const trade of accountTrades()) {
    if (trade.status !== "closed" || !keys.has(dayKey(trade.close_time))) continue;
    const row = groups.get(trade.symbol) || { net: 0 };
    row.net += trade.net;
    groups.set(trade.symbol, row);
  }
  const rows = [...groups.entries()].sort((a, b) => Math.abs(b[1].net) - Math.abs(a[1].net)).slice(0, 8);
  if (!rows.length) return `<p class="sub">No symbol results this month.</p>`;
  const max = Math.max(...rows.map((row) => Math.abs(row[1].net)), 1);
  return rows.map(([name, row]) => {
    const width = Math.max(4, (Math.abs(row.net) / max) * 100);
    return `<div class="hbar"><span>${esc(name)}</span><span class="track"><span class="fill ${tone(row.net)}" style="width:${width.toFixed(1)}%"></span></span><span class="num ${tone(row.net)}">${money(row.net)}</span></div>`;
  }).join("");
}

function renderDayChip() {
  const button = $("clear-day");
  if (!filters.day) {
    button.hidden = true;
    return;
  }
  const [year, month, day] = filters.day.split("-").map(Number);
  const label = new Date(year, month - 1, day).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  button.hidden = false;
  button.textContent = `${label} · clear`;
}

function shiftMonth(delta) {
  const date = new Date(view.year, view.month + delta, 1);
  view.year = date.getFullYear();
  view.month = date.getMonth();
  renderDashboard();
}

function breakdown(trades, keyFn) {
  const groups = new Map();
  for (const trade of trades) {
    if (trade.status !== "closed") continue;
    const key = keyFn(trade);
    const row = groups.get(key) || { trades: 0, wins: 0, net: 0 };
    row.trades += 1;
    row.net += trade.net;
    if (trade.net > 0) row.wins += 1;
    groups.set(key, row);
  }
  const rows = [...groups.entries()].sort((a, b) => b[1].net - a[1].net);
  if (!rows.length) return `<p class="sub">No closed trades in this filter.</p>`;
  return `<table>
    <thead><tr><th>Name</th><th class="num">Trades</th><th class="num">Win</th><th class="num">Net</th></tr></thead>
    <tbody>
      ${rows.map(([name, row]) => `<tr>
        <td>${esc(name)}</td>
        <td class="num">${row.trades}</td>
        <td class="num">${row.trades ? Math.round((row.wins / row.trades) * 100) : 0}%</td>
        <td class="num ${tone(row.net)}">${money(row.net)}</td>
      </tr>`).join("")}
    </tbody>
  </table>`;
}

async function refresh() {
  try {
    const response = await fetch("/api/state");
    if (!response.ok) throw new Error(String(response.status));
    state = await response.json();
    renderStatus();
    renderAccountSwitch();
    renderMetrics();
    renderTerminals();
    renderTable();
    renderEditor();
    renderDashboard();
    renderReview();
  } catch (error) {
    $("status").textContent = "Journal server is not responding";
  }
}

function bind() {
  syncAppearance();
  $("theme-select").addEventListener("change", (event) => {
    setAppearance(event.target.value, document.documentElement.dataset.mode || "dark");
  });
  $("mode-switch").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-mode]");
    if (!button) return;
    setAppearance(document.documentElement.dataset.theme || "dracula", button.dataset.mode);
  });
  $("review-period").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-period]");
    if (!button || button.dataset.period === reviewPeriod) return;
    reviewPeriod = button.dataset.period;
    if (reviewPeriod === "custom") ensureCustomDates();
    hideChartTip();
    renderReview();
  });
  const applyCustom = () => {
    reviewPeriod = "custom";
    hideChartTip();
    renderReview();
  };
  $("review-from").addEventListener("change", applyCustom);
  $("review-to").addEventListener("change", applyCustom);
  $("growth-chart").addEventListener("mousemove", onChartMove);
  $("growth-chart").addEventListener("mouseleave", hideChartTip);
  $("growth-chart").addEventListener("touchstart", onChartMove, { passive: true });
  $("growth-chart").addEventListener("touchmove", onChartMove, { passive: true });
  $("curve").addEventListener("mousemove", onCurveMove);
  $("curve").addEventListener("mouseleave", hideCurveTip);
  $("curve").addEventListener("touchstart", onCurveMove, { passive: true });
  $("curve").addEventListener("touchmove", onCurveMove, { passive: true });
  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      dashStamp = "";
      renderDashboard();
    }, 150);
  });
  $("month-prev").addEventListener("click", () => shiftMonth(-1));
  $("month-next").addEventListener("click", () => shiftMonth(1));
  $("calendar").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-day]");
    if (!button || button.disabled) return;
    filters.day = button.dataset.day;
    renderDashboard();
    renderTable();
    if (location.hash !== "#log") location.hash = "log";
    else showPage("log");
  });
  window.addEventListener("hashchange", () => showPage(pageName()));
  showPage(pageName());
  $("clear-day").addEventListener("click", () => {
    filters.day = "";
    dashStamp = "";
    renderDashboard();
    renderTable();
  });
  $("range").addEventListener("change", (event) => { filters.range = event.target.value; renderTable(); renderReview(); });
  $("status-filter").addEventListener("change", (event) => { filters.status = event.target.value; renderTable(); renderReview(); });
  $("account-switch").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-account]");
    if (!button) return;
    applyAccount(button.dataset.account);
  });
  $("search").addEventListener("input", (event) => { filters.q = event.target.value; renderTable(); renderReview(); });
  $("note").addEventListener("input", () => { dirty = true; $("save-state").textContent = "Unsaved"; });
  $("tags").addEventListener("input", () => { dirty = true; $("save-state").textContent = "Unsaved"; });
  $("editor-form").addEventListener("submit", (event) => { event.preventDefault(); saveNote(); });
  document.addEventListener("keydown", (event) => {
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName);
    if (typing || !state.trades.length) return;
    const trades = filteredTrades();
    const index = trades.findIndex((trade) => trade.key === selectedKey);
    if (event.key === "j" || event.key === "ArrowDown") {
      const next = trades[Math.min(trades.length - 1, index + 1)] || trades[0];
      if (next) selectTrade(next.key);
    }
    if (event.key === "k" || event.key === "ArrowUp") {
      const next = trades[Math.max(0, index < 0 ? 0 : index - 1)];
      if (next) selectTrade(next.key);
    }
  });
}

bind();
refresh();
setInterval(refresh, 3000);
