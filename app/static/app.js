const filters = {
  range: "30",
  status: "all",
  account: localStorage.getItem("journal-account") || "all",
  q: "",
  day: "",
};

const view = (() => {
  const now = new Date();
  const saved = (localStorage.getItem("journal-view") || "").split("-").map(Number);
  return saved.length === 2 && saved[0] >= 2000 && saved[0] <= 2100 && saved[1] >= 0 && saved[1] <= 11
    ? { year: saved[0], month: saved[1] } : { year: now.getFullYear(), month: now.getMonth() };
})();
let reviewPeriod = ["day","week","month","d90","year","custom"].includes(localStorage.getItem("journal-review-period")) ? localStorage.getItem("journal-review-period") : "month";
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

function modePreference() {
  return localStorage.getItem("journal-mode") === "light" ? "light" : "dark";
}

function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", paint("--bg") || "#000000");
}

function syncAppearance() {
  const select = $("theme-select");
  if (!select) return;
  const theme = document.documentElement.dataset.theme || "dracula";
  select.value = theme;
  document.querySelectorAll("#mode-switch button").forEach((button) => {
    const on = button.dataset.mode === (document.documentElement.dataset.mode || "dark");
    button.classList.toggle("on", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
    button.disabled = theme === "amoled" && button.dataset.mode === "light";
  });
  syncThemeColor();
}

function setAppearance(theme, mode) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.mode = theme === "amoled" ? "dark" : mode;
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
let curveMode = localStorage.getItem("journal-cumulative-mode") === "percent" ? "percent" : "profit";

// Every amount belongs to one visibility group. The eye button on a page flips that page's groups,
// and Settings lets each group be flipped on its own.
const HIDE_KEYS = ["balance", "pnl", "calendar", "charts", "review", "trades", "insights"];
const HIDE_LABELS = {
  all: "all amounts",
  balance: "account balances",
  pnl: "closed profit totals",
  calendar: "calendar amounts",
  charts: "chart values",
  review: "review statistics",
  trades: "trade amounts",
  insights: "insight amounts",
};
const PAGE_KEYS = {
  overview: ["balance", "pnl", "calendar", "charts", "review"],
  log: ["trades"],
  insights: ["insights"],
  settings: ["balance"],
};
const MASK = "••••••";
const EYE_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

function loadHidden() {
  try {
    const saved = JSON.parse(localStorage.getItem("journal-hidden"));
    if (Array.isArray(saved)) return new Set(saved.filter((key) => HIDE_KEYS.includes(key)));
  } catch (error) {}
  // First run of this version: carry over the two older switches.
  const keys = new Set();
  if (localStorage.getItem("journal-hide-balances") === "1") keys.add("balance");
  if (localStorage.getItem("journal-hide-closed") === "1") ["pnl", "calendar", "charts"].forEach((key) => keys.add(key));
  return keys;
}
const hidden = loadHidden();

function isHidden(key) {
  return hidden.has(key);
}
function amount(key, value, currency) {
  return hidden.has(key) ? MASK : money(value, currency);
}

// Display currency. The Eastern Caribbean dollar is pegged at 2.70 XCD per US dollar,
// so amounts in USD (or US cents) convert with a fixed rate. The choice applies on every page.
const XCD_RATES = { USD: 2.7, USC: 0.027 };
let showXcd = localStorage.getItem("journal-currency") === "XCD";

// The account currency the current scope shares, or null when the scope mixes currencies.
function baseCurrency() {
  const set = new Set(scopedAccounts().map((account) => (account.currency || "USD").toUpperCase()));
  if (set.size === 0) return "USD";
  return set.size === 1 ? [...set][0] : null;
}
function xcdRate(currency) {
  const code = String(currency === undefined ? baseCurrency() || "" : currency || "USD").toUpperCase();
  return showXcd ? XCD_RATES[code] || 1 : 1;
}
function shownCurrency(currency) {
  const code = String(currency === undefined ? baseCurrency() || "" : currency || "USD").toUpperCase();
  return showXcd && XCD_RATES[code] ? "XCD" : code;
}
function setCurrency(xcd) {
  if (showXcd === xcd) return;
  showXcd = xcd;
  try { localStorage.setItem("journal-currency", xcd ? "XCD" : "base"); } catch (error) {}
  setHidden([], true);
}
function syncCurrencySwitch() {
  const el = $("currency-switch");
  if (!el) return;
  const base = baseCurrency();
  const convertible = base && XCD_RATES[base];
  const baseLabel = base === "USC" ? "USD" : base || "Account";
  el.querySelector('[data-currency="base"]').textContent = baseLabel;
  el.querySelectorAll("button[data-currency]").forEach((button) => {
    const on = (button.dataset.currency === "XCD") === showXcd;
    button.classList.toggle("on", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  });
  el.title = convertible
    ? "Show amounts in Eastern Caribbean dollars (fixed rate 2.70 XCD = 1 USD)"
    : "XCD conversion is available for USD accounts only";
}
function hiddenStamp() {
  return HIDE_KEYS.map((key) => (hidden.has(key) ? "1" : "0")).join("");
}
function setHidden(keys, on) {
  for (const key of keys) {
    if (on) hidden.add(key);
    else hidden.delete(key);
  }
  try { localStorage.setItem("journal-hidden", JSON.stringify([...hidden])); } catch (error) {}
  syncPrivacyControls();
  syncCurrencySwitch();
  dashStamp = "";
  tableStamp = "";
  reviewStamp = "";
  editorStamp = "";
  renderMetrics();
  renderTerminals();
  renderInsights();
  renderDashboard();
  renderTable();
  renderEditor();
  renderReview();
}
function togglePage(page) {
  const keys = PAGE_KEYS[page] || [];
  setHidden(keys, !keys.every((key) => hidden.has(key)));
}
function toggleKey(key) {
  if (key === "all") setHidden(HIDE_KEYS, !HIDE_KEYS.every((item) => hidden.has(item)));
  else setHidden([key], !hidden.has(key));
}
function syncPrivacyControls() {
  document.querySelectorAll("[data-eye-page]").forEach((button) => {
    const keys = PAGE_KEYS[button.dataset.eyePage] || [];
    const off = keys.length > 0 && keys.every((key) => hidden.has(key));
    const label = off ? "Show amounts" : "Hide amounts";
    button.setAttribute("aria-pressed", off ? "true" : "false");
    button.setAttribute("aria-label", `${label} on this page`);
    button.title = `${label} on this page`;
    button.innerHTML = off ? EYE_OFF : EYE_ON;
  });
  document.querySelectorAll("[data-hide-key]").forEach((button) => {
    const key = button.dataset.hideKey;
    const off = key === "all" ? HIDE_KEYS.every((item) => hidden.has(item)) : hidden.has(key);
    const label = `${off ? "Show" : "Hide"} ${HIDE_LABELS[key] || key}`;
    button.setAttribute("aria-pressed", off ? "true" : "false");
    button.setAttribute("aria-label", label);
    button.title = label;
    button.innerHTML = off ? EYE_OFF : EYE_ON;
  });
  const mode = $("cumulative-mode");
  if (mode) mode.value = curveMode;
}

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

function money(value, currency) {
  const n = Number(value || 0) * xcdRate(currency);
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
        metric("Equity", amount("balance", row.equity, currency), shownCurrency(currency)),
        metric("Balance", amount("balance", row.balance, currency), shownCurrency(currency)),
        metric("Floating", amount("balance", row.floating, currency), shownCurrency(currency), tone(row.floating)),
      );
    }
  }
  bits.push(metric("Closed today", amount("pnl", closedToday), showXcd ? shownCurrency() : "", tone(closedToday)));
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
    $("settings-terminals").innerHTML = `<article class="terminal"><strong>No terminals</strong><p>Start MetaTrader 5 on this PC. The journal picks up every terminal64.exe.</p></article>`;
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
      <p>${esc(amount("balance", account.equity, account.currency))} ${esc(shownCurrency(account.currency))} equity</p>
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
  $("settings-terminals").innerHTML = cards.join("");
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
  return ["#log", "#insights", "#news", "#settings"].includes(location.hash) ? location.hash.slice(1) : "overview";
}

