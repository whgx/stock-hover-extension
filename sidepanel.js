/**
 * sidepanel.js (v8.0) — Chrome Side Panel 侧边栏
 * 常驻浏览器右侧，不离开当前页面看行情
 * Tab: 自选股 / 持仓 / 指数
 */
let currentTab = "watch";
let refreshTimer = null;

function sendMsg(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(resp);
      });
    } catch (e) { resolve(null); }
  });
}

function safe(v, d = 2) {
  if (v == null || isNaN(v)) return "--";
  return Number(v).toFixed(d);
}
function fmtMoney(v) {
  if (v == null || isNaN(v)) return "--";
  const abs = Math.abs(v); const s = v >= 0 ? "+" : "";
  if (abs >= 1e8) return s + (v / 1e8).toFixed(2) + "亿";
  if (abs >= 1e4) return s + (v / 1e4).toFixed(2) + "万";
  return s + v.toFixed(0);
}
function cls(pct) { return pct > 0 ? "up" : pct < 0 ? "down" : ""; }
function sign(v) { return v >= 0 ? "+" : ""; }

function isMarketOpen() {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  return (t >= 565 && t <= 690) || (t >= 780 && t <= 900);
}

function updateClock() {
  const el = document.getElementById("clockBar");
  if (!el) return;
  const now = new Date();
  const time = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  const open = isMarketOpen();
  el.innerHTML = time + '<span class="market-status ' + (open ? "open" : "closed") + '">' + (open ? "● 交易中" : "○ 已休市") + "</span>";
}

async function loadWatch() {
  const c = document.getElementById("content");
  const resp = await sendMsg({ action: "getWatchlistQuotes" });
  if (!resp || !resp.success) { c.innerHTML = '<div class="empty">加载失败</div>'; return; }
  const list = resp.data ?? [];
  const badge = document.getElementById("watchBadge");
  if (badge) { badge.textContent = list.length; badge.style.display = list.length > 0 ? "" : "none"; }
  if (list.length === 0) { c.innerHTML = '<div class="empty"><div class="empty-icon">⭐</div>暂无自选股</div>'; return; }
  c.innerHTML = list.map((s) => {
    const cl = cls(s.changePercent);
    return '<div class="stock-row" data-secid="' + s.secid + '" data-name="' + s.name + '" data-code="' + s.code + '">' +
      '<div><div class="stock-name">' + s.name + '</div><div class="stock-code">' + s.code + '</div></div>' +
      '<span class="stock-price ' + cl + '">' + safe(s.price) + '</span>' +
      '<span class="stock-pct ' + cl + '">' + sign(s.changePercent) + safe(s.changePercent) + '%</span>' +
      '</div>';
  }).join("");
}

async function loadPortfolio() {
  const c = document.getElementById("content");
  const resp = await sendMsg({ action: "getPortfolioQuotes" });
  if (!resp || !resp.success) { c.innerHTML = '<div class="empty">加载失败</div>'; return; }
  const positions = resp.data ?? [];
  if (positions.length === 0) { c.innerHTML = '<div class="empty"><div class="empty-icon">💼</div>暂无持仓</div>'; return; }
  let totalCost = 0, totalMV = 0;
  positions.forEach((p) => { totalCost += (p.avgCost || 0) * (p.quantity || 0); totalMV += (p.price || 0) * (p.quantity || 0); });
  const totalPnL = totalMV - totalCost;
  const pnlPct = totalCost > 0 ? (totalPnL / totalCost * 100) : 0;
  const pc = totalPnL >= 0 ? "up" : "down";
  let html = '<div class="summary">';
  html += '<div class="summary-row"><span class="summary-label">总市值</span><span class="summary-val">' + fmtMoney(totalMV) + '</span></div>';
  html += '<div class="summary-row"><span class="summary-label">总盈亏</span><span class="summary-val ' + pc + '">' + sign(totalPnL) + fmtMoney(Math.abs(totalPnL)) + '</span></div>';
  html += '<div class="summary-row"><span class="summary-label">收益率</span><span class="summary-val ' + pc + '">' + sign(pnlPct) + pnlPct.toFixed(2) + '%</span></div>';
  html += '</div>';
  html += positions.map((p) => {
    const pnl = (p.price - p.avgCost) * p.quantity;
    const cl = pnl >= 0 ? "up" : "down";
    return '<div class="stock-row"><div><div class="stock-name">' + p.name + '</div><div class="stock-code">' + p.quantity + ' @ ' + safe(p.avgCost) + '</div></div><span class="stock-price">' + safe(p.price) + '</span><span class="stock-pct ' + cl + '">' + sign(pnl) + fmtMoney(Math.abs(pnl)) + '</span></div>';
  }).join("");
  c.innerHTML = html;
}

async function loadIndex() {
  const c = document.getElementById("content");
  const resp = await sendMsg({ action: "getMarketIndices" });
  if (!resp || !resp.success || !resp.data) { c.innerHTML = '<div class="empty">加载失败</div>'; return; }
  c.innerHTML = resp.data.map((idx) => {
    const cl = cls(idx.pct);
    return '<div class="stock-row"><div><div class="stock-name">' + idx.name + '</div></div><span class="stock-price ' + cl + '">' + safe(idx.price) + '</span><span class="stock-pct ' + cl + '">' + sign(idx.pct) + safe(idx.pct) + '%</span></div>';
  }).join("");
}

function loadTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".stab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  if (tab === "watch") loadWatch();
  if (tab === "portfolio") loadPortfolio();
  if (tab === "index") loadIndex();
}

// ═══ 初始化 ═══
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".stab").forEach((t) => t.addEventListener("click", () => loadTab(t.dataset.tab)));
  document.getElementById("btnOpenDash").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  });

  updateClock();
  loadTab("watch");
  setInterval(updateClock, 60000);
  // 盘中自动刷新
  refreshTimer = setInterval(() => {
    if (isMarketOpen()) loadTab(currentTab);
  }, 5000);
});
