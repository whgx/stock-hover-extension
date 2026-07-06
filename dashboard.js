/**
 * dashboard.js (v8.0 PRO) — 专业交易工作台
 * 布局：左侧导航栏 + 右侧仪表盘
 * 功能：大盘指数 / 市场情绪 / 日K线图+成交量 / 板块热力图 / 自选股看板 / 持仓盈亏 / 预警
 *       持仓分析（饼图/贡献度/明细表）/ 市场异动（龙虎榜/涨跌停/热门排行）/ 条件选股器
 */

// ═══ 全局状态 ═══
let currentKlineSecid = "1.000001"; // 默认显示上证指数K线
let currentKlinePeriod = 101;
let searchDebounce = null;
let searchResults = [];
let searchHlIdx = -1;
let refreshTimer = null;
let currentDetailStock = null; // 当前详情面板的股票 { secid, name, code, price }

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
  loadTicker();
  loadKline(currentKlineSecid);
  updateClock();

  // 检查 URL 参数（从悬浮卡片跳转过来）
  const params = new URLSearchParams(window.location.search);
  const jumpSecid = params.get("secid");
  const jumpName = params.get("name");
  const jumpCode = params.get("code");
  if (jumpSecid) {
    currentKlineSecid = jumpSecid;
    switchView("overview");
    setTimeout(() => {
      loadKline(jumpSecid, jumpName || "");
      if (jumpCode) openDetail(jumpSecid, jumpName || "", jumpCode);
    }, 300);
  }

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
    if (!e.target.closest(".sidebar-search")) hideDropdown();
  });

  // 刷新按钮
  document.getElementById("refreshAll").addEventListener("click", () => {
    loadIndices(); loadSentiment(); loadSectors();
    loadWatchlist(); loadPortfolio(); loadAlerts();
    loadTicker(); loadKline(currentKlineSecid);
    if (currentView === "market") loadMarketData();
    if (currentView === "portfolio") loadPortfolioAnalysis();
    if (currentView === "watchlist") loadWatchlistFull();
    if (currentView === "alerts") loadAlertsFull();
    if (currentView === "screener") {}
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

  // ── 左侧导航栏切换 ──
  document.querySelectorAll(".nav-item[data-view]").forEach((item) => {
    item.addEventListener("click", () => switchView(item.dataset.view));
  });

  // ── 设置按钮 ──
  const navSettings = document.getElementById("navSettings");
  if (navSettings) navSettings.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
  });

  // ── 龙虎榜按钮 ──
  const btnDragon = document.getElementById("btnDragon");
  if (btnDragon) btnDragon.addEventListener("click", () => switchView("market"));

  // ── 热力图按钮 ──
  const btnHeatmap = document.getElementById("btnHeatmap");
  if (btnHeatmap) btnHeatmap.addEventListener("click", () => {
    switchView("overview");
    setTimeout(() => {
      const el = document.getElementById("sectorHeatmap");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 100);
  });

  // ── 情绪条按钮 ──
  const btnLimitUp = document.getElementById("btnLimitUp");
  if (btnLimitUp) btnLimitUp.addEventListener("click", () => {
    limitBoardType = "up";
    switchView("market");
    setTimeout(() => loadLimitBoard(), 200);
  });
  const btnLimitDown = document.getElementById("btnLimitDown");
  if (btnLimitDown) btnLimitDown.addEventListener("click", () => {
    limitBoardType = "down";
    switchView("market");
    setTimeout(() => loadLimitBoard(), 200);
  });
  const btnGainers = document.getElementById("btnGainers");
  if (btnGainers) btnGainers.addEventListener("click", () => {
    hotRankType = "gainer";
    switchView("market");
    setTimeout(() => loadHotRank(), 200);
  });
  const btnLosers = document.getElementById("btnLosers");
  if (btnLosers) btnLosers.addEventListener("click", () => {
    hotRankType = "loser";
    switchView("market");
    setTimeout(() => loadHotRank(), 200);
  });

  // ── 涨跌停 Tab 切换 ──
  document.querySelectorAll(".iltab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".iltab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      limitBoardType = tab.dataset.board;
      loadLimitBoard();
    });
  });

  // ── 热门排行 Tab 切换 ──
  document.querySelectorAll(".iltab2").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".iltab2").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      hotRankType = tab.dataset.rank;
      loadHotRank();
    });
  });

  // ── 详情侧栏操作按钮 ──
  const detailBtnWatch = document.getElementById("detailBtnWatch");
  if (detailBtnWatch) detailBtnWatch.addEventListener("click", detailActionAddWatchlist);
  const detailBtnPosition = document.getElementById("detailBtnPosition");
  if (detailBtnPosition) detailBtnPosition.addEventListener("click", detailActionAddPosition);
  const detailBtnAlert = document.getElementById("detailBtnAlert");
  if (detailBtnAlert) detailBtnAlert.addEventListener("click", detailActionAddAlert);

  // ── Modal 关闭逻辑 ──
  document.querySelectorAll(".modal-close").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.modal;
      if (id) document.getElementById(id).style.display = "none";
    });
  });
  // 点击遮罩关闭
  document.querySelectorAll(".modal-overlay").forEach((overlay) => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.style.display = "none";
    });
  });
  // 持仓确认
  const posConfirm = document.getElementById("posConfirm");
  if (posConfirm) posConfirm.addEventListener("click", confirmAddPosition);
  // 预警确认
  const alertConfirm = document.getElementById("alertConfirm");
  if (alertConfirm) alertConfirm.addEventListener("click", confirmAddAlert);
  // 预警类型联动标签
  const alertTypeSel = document.getElementById("alertType");
  if (alertTypeSel) alertTypeSel.addEventListener("change", () => {
    const label = document.getElementById("alertTargetLabel");
    const inp = document.getElementById("alertTarget");
    if (alertTypeSel.value === "pct") {
      label.textContent = "涨跌幅 (%)";
      inp.placeholder = "如 5.0";
    } else {
      label.textContent = "目标价格";
      inp.placeholder = "如 15.00";
    }
  });

  // ── 条件选股器 ──
  initScreener();

  // ── 视图页面「添加」按钮 ──
  const btnAddWatchlist = document.getElementById("btnAddWatchlist");
  if (btnAddWatchlist) btnAddWatchlist.addEventListener("click", () => openStockPicker("watchlist"));
  const btnAddPosition = document.getElementById("btnAddPosition");
  if (btnAddPosition) btnAddPosition.addEventListener("click", () => openStockPicker("position"));

  // ── 股票选择器搜索 ──
  const pickerInput = document.getElementById("pickerSearchInput");
  if (pickerInput) {
    let pickerDebounce = null;
    pickerInput.addEventListener("input", () => {
      const kw = pickerInput.value.trim();
      if (!kw) { document.getElementById("pickerResults").innerHTML = '<div class="picker-empty">请输入关键词搜索股票</div>'; return; }
      if (pickerDebounce) clearTimeout(pickerDebounce);
      pickerDebounce = setTimeout(() => doPickerSearch(kw), 250);
    });
  }

  // ── 选股器操作符联动 ──
  ["screenChgOp", "screenPeOp", "screenPbOp"].forEach((id) => {
    const sel = document.getElementById(id);
    if (sel) sel.addEventListener("change", () => {
      const baseId = id.replace("Op", "");
      const val2 = document.getElementById(baseId + "Val2");
      if (val2) val2.style.display = sel.value === "between" ? "" : "none";
    });
  });

  // 定时刷新（盘中5秒，非盘中30秒）
  startAutoRefresh();
  // 时钟每秒更新
  setInterval(updateClock, 1000);
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
      <div class="search-item-actions">
        <button class="search-act-btn search-act-watch" data-idx="${idx}" title="加入自选">⭐</button>
        <button class="search-act-btn search-act-pos" data-idx="${idx}" title="加入持仓">💼</button>
      </div>
    </div>
  `).join("");
  dd.querySelectorAll(".search-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      // 如果点击的是操作按钮，不触发展开
      if (e.target.closest(".search-act-btn")) return;
      const idx = parseInt(el.dataset.idx);
      if (searchResults[idx]) selectStock(searchResults[idx]);
    });
  });
  // 绑定快捷操作按钮
  dd.querySelectorAll(".search-act-watch").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      if (searchResults[idx]) quickAddWatchlist(searchResults[idx]);
    });
  });
  dd.querySelectorAll(".search-act-pos").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      if (searchResults[idx]) quickAddPosition(searchResults[idx]);
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
    const changeStr = idx.change != null ? (idx.change >= 0 ? "+" : "") + safe(idx.change) : "";
    const amtStr = idx.amount != null ? fmtAmt(idx.amount) : "";
    return `
      <div class="index-item" data-secid="${idx.secid}">
        <div class="index-name">${idx.name}</div>
        <div class="index-price ${c}">${safe(idx.price)}</div>
        <div class="index-change ${c}">${changeStr}</div>
        <div class="index-pct ${c}">${sign(idx.pct)}${safe(idx.pct)}%</div>
        ${amtStr ? `<div class="index-amount">${amtStr}</div>` : ""}
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
  const bar = document.getElementById("sentimentBar");
  if (bar) {
    const total = (d.up || 0) + (d.down || 0) + (d.flat || 0);
    const upPct = total > 0 ? ((d.up / total) * 100).toFixed(1) : 0;
    const downPct = total > 0 ? ((d.down / total) * 100).toFixed(1) : 0;
    const flatPct = total > 0 ? 100 - parseFloat(upPct) - parseFloat(downPct) : 0;
    // 顶部条改为紧凑涨跌比可视化
    bar.style.display = "flex";
    bar.innerHTML = `
      <div class="sent-ratio-bar">
        <div class="sent-ratio-up" style="width:${upPct}%" title="上涨 ${d.up || 0}"></div>
        <div class="sent-ratio-flat" style="width:${flatPct}%" title="平盘 ${d.flat || 0}"></div>
        <div class="sent-ratio-down" style="width:${downPct}%" title="下跌 ${d.down || 0}"></div>
      </div>
      <span class="sent-ratio-text up">${d.up || 0} 红</span>
      <span class="sent-ratio-sep">/</span>
      <span class="sent-ratio-text down">${d.down || 0} 绿</span>
      <span class="sent-ratio-sep">·</span>
      <span class="sent-ratio-text">涨停 <b class="up">${d.limitUp || 0}</b></span>
      <span class="sent-ratio-sep">·</span>
      <span class="sent-ratio-text">跌停 <b class="down">${d.limitDown || 0}</b></span>
    `;
  }
  // 更新右侧面板情绪统计块（详细数字保留）
  const sentStats = document.getElementById("sentStats");
  if (sentStats) {
    const total2 = (d.up || 0) + (d.down || 0) + (d.flat || 0);
    const ratio = total2 > 0 ? Math.round((d.up / total2) * 100) : 0;
    sentStats.innerHTML = `
      <div class="sent-stat-box up">
        <div class="sent-stat-num up">${d.up || 0}</div>
        <div class="sent-stat-label">上涨</div>
      </div>
      <div class="sent-stat-box down">
        <div class="sent-stat-num down">${d.down || 0}</div>
        <div class="sent-stat-label">下跌</div>
      </div>
      <div class="sent-stat-box flat">
        <div class="sent-stat-num">${d.flat || 0}</div>
        <div class="sent-stat-label">平盘</div>
      </div>
      <div class="sent-stat-box up">
        <div class="sent-stat-num up">${d.limitUp || 0}</div>
        <div class="sent-stat-label">涨停</div>
      </div>
      <div class="sent-stat-box down">
        <div class="sent-stat-num down">${d.limitDown || 0}</div>
        <div class="sent-stat-label">跌停</div>
      </div>
      <div class="sent-stat-box flat">
        <div class="sent-stat-num">${ratio}%</div>
        <div class="sent-stat-label">赚钱效应</div>
      </div>
    `;
  }
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
        <div class="watch-item-info">
          <div class="watch-item-name">${s.name}</div>
          <div class="watch-item-code">${s.code}</div>
        </div>
        <div class="watch-item-price ${c}">${safe(s.price)}</div>
        <div class="watch-item-pct ${c}">${sign(s.changePercent)}${safe(s.changePercent)}%</div>
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
    <div class="pf-stat-box">
      <div class="pf-total-label">总市值</div>
      <div class="pf-total-val">${fmtMoney(totalMV)}</div>
      <div class="pf-total-detail">成本 ${fmtMoney(totalCost)}</div>
    </div>
    <div class="pf-stat-box">
      <div class="pf-total-label">总盈亏</div>
      <div class="pf-total-val ${pcls}">${sign(totalProfit)}${fmtMoney(totalProfit)}</div>
      <div class="pf-total-pct ${pcls}">${sign(totalPct)}${totalPct.toFixed(2)}%</div>
    </div>
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

  const resp = await sendMsg({ action: "getKline", secid, count: 120, period: currentKlinePeriod });
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
  drawVolume(candles);

  const last = candles[candles.length - 1];
  infoEl.innerHTML = `
    <span style="color:var(--text-2)">日期 ${last.date}</span>
    <span class="${cls(last.open - last.close)}">开 ${last.open.toFixed(2)}</span>
    <span class="${cls(last.high - last.close)}">高 ${last.high.toFixed(2)}</span>
    <span class="${cls(last.low - last.close)}">低 ${last.low.toFixed(2)}</span>
    <span class="${cls(last.close - candles[candles.length - 2]?.close || last.open)}">收 ${last.close.toFixed(2)}</span>
    <span class="${cls(last.pct)}">${sign(last.pct)}${last.pct.toFixed(2)}%</span>
    <span style="color:var(--text-2)">量 ${fmtVol(last.volume)}</span>
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
  const isDarkTheme = !document.body.classList.contains("light-mode");
  ctx.strokeStyle = isDarkTheme ? "#1e2433" : "#e0e3e8";
  ctx.lineWidth = 1;
  ctx.font = "10px monospace";
  ctx.fillStyle = isDarkTheme ? "#5a6378" : "#9aa0b0";
  ctx.textAlign = "left";
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (chartH / 4) * i;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(W - padding.right, y);
    ctx.stroke();
    const price = pMax - ((pMax - pMin) / 4) * i;
    ctx.fillText(price.toFixed(2), W - padding.right + 4, y + 3);
  }
  ctx.setLineDash([]);

  // 绘制K线 — 专业交易终端配色
  const upColor = "#ff4d4f", downColor = "#00d68f";

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
  drawMA(m5, "#f0b429");
  drawMA(m10, "#3b82f6");
  drawMA(m20, "#8b5cf6");

  // 图例
  ctx.font = "10px monospace";
  ctx.textAlign = "left";
  ctx.fillStyle = "#f0b429"; ctx.fillText("MA5:" + (m5[m5.length-1] ? m5[m5.length-1].toFixed(2) : "--"), 10, 14);
  ctx.fillStyle = "#3b82f6"; ctx.fillText("MA10:" + (m10[m10.length-1] ? m10[m10.length-1].toFixed(2) : "--"), 80, 14);
  ctx.fillStyle = "#8b5cf6"; ctx.fillText("MA20:" + (m20[m20.length-1] ? m20[m20.length-1].toFixed(2) : "--"), 155, 14);
}

// ═══ 成交量柱状图 ═══
function drawVolume(candles) {
  const volCanvas = document.getElementById("volCanvas");
  if (!volCanvas) return;
  const ctx = volCanvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const W = volCanvas.clientWidth;
  const H = volCanvas.clientHeight;
  volCanvas.width = W * dpr;
  volCanvas.height = H * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const showCount = Math.min(candles.length, 60);
  const data = candles.slice(-showCount);
  if (data.length === 0) return;

  const padding = { top: 4, right: 50, bottom: 2, left: 8 };
  const chartW = W - padding.left - padding.right;
  const chartH = H - padding.top - padding.bottom;
  const candleW = chartW / data.length;
  const bodyW = Math.max(2, candleW * 0.6);

  let vMax = 0;
  data.forEach((c) => { vMax = Math.max(vMax, c.volume || 0); });
  if (vMax === 0) return;

  const upColor = "#ff4d4f", downColor = "#00d68f";

  data.forEach((c, i) => {
    const x = padding.left + i * candleW + candleW / 2;
    const isUp = c.close >= c.open;
    const color = isUp ? upColor : downColor;
    const h = ((c.volume || 0) / vMax) * chartH;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.6;
    ctx.fillRect(x - bodyW / 2, padding.top + chartH - h, bodyW, h);
  });
  ctx.globalAlpha = 1;

  // 标注最大量
  ctx.font = "9px monospace";
  ctx.fillStyle = "#5a6378";
  ctx.textAlign = "left";
  ctx.fillText(fmtVol(vMax), W - padding.right + 4, padding.top + 6);
}

// ═══ 详情侧栏 ═══
async function openDetail(secid, name, code) {
  const panel = document.getElementById("detailPanel");
  panel.style.display = "block";
  document.getElementById("detailName").textContent = name || "";
  document.getElementById("detailCode").textContent = code || "";
  document.getElementById("detailPrice").textContent = "加载中…";
  document.getElementById("detailChange").textContent = "";

  // 存储当前详情股票信息
  currentDetailStock = { secid, name: name || "", code: code || "", price: 0 };

  // 获取行情
  const resp = await sendMsg({ action: "getQuoteBySecid", secid });
  if (resp && resp.success && resp.data) {
    const d = resp.data;
    const c = cls(d.changePercent);
    currentDetailStock.price = d.price;
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
  // V6: 新闻
  if (code) loadNews(code);
  // V6: 财务指标
  if (code) loadFinance(code);
  // 检查是否已在自选股
  checkDetailWatchStatus(secid);
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
  const isDarkTheme = !document.body.classList.contains("light-mode");
  ctx.strokeStyle = isDarkTheme ? "#2a3040" : "#d0d4dc";
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
  const lineColor = isUp ? "#ff4d4f" : "#00d68f";

  ctx.beginPath();
  ctx.moveTo(pad.left, yOf(prices[0]));
  prices.forEach((p, i) => {
    ctx.lineTo(pad.left + i * stepX, yOf(p));
  });
  ctx.lineTo(pad.left + (prices.length - 1) * stepX, pad.top + cH);
  ctx.lineTo(pad.left, pad.top + cH);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + cH);
  grad.addColorStop(0, isUp ? "rgba(255,77,79,0.12)" : "rgba(0,214,143,0.12)");
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

// ════════════════════════════════════════════════════════════
// V6 新增模块
// ════════════════════════════════════════════════════════════

// ── 行情滚动条 ──────────────────────────────────
async function loadTicker() {
  const track = document.getElementById("tickerTrack");
  if (!track) return;
  // 获取自选股 + 一些热门股
  let codes = [];
  const watchResp = await sendMsg({ action: "getWatchlistQuotes" });
  if (watchResp && watchResp.success && watchResp.data) {
    codes = watchResp.data.slice(0, 10).map((s) => ({ secid: s.secid, name: s.name, code: s.code, price: s.price, changePercent: s.changePercent }));
  }
  // 如果自选股太少，加入热门股
  if (codes.length < 5) {
    const hotResp = await sendMsg({ action: "getHotStocks", rankType: "amount" });
    if (hotResp && hotResp.success && hotResp.data) {
      codes = [...codes, ...hotResp.data.slice(0, 10).map((s) => ({
        secid: guessSecid(s.code), name: s.name, code: s.code, price: s.price, changePercent: s.pct,
      }))];
    }
  }
  if (codes.length === 0) {
    track.innerHTML = '<span style="color:#888;padding:0 20px">暂无行情数据</span>';
    return;
  }
  // 使用已批量获取的数据直接渲染（无需再逐个请求）
  const html = codes.map((s) => {
    const c = cls(s.changePercent);
    return `
      <span class="ticker-item" data-secid="${s.secid}" data-name="${s.name}" data-code="${s.code}">
        <span class="ticker-name">${s.name}</span>
        <span class="ticker-price ${c}">${safe(s.price)}</span>
        <span class="ticker-pct ${c}">${sign(s.changePercent)}${safe(s.changePercent)}%</span>
      </span>
    `;
  });
  // 复制一份实现无缝滚动
  track.innerHTML = html.join("") + html.join("");
  // 绑定点击
  track.querySelectorAll(".ticker-item").forEach((el) => {
    el.addEventListener("click", () => {
      openDetail(el.dataset.secid, el.dataset.name, el.dataset.code);
      currentKlineSecid = el.dataset.secid;
      loadKline(el.dataset.secid, el.dataset.name);
    });
  });
}

function guessSecid(code) {
  if (/^(6|9)/.test(code)) return "1." + code;
  if (/^(0|3|2)/.test(code)) return "0." + code;
  return "1." + code;
}

// ── 视图切换（左侧导航栏）──────────────────────────
let currentView = "overview";
const viewTitles = {
  overview: "大盘总览",
  watchlist: "自选股看板",
  portfolio: "持仓分析",
  alerts: "价格预警",
  market: "市场异动",
  screener: "条件选股",
};
function switchView(view) {
  currentView = view;
  // 导航栏高亮
  document.querySelectorAll(".nav-item[data-view]").forEach((t) => {
    t.classList.toggle("active", t.dataset.view === view);
  });
  // 视图显隐
  document.querySelectorAll(".content-view").forEach((el) => {
    el.classList.toggle("active", el.id === "view" + view.charAt(0).toUpperCase() + view.slice(1));
  });
  // 页面标题
  const titleEl = document.getElementById("pageTitle");
  if (titleEl) titleEl.textContent = viewTitles[view] || view;
  // 懒加载
  if (view === "portfolio") loadPortfolioAnalysis();
  if (view === "market") loadMarketData();
  if (view === "watchlist") loadWatchlistFull();
  if (view === "alerts") loadAlertsFull();
}

// ── 龙虎榜 ──────────────────────────────────
async function loadDragonTiger() {
  const container = document.getElementById("dragonList");
  if (!container) return;
  container.innerHTML = '<div style="padding:12px;color:#888">加载龙虎榜数据…</div>';
  const resp = await sendMsg({ action: "getDragonTiger" });
  if (!resp || !resp.success || !resp.data || resp.data.length === 0) {
    container.innerHTML = '<div style="padding:12px;color:#888">暂无龙虎榜数据</div>';
    return;
  }
  const today = resp.data[0]?.date || "";
  document.getElementById("dragonTime").textContent = today ? "日期: " + today : "";
  container.innerHTML = resp.data.map((s, i) => {
    const c = cls(s.pct);
    return `
      <div class="dragon-row" data-code="${s.code}" data-name="${s.name}">
        <span class="dragon-rank">${i + 1}</span>
        <div>
          <span class="dragon-name">${s.name}</span>
          <span class="dragon-code">${s.code}</span>
        </div>
        <span class="dragon-net ${s.netBuy >= 0 ? "up" : "down"}">${s.netBuy >= 0 ? "+" : ""}${fmtAmt(s.netBuy)}</span>
        <span class="${c}" style="font-family:var(--font-mono);text-align:right">${sign(s.pct)}${safe(s.pct)}%</span>
        <span class="dragon-reason">${s.reason || ""}</span>
      </div>
    `;
  }).join("");
  container.querySelectorAll(".dragon-row").forEach((el) => {
    el.addEventListener("click", () => {
      const secid = guessSecid(el.dataset.code);
      openDetail(secid, el.dataset.name, el.dataset.code);
    });
  });
}

// ── 涨停/跌停板 ──────────────────────────────────
let limitBoardType = "up";
async function loadLimitBoard() {
  const container = document.getElementById("limitBoardList");
  if (!container) return;
  container.innerHTML = '<div style="padding:12px;color:#888">加载中…</div>';
  const resp = await sendMsg({ action: "getLimitBoard", type: limitBoardType });
  if (!resp || !resp.success || !resp.data || resp.data.length === 0) {
    container.innerHTML = '<div style="padding:12px;color:#888">暂无数据</div>';
    return;
  }
  container.innerHTML = resp.data.slice(0, 30).map((s, i) => {
    const c = cls(s.pct);
    return `
      <div class="limit-row" data-code="${s.code}" data-name="${s.name}">
        <span class="limit-rank">${i + 1}</span>
        <div>
          <span class="limit-name">${s.name}</span>
          <span class="limit-code">${s.code}</span>
        </div>
        <span class="${c}" style="font-family:var(--font-mono);text-align:right">${safe(s.price)}</span>
        <span class="${c}" style="font-family:var(--font-mono);text-align:right">${sign(s.pct)}${safe(s.pct)}%</span>
        <span style="font-family:var(--font-mono);color:var(--text-2);text-align:right;font-size:11px">${s.amountStr || fmtAmt(s.amount)}</span>
      </div>
    `;
  }).join("");
  container.querySelectorAll(".limit-row").forEach((el) => {
    el.addEventListener("click", () => {
      const secid = guessSecid(el.dataset.code);
      openDetail(secid, el.dataset.name, el.dataset.code);
    });
  });
}

// ── 热门排行 ──────────────────────────────────
let hotRankType = "amount";
async function loadHotRank() {
  const container = document.getElementById("hotRankList");
  if (!container) return;
  container.innerHTML = '<div style="padding:12px;color:#888">加载中…</div>';
  const resp = await sendMsg({ action: "getHotStocks", rankType: hotRankType });
  if (!resp || !resp.success || !resp.data || resp.data.length === 0) {
    container.innerHTML = '<div style="padding:12px;color:#888">暂无数据</div>';
    return;
  }
  container.innerHTML = resp.data.map((s, i) => {
    const c = cls(s.pct);
    return `
      <div class="hot-row" data-code="${s.code}" data-name="${s.name}">
        <span class="hot-rank">${i + 1}</span>
        <div>
          <span class="hot-name">${s.name}</span>
          <span class="hot-code">${s.code}</span>
        </div>
        <span class="${c}" style="font-family:var(--font-mono);text-align:right">${safe(s.price)}</span>
        <span class="${c}" style="font-family:var(--font-mono);text-align:right">${sign(s.pct)}${safe(s.pct)}%</span>
        <span style="font-family:var(--font-mono);color:var(--text-2);text-align:right;font-size:11px">${s.amountStr || fmtAmt(s.amount)}</span>
      </div>
    `;
  }).join("");
  container.querySelectorAll(".hot-row").forEach((el) => {
    el.addEventListener("click", () => {
      const secid = guessSecid(el.dataset.code);
      openDetail(secid, el.dataset.name, el.dataset.code);
    });
  });
}

// ── 加载市场数据（切到 market Tab 时调用）──
async function loadMarketData() {
  await Promise.all([
    loadDragonTiger(),
    loadLimitBoard(),
    loadHotRank(),
  ]);
}

// ── 持仓分析（饼图 + 贡献度 + 明细表）──
async function loadPortfolioAnalysis() {
  const resp = await sendMsg({ action: "getPortfolioQuotes" });
  const summaryEl = document.getElementById("pdSummary");
  if (!resp || !resp.success || !resp.data || resp.data.length === 0) {
    summaryEl.innerHTML = '<div style="padding:20px;color:#888;text-align:center">暂无持仓数据，请先在 Popup 中添加持仓</div>';
    document.getElementById("contributionBars").innerHTML = "";
    document.getElementById("portfolioTableBody").innerHTML = "";
    drawPieEmpty();
    return;
  }
  const positions = resp.data;
  // 计算总览
  let totalCost = 0, totalMarket = 0;
  positions.forEach((p) => {
    const cost = (p.avgCost || 0) * (p.quantity || 0);
    const market = (p.price || 0) * (p.quantity || 0);
    totalCost += cost;
    totalMarket += market;
  });
  const totalPnL = totalMarket - totalCost;
  const totalPnLPct = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0;
  const c = totalPnL >= 0 ? "up" : "down";

  summaryEl.innerHTML = `
    <div class="pd-stat">
      <div class="pd-label">总市值</div>
      <div class="pd-value">${fmtMoney(totalMarket)}</div>
    </div>
    <div class="pd-stat">
      <div class="pd-label">总成本</div>
      <div class="pd-value">${fmtMoney(totalCost)}</div>
    </div>
    <div class="pd-stat">
      <div class="pd-label">总盈亏</div>
      <div class="pd-value ${c}">${sign(totalPnL)}${fmtMoney(Math.abs(totalPnL))}</div>
    </div>
    <div class="pd-stat">
      <div class="pd-label">收益率</div>
      <div class="pd-value ${c}">${sign(totalPnLPct)}${safe(totalPnLPct)}%</div>
    </div>
  `;

  // 持仓分布饼图
  drawPie(positions, totalMarket);

  // 个股盈亏贡献度
  const sorted = [...positions].sort((a, b) => {
    const ap = (a.price - a.avgCost) * a.quantity;
    const bp = (b.price - b.avgCost) * b.quantity;
    return Math.abs(bp) - Math.abs(ap);
  });
  const maxAbs = Math.max(...sorted.map((p) => Math.abs((p.price - p.avgCost) * p.quantity)), 1);
  document.getElementById("contributionBars").innerHTML = sorted.map((p) => {
    const pnl = (p.price - p.avgCost) * p.quantity;
    const pnlPct = p.avgCost > 0 ? ((p.price - p.avgCost) / p.avgCost) * 100 : 0;
    const width = (Math.abs(pnl) / maxAbs) * 100;
    const pc = pnl >= 0 ? "up" : "down";
    return `
      <div class="contrib-row">
        <div class="contrib-info">
          <span class="contrib-name">${p.name}</span>
          <span class="contrib-pnl ${pc}">${sign(pnl)}${fmtMoney(Math.abs(pnl))} (${sign(pnlPct)}${safe(pnlPct)}%)</span>
        </div>
        <div class="contrib-bar-wrap">
          <div class="contrib-bar ${pc}" style="width:${width}%"></div>
        </div>
      </div>
    `;
  }).join("");

  // 明细表
  document.getElementById("portfolioTableBody").innerHTML = positions.map((p) => {
    const market = (p.price || 0) * (p.quantity || 0);
    const cost = (p.avgCost || 0) * (p.quantity || 0);
    const pnl = market - cost;
    const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
    const pc = pnl >= 0 ? "up" : "down";
    return `
      <tr>
        <td><strong>${p.name}</strong><br><span style="font-size:11px;color:#888">${p.code}</span></td>
        <td>${p.quantity}</td>
        <td>${safe(p.avgCost)}</td>
        <td>${safe(p.price)}</td>
        <td>${fmtMoney(market)}</td>
        <td>${fmtMoney(cost)}</td>
        <td class="${pc}">${sign(pnl)}${fmtMoney(Math.abs(pnl))}</td>
        <td class="${pc}">${sign(pnlPct)}${safe(pnlPct)}%</td>
      </tr>
    `;
  }).join("");
}

// ── 饼图绘制 ──────────────────────────────────
function drawPie(positions, totalMarket) {
  const canvas = document.getElementById("pieCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const radius = Math.min(cx, cy) - 10;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (totalMarket <= 0 || positions.length === 0) {
    drawPieEmpty();
    return;
  }

  // 饼图颜色
  const colors = [
    "#e8739a", "#6c8eef", "#5abe7f", "#f0a04b",
    "#8b6fd6", "#4ec5d4", "#e8c847", "#d65c5c",
    "#7b9e3f", "#c97eb4", "#5e9eb8", "#d4882e",
  ];

  let startAngle = -Math.PI / 2;
  const legendHtml = [];

  positions.forEach((p, i) => {
    const value = (p.price || 0) * (p.quantity || 0);
    const pct = value / totalMarket;
    const endAngle = startAngle + pct * Math.PI * 2;
    const color = colors[i % colors.length];

    // 扇形
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = "#1a1a2e";
    ctx.lineWidth = 2;
    ctx.stroke();

    // 图例
    legendHtml.push(`
      <div class="pie-legend-item">
        <span class="pie-legend-dot" style="background:${color}"></span>
        <span class="pie-legend-name">${p.name}</span>
        <span class="pie-legend-pct">${safe(pct * 100, 1)}%</span>
      </div>
    `);

    startAngle = endAngle;
  });

  // 中心圆（环形效果）
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.45, 0, Math.PI * 2);
  ctx.fillStyle = "#1a1a2e";
  ctx.fill();

  // 中心文字
  ctx.fillStyle = "#ccc";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("总市值", cx, cy - 5);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 14px sans-serif";
  ctx.fillText(fmtMoney(totalMarket), cx, cy + 15);

  document.getElementById("pieLegend").innerHTML = legendHtml.join("");
}

function drawPieEmpty() {
  const canvas = document.getElementById("pieCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#888";
  ctx.font = "13px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("暂无持仓", canvas.width / 2, canvas.height / 2);
}

// ── 个股新闻 ──────────────────────────────────
async function loadNews(code) {
  const container = document.getElementById("detailNews");
  if (!container) return;
  container.innerHTML = '<div style="padding:8px;color:#888">加载新闻中…</div>';
  const resp = await sendMsg({ action: "getStockNews", code });
  if (!resp || !resp.success || !resp.data || resp.data.length === 0) {
    container.innerHTML = '<div style="padding:8px;color:#888">暂无新闻</div>';
    return;
  }
  container.innerHTML = resp.data.map((n) => `
    <div class="news-item">
      <a href="${n.url || "#"}" target="_blank" class="news-title">${n.title || "无标题"}</a>
      <div class="news-meta">${n.source || ""} · ${n.date || ""}</div>
    </div>
  `).join("");
}

// ── 财务指标 ──────────────────────────────────
async function loadFinance(code) {
  const container = document.getElementById("detailFinance");
  if (!container) return;
  container.innerHTML = '<div style="padding:8px;color:#888">加载财务数据…</div>';
  const resp = await sendMsg({ action: "getFinance", code });
  if (!resp || !resp.success || !resp.data) {
    container.innerHTML = '<div style="padding:8px;color:#888">暂无财务数据</div>';
    return;
  }
  const d = resp.data;
  const items = [
    { label: "市盈率(PE)", value: d.pe, suffix: "" },
    { label: "市净率(PB)", value: d.pb, suffix: "" },
    { label: "ROE", value: d.roe, suffix: "%" },
    { label: "毛利率", value: d.grossMargin, suffix: "%" },
    { label: "净利率", value: d.netMargin, suffix: "%" },
    { label: "营收同比", value: d.revenueYoY, suffix: "%" },
    { label: "净利同比", value: d.profitYoY, suffix: "%" },
    { label: "EPS", value: d.eps, suffix: "" },
  ];
  container.innerHTML = items.map((it) => `
    <div class="fin-item">
      <span class="fin-label">${it.label}</span>
      <span class="fin-value">${it.value != null ? safe(it.value, 2) + it.suffix : "—"}</span>
    </div>
  `).join("") + (d.reportDate ? `<div style="grid-column:1/-1;text-align:right;color:var(--text-2);font-size:10px;padding:4px 0;font-family:var(--font-mono)">报告期 ${d.reportDate}</div>` : "");
}

// ── 自动刷新（盘中 5 秒）──────────────────────────
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (!isMarketOpen()) return;
    if (currentView === "overview") {
      loadIndices();
      loadSentiment();
      loadWatchlist();
      loadPortfolio();
    }
  }, 5000);
}

function isMarketOpen() {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const h = now.getHours();
  const m = now.getMinutes();
  const t = h * 60 + m;
  return (t >= 565 && t <= 690) || (t >= 780 && t <= 900);
}

// ════════════════════════════════════════════════════════════
// V8 新增功能
// ════════════════════════════════════════════════════════════

// ── 时钟 ──────────────────────────────────
function updateClock() {
  const el = document.getElementById("sidebarClock");
  if (!el) return;
  const now = new Date();
  const time = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const date = now.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
  const isMarket = isMarketOpen();
  el.innerHTML = `${date} ${time}${isMarket ? '<br><span style="color:var(--red)">● 交易中</span>' : ""}`;
}

// ── 自选股全屏视图 ──────────────────────────────────
async function loadWatchlistFull() {
  const container = document.getElementById("watchlistFullGrid");
  const countEl = document.getElementById("watchlistCountFull");
  if (!container) return;
  container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">⏳</div><div>加载中…</div></div>';
  const resp = await sendMsg({ action: "getWatchlistQuotes" });
  if (!resp || !resp.success) {
    container.innerHTML = '<div class="empty-state">加载失败</div>';
    return;
  }
  const list = resp.data ?? [];
  if (countEl) countEl.textContent = list.length + " 只";
  if (list.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">⭐</div><div>暂无自选股，通过搜索框添加</div></div>';
    return;
  }
  let html = '<div class="watch-full-header"><span>#</span><span>名称/代码</span><span>现价</span><span>涨跌</span><span>涨跌幅</span><span>成交额</span></div>';
  html += list.map((s, i) => {
    const c = cls(s.changePercent);
    return `
      <div class="watch-full-item" data-secid="${s.secid}" data-name="${s.name}" data-code="${s.code}">
        <span class="watch-full-rank">${i + 1}</span>
        <div><div class="watch-full-name">${s.name}</div><div class="watch-full-code">${s.code}</div></div>
        <span class="watch-full-price ${c}">${safe(s.price)}</span>
        <span class="watch-full-chg ${c}">${sign(s.change)}${safe(s.change)}</span>
        <span class="watch-full-pct ${c}">${sign(s.changePercent)}${safe(s.changePercent)}%</span>
        <span class="watch-full-amount">${fmtAmt(s.amount)}</span>
      </div>
    `;
  }).join("");
  container.innerHTML = html;
  container.querySelectorAll(".watch-full-item").forEach((el) => {
    el.addEventListener("click", () => {
      openDetail(el.dataset.secid, el.dataset.name, el.dataset.code);
      currentKlineSecid = el.dataset.secid;
      loadKline(el.dataset.secid, el.dataset.name);
    });
  });
}

// ── 预警全屏视图 ──────────────────────────────────
async function loadAlertsFull() {
  const container = document.getElementById("alertListFull");
  if (!container) return;
  container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">⏳</div><div>加载中…</div></div>';
  const resp = await sendMsg({ action: "getAlerts" });
  if (!resp || !resp.success) {
    container.innerHTML = '<div class="empty-state">加载失败</div>';
    return;
  }
  const alerts = resp.data ?? [];
  if (alerts.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🔔</div><div>暂无预警，通过 Popup 添加</div></div>';
    return;
  }
  const typeLabel = { above: "涨到", below: "跌到", pct: "涨跌幅达" };
  const typeUnit = { above: "元", below: "元", pct: "%" };
  let html = '<div class="alert-full-header"><span>股票名称</span><span>预警条件</span><span>目标值</span><span>状态</span></div>';
  html += alerts.map((a) => `
    <div class="alert-full-row">
      <div><div class="alert-row-name">${a.name}</div><div class="alert-row-desc">${a.code || a.secid}</div></div>
      <span style="font-size:12px;color:var(--text-2)">${typeLabel[a.type]}</span>
      <span style="font-family:var(--font-mono);font-weight:600">${a.target}${typeUnit[a.type]}</span>
      <span class="alert-row-status ${a.triggered ? "status-triggered" : "status-active"}">${a.triggered ? "已触发" : "监控中"}</span>
    </div>
  `).join("");
  container.innerHTML = html;
}

// ── 条件选股器 ──────────────────────────────────
function initScreener() {
  const btnRun = document.getElementById("btnScreenRun");
  const btnReset = document.getElementById("btnScreenReset");
  if (btnRun) btnRun.addEventListener("click", runScreener);
  if (btnReset) btnReset.addEventListener("click", resetScreener);
}

async function runScreener() {
  const resultsEl = document.getElementById("screenResults");
  const statsEl = document.getElementById("screenStats");
  const btnRun = document.getElementById("btnScreenRun");

  // 收集筛选条件
  const conditions = {};

  // 涨跌幅
  const chgOp = document.getElementById("screenChgOp").value;
  const chgV1 = parseFloat(document.getElementById("screenChgVal1").value);
  const chgV2 = parseFloat(document.getElementById("screenChgVal2").value);
  if (!isNaN(chgV1)) conditions.chg = { op: chgOp, v1: chgV1, v2: !isNaN(chgV2) ? chgV2 : null };

  // PE
  const peOp = document.getElementById("screenPeOp").value;
  const peV1 = parseFloat(document.getElementById("screenPeVal1").value);
  const peV2 = parseFloat(document.getElementById("screenPeVal2").value);
  if (!isNaN(peV1)) conditions.pe = { op: peOp, v1: peV1, v2: !isNaN(peV2) ? peV2 : null };

  // PB
  const pbOp = document.getElementById("screenPbOp").value;
  const pbV1 = parseFloat(document.getElementById("screenPbVal1").value);
  const pbV2 = parseFloat(document.getElementById("screenPbVal2").value);
  if (!isNaN(pbV1)) conditions.pb = { op: pbOp, v1: pbV1, v2: !isNaN(pbV2) ? pbV2 : null };

  // 成交额
  const amtMin = parseFloat(document.getElementById("screenAmtUnit").value);
  conditions.amtMin = amtMin;

  // 换手率
  const turnOp = document.getElementById("screenTurnOp").value;
  const turnVal = parseFloat(document.getElementById("screenTurnVal").value);
  if (!isNaN(turnVal)) conditions.turn = { op: turnOp, val: turnVal };

  // 排序
  conditions.sort = document.getElementById("screenSort").value;

  resultsEl.innerHTML = '<div class="empty-state"><div class="loading-spin"></div><div style="margin-top:8px">正在筛选全市场股票…</div></div>';
  btnRun.disabled = true;
  btnRun.textContent = "筛选中…";
  if (statsEl) statsEl.innerHTML = "";

  try {
    const resp = await sendMsg({ action: "screener", conditions });
    if (!resp || !resp.success || !resp.data) {
      resultsEl.innerHTML = '<div class="empty-state"><div class="empty-state-icon">⚠️</div><div>筛选失败，请稍后重试</div></div>';
      return;
    }
    const stocks = resp.data;
    if (stocks.length === 0) {
      resultsEl.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📭</div><div>没有符合条件的股票，请放宽筛选条件</div></div>';
      if (statsEl) statsEl.innerHTML = "符合条件：<span class='count'>0</span> 只";
      return;
    }
    if (statsEl) statsEl.innerHTML = `符合条件：<span class="count">${stocks.length}</span> 只 · 按条件排序`;
    let html = '<div class="screen-header"><span>#</span><span>名称/代码</span><span>现价</span><span>涨跌幅</span><span>PE</span><span>PB</span><span>成交额</span></div>';
    html += stocks.map((s, i) => {
      const c = cls(s.pct);
      const secid = guessSecid(s.code);
      return `
        <div class="screen-result-row" data-secid="${secid}" data-name="${s.name}" data-code="${s.code}">
          <span class="screen-rank">${i + 1}</span>
          <div><div class="screen-name">${s.name}</div><div class="screen-code">${s.code}</div></div>
          <span class="screen-price ${c}">${safe(s.price)}</span>
          <span class="screen-pct ${c}">${sign(s.pct)}${safe(s.pct)}%</span>
          <span class="screen-pe">${s.pe != null ? safe(s.pe, 1) : "--"}</span>
          <span class="screen-pb">${s.pb != null ? safe(s.pb, 1) : "--"}</span>
          <span class="screen-amount">${fmtAmt(s.amount)}</span>
        </div>
      `;
    }).join("");
    resultsEl.innerHTML = html;
    resultsEl.querySelectorAll(".screen-result-row").forEach((el) => {
      el.addEventListener("click", () => {
        openDetail(el.dataset.secid, el.dataset.name, el.dataset.code);
        currentKlineSecid = el.dataset.secid;
        loadKline(el.dataset.secid, el.dataset.name);
      });
    });
  } catch (e) {
    resultsEl.innerHTML = '<div class="empty-state">筛选出错</div>';
  } finally {
    btnRun.disabled = false;
    btnRun.textContent = "🔍 开始筛选";
  }
}

function resetScreener() {
  ["screenChgVal1", "screenChgVal2", "screenPeVal1", "screenPeVal2", "screenPbVal1", "screenPbVal2", "screenTurnVal"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  document.getElementById("screenResults").innerHTML = '<div class="empty-state"><div class="empty-state-icon">🔍</div><div>设置筛选条件后点击「开始筛选」</div></div>';
  document.getElementById("screenStats").innerHTML = "";
}

// ════════════════════════════════════════════════════════════
// V8.1 新增：自选/持仓/预警 添加功能
// ════════════════════════════════════════════════════════════

// ── Toast 提示 ──────────────────────────────────
function showToast(msg, type = "success") {
  const container = document.getElementById("toastContainer");
  if (!container) return;
  const icons = { success: "✅", error: "❌", info: "ℹ️" };
  const toast = document.createElement("div");
  toast.className = "toast " + type;
  toast.innerHTML = `<span class="toast-icon">${icons[type] || "✅"}</span><span class="toast-msg">${msg}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ── 检查详情面板的自选状态 ──────────────────────────────────
