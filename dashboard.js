/**
 * dashboard.js (v5.0) — 全屏投资工作台
 * 功能：大盘指数 / 市场情绪 / 日K线图 / 板块热力图 / 自选股网格 / 持仓盈亏 / 预警 / 股票详情侧栏
 */

// ═══ 全局状态 ═══
let currentKlineSecid = "1.000001"; // 默认显示上证指数K线
let currentKlinePeriod = 101;
let searchDebounce = null;
let searchResults = [];
let searchHlIdx = -1;
let refreshTimer = null;

// ═══ 工具函数 ═══
function safe(v, d = 2) {
  if (v == null || isNaN(v)) return "--";
  return Number(v).toFixed(d);
}

function fmtVol(v) {
  if (v == null || isNaN(v)) return "--";
  if (v >= 1e8) return (v / 1e8).toFixed(2) + "亿";
  if (v >= 1e4) return (v / 1e4).toFixed(2) + "万";
  return v.toString();
}

function fmtAmt(v) {
  if (v == null || isNaN(v)) return "--";
  if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(2) + "亿";
  if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(2) + "万";
  return v.toFixed(0);
}

function fmtMoney(v) {
  if (v == null || isNaN(v)) return "--";
  const abs = Math.abs(v);
  const sign = v >= 0 ? "+" : "";
  if (abs >= 1e8) return sign + (v / 1e8).toFixed(2) + "亿";
  if (abs >= 1e4) return sign + (v / 1e4).toFixed(2) + "万";
  return sign + v.toFixed(0);
}

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

// 涨跌颜色
function cls(pct) {
  if (pct > 0) return "up";
  if (pct < 0) return "down";
  return "";
}
function sign(v) { return v >= 0 ? "+" : ""; }

// 涨跌幅 → 背景色（用于热力图）
function heatColor(pct) {
  const p = Math.max(-5, Math.min(5, pct));
  if (p >= 0) {
    const a = 0.25 + (p / 5) * 0.75;
    return `rgba(232,73,62,${a.toFixed(2)})`;
  } else {
    const a = 0.25 + (Math.abs(p) / 5) * 0.75;
    return `rgba(0,168,112,${a.toFixed(2)})`;
  }
}

// ═══ 初始化 ═══
document.addEventListener("DOMContentLoaded", () => {
  loadIndices();
  loadSentiment();
  loadSectors();
  loadWatchlist();
  loadPortfolio();
  loadAlerts();
  loadKline(currentKlineSecid);

  // 全局搜索
  const inp = document.getElementById("globalSearch");
  inp.addEventListener("input", () => {
    const kw = inp.value.trim();
    if (!kw) { hideDropdown(); return; }
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => doSearch(kw), 250);
  });
  inp.addEventListener("keydown", (e) => {
    const dd = document.getElementById("searchDropdown");
    if (!dd.classList.contains("show")) {
      if (e.key === "Enter" && inp.value.trim()) doSearch(inp.value.trim());
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      searchHlIdx = Math.min(searchHlIdx + 1, searchResults.length - 1);
      renderDropdown();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      searchHlIdx = Math.max(searchHlIdx - 1, 0);
      renderDropdown();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (searchHlIdx >= 0 && searchResults[searchHlIdx]) selectStock(searchResults[searchHlIdx]);
    } else if (e.key === "Escape") hideDropdown();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".topbar-center")) hideDropdown();
  });

  // 刷新按钮
  document.getElementById("refreshAll").addEventListener("click", () => {
    loadIndices(); loadSentiment(); loadSectors();
    loadWatchlist(); loadPortfolio(); loadAlerts();
    loadKline(currentKlineSecid);
  });

  // K线周期切换
  document.querySelectorAll(".kltab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".kltab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      currentKlinePeriod = parseInt(tab.dataset.period);
      loadKline(currentKlineSecid);
    });
  });

  // 详情关闭
  document.getElementById("detailClose").addEventListener("click", () => {
    document.getElementById("detailPanel").style.display = "none";
  });

  // 定时刷新（30秒）
  refreshTimer = setInterval(() => {
    loadIndices();
    loadWatchlist();
    loadPortfolio();
  }, 30000);
});