function showPage(name) {
  const log = name === "log";
  const settings = name === "settings";
  const insights = name === "insights";
  $("page-overview").hidden = log || settings || insights;
  $("page-log").hidden = !log;
  $("page-insights").hidden = !insights;
  $("page-settings").hidden = !settings;
  document.querySelectorAll("#pages a, #settings-link").forEach((link) => {
    const on = link.getAttribute("href") === `#${name}`;
    link.classList.toggle("on", on);
    if (on) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  if (log) {
    renderTable();
    renderEditor();
  }
  if (insights) renderInsights();
  if (settings) renderTerminals();
  if (!log && !settings && !insights) {
    dashStamp = "";
    renderDashboard();
  }
}

function applyAccount(key) {
  if (filters.account === key) return;
  filters.account = key;
  localStorage.setItem("journal-account", key);
  filters.day = "";
  dashStamp = "";
  tableStamp = "";
  renderAccountSwitch();
  syncCurrencySwitch();
  renderMetrics();
  renderTerminals();
  renderInsights();
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
  const stamp = `${hiddenStamp()}|${filters.account}|${selectedKey}|${trades.map((trade) => `${trade.key}:${trade.net}:${trade.status}:${trade.note}:${trade.rating}`).join("|")}`;
  if (stamp === tableStamp && scroller.querySelector("tbody")) return;
  tableStamp = stamp;
  if (!trades.length) {
    scroller.innerHTML = `<p class="empty" style="padding:16px">No trades in this filter yet.</p>`;
    return;
  }
  const rows = trades.map((trade) => {
    const marked = trade.note || (trade.tags && trade.tags.length) || trade.rating ? `<span class="mark">●</span>` : "";
    const exit = trade.status === "open" ? `<span class="pill open">open</span>` : esc(trade.exit || "closed");
    const label = `${trade.account} ${trade.symbol} ${trade.side} ${amount("trades", trade.net, trade.currency)}`;
    return `<tr data-key="${esc(trade.key)}" class="${trade.key === selectedKey ? "selected" : ""}" tabindex="0" role="button" aria-label="${esc(label)}">
      <td>${when(trade.close_time || trade.open_time)}</td>
      ${showAccount ? `<td>${esc(trade.account)}</td>` : ""}
      <td>${esc(trade.symbol)} ${marked}</td>
      <td><span class="pill ${trade.side === "short" ? "short" : ""}">${esc(trade.side)}</span></td>
      <td class="num">${trade.volume.toFixed(2)}</td>
      <td class="num ${tone(trade.net)}">${amount("trades", trade.net, trade.currency)}</td>
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

function paintFacts(trade) {
  const rows = [
    ["Status", trade.status],
    ["Hold", hold(trade)],
    ["Volume", trade.volume.toFixed(2)],
    ["Magic", trade.magic || "—"],
    ["Entry", price(trade.open_price)],
    ["Exit", price(trade.close_price)],
    ["Realized", amount("trades", trade.realized, trade.currency)],
    ["Floating", amount("trades", trade.floating, trade.currency)],
    ["Commission", amount("trades", trade.commission, trade.currency)],
    ["Swap", amount("trades", trade.swap, trade.currency)],
    ["Net", amount("trades", trade.net, trade.currency) + (trade.currency ? ` ${shownCurrency(trade.currency)}` : "")],
    ["Exit reason", trade.exit || "—"],
  ];
  if (trade.sl) rows.push(["Stop", price(trade.sl)]);
  if (trade.tp) rows.push(["Target", price(trade.tp)]);
  $("ed-facts").innerHTML = rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd class="${label === "Net" ? tone(trade.net) : ""}">${esc(value)}</dd></div>`).join("");
}

function renderEditor() {
  const trade = selectedTrade();
  $("editor-empty").hidden = Boolean(trade);
  $("editor-form").hidden = !trade;
  if (!trade) return;
  if (dirty) {
    paintFacts(trade);
    return;
  }
  const stamp = [hiddenStamp(), trade.key, trade.note, trade.rating, (trade.tags || []).join("|"), trade.net, trade.status, trade.close_price, trade.floating].join("~");
  if (stamp === editorStamp) return;
  editorStamp = stamp;
  rating = trade.rating || null;
  $("ed-kicker").textContent = `${trade.account} · ${trade.login}`;
  $("ed-title").textContent = `${trade.symbol} ${trade.side}`;
  $("ed-sub").textContent = trade.comment || "No entry comment";
  paintFacts(trade);
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

function smoothPath(coords) {
  if (!coords.length) return "";
  if (coords.length === 1) return `M${coords[0][0].toFixed(1)},${coords[0][1].toFixed(1)}`;
  let path = `M${coords[0][0].toFixed(1)},${coords[0][1].toFixed(1)}`;
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[Math.max(0, i - 1)], p1 = coords[i], p2 = coords[i + 1], p3 = coords[Math.min(coords.length - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    path += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return path;
}

function growthChart(points) {
  chartModel = null;
  if (points.length < 2) return `<p class="sub">This view needs at least one closed trade before the growth line can be drawn.</p>`;
  const width = 760, height = 250, padL = 58, padR = 14, padT = 16, padB = 28;
  chartModel = { points, width, height, padL, padR, padT, padB };
  const lows = points.map((point) => -point.drawdown), highs = points.map((point) => point.growth);
  const scale = niceScale(Math.min(0, ...lows, ...highs) - 5, Math.max(0, ...highs) + 5);
  const { min, max, step, ticks } = scale;
  const x = (index) => padL + (index / (points.length - 1)) * (width - padL - padR);
  const y = (value) => padT + (1 - (value - min) / (max - min)) * (height - padT - padB);
  const growthCoords = points.map((point,index) => [x(index),y(point.growth)]);
  const ddCoords = points.map((point,index) => [x(index),y(-point.drawdown)]);
  const growth = smoothPath(growthCoords), drawdown = smoothPath(ddCoords), zeroY = y(0);
  const fill = `${drawdown} L${x(points.length-1).toFixed(1)},${zeroY.toFixed(1)} L${x(0).toFixed(1)},${zeroY.toFixed(1)} Z`;
  const ink = chartInk();
  const horizontal = ticks.map(tick => `<line x1="${padL}" x2="${width-padR}" y1="${y(tick).toFixed(1)}" y2="${y(tick).toFixed(1)}" stroke="${ink.line}" stroke-width="1"></line>`).join("");
  const labels = ticks.map(tick => `<text x="${padL-8}" y="${(y(tick)+4).toFixed(1)}" text-anchor="end" fill="${ink.muted}" font-size="11">${axisTick(tick,step,true)}</text>`).join("");
  const marks=[], stride=Math.max(1,Math.ceil((points.length-1)/6));
  for(let i=0;i<points.length;i+=stride) marks.push(i);
  if(marks[marks.length-1]!==points.length-1) marks.push(points.length-1);
  const vertical=marks.map(i=>`<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${padT}" y2="${height-padB}" stroke="${ink.line}" stroke-width="1"></line>`).join("");
  const xLabels=marks.map(i=>`<text x="${x(i).toFixed(1)}" y="${height-7}" text-anchor="middle" fill="${ink.muted}" font-size="10">${esc(new Date(points[i].time*1000).toLocaleDateString(undefined,{month:"short",day:"numeric"}))}</text>`).join("");
  return `<svg class="chart growth-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Growth and drawdown">
    <rect x="${padL}" y="${padT}" width="${width-padL-padR}" height="${height-padT-padB}" fill="${ink.flat}" fill-opacity="0.18"></rect>
    ${horizontal}${vertical}<line x1="${padL}" x2="${width-padR}" y1="${zeroY}" y2="${zeroY}" stroke="${ink.muted}" stroke-opacity="0.7" stroke-dasharray="4 3"></line>
    ${labels}${xLabels}<path d="${fill}" fill="${ink.loss}" opacity="0.22"></path>
    <path d="${drawdown}" fill="none" stroke="${ink.loss}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
    <path d="${growth}" fill="none" stroke="${ink.growth}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path>
    <line id="chart-guide" visibility="hidden" stroke="${ink.accent}" stroke-width="1" y1="${padT}" y2="${height-padB}"></line>
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
    hiddenStamp(),
    trades.map((trade) => `${trade.key}:${trade.net.toFixed(2)}`).join(","),
    flows.map((flow) => `${flow.time}:${flow.amount.toFixed(2)}`).join(","),
  ].join("|");
  if (stamp === reviewStamp && $("growth-chart").childElementCount) return;
  reviewStamp = stamp;
  const curve = buildCurve(trades, flows, startBalance, start);
  const stats = myfxbookStats(trades, flows, curve);
  const R = (value) => amount("review", value);
  const B = (value) => amount("balance", value);
  const won = (count, rate) => (count ? `${count} (${rate == null ? "—" : `${rate.toFixed(0)}%`} won)` : "—");
  $("growth-chart").innerHTML = growthChart(curve.points);
  $("review-stats").innerHTML = [
    `<div class="fx-label">Summary</div>`,
    fxRow("Gain", signedPct(stats.gain), tone(stats.gain)),
    fxRow("Profit", R(stats.net), tone(stats.net)),
    fxRow("Balance", B(balance)),
    fxRow("Equity", B(equity), tone(equity - balance)),
    fxRow("Deposits", B(stats.deposits)),
    fxRow("Withdrawals", B(stats.withdrawals), tone(stats.withdrawals)),
    fxRow("Interest", B(stats.interest), tone(stats.interest)),
    `<div class="fx-label">Drawdown</div>`,
    fxRow("Max drawdown", signedPct(-stats.maxDd), stats.maxDd ? "loss" : ""),
    fxRow(showXcd && xcdRate() !== 1 ? "Max drawdown XCD" : "Max drawdown $", R(-stats.maxDdMoney), stats.maxDdMoney ? "loss" : ""),
    fxRow("Recovery factor", factorText(stats.recovery)),
    fxRow("Absolute drawdown", R(curve.absoluteDd), curve.absoluteDd ? "loss" : ""),
    `<div class="fx-label">Trades</div>`,
    fxRow("Trades", String(stats.trades)),
    fxRow("Profitability", stats.profitability == null ? "—" : `${stats.profitability.toFixed(1)}%`),
    fxRow("Lots", stats.lots.toFixed(2)),
    fxRow("Commissions", R(stats.commissions), tone(stats.commissions)),
    fxRow("Swap", R(stats.swap), tone(stats.swap)),
    fxRow("Gross profit", R(stats.grossProfit), "gain"),
    fxRow("Gross loss", R(-stats.grossLoss), stats.grossLoss ? "loss" : ""),
    fxRow("Profit factor", factorText(stats.profitFactor)),
    fxRow("Expected payoff", stats.expectancy == null ? "—" : R(stats.expectancy), tone(stats.expectancy)),
    fxRow("Average win", stats.avgWin == null ? "—" : R(stats.avgWin), "gain"),
    fxRow("Average loss", stats.avgLoss == null ? "—" : R(stats.avgLoss), "loss"),
    fxRow("Longs won", won(stats.longs, stats.longsWon)),
    fxRow("Shorts won", won(stats.shorts, stats.shortsWon)),
    fxRow("Best trade", stats.best ? `${stats.best.symbol} ${R(stats.best.net)}` : "—", "gain"),
    fxRow("Worst trade", stats.worst ? `${stats.worst.symbol} ${R(stats.worst.net)}` : "—", "loss"),
    fxRow("Max consecutive wins", String(stats.maxWins)),
    fxRow("Max consecutive losses", String(stats.maxLosses)),
    fxRow("Average trade length", durationText(stats.holdSeconds)),
    `<div class="fx-label">Ratios</div>`,
    fxRow("Standard deviation", stats.stdev == null ? "—" : R(stats.stdev)),
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
  const nowDate = new Date();
  const chartDays = view.year === nowDate.getFullYear() && view.month === nowDate.getMonth()
    ? days.slice(0, nowDate.getDate()) : days;
  const stamp = `${view.year}-${view.month}|${filters.account}|${filters.day}|${curveMode}|${hiddenStamp()}|${days.map((day) => `${day.net.toFixed(2)}:${day.count}`).join(",")}`;
  if (stamp === dashStamp) return;
  dashStamp = stamp;
  const monthNet = days.reduce((sum, day) => sum + day.net, 0);
  const label = new Date(view.year, view.month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  $("month-label").textContent = label;
  $("month-net").textContent = amount("pnl", monthNet);
  $("month-net").className = `month-net ${tone(monthNet)}`;
  const now = new Date();
  $("month-next").disabled = view.year > now.getFullYear() || (view.year === now.getFullYear() && view.month >= now.getMonth());
  $("calendar").innerHTML = calendarHtml(days);
  $("daily-bars").innerHTML = dailyBars(chartDays);
  $("curve").innerHTML = curveSvg(chartDays);
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
    const profit = traded ? `<span class="p ${tone(day.net)}">${amount("calendar", day.net)}</span><span class="c">${day.count} trade${day.count === 1 ? "" : "s"}</span>` : "";
    const spoken = traded ? `${day.key} ${isHidden("calendar") ? "amount hidden" : money(day.net)}` : day.key;
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

// Axis bounds and ticks land on multiples of 5 (0.5 / 2.5 only for very small ranges).
function niceScale(low, high) {
  const span = Math.max(high - low, 0);
  const steps = span < 10
    ? [0.5, 2.5, 5, 10]
    : [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000, 2500000, 5000000];
  const step = steps.find((item) => span / item <= 6) || steps[steps.length - 1];
  let min = Math.floor(low / step + 1e-9) * step;
  let max = Math.ceil(high / step - 1e-9) * step;
  if (high > 0 && max - high < step * 0.1) max += step;
  if (low < 0 && low - min < step * 0.1) min -= step;
  if (max <= min) max = min + step;
  const ticks = [];
  for (let value = min; value <= max + step / 1000; value += step) ticks.push(Math.round(value / step) * step);
  return { min, max, step, ticks };
}

function axisTick(value, step, percent) {
  if (Math.abs(value) < 1e-9) return percent ? "0%" : "0";
  const body = Math.abs(value).toFixed(Number.isInteger(step) ? 0 : 1) + (percent ? "%" : "");
  return (value < 0 ? "−" : percent ? "" : "+") + body;
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
    return `<g><title>${day.key}: ${isHidden("charts") ? "amount hidden" : money(day.net)}</title><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${heightPx.toFixed(1)}" rx="2" fill="${color}"></rect>${tick}</g>`;
  }).join("");
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Profit for each day of the month">
    <line x1="${padX}" x2="${width - padX}" y1="${zero}" y2="${zero}" stroke="${ink.line}"></line>
    ${bars}
  </svg>`;
}

function curveSvg(days) {
  const rawPoints = runningTotal(days);
  const balanceBase = scopedAccounts().reduce((sum, account) => sum + Number(account.balance || 0), 0);
  const divisor = balanceBase > 0 ? balanceBase : 1;
  const percent = curveMode === "percent";
  const points = percent ? rawPoints.map((value) => (value / divisor) * 100) : rawPoints;
  const dayValues = percent ? days.map((day) => ({ ...day, net: (day.net / divisor) * 100 })) : days;
  if (points.length < 2 || points.every((point) => point === 0)) {
    curveModel = null;
    return `<p class="sub">The cumulative line fills in as the month gets closed trades.</p>`;
  }
  // Draw at the card's real width so the box and grid fill it and the text stays 1:1.
  const width = Math.max(300, Math.min(Math.round($("curve").clientWidth) || 360, 1000));
  const height = Math.round(Math.min(300, Math.max(200, width * 0.5)));
  const padL = 54;
  const padR = 14;
  const padT = 14;
  const padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const scale = niceScale(Math.min(0, ...points), Math.max(0, ...points));
  const { min, max } = scale;
  const x = (index) => padL + (index / (points.length - 1)) * plotW;
  const y = (value) => padT + (1 - (value - min) / (max - min)) * plotH;
  const line = smoothPath(points.map((value,index) => [x(index),y(value)]));
  const fill = `${line} L${x(points.length - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;
  const ink = chartInk();
  const color = points[points.length - 1] >= 0 ? ink.gain : ink.loss;
  const masked = isHidden("charts") && !percent;

  const horizontal = scale.ticks.map((tick) => `<line x1="${padL}" x2="${width - padR}" y1="${y(tick).toFixed(1)}" y2="${y(tick).toFixed(1)}" stroke="${ink.line}" stroke-width="1"></line>`).join("");
  const yLabels = scale.ticks.map((tick) => `<text x="${padL - 8}" y="${(y(tick) + 4).toFixed(1)}" text-anchor="end" fill="${ink.muted}" font-size="12">${masked ? "•••" : axisTick(tick, scale.step, percent)}</text>`).join("");

  const marks = [];
  days.forEach((day, index) => { if (day.day === 1 || day.day % 5 === 0) marks.push(index); });
  const lastIndex = days.length - 1;
  if (!marks.length || lastIndex - marks[marks.length - 1] >= 3) marks.push(lastIndex);
  const vertical = marks.map((index) => `<line x1="${x(index).toFixed(1)}" x2="${x(index).toFixed(1)}" y1="${padT}" y2="${padT + plotH}" stroke="${ink.line}" stroke-width="1"></line>`).join("");
  const xLabels = marks.map((index) => `<text x="${x(index).toFixed(1)}" y="${height - 8}" text-anchor="middle" fill="${ink.muted}" font-size="12">${days[index].day}</text>`).join("");

  const last = points[points.length - 1];
  const spoken = percent ? `${last >= 0 ? "+" : ""}${last.toFixed(2)}%` : (masked ? "hidden" : money(last));
  curveModel = { days: dayValues, points, rawPoints, width, height, padL, padR, padT, padB, divisor, mode: curveMode };
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Cumulative closed ${percent ? "percentage" : "profit"}, ending at ${spoken}">
    <rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="${ink.flat}" fill-opacity="0.4"></rect>
    ${horizontal}
    ${vertical}
    <line x1="${padL}" x2="${width - padR}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="${ink.muted}" stroke-opacity="0.65" stroke-dasharray="4 3"></line>
    ${yLabels}
    ${xLabels}
    <path d="${fill}" fill="${color}" opacity="0.18"></path>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"></path>
    <circle cx="${x(points.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="3.5" fill="${color}"></circle>
    <rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="none" stroke="${ink.muted}" stroke-opacity="0.6" stroke-width="1.25"></rect>
    <line id="curve-guide" visibility="hidden" stroke="${ink.accent}" stroke-width="1" y1="${padT}" y2="${padT + plotH}"></line>
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
  const rawValue = curveModel.rawPoints[index];
  const pctValue = (rawValue / curveModel.divisor) * 100;
  const cumulativeLabel = curveModel.mode === "percent" ? `${pctValue >= 0 ? "+" : ""}${pctValue.toFixed(2)}%` : amount("charts", rawValue);
  const dayLabel = curveModel.mode === "percent" ? `${day.net >= 0 ? "+" : ""}${day.net.toFixed(2)}%` : amount("charts", day.net);
  tip.innerHTML = `<strong>${esc(whenLabel)}</strong><span>Cumulative ${esc(cumulativeLabel)}</span><span>Day ${esc(dayLabel)}</span>`;
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
    return `<div class="hbar"><span>${esc(name)}</span><span class="track"><span class="fill ${tone(row.net)}" style="width:${width.toFixed(1)}%"></span></span><span class="num ${tone(row.net)}">${amount("charts", row.net)}</span></div>`;
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
        <td class="num ${tone(row.net)}">${amount("review", row.net)}</td>
      </tr>`).join("")}
    </tbody>
  </table>`;
}


const SESSION_DEFS = [
  { name: "New York", zone: "America/New_York", open: 8, close: 17, city: "New York, USA", kind: "forex" },
  { name: "London", zone: "Europe/London", open: 8, close: 17, city: "London, UK", kind: "forex" },
  { name: "Asia · Tokyo", zone: "Asia/Tokyo", open: 9, close: 18, city: "Tokyo, Japan", kind: "forex" },
  // Gold, NASDAQ and S&P 500 trade 24/5 (Sunday 17:00 to Friday 17:00 New York), not on COMEX or cash-exchange hours.
  { name: "Gold", zone: "America/New_York", open: 0, close: 24, city: "Gold", kind: "cfd" },
  { name: "NASDAQ", zone: "America/New_York", open: 0, close: 24, city: "NASDAQ", kind: "cfd" },
  { name: "S&P 500", zone: "America/New_York", open: 0, close: 24, city: "S&P 500", kind: "cfd" },
];

function zonedParts(date, zone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(date);
  const out = {};
  for (const part of parts) if (part.type !== "literal") out[part.type] = part.value;
  return { weekday: out.weekday, year: +out.year, month: +out.month, day: +out.day, hour: +out.hour, minute: +out.minute };
}
function easterSunday(year) {
  const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),month=Math.floor((h+l-7*m+114)/31),day=((h+l-7*m+114)%31)+1;
  return new Date(Date.UTC(year, month-1, day));
}
function nthWeekday(year, monthIndex, weekday, nth) {
  const first = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7;
}
function lastWeekday(year, monthIndex, weekday) {
  const last = new Date(Date.UTC(year, monthIndex + 1, 0));
  return last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7);
}
function isMarketHoliday(parts, sessionName) {
  const {year,month,day}=parts;
  const dateKey=`${year}-${month}-${day}`;
  const easter=easterSunday(year);
  const goodFriday=new Date(easter.getTime()-2*86400000);
  const easterMonday=new Date(easter.getTime()+86400000);
  const key=(d)=>`${d.getUTCFullYear()}-${d.getUTCMonth()+1}-${d.getUTCDate()}`;
  if (dateKey===`${year}-1-1` || dateKey===`${year}-12-25` || dateKey===`${year}-12-26` || dateKey===key(goodFriday)) return true;
  if (sessionName === "New York") {
    const usDates = [
      `1-${nthWeekday(year,0,1,3)}`, `2-${nthWeekday(year,1,1,3)}`,
      `5-${lastWeekday(year,4,1)}`, `6-19`, `7-4`,
      `9-${nthWeekday(year,8,1,1)}`, `11-${nthWeekday(year,10,4,4)}`
    ];
    if (usDates.includes(`${month}-${day}`)) return true;
  }
  if (sessionName === "London") {
    const ukDates = [`${easterMonday.getUTCMonth()+1}-${easterMonday.getUTCDate()}`, `5-${nthWeekday(year,4,1,1)}`, `5-${lastWeekday(year,4,1)}`, `8-${lastWeekday(year,7,1)}`];
    if (ukDates.includes(`${month}-${day}`)) return true;
  }
  if (sessionName === "Asia · Tokyo" && (month===1&&day===1 || month===2&&day===11 || month===2&&day===23 || month===4&&day===29 || month===5&&[3,4,5].includes(day) || month===8&&day===11 || month===11&&day===3 || month===11&&day===23)) return true;
  return false;
}
function forexWeekend(now) {
  const ny=zonedParts(now,"America/New_York");
  const minutes=ny.hour*60+ny.minute;
  return (ny.weekday==="Fri" && minutes>=17*60) || ny.weekday==="Sat" || (ny.weekday==="Sun" && minutes<17*60);
}
function sessionStatus(def, now) {
  const parts=zonedParts(now,def.zone);
  if (forexWeekend(now)) return { status:"Weekend", parts };
  if (def.kind === "cfd") {
    const closedDay = (parts.month === 1 && parts.day === 1) || (parts.month === 12 && parts.day === 25);
    return { status: closedDay ? "Holiday" : "Open", parts };
  }
  if (isMarketHoliday(parts,def.name)) return { status:"Holiday", parts };
  const hour=parts.hour+parts.minute/60;
  if (hour>=def.open && hour<def.close) return {status:"Open",parts};
  const preOpen = def.kind === "equity" ? 4 : def.open - 1;
  const postClose = def.kind === "equity" ? 20 : def.close + 1;
  if (hour>=preOpen && hour<def.open) return {status:"Pre Market",parts};
  if (hour>=def.close && hour<postClose) return {status:"Post Market",parts};
  return {status:"Closed",parts};
}
function timezoneOffsetMinutes(date, zone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit", hourCycle:"h23" }).formatToParts(date);
  const values={}; for (const part of parts) if(part.type!=="literal") values[part.type]=Number(part.value);
  return (Date.UTC(values.year,values.month-1,values.day,values.hour,values.minute,values.second)-date.getTime())/60000;
}
function renderSessionClocks() {
  const now=new Date();
  const openCount=SESSION_DEFS.filter(def=>sessionStatus(def,now).status==="Open").length;
  const localOffset=-now.getTimezoneOffset();
  const localHour=now.getHours()+now.getMinutes()/60;
  const labelOffset=window.matchMedia("(max-width: 800px)").matches?95:118;
  const hourLabels=Array.from({length:24},(_,i)=>`<span>${String(i).padStart(2,"0")}</span>`).join("");
  $("session-market-status").textContent=forexWeekend(now)?"Forex market · Weekend closure":`${openCount} of ${SESSION_DEFS.length} markets open`;
  const rows=SESSION_DEFS.map(def=>{
    const {status}=sessionStatus(def,now);
    const zoneOffset=timezoneOffsetMinutes(now,def.zone);
    const shift=(localOffset-zoneOffset)/60;
    let left=((def.open+shift)%24+24)%24;
    let width=def.close-def.open;
    const firstWidth=Math.min(width,24-left);
    const secondWidth=width-firstWidth;
    const colorClass = def.name==="New York"?"new-york":def.name==="London"?"london":def.name==="Asia · Tokyo"?"asia":def.name.startsWith("Gold")?"gold":def.name==="NASDAQ"?"nasdaq":"sp500";
    const always = def.kind === "cfd";
    const bar = always
      ? `<span class="session-bar ${colorClass}${status === "Open" ? "" : " idle"}" style="left:.4%;width:99.2%"></span>`
      : `<span class="session-bar ${colorClass}" style="left:${left/24*100}%;width:${firstWidth/24*100}%"></span>${secondWidth>0?`<span class="session-bar ${colorClass}" style="left:0;width:${secondWidth/24*100}%"></span>`:""}`;
    const time=new Intl.DateTimeFormat(undefined,{timeZone:def.zone,hour:"2-digit",minute:"2-digit",hour12:true}).format(now);
    const date=new Intl.DateTimeFormat(undefined,{timeZone:def.zone,weekday:"short",month:"short",day:"numeric"}).format(now);
    const city=def.name==="Asia · Tokyo"?"Tokyo":def.name;
    const marketLabel = city;
    return `<div class="session-row"><div class="session-city"><strong>${esc(marketLabel)}</strong><span class="session-pill ${status.toLowerCase().replace(/\s+/g,"-")}">${esc(status)}</span><small>${always ? "24/5 · Mon–Fri" : `${time} · ${date}`}</small></div><div class="session-track" aria-label="${esc(city)} session hours on a 24 hour local timeline">${bar}</div></div>`;
  }).join("");
  $("session-clocks").innerHTML=`<div class="session-timeline"><div class="timeline-spacer"></div><div class="timeline-hours">${hourLabels}</div></div><div class="session-rows">${rows}</div><div class="session-now" style="left:calc(${localHour/24*100}% + ${labelOffset*(1-localHour/24)}px)" aria-hidden="true"><span>NOW</span></div><div class="session-legend"><span><i class="legend-dot asia"></i>Asia / Tokyo</span><span><i class="legend-dot london"></i>London</span><span><i class="legend-dot new-york"></i>New York</span><span><i class="legend-dot gold"></i>Gold</span><span><i class="legend-dot nasdaq"></i>NASDAQ</span><span><i class="legend-dot sp500"></i>S&amp;P 500</span><span class="session-local-zone">${esc(Intl.DateTimeFormat().resolvedOptions().timeZone||"Local time")}</span></div>`;
}
function sessionForTrade(unix) {
  const date=new Date(unix*1000);
  const ny=zonedParts(date,"America/New_York"), london=zonedParts(date,"Europe/London"), tokyo=zonedParts(date,"Asia/Tokyo");
  if(ny.hour>=8&&ny.hour<17) return "New York";
  if(london.hour>=8&&london.hour<17) return "London";
  if(tokyo.hour>=9&&tokyo.hour<18) return "Asia";
  return "Off-hours";
}
function insightBarChart(rows, formatter=(value)=>amount("insights",value)) {
  if(!rows.length || !rows.some(row=>row.count)) return `<p class="sub">No closed trades available for this grouping.</p>`;
  const max=Math.max(...rows.map(row=>Math.abs(row.net)),0.01);
  return `<div class="insight-bars">${rows.map(row=>{const width=Math.max(1,Math.abs(row.net)/max*50);const left=row.net<0?50-width:50;return `<div class="insight-bar-row"><span class="insight-label">${esc(row.label)}</span><div class="insight-track"><i class="insight-fill ${tone(row.net)}" style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%"></i></div><strong class="insight-value ${tone(row.net)}">${formatter(row.net)}</strong><small>${row.count} trade${row.count===1?"":"s"}</small></div>`;}).join("")}</div>`;
}
function renderInsights() {
  const closed=accountTrades().filter(t=>t.status==="closed"&&t.close_time);
  $("insights-count").textContent=`${closed.length} closed trades`;
  const weekdays=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].map(label=>({label,net:0,count:0}));
  const sessions=["Asia","London","New York","Off-hours"].map(label=>({label,net:0,count:0}));
  const buckets=Array.from({length:6},(_,i)=>({label:`${String(i*4).padStart(2,"0")}:00–${String(i*4+4).padStart(2,"0")}:00`,net:0,count:0}));
  for(const trade of closed){
    const close=new Date(trade.close_time*1000); const weekday=weekdays[close.getDay()]; weekday.net+=Number(trade.net||0);weekday.count++;
    const session=sessions.find(row=>row.label===sessionForTrade(trade.open_time||trade.close_time));session.net+=Number(trade.net||0);session.count++;
    const hour=new Date(trade.open_time*1000).getHours();const bucket=buckets[Math.min(5,Math.floor(hour/4))];bucket.net+=Number(trade.net||0);bucket.count++;
  }
  $("weekday-insight").innerHTML=insightBarChart(weekdays);
  $("session-insight").innerHTML=insightBarChart(sessions);
  $("time-insight").innerHTML=insightBarChart(buckets);
}

async function refresh() {
  try {
    const response = await fetch("/api/state");
    if (!response.ok) throw new Error(String(response.status));
    state = await response.json();
    if (filters.account !== "all" && !state.accounts.some(a => accountKey(a) === filters.account)) {
      filters.account = "all";
      localStorage.setItem("journal-account", "all");
    }
    renderStatus();
    renderAccountSwitch();
    syncCurrencySwitch();
    renderMetrics();
    renderTerminals();
    renderSessionClocks();
    renderInsights();
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
  syncPrivacyControls();
  syncCurrencySwitch();
  document.addEventListener("click", (event) => {
    const cur = event.target.closest("button[data-currency]");
    if (cur) {
      setCurrency(cur.dataset.currency === "XCD");
      return;
    }
    const eye = event.target.closest("[data-eye-page]");
    if (eye) {
      togglePage(eye.dataset.eyePage);
      return;
    }
    const toggle = event.target.closest("[data-hide-key]");
    if (toggle) toggleKey(toggle.dataset.hideKey);
  });
  $("cumulative-mode").addEventListener("change", (event) => {
    curveMode = event.target.value === "percent" ? "percent" : "profit";
    localStorage.setItem("journal-cumulative-mode", curveMode);
    dashStamp = "";
    renderDashboard();
  });
  $("theme-select").addEventListener("change", (event) => {
    setAppearance(event.target.value, modePreference());
  });
  $("mode-switch").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-mode]");
    if (!button || button.disabled) return;
    setAppearance(document.documentElement.dataset.theme || "dracula", button.dataset.mode);
  });
  $("review-period").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-period]");
    if (!button || button.dataset.period === reviewPeriod) return;
    reviewPeriod = button.dataset.period;
    localStorage.setItem("journal-review-period", reviewPeriod);
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
  // A fresh open of the app always starts on Overview, even if the browser restored
  // an old #settings link. Reloading the same tab keeps the page you were on.
  let opened = false;
  try { opened = sessionStorage.getItem("journal-opened") === "1"; sessionStorage.setItem("journal-opened", "1"); } catch (error) {}
  if (!opened && location.hash && location.hash !== "#overview") {
    history.replaceState(null, "", location.pathname + location.search);
  }
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
renderSessionClocks();
setInterval(renderSessionClocks, 1000);
setInterval(refresh, 3000);