async function checkDetailWatchStatus(secid) {
  const btn = document.getElementById("detailBtnWatch");
  if (!btn) return;
  const resp = await sendMsg({ action: "checkWatchlist", secid });
  if (resp && resp.success && resp.data) {
    btn.classList.add("active");
    btn.textContent = "★ 已选";
  } else {
    btn.classList.remove("active");
    btn.textContent = "⭐ 自选";
  }
}

// ── 详情面板：加入自选 ──────────────────────────────────
async function detailActionAddWatchlist() {
  if (!currentDetailStock) return;
  const { secid, name, code } = currentDetailStock;
  const btn = document.getElementById("detailBtnWatch");
  if (btn && btn.classList.contains("active")) {
    // 已在自选，执行移除
    const resp = await sendMsg({ action: "removeFromWatchlist", secid });
    if (resp && resp.success) {
      btn.classList.remove("active");
      btn.textContent = "⭐ 自选";
      showToast(`已从自选股移除 ${name}`, "info");
      loadWatchlist();
      loadTicker();
    }
  } else {
    // 加入自选
    const resp = await sendMsg({ action: "addToWatchlist", stock: { secid, name, code } });
    if (resp && resp.success) {
      btn.classList.add("active");
      btn.textContent = "★ 已选";
      showToast(`已添加 ${name} 到自选股`, "success");
      loadWatchlist();
      loadTicker();
    } else {
      showToast("添加失败，请重试", "error");
    }
  }
}