// ═══ 搜索 ═══
async function doSearch(kw) {
  const dd = document.getElementById("searchDropdown");
  dd.innerHTML = '<div style="padding:12px;text-align:center;color:#888">搜索中…</div>';
  dd.classList.add("show");
  searchHlIdx = -1;
  const resp = await sendMsg({ action: "searchList", keyword: kw });
  if (!resp || !resp.success) { dd.innerHTML = '<div style="padding:12px;text-align:center;color:#888">搜索失败</div>'; return; }
  searchResults = resp.data ?? [];
  renderDropdown();
}

function renderDropdown() {
  const dd = document.getElementById("searchDropdown");
  if (searchResults.length === 0) {
    dd.innerHTML = '<div style="padding:12px;text-align:center;color:#888">未找到匹配的股票</div>';
    return;
  }
  dd.innerHTML = searchResults.map((item, idx) => `
    <div class="search-item${idx === searchHlIdx ? " highlighted" : ""}" data-idx="${idx}">
      <span class="search-item-name">${item.name}</span>
      <span class="search-item-code">${item.code}</span>
      ${item.marketType ? `<span class="search-item-market">${item.marketType}</span>` : ""}
    </div>
  `).join("");
  dd.querySelectorAll(".search-item").forEach((el) => {
    el.addEventListener("click", () => {
      const idx = parseInt(el.dataset.idx);
      if (searchResults[idx]) selectStock(searchResults[idx]);
    });
  });
}

function hideDropdown() {
  document.getElementById("searchDropdown").classList.remove("show");
  searchHlIdx = -1;
}

function selectStock(item) {
  hideDropdown();
  document.getElementById("globalSearch").value = "";
  // 加载K线
  currentKlineSecid = item.secid;
  loadKline(item.secid, item.name);
  // 打开详情侧栏
  openDetail(item.secid, item.name, item.code);
}