// ── 详情面板：添加持仓（弹出 Modal）──────────────────────────
function detailActionAddPosition() {
  if (!currentDetailStock) return;
  const { name, code, price } = currentDetailStock;
  const info = document.getElementById("positionStockInfo");
  info.innerHTML = `<span class="msi-name">${name}</span><span class="msi-code">${code}</span><span class="msi-price ${cls(price)}">${safe(price)}</span>`;
  // 预填当前价
  const costInput = document.getElementById("posCostPrice");
  if (costInput && price > 0) costInput.value = price;
  document.getElementById("posQuantity").value = "";
  document.getElementById("positionModal").style.display = "flex";
  setTimeout(() => costInput.focus(), 100);
}

// ── 确认添加持仓 ──────────────────────────────────
async function confirmAddPosition() {
  if (!currentDetailStock) return;
  const costPrice = parseFloat(document.getElementById("posCostPrice").value);
  const quantity = parseFloat(document.getElementById("posQuantity").value);
  if (isNaN(costPrice) || costPrice <= 0) { showToast("请输入有效的买入价", "error"); return; }
  if (isNaN(quantity) || quantity <= 0) { showToast("请输入有效的持仓数量", "error"); return; }

  const { secid, name, code } = currentDetailStock;
  const resp = await sendMsg({
    action: "addPosition",
    position: { secid, name, code, costPrice, quantity },
  });
  if (resp && resp.success) {
    showToast(`已添加持仓：${name} ${quantity}股 @ ${costPrice.toFixed(3)}`, "success");
    document.getElementById("positionModal").style.display = "none";
    loadPortfolio();
    if (currentView === "portfolio") loadPortfolioAnalysis();
  } else {
    showToast("添加持仓失败", "error");
  }
}

// ── 详情面板：设置预警（弹出 Modal）──────────────────────────
function detailActionAddAlert() {
  if (!currentDetailStock) return;
  const { name, code, price } = currentDetailStock;
  const info = document.getElementById("alertStockInfo");
  info.innerHTML = `<span class="msi-name">${name}</span><span class="msi-code">${code}</span><span class="msi-price ${cls(price)}">${safe(price)}</span>`;
  // 重置
  document.getElementById("alertType").value = "above";
  document.getElementById("alertTargetLabel").textContent = "目标价格";
  const targetInput = document.getElementById("alertTarget");
  targetInput.value = price > 0 ? (price * 1.1).toFixed(2) : "";
  targetInput.placeholder = "如 15.00";
  document.getElementById("alertModal").style.display = "flex";
  setTimeout(() => targetInput.focus(), 100);
}

// ── 确认设置预警 ──────────────────────────────────
async function confirmAddAlert() {
  if (!currentDetailStock) return;
  const type = document.getElementById("alertType").value;
  const target = parseFloat(document.getElementById("alertTarget").value);
  if (isNaN(target) || target <= 0) { showToast("请输入有效的目标值", "error"); return; }

  const { secid, name, code } = currentDetailStock;
  const resp = await sendMsg({
    action: "addAlert",
    alert: { secid, name, code, type, target },
  });
  if (resp && resp.success) {
    const typeLabel = { above: "涨到", below: "跌到", pct: "涨跌幅达" };
    const unit = type === "pct" ? "%" : "元";
    showToast(`已设置预警：${name} ${typeLabel[type]} ${target}${unit}`, "success");
    document.getElementById("alertModal").style.display = "none";
    loadAlerts();
    if (currentView === "alerts") loadAlertsFull();
  } else {
    showToast("设置预警失败", "error");
  }
}