// ═══ 大盘指数 ═══
async function loadIndices() {
  const bar = document.getElementById("indexBar");
  const resp = await sendMsg({ action: "getMarketIndices" });
  if (!resp || !resp.success || !resp.data || resp.data.length === 0) {
    bar.innerHTML = '<div class="index-loading">指数数据获取失败，稍后自动重试</div>';
    return;
  }
  bar.innerHTML = resp.data.map((idx) => {
    const c = cls(idx.pct);
    return `
      <div class="index-item" data-secid="${idx.secid}">
        <div class="index-name">${idx.name}</div>
        <div class="index-price ${c}">${safe(idx.price)}</div>
        <div class="index-pct ${c}">${sign(idx.pct)}${safe(idx.pct)}%</div>
      </div>
    `;
  }).join("");

  bar.querySelectorAll(".index-item").forEach((el) => {
    el.addEventListener("click", () => {
      const secid = el.dataset.secid;
      const name = el.querySelector(".index-name").textContent;
      currentKlineSecid = secid;
      loadKline(secid, name);
    });
  });

  document.getElementById("updateTime").textContent = "更新于 " + new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

// ═══ 市场情绪 ═══
async function loadSentiment() {
  const resp = await sendMsg({ action: "getMarketSentiment" });
  if (!resp || !resp.success || !resp.data) return;
  const d = resp.data;
  document.getElementById("sentimentBar").style.display = "flex";
  document.getElementById("sentUp").textContent = d.up || 0;
  document.getElementById("sentDown").textContent = d.down || 0;
  document.getElementById("sentFlat").textContent = d.flat || 0;
  document.getElementById("sentLimitUp").textContent = d.limitUp || 0;
  document.getElementById("sentLimitDown").textContent = d.limitDown || 0;
}

// ═══ 板块热力图 ═══
async function loadSectors() {
  const container = document.getElementById("sectorHeatmap");
  const resp = await sendMsg({ action: "getSectorData" });
  if (!resp || !resp.success || !resp.data || resp.data.length === 0) {
    container.innerHTML = '<div style="padding:24px;text-align:center;color:#888;width:100%">板块数据获取失败</div>';
    return;
  }

  const sectors = resp.data;
  // 按涨跌幅绝对值排序，大的格子更大
  const maxAbs = Math.max(...sectors.map((s) => Math.abs(s.pct || 0)), 1);

  container.innerHTML = sectors.map((s) => {
    const bg = heatColor(s.pct || 0);
    // 格子宽度根据涨跌幅大小微调
    const flex = 1 + Math.abs(s.pct || 0) / maxAbs * 0.5;
    return `
      <div class="sector-cell" style="background:${bg};flex:${flex.toFixed(2)}" data-code="${s.code}" data-name="${s.name}">
        <div class="sector-cell-name">${s.name}</div>
        <div class="sector-cell-pct">${sign(s.pct || 0)}${safe(s.pct)}%</div>
        ${s.leader ? `<div class="sector-cell-leader">${s.leader} ${s.leaderPct ? sign(s.leaderPct) + safe(s.leaderPct) + "%" : ""}</div>` : ""}
      </div>
    `;
  }).join("");

  document.getElementById("sectorTime").textContent = "更新于 " + new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

// ═══ 自选股网格 ═══
async function loadWatchlist() {
  const container = document.getElementById("watchlistGrid");
  document.getElementById("watchlistCount2").textContent = "";
  const resp = await sendMsg({ action: "getWatchlistQuotes" });
  if (!resp || !resp.success) {
    container.innerHTML = '<div class="watch-empty">加载失败</div>';
    return;
  }
  const list = resp.data ?? [];
  document.getElementById("watchlistCount2").textContent = list.length + " 只";

  if (list.length === 0) {
    container.innerHTML = '<div class="watch-empty">暂无自选股<br><span style="font-size:12px">通过顶部搜索框添加</span></div>';
    return;
  }

  container.innerHTML = list.map((s) => {
    const c = cls(s.changePercent);
    return `
      <div class="watch-item" data-secid="${s.secid}" data-name="${s.name}" data-code="${s.code}">
        <div class="watch-item-name">${s.name}</div>
        <div class="watch-item-price ${c}">${safe(s.price)}</div>
        <div class="watch-item-pct ${c}">${sign(s.changePercent)}${safe(s.changePercent)}%</div>
        <div class="watch-item-code">${s.code}</div>
      </div>
    `;
  }).join("");

  container.querySelectorAll(".watch-item").forEach((el) => {
    el.addEventListener("click", () => {
      const secid = el.dataset.secid;
      const name = el.dataset.name;
      const code = el.dataset.code;
      currentKlineSecid = secid;
      loadKline(secid, name);
      openDetail(secid, name, code);
    });
  });
}

// ═══ 持仓盈亏 ═══
async function loadPortfolio() {
  const summaryEl = document.getElementById("portfolioSummary");
  const detailEl = document.getElementById("portfolioDetail");
  const resp = await sendMsg({ action: "getPortfolioQuotes" });
  if (!resp || !resp.success) {
    summaryEl.innerHTML = '<div style="padding:20px;text-align:center;color:#888">加载失败</div>';
    return;
  }
  const list = resp.data ?? [];
  if (list.length === 0) {
    summaryEl.innerHTML = "";
    detailEl.innerHTML = '<div class="pf-empty">暂无持仓<br><span style="font-size:12px">在 Popup 中添加持仓</span></div>';
    return;
  }

  let totalProfit = 0, totalCost = 0, totalMV = 0;
  list.forEach((p) => {
    totalProfit += p.profit || 0;
    totalCost += p.totalCost || 0;
    totalMV += p.marketValue || 0;
  });
  const totalPct = totalCost > 0 ? (totalProfit / totalCost) * 100 : 0;
  const pcls = totalProfit >= 0 ? "up" : "down";

  summaryEl.innerHTML = `
    <div class="pf-total-label">总盈亏</div>
    <div class="pf-total-val ${pcls}">${sign(totalProfit)}${totalProfit.toFixed(2)}</div>
    <div class="pf-total-pct ${pcls}">${sign(totalPct)}${totalPct.toFixed(2)}%</div>
    <div class="pf-total-detail">市值 ${fmtAmt(totalMV)} · 成本 ${fmtAmt(totalCost)}</div>
  `;

  detailEl.innerHTML = list.map((p) => {
    const c = (p.profit || 0) >= 0 ? "up" : "down";
    return `
      <div class="pf-row" data-secid="${p.secid}" data-name="${p.name}" data-code="${p.code}">
        <div class="pf-row-left">
          <span class="pf-row-name">${p.name}</span>
          <span class="pf-row-detail">${p.quantity}股 @ ${safe(p.costPrice, 3)} · 现价 ${safe(p.currentPrice)}</span>
        </div>
        <div class="pf-row-right">
          <div class="pf-row-profit ${c}">${sign(p.profit)}${(p.profit || 0).toFixed(2)}</div>
          <div class="pf-row-pct ${c}">${sign(p.profitPct)}${(p.profitPct || 0).toFixed(2)}%</div>
        </div>
      </div>
    `;
  }).join("");

  detailEl.querySelectorAll(".pf-row").forEach((el) => {
    el.addEventListener("click", () => {
      const secid = el.dataset.secid;
      const name = el.dataset.name;
      const code = el.dataset.code;
      currentKlineSecid = secid;
      loadKline(secid, name);
      openDetail(secid, name, code);
    });
  });
}

// ═══ 预警列表 ═══
async function loadAlerts() {
  const container = document.getElementById("alertList");
  const resp = await sendMsg({ action: "getAlerts" });
  if (!resp || !resp.success) {
    container.innerHTML = '<div class="alert-empty">加载失败</div>';
    return;
  }
  const alerts = resp.data ?? [];
  if (alerts.length === 0) {
    container.innerHTML = '<div class="alert-empty">暂无预警</div>';
    return;
  }
  const typeLabel = { above: "涨到", below: "跌到", pct: "涨跌幅达" };
  const typeUnit = { above: "元", below: "元", pct: "%" };
  container.innerHTML = alerts.map((a) => `
    <div class="alert-row">
      <div>
        <div class="alert-row-name">${a.name}</div>
        <div class="alert-row-desc">${typeLabel[a.type]} ${a.target}${typeUnit[a.type]}</div>
      </div>
      <span class="alert-row-status ${a.triggered ? "status-triggered" : "status-active"}">${a.triggered ? "已触发" : "监控中"}</span>
    </div>
  `).join("");
}

// ═══ K线图 ═══
async function loadKline(secid, name) {
  const canvas = document.getElementById("klineCanvas");
  const ctx = canvas.getContext("2d");
  const titleEl = document.getElementById("klineTitle");
  const infoEl = document.getElementById("klineInfo");
  titleEl.textContent = (name || "") + " · " + (currentKlinePeriod === 101 ? "日K" : currentKlinePeriod === 102 ? "周K" : "月K");
  infoEl.textContent = "加载中…";

  const resp = await sendMsg({ action: "getKline", secid, count: 120 });
  if (!resp || !resp.success || !resp.data) {
    drawKlineEmpty(canvas, ctx, "暂无K线数据");
    infoEl.textContent = "";
    return;
  }

  const data = resp.data;
  const candles = data.candles;
  if (!candles || candles.length === 0) {
    drawKlineEmpty(canvas, ctx, "无K线数据");
    infoEl.textContent = "";
    return;
  }

  drawKline(canvas, ctx, candles, data.ma5, data.ma10, data.ma20);

  const last = candles[candles.length - 1];
  infoEl.innerHTML = `
    <span>日期: ${last.date}</span>
    <span class="${cls(last.open - last.close)}">开: ${last.open.toFixed(2)}</span>
    <span class="${cls(last.high - last.close)}">高: ${last.high.toFixed(2)}</span>
    <span class="${cls(last.low - last.close)}">低: ${last.low.toFixed(2)}</span>
    <span class="${cls(last.close - candles[candles.length - 2]?.close || last.open)}">收: ${last.close.toFixed(2)}</span>
    <span class="${cls(last.pct)}">${sign(last.pct)}${last.pct.toFixed(2)}%</span>
    <span style="color:var(--text-sub)">量: ${fmtVol(last.volume)}</span>
  `;
}

function drawKlineEmpty(canvas, ctx, msg) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#888";
  ctx.font = "14px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(msg, w / 2, h / 2);
}

function drawKline(canvas, ctx, candles, ma5, ma10, ma20) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  // 只取最近 60 根绘制
  const showCount = Math.min(candles.length, 60);
  const data = candles.slice(-showCount);
  const m5 = ma5.slice(-showCount);
  const m10 = ma10.slice(-showCount);
  const m20 = ma20.slice(-showCount);

  const padding = { top: 10, right: 50, bottom: 20, left: 8 };
  const chartW = W - padding.left - padding.right;
  const chartH = H - padding.top - padding.bottom;
  const candleW = chartW / data.length;
  const bodyW = Math.max(2, candleW * 0.6);

  // 价格范围
  let pMin = Infinity, pMax = -Infinity;
  data.forEach((c) => { pMin = Math.min(pMin, c.low); pMax = Math.max(pMax, c.high); });
  m20.forEach((v) => { if (v != null) { pMin = Math.min(pMin, v); pMax = Math.max(pMax, v); } });
  const pRange = pMax - pMin || 1;
  pMin -= pRange * 0.05;
  pMax += pRange * 0.05;

  const yOf = (price) => padding.top + chartH - ((price - pMin) / (pMax - pMin)) * chartH;
  const xOf = (i) => padding.left + i * candleW + candleW / 2;

  // 横线
  ctx.strokeStyle = "#f0f0f0";
  ctx.lineWidth = 1;
  ctx.font = "10px sans-serif";
  ctx.fillStyle = "#aaa";
  ctx.textAlign = "left";
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (chartH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(W - padding.right, y);
    ctx.stroke();
    const price = pMax - ((pMax - pMin) / 4) * i;
    ctx.fillText(price.toFixed(2), W - padding.right + 4, y + 3);
  }

  // 绘制K线
  const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const upColor = "#e8493e", downColor = "#00a870";
  const upBg = isDark ? "#3a1a1a" : "#fff1f0", downBg = isDark ? "#1a3a1a" : "#f0fff5";

  data.forEach((c, i) => {
    const x = xOf(i);
    const isUp = c.close >= c.open;
    const color = isUp ? upColor : downColor;

    // 影线
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, yOf(c.high));
    ctx.lineTo(x, yOf(c.low));
    ctx.stroke();

    // 实体
    const yOpen = yOf(c.open);
    const yClose = yOf(c.close);
    const bodyTop = Math.min(yOpen, yClose);
    const bodyH = Math.max(1, Math.abs(yClose - yOpen));
    ctx.fillStyle = isUp ? upColor : color;
    ctx.fillRect(x - bodyW / 2, bodyTop, bodyW, bodyH);
  });

  // 均线
  const drawMA = (arr, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] == null) continue;
      const x = xOf(i);
      const y = yOf(arr[i]);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };
  drawMA(m5, "#f5a623");
  drawMA(m10, "#1890ff");
  drawMA(m20, "#9b59b6");

  // 图例
  ctx.font = "11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillStyle = "#f5a623"; ctx.fillText("MA5", 10, 14);
  ctx.fillStyle = "#1890ff"; ctx.fillText("MA10", 45, 14);
  ctx.fillStyle = "#9b59b6"; ctx.fillText("MA20", 85, 14);
}