// ── 搜索下拉：快速添加自选 ──────────────────────────────────
async function quickAddWatchlist(item) {
  const resp = await sendMsg({ action: "addToWatchlist", stock: { secid: item.secid, name: item.name, code: item.code } });
  if (resp && resp.success) {
    showToast(`已添加 ${item.name} 到自选股`, "success");
    loadWatchlist();
    loadTicker();
  } else {
    showToast("添加失败", "error");
  }
}

// ── 搜索下拉：快速添加持仓 ──────────────────────────────────
function quickAddPosition(item) {
  // 先获取实时价格
  currentDetailStock = { secid: item.secid, name: item.name, code: item.code, price: 0 };
  // 用详情面板的 Modal
  detailActionAddPosition();
  // 异步获取价格更新
  sendMsg({ action: "getQuoteBySecid", secid: item.secid }).then((resp) => {
    if (resp && resp.success && resp.data) {
      currentDetailStock.price = resp.data.price;
      const info = document.getElementById("positionStockInfo");
      if (info) {
        const priceEl = info.querySelector(".msi-price");
        if (priceEl) { priceEl.textContent = safe(resp.data.price); priceEl.className = "msi-price " + cls(resp.data.changePercent); }
      }
      const costInput = document.getElementById("posCostPrice");
      if (costInput && !costInput.value) costInput.value = resp.data.price;
    }
  });
}

// ════════════════════════════════════════════════════════════
// V8.2 新增：视图页面级股票选择器（自选股/持仓页面添加入口）
// ════════════════════════════════════════════════════════════

let pickerMode = "watchlist"; // "watchlist" | "position"
let pickerResults = [];

// ── 打开股票选择器 ──────────────────────────────────
function openStockPicker(mode) {
  pickerMode = mode;
  const modal = document.getElementById("stockPickerModal");
  const title = document.getElementById("stockPickerTitle");
  const input = document.getElementById("pickerSearchInput");
  const resultsEl = document.getElementById("pickerResults");
  title.textContent = mode === "watchlist" ? "⭐ 添加自选股" : "💼 添加持仓";
  input.value = "";
  resultsEl.innerHTML = '<div class="picker-empty">请输入股票名称或代码…</div>';
  pickerResults = [];
  modal.style.display = "flex";
  setTimeout(() => input.focus(), 100);
}

// ── 选择器搜索 ──────────────────────────────────
async function doPickerSearch(kw) {
  const resultsEl = document.getElementById("pickerResults");
  resultsEl.innerHTML = '<div class="picker-loading"><span class="loading-spin"></span> 搜索中…</div>';
  const resp = await sendMsg({ action: "searchList", keyword: kw });
  if (!resp || !resp.success) {
    resultsEl.innerHTML = '<div class="picker-empty">搜索失败，请重试</div>';
    return;
  }
  pickerResults = resp.data ?? [];
  if (pickerResults.length === 0) {
    resultsEl.innerHTML = '<div class="picker-empty">未找到匹配的股票</div>';
    return;
  }
  renderPickerResults();
}