// ═══ 详情侧栏 ═══
async function openDetail(secid, name, code) {
  const panel = document.getElementById("detailPanel");
  panel.style.display = "block";
  document.getElementById("detailName").textContent = name || "";
  document.getElementById("detailCode").textContent = code || "";
  document.getElementById("detailPrice").textContent = "加载中…";
  document.getElementById("detailChange").textContent = "";

  // 获取行情
  const resp = await sendMsg({ action: "getQuoteBySecid", secid });
  if (resp && resp.success && resp.data) {
    const d = resp.data;
    const c = cls(d.changePercent);
    document.getElementById("detailPrice").textContent = safe(d.price);
    document.getElementById("detailPrice").className = "detail-price " + c;
    document.getElementById("detailChange").textContent = `${sign(d.change)}${safe(d.change)}  (${sign(d.changePercent)}${safe(d.changePercent)}%)`;
    document.getElementById("detailChange").className = "detail-change " + c;
    document.getElementById("detailOpen").textContent = safe(d.open);
    document.getElementById("detailHigh").textContent = safe(d.high);
    document.getElementById("detailLow").textContent = safe(d.low);
    document.getElementById("detailPreClose").textContent = safe(d.preClose);
    document.getElementById("detailVolume").textContent = fmtVol(d.volume);
    document.getElementById("detailAmount").textContent = fmtAmt(d.amount);
    document.getElementById("detailAmplitude").textContent = safe(d.amplitude) + "%";
    document.getElementById("detailChg").textContent = sign(d.change) + safe(d.change);
    document.getElementById("detailChg").className = "stat-val " + c;
  } else {
    document.getElementById("detailPrice").textContent = "行情获取失败";
  }

  // 分时图
  loadTrend(secid);
  // 资金流向
  loadFundFlow(secid);
  // 相关个股
  loadRelated(secid);
  // 公告
  loadAnnouncements(secid);
}

async function loadTrend(secid) {
  const canvas = document.getElementById("trendCanvas");
  const ctx = canvas.getContext("2d");
  const resp = await sendMsg({ action: "getTrend", secid });
  if (!resp || !resp.success || !resp.data) {
    drawKlineEmpty(canvas, ctx, "无分时数据");
    return;
  }
  const points = resp.data.points;
  const preClose = resp.data.preClose;
  drawTrend(canvas, ctx, points, preClose);
}

function drawTrend(canvas, ctx, points, preClose) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  if (!points || points.length === 0) {
    ctx.fillStyle = "#888"; ctx.font = "12px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("无分时数据", W / 2, H / 2);
    return;
  }

  const prices = points.map((p) => p.price);
  let pMin = Math.min(...prices, preClose);
  let pMax = Math.max(...prices, preClose);
  const range = pMax - pMin || 1;
  pMin -= range * 0.1; pMax += range * 0.1;

  const pad = { top: 8, right: 45, bottom: 8, left: 4 };
  const cW = W - pad.left - pad.right;
  const cH = H - pad.top - pad.bottom;
  const stepX = cW / (points.length - 1 || 1);
  const yOf = (p) => pad.top + cH - ((p - pMin) / (pMax - pMin)) * cH;

  // 昨收虚线
  const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  ctx.strokeStyle = isDark ? "#444" : "#ddd";
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  const ypc = yOf(preClose);
  ctx.moveTo(pad.left, ypc);
  ctx.lineTo(W - pad.right, ypc);
  ctx.stroke();
  ctx.setLineDash([]);

  // 填充区域
  const lastPrice = prices[prices.length - 1];
  const isUp = lastPrice >= preClose;
  const lineColor = isUp ? "#e8493e" : "#00a870";

  ctx.beginPath();
  ctx.moveTo(pad.left, yOf(prices[0]));
  prices.forEach((p, i) => {
    ctx.lineTo(pad.left + i * stepX, yOf(p));
  });
  ctx.lineTo(pad.left + (prices.length - 1) * stepX, pad.top + cH);
  ctx.lineTo(pad.left, pad.top + cH);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + cH);
  grad.addColorStop(0, isUp ? "rgba(232,73,62,0.15)" : "rgba(0,168,112,0.15)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.fill();

  // 价格线
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  prices.forEach((p, i) => {
    const x = pad.left + i * stepX;
    const y = yOf(p);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Y轴标签
  ctx.font = "10px sans-serif";
  ctx.fillStyle = "#aaa";
  ctx.textAlign = "left";
  ctx.fillText(pMax.toFixed(2), W - pad.right + 4, pad.top + 8);
  ctx.fillText(preClose.toFixed(2), W - pad.right + 4, ypc + 3);
  ctx.fillText(pMin.toFixed(2), W - pad.right + 4, pad.top + cH);
}

async function loadFundFlow(secid) {
  const container = document.getElementById("detailFundFlow");
  container.innerHTML = '<div style="padding:8px;color:#888">加载中…</div>';
  const resp = await sendMsg({ action: "getFundFlow", secid });
  if (!resp || !resp.success || !resp.data) {
    container.innerHTML = '<div style="padding:8px;color:#888">无资金流向数据</div>';
    return;
  }
  const f = resp.data;
  const maxAbs = Math.max(Math.abs(f.main || 0), Math.abs(f.superLarge || 0), Math.abs(f.large || 0), Math.abs(f.medium || 0), Math.abs(f.small || 0), 1);

  const rows = [
    { label: "主力", val: f.main, color: "#e8493e" },
    { label: "超大单", val: f.superLarge, color: "#ff6b6b" },
    { label: "大单", val: f.large, color: "#ffa940" },
    { label: "中单", val: f.medium, color: "#1890ff" },
    { label: "小单", val: f.small, color: "#00a870" },
  ];

  container.innerHTML = rows.map((r) => {
    const isPos = (r.val || 0) >= 0;
    const pct = Math.abs(r.val || 0) / maxAbs * 50; // bar 占比
    const c = isPos ? "up" : "down";
    return `
      <div class="ff-row">
        <span class="ff-label">${r.label}</span>
        <div class="ff-bar">
          <div class="ff-bar-fill" style="width:${pct}%;${isPos ? "left:50%" : "right:50%;left:auto"};background:${r.color}"></div>
        </div>
        <span class="ff-val ${c}">${fmtMoney(r.val)}</span>
      </div>
    `;
  }).join("");
}

async function loadRelated(secid) {
  const container = document.getElementById("detailRelated");
  container.innerHTML = '<div style="padding:8px;color:#888">加载中…</div>';
  const resp = await sendMsg({ action: "getRelatedStocks", secid });
  if (!resp || !resp.success || !resp.data) {
    container.innerHTML = '<div style="padding:8px;color:#888">无相关个股数据</div>';
    return;
  }
  const d = resp.data;
  container.innerHTML = `
    <div style="font-size:11px;color:var(--text-sub);margin-bottom:4px;">${d.boardName}</div>
    ${d.stocks.map((s) => `
      <div class="rel-row" data-secid="${s.secid}" data-name="${s.name}" data-code="${s.code}">
        <span class="rel-name">${s.name}</span>
        <span class="${cls(s.changePercent)}">${sign(s.changePercent)}${safe(s.changePercent)}%</span>
      </div>
    `).join("")}
  `;
  container.querySelectorAll(".rel-row").forEach((el) => {
    el.addEventListener("click", () => {
      openDetail(el.dataset.secid, el.dataset.name, el.dataset.code);
      currentKlineSecid = el.dataset.secid;
      loadKline(el.dataset.secid, el.dataset.name);
    });
  });
}

async function loadAnnouncements(secid) {
  const container = document.getElementById("detailAnnouncements");
  container.innerHTML = '<div style="padding:8px;color:#888">加载中…</div>';
  const resp = await sendMsg({ action: "getAnnouncements", secid });
  if (!resp || !resp.success || !resp.data || resp.data.length === 0) {
    container.innerHTML = '<div style="padding:8px;color:#888">暂无公告</div>';
    return;
  }
  container.innerHTML = resp.data.map((a) => `
    <div class="ann-item">
      <div class="ann-title">${a.title || "无标题"}</div>
      <div class="ann-date">${a.date || ""}</div>
    </div>
  `).join("");
}