// ── 渲染选择器结果 ──────────────────────────────────
function renderPickerResults() {
  const resultsEl = document.getElementById("pickerResults");
  const actLabel = pickerMode === "watchlist" ? "⭐ 加自选" : "💼 加持仓";
  const actClass = pickerMode === "watchlist" ? "picker-act-watch" : "picker-act-pos";
  resultsEl.innerHTML = pickerResults.map((item, idx) => `
    <div class="picker-item" data-idx="${idx}">
      <div class="picker-item-info">
        <span class="picker-item-name">${item.name}</span>
        <span class="picker-item-code">${item.code}</span>
      </div>
      ${item.marketType ? `<span class="picker-item-market">${item.marketType}</span>` : ""}
      <div class="picker-item-actions">
        <button class="picker-act-btn ${actClass}" data-idx="${idx}">${actLabel}</button>
      </div>
    </div>
  `).join("");
  resultsEl.querySelectorAll(".picker-act-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      if (!pickerResults[idx]) return;
      if (pickerMode === "watchlist") {
        pickerAddWatchlist(pickerResults[idx]);
      } else {
        pickerAddPosition(pickerResults[idx]);
      }
    });
  });
}

// ── 选择器：添加自选 ──────────────────────────────────
async function pickerAddWatchlist(item) {
  const resp = await sendMsg({ action: "addToWatchlist", stock: { secid: item.secid, name: item.name, code: item.code } });
  if (resp && resp.success) {
    showToast(`已添加 ${item.name} 到自选股`, "success");
    loadWatchlist();
    loadWatchlistFull();
    loadTicker();
    // 关闭选择器
    document.getElementById("stockPickerModal").style.display = "none";
  } else {
    showToast("添加失败，可能已在自选股中", "error");
  }
}

// ── 选择器：添加持仓 ──────────────────────────────────
async function pickerAddPosition(item) {
  // 获取实时价格
  let price = 0;
  const quoteResp = await sendMsg({ action: "getQuoteBySecid", secid: item.secid });
  if (quoteResp && quoteResp.success && quoteResp.data) price = quoteResp.data.price;

  // 关闭股票选择器
  document.getElementById("stockPickerModal").style.display = "none";

  // 设置当前详情股票并打开持仓 Modal
  currentDetailStock = { secid: item.secid, name: item.name, code: item.code, price };
  const info = document.getElementById("positionStockInfo");
  info.innerHTML = `<span class="msi-name">${item.name}</span><span class="msi-code">${item.code}</span><span class="msi-price ${cls(price)}">${safe(price)}</span>`;
  const costInput = document.getElementById("posCostPrice");
  if (costInput && price > 0) costInput.value = price;
  document.getElementById("posQuantity").value = "";
  document.getElementById("positionModal").style.display = "flex";
  setTimeout(() => costInput.focus(), 100);
}
