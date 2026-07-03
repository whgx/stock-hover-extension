/**
 * content.js (v4.1) — 注入到页面
 * 功能：选中弹出 + 右键菜单触发 + 快捷键触发 + 自选股收藏 + 迷你分时图 + 价格预警
 *       + 资金流向 + 相关个股 + 公告列表 + 持仓盈亏
 *
 * v4.1 修复：
 *  - Extension context invalidated 防护
 *  - 所有 chrome.runtime 调用包裹 try-catch + 有效性检查
 */

(() => {
  let card = null;
  let hideTimer = null;
  let scrollTimer = null;
  let currentData = null;
  let pinned = false; // 是否固定（点击图钉后不自动消失）
  let mouseOnCard = false; // 鼠标是否在卡片上（滚动时不隐藏）

  // ── 扩展上下文有效性检查 ──────────────────────────
  function isContextValid() {
    try {
      return !!chrome.runtime && !!chrome.runtime.id;
    } catch (e) {
      return false;
    }
  }

  // ── 安全消息发送（防止 context invalidated 崩溃）─────
  function safeSendMessage(message, callback) {
    if (!isContextValid()) {
      // 上下文已失效（扩展被重载/更新），静默失败
      if (callback) callback(null);
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        // 忽略 context invalidated 错误
        if (chrome.runtime.lastError) {
          console.warn("[选股助手] 消息发送失败:", chrome.runtime.lastError.message);
          if (callback) callback(null);
          return;
        }
        if (callback) callback(resp);
      });
    } catch (e) {
      console.warn("[选股助手] 消息发送异常:", e.message);
      if (callback) callback(null);
    }
  }

  // ── 判断选中文本是否可能是股票 ───────────────────────
  function looksLikeStock(text) {
    const t = text.trim();
    if (!t || t.length > 20) return false;
    // 纯数字代码 5~6 位
    if (/^\d{5,6}$/.test(t)) return true;
    // 字母代码（美股等）2~6 位大写
    if (/^[A-Z]{2,6}$/.test(t)) return true;
    // 中文名称：3~8 个汉字，不含标点
    if (/^[\u4e00-\u9fa5]{3,8}$/.test(t)) return true;
    return false;
  }

  // ── 创建卡片 DOM ────────────────────────────────────
  function createCard() {
    const el = document.createElement("div");
    el.id = "stock-quote-card";
    el.innerHTML = `
      <div class="sqc-header">
        <span class="sqc-name"></span>
        <span class="sqc-code"></span>
        <span class="sqc-pin sqc-icon-btn" title="固定（固定后不自动消失）">📌</span>
        <span class="sqc-expand sqc-icon-btn" title="在工作台中打开">⛶</span>
        <span class="sqc-star sqc-icon-btn" title="加入自选">☆</span>
        <span class="sqc-bell sqc-icon-btn" title="价格预警">🔔</span>
        <span class="sqc-portfolio sqc-icon-btn" title="持仓">💼</span>
        <span class="sqc-close" title="关闭">&times;</span>
      </div>
      <div class="sqc-tabs">
        <span class="sqc-tab active" data-tab="quote">行情</span>
        <span class="sqc-tab" data-tab="flow">资金</span>
        <span class="sqc-tab" data-tab="related">相关</span>
        <span class="sqc-tab" data-tab="news">公告</span>
      </div>
      <div class="sqc-tab-panel active" data-panel="quote">
        <div class="sqc-body">
          <div class="sqc-loading">查询中…</div>
        </div>
        <div class="sqc-chart-wrap" style="display:none;">
          <canvas class="sqc-chart"></canvas>
          <div class="sqc-chart-time">
            <span class="sqc-time-start">09:30</span>
            <span class="sqc-time-end">15:00</span>
          </div>
        </div>
      </div>
      <div class="sqc-tab-panel" data-panel="flow">
        <div class="sqc-flow-body">
          <div class="sqc-loading">加载中…</div>
        </div>
      </div>
      <div class="sqc-tab-panel" data-panel="related">
        <div class="sqc-related-body">
          <div class="sqc-loading">加载中…</div>
        </div>
      </div>
      <div class="sqc-tab-panel" data-panel="news">
        <div class="sqc-news-body">
          <div class="sqc-loading">加载中…</div>
        </div>
      </div>
      <div class="sqc-alert-panel" style="display:none;">
        <div class="sqc-alert-row">
          <select class="sqc-alert-type">
            <option value="above">涨到</option>
            <option value="below">跌到</option>
            <option value="pct">涨跌幅达</option>
          </select>
          <input class="sqc-alert-val" type="number" placeholder="目标值" step="0.01"/>
          <span class="sqc-alert-unit">元</span>
          <button class="sqc-alert-set">设置</button>
        </div>
      </div>
      <div class="sqc-position-panel" style="display:none;">
        <div class="sqc-position-info" style="display:none;"></div>
        <div class="sqc-position-row">
          <label>买入价</label>
          <input class="sqc-pos-cost" type="number" placeholder="0.00" step="0.01"/>
          <label>数量</label>
          <input class="sqc-pos-qty" type="number" placeholder="100" step="1"/>
          <button class="sqc-pos-set">保存</button>
        </div>
      </div>
    `;
    document.body.appendChild(el);

    // 事件绑定
    el.querySelector(".sqc-close").addEventListener("click", (e) => {
      e.stopPropagation();
      hideCard();
    });
    el.querySelector(".sqc-pin").addEventListener("click", (e) => {
      e.stopPropagation();
      togglePin();
    });
    const expandBtn = el.querySelector(".sqc-expand");
    if (expandBtn) expandBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      expandToDashboard();
    });
    el.querySelector(".sqc-star").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleWatchlist();
    });
    el.querySelector(".sqc-bell").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleAlertPanel();
    });
    el.querySelector(".sqc-portfolio").addEventListener("click", (e) => {
      e.stopPropagation();
      togglePositionPanel();
    });
    el.querySelector(".sqc-pos-set").addEventListener("click", (e) => {
      e.stopPropagation();
      savePosition();
    });
    el.querySelector(".sqc-alert-set").addEventListener("click", (e) => {
      e.stopPropagation();
      setAlert();
    });
    // 预警类型变化时自动切换单位
    el.querySelector(".sqc-alert-type").addEventListener("change", (e) => {
      const type = e.target.value;
      el.querySelector(".sqc-alert-unit").textContent = type === "pct" ? "%" : "元";
    });

    // Tab 切换
    el.querySelectorAll(".sqc-tab").forEach((tab) => {
      tab.addEventListener("click", (e) => {
        e.stopPropagation();
        const tabName = tab.dataset.tab;
        el.querySelectorAll(".sqc-tab").forEach((t) => t.classList.remove("active"));
        el.querySelectorAll(".sqc-tab-panel").forEach((p) => p.classList.remove("active"));
        tab.classList.add("active");
        el.querySelector(`.sqc-tab-panel[data-panel="${tabName}"]`).classList.add("active");
        // 懒加载：切到对应 tab 时才拉取数据
        if (tabName === "flow" && !card._flowLoaded) loadFundFlow();
        if (tabName === "related" && !card._relatedLoaded) loadRelatedStocks();
        if (tabName === "news" && !card._newsLoaded) loadAnnouncements();
        // 重新定位
        if (card._lastRect) positionCard(card._lastRect);
      });
    });

    // 鼠标进出卡片
    el.addEventListener("mouseleave", () => {
      mouseOnCard = false;
      if (pinned) return;
      hideTimer = setTimeout(hideCard, 1500);
    });
    el.addEventListener("mouseenter", () => {
      mouseOnCard = true;
      if (hideTimer) clearTimeout(hideTimer);
    });

    // 阻止卡片内的事件冒泡到 document，防止触发 mouseup 重新弹卡
    el.addEventListener("mouseup", (e) => e.stopPropagation());
    el.addEventListener("mousedown", (e) => e.stopPropagation());

    return el;
  }

  function hideCard() {
    if (card) {
      card.remove();
      card = null;
    }
    currentData = null;
    pinned = false;
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }

  // ── 固定/取消固定 ──────────────────────────────────
  function expandToDashboard() {
    const params = new URLSearchParams();
    if (currentData) {
      if (currentData.secid) params.set("secid", currentData.secid);
      if (currentData.name) params.set("name", currentData.name);
      if (currentData.code) params.set("code", currentData.code);
    }
    const url = chrome.runtime.getURL("dashboard.html" + (params.toString() ? "?" + params.toString() : ""));
    chrome.tabs.create({ url });
  }

  function togglePin() {
    pinned = !pinned;
    const pinBtn = card.querySelector(".sqc-pin");
    if (pinned) {
      pinBtn.classList.add("sqc-pinned");
      pinBtn.style.opacity = "1";
    } else {
      pinBtn.classList.remove("sqc-pinned");
      pinBtn.style.opacity = "";
    }
  }

  // ── 定位卡片 ────────────────────────────────────────
  function positionCard(rect) {
    if (!card) return;
    const cardW = 320;
    const gap = 12;
    // 先让卡片可见以获取真实高度
    card.style.visibility = "hidden";
    card.style.left = "0px";
    card.style.top = "0px";
    const cardH = card.offsetHeight || 300;
    card.style.visibility = "";

    let left = rect.left + rect.width / 2 - cardW / 2;
    let top = rect.bottom + gap;
    if (left < 8) left = 8;
    if (left + cardW > window.innerWidth - 8)
      left = window.innerWidth - cardW - 8;
    if (top + cardH > window.innerHeight - 8) {
      // 尝试放在上方
      top = rect.top - cardH - gap;
      // 上方也放不下 → 放在视口内尽量靠上
      if (top < 8) top = 8;
    }
    card.style.left = left + "px";
    card.style.top = top + "px";
  }

  // ── 渲染行情数据 ────────────────────────────────────
  // ── 安全数值格式化（防止 null/undefined 崩溃）────────
  function safeNum(v, decimals = 2) {
    if (v === null || v === undefined || v === "-" || isNaN(v)) return "--";
    return Number(v).toFixed(decimals);
  }
  function safePct(v) {
    if (v === null || v === undefined || isNaN(v)) return "--";
    return Number(v).toFixed(2) + "%";
  }

  function renderQuote(data) {
    if (!card) return;
    currentData = data;

    // 安全取值
    const change = data.change ?? 0;
    const isUp = change >= 0;
    const colorClass = isUp ? "sqc-up" : "sqc-down";
    const arrow = isUp ? "▲" : "▼";
    const sign = isUp ? "+" : "";

    card.querySelector(".sqc-name").textContent = data.name || data.code;
    card.querySelector(".sqc-code").textContent = data.code;

    // 检查自选状态
    safeSendMessage(
      { action: "checkWatchlist", secid: data.secid },
      (resp) => {
        if (card && resp && resp.success && resp.data) {
          card.querySelector(".sqc-star").textContent = "★";
          card.querySelector(".sqc-star").classList.add("sqc-starred");
        }
      }
    );

    card.querySelector(".sqc-body").innerHTML = `
      <div class="sqc-price-row">
        <span class="sqc-price ${colorClass}">${safeNum(data.price)}</span>
        <span class="sqc-change ${colorClass}">${arrow} ${sign}${safeNum(data.change)}</span>
        <span class="sqc-pct ${colorClass}">${sign}${safePct(data.changePercent)}</span>
      </div>
      <div class="sqc-grid">
        <div class="sqc-item"><span class="sqc-label">今开</span><span class="sqc-val">${safeNum(data.open)}</span></div>
        <div class="sqc-item"><span class="sqc-label">昨收</span><span class="sqc-val">${safeNum(data.preClose)}</span></div>
        <div class="sqc-item"><span class="sqc-label">最高</span><span class="sqc-val sqc-up">${safeNum(data.high)}</span></div>
        <div class="sqc-item"><span class="sqc-label">最低</span><span class="sqc-val sqc-down">${safeNum(data.low)}</span></div>
        <div class="sqc-item"><span class="sqc-label">成交量</span><span class="sqc-val">${formatVolume(data.volume)}</span></div>
        <div class="sqc-item"><span class="sqc-label">成交额</span><span class="sqc-val">${formatAmount(data.amount)}</span></div>
        <div class="sqc-item"><span class="sqc-label">振幅</span><span class="sqc-val">${safePct(data.amplitude)}</span></div>
      </div>
    `;

    // 拉取分时图
    if (data.secid && data.preClose) {
      loadTrendChart(data.secid, data.preClose);
    }
  }

  function showError(msg) {
    if (!card) return;
    card.querySelector(".sqc-body").innerHTML = `<div class="sqc-error">${msg}</div>`;
    card.querySelector(".sqc-chart-wrap").style.display = "none";
  }

  // ── 资金流向 ──────────────────────────────────────────
  function loadFundFlow() {
    if (!currentData) return;
    card._flowLoaded = true;
    safeSendMessage(
      { action: "getFundFlow", secid: currentData.secid },
      (resp) => {
        if (!card) return;
        const body = card.querySelector(".sqc-flow-body");
        if (!resp || !resp.success || !resp.data) {
          body.innerHTML = '<div class="sqc-error">暂无资金流向数据</div>';
          return;
        }
        renderFundFlow(resp.data);
      }
    );
  }

  function renderFundFlow(flow) {
    const body = card.querySelector(".sqc-flow-body");
    const items = [
      { label: "主力", val: flow.main, cls: "sqc-flow-main" },
      { label: "超大单", val: flow.superLarge, cls: "" },
      { label: "大单", val: flow.large, cls: "" },
      { label: "中单", val: flow.medium, cls: "" },
      { label: "小单", val: flow.small, cls: "" },
    ];

    // 找到最大绝对值用于柱状图比例
    const maxAbs = Math.max(...items.map((i) => Math.abs(i.val || 0)), 1);

    body.innerHTML = `
      <div class="sqc-flow-list">
        ${items.map((item) => {
          const isPositive = (item.val || 0) >= 0;
          const pct = Math.min(Math.abs(item.val || 0) / maxAbs * 100, 100);
          const valStr = formatMoney(item.val);
          const colorClass = isPositive ? "sqc-up" : "sqc-down";
          const barClass = isPositive ? "sqc-bar-up" : "sqc-bar-down";
          return `
            <div class="sqc-flow-item">
              <span class="sqc-flow-label">${item.label}</span>
              <div class="sqc-flow-bar-wrap">
                <div class="sqc-flow-bar ${barClass}" style="width:${pct}%"></div>
              </div>
              <span class="sqc-flow-val ${colorClass}">${isPositive ? "+" : ""}${valStr}</span>
            </div>
          `;
        }).join("")}
      </div>
      <div class="sqc-flow-hint">数据来源：东方财富 · 单位：元</div>
    `;

    if (card._lastRect) positionCard(card._lastRect);
  }

  function formatMoney(val) {
    if (val === null || val === undefined || isNaN(val)) return "--";
    const abs = Math.abs(val);
    if (abs >= 100000000) return (val / 100000000).toFixed(2) + "亿";
    if (abs >= 10000) return (val / 10000).toFixed(2) + "万";
    return val.toFixed(0);
  }

  // ── 相关个股 ──────────────────────────────────────────
  function loadRelatedStocks() {
    if (!currentData) return;
    card._relatedLoaded = true;
    safeSendMessage(
      { action: "getRelatedStocks", secid: currentData.secid },
      (resp) => {
        if (!card) return;
        const body = card.querySelector(".sqc-related-body");
        if (!resp || !resp.success || !resp.data || !resp.data.stocks || resp.data.stocks.length === 0) {
          body.innerHTML = '<div class="sqc-error">暂无相关个股数据</div>';
          return;
        }
        renderRelatedStocks(resp.data);
      }
    );
  }

  function renderRelatedStocks(data) {
    const body = card.querySelector(".sqc-related-body");
    body.innerHTML = `
      <div class="sqc-related-header">所属行业：${data.boardName}</div>
      <div class="sqc-related-list">
        ${data.stocks.map((s) => {
          const isUp = (s.changePercent || 0) >= 0;
          const cls = isUp ? "sqc-up" : "sqc-down";
          const sign = isUp ? "+" : "";
          return `
            <div class="sqc-related-item" data-keyword="${s.code}" title="点击查看 ${s.name} 行情">
              <span class="sqc-related-name">${s.name}</span>
              <span class="sqc-related-code">${s.code}</span>
              <span class="sqc-related-pct ${cls}">${sign}${(s.changePercent || 0).toFixed(2)}%</span>
            </div>
          `;
        }).join("")}
      </div>
    `;

    // 点击相关个股 → 切换查询
    body.querySelectorAll(".sqc-related-item").forEach((item) => {
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        const keyword = item.dataset.keyword;
        // 重置 tab 状态
        card._flowLoaded = false;
        card._relatedLoaded = false;
        card._newsLoaded = false;
        // 切回行情 tab
        card.querySelectorAll(".sqc-tab").forEach((t) => t.classList.remove("active"));
        card.querySelectorAll(".sqc-tab-panel").forEach((p) => p.classList.remove("active"));
        card.querySelector('.sqc-tab[data-tab="quote"]').classList.add("active");
        card.querySelector('.sqc-tab-panel[data-panel="quote"]').classList.add("active");
        // 重新查询
        showCardAt(card._lastRect, keyword);
      });
    });

    if (card._lastRect) positionCard(card._lastRect);
  }

  // ── 公告列表 ──────────────────────────────────────────
  function loadAnnouncements() {
    if (!currentData) return;
    card._newsLoaded = true;
    safeSendMessage(
      { action: "getAnnouncements", secid: currentData.secid },
      (resp) => {
        if (!card) return;
        const body = card.querySelector(".sqc-news-body");
        if (!resp || !resp.success || !resp.data || resp.data.length === 0) {
          body.innerHTML = '<div class="sqc-error">暂无公告</div>';
          return;
        }
        renderAnnouncements(resp.data);
      }
    );
  }

  function renderAnnouncements(anns) {
    const body = card.querySelector(".sqc-news-body");
    body.innerHTML = `
      <div class="sqc-news-list">
        ${anns.map((a) => `
          <a class="sqc-news-item" href="https://data.eastmoney.com/notices/stock/${a.artCode}.html" target="_blank" title="${a.title}">
            <span class="sqc-news-date">${a.date}</span>
            <span class="sqc-news-title">${a.title}</span>
          </a>
        `).join("")}
      </div>
    `;

    if (card._lastRect) positionCard(card._lastRect);
  }

  // ── 迷你分时图（带价格坐标轴）────────────────────────
  function loadTrendChart(secid, preClose) {
    safeSendMessage(
      { action: "getTrend", secid },
      (resp) => {
        if (!card) return; // 卡片可能已关闭
        if (!resp || !resp.success || !resp.data) return;
        drawTrend(resp.data, preClose);
      }
    );
  }

  function drawTrend(trendData, preClose) {
    if (!card) return;
    const chartWrap = card.querySelector(".sqc-chart-wrap");
    const canvas = card.querySelector(".sqc-chart");
    const points = trendData.points;
    if (!points || points.length < 2) return;

    // 更新时间标签为实际数据的时间范围
    const firstTime = points[0].time || "";
    const lastTime = points[points.length - 1].time || "";
    const timeStartEl = card.querySelector(".sqc-time-start");
    const timeEndEl = card.querySelector(".sqc-time-end");
    if (timeStartEl) timeStartEl.textContent = firstTime.slice(11, 16) || "09:30";
    if (timeEndEl) timeEndEl.textContent = lastTime.slice(11, 16) || "15:00";

    // 布局参数：左侧留 52px 给价格标签，右侧留 8px
    const cssW = 308; // 卡片内宽 320 - padding
    const cssH = 80;
    const labelW = 48;
    const padR = 4;
    const padT = 4;
    const padB = 4;
    const plotW = cssW - labelW - padR;
    const plotH = cssH - padT - padB;

    // DPR 高清处理
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";

    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    // 计算价格范围
    const prices = points.map((p) => p.price);
    const allPrices = preClose ? [...prices, preClose] : prices;
    let minP = Math.min(...allPrices);
    let maxP = Math.max(...allPrices);
    const range = maxP - minP || 1;
    const pad = range * 0.15;
    minP -= pad;
    maxP += pad;

    const priceToY = (p) => padT + plotH - ((p - minP) / (maxP - minP)) * plotH;
    const idxToX = (i) => labelW + (i / (points.length - 1)) * plotW;

    // 1. 绘制背景网格
    ctx.strokeStyle = "#f0f0f0";
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = padT + (i / 4) * plotH;
      ctx.beginPath();
      ctx.moveTo(labelW, y);
      ctx.lineTo(cssW - padR, y);
      ctx.stroke();
    }

    // 2. 绘制昨收虚线
    if (preClose) {
      const y = priceToY(preClose);
      ctx.strokeStyle = "#999";
      ctx.lineWidth = 0.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(labelW, y);
      ctx.lineTo(cssW - padR, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 3. 绘制价格线和填充
    const lastPrice = points[points.length - 1].price;
    const isUp = lastPrice >= (preClose || points[0].price);
    const lineColor = isUp ? "#e33232" : "#00a750";
    const fillColor = isUp ? "rgba(227,50,50,0.08)" : "rgba(0,167,80,0.08)";

    // 填充
    ctx.beginPath();
    ctx.moveTo(idxToX(0), padT + plotH);
    points.forEach((p, i) => {
      ctx.lineTo(idxToX(i), priceToY(p.price));
    });
    ctx.lineTo(idxToX(points.length - 1), padT + plotH);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();

    // 线条
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = idxToX(i);
      const y = priceToY(p.price);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // 4. 绘制价格标签（Y 轴）
    ctx.font = "10px -apple-system, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    // 最高价
    ctx.fillStyle = "#e33232";
    ctx.fillText(maxP.toFixed(2), labelW - 4, priceToY(maxP));
    // 最低价
    ctx.fillStyle = "#00a750";
    ctx.fillText(minP.toFixed(2), labelW - 4, priceToY(minP));
    // 昨收价
    if (preClose) {
      ctx.fillStyle = "#999";
      ctx.fillText(preClose.toFixed(2), labelW - 4, priceToY(preClose));
    }

    // 5. 最新价点
    const lastX = idxToX(points.length - 1);
    const lastY = priceToY(lastPrice);
    ctx.fillStyle = lineColor;
    ctx.beginPath();
    ctx.arc(lastX, lastY, 2.5, 0, Math.PI * 2);
    ctx.fill();

    // 6. 右侧最新价标签
    ctx.fillStyle = lineColor;
    ctx.textAlign = "left";
    const label = lastPrice.toFixed(2);
    const labelX = Math.min(lastX + 4, cssW - padR - 30);
    // 背景小框
    ctx.fillStyle = lineColor;
    const tw = ctx.measureText(label).width + 6;
    ctx.fillRect(labelX - 1, lastY - 7, tw, 14);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, labelX + 2, lastY);

    // 显示 chart 区域
    chartWrap.style.display = "block";

    // 图表加载后卡片高度变化，重新定位
    if (card._lastRect) positionCard(card._lastRect);
  }

  // ── 自选股切换 ──────────────────────────────────────
  function toggleWatchlist() {
    if (!currentData) return;
    const star = card.querySelector(".sqc-star");
    const isStarred = star.classList.contains("sqc-starred");

    if (isStarred) {
      safeSendMessage(
        { action: "removeFromWatchlist", secid: currentData.secid },
        () => {
          if (!card) return;
          star.textContent = "☆";
          star.classList.remove("sqc-starred");
        }
      );
    } else {
      safeSendMessage(
        {
          action: "addToWatchlist",
          stock: {
            secid: currentData.secid,
            code: currentData.code,
            name: currentData.name,
          },
        },
        () => {
          if (!card) return;
          star.textContent = "★";
          star.classList.add("sqc-starred");
        }
      );
    }
  }

  // ── 价格预警面板 ────────────────────────────────────
  function toggleAlertPanel() {
    if (!currentData) return;
    const panel = card.querySelector(".sqc-alert-panel");
    const isVisible = panel.style.display !== "none";
    panel.style.display = isVisible ? "none" : "block";

    if (!isVisible) {
      // 安全设置默认值
      const defaultPrice = (currentData.price != null && !isNaN(currentData.price)) 
        ? currentData.price.toFixed(2) 
        : "";
      card.querySelector(".sqc-alert-val").value = defaultPrice;
      // 根据当前类型设置单位
      const type = card.querySelector(".sqc-alert-type").value;
      card.querySelector(".sqc-alert-unit").textContent = type === "pct" ? "%" : "元";
    }
  }

  function setAlert() {
    if (!currentData) return;
    const type = card.querySelector(".sqc-alert-type").value;
    const val = parseFloat(card.querySelector(".sqc-alert-val").value);
    if (isNaN(val)) return;

    safeSendMessage(
      {
        action: "addAlert",
        alert: {
          secid: currentData.secid,
          code: currentData.code,
          name: currentData.name,
          type,
          target: val,
        },
      },
      () => {
        if (!card) return;
        card.querySelector(".sqc-alert-panel").innerHTML =
          '<div class="sqc-alert-done">✅ 预警已设置，达到条件时将通知你</div>';
      }
    );
  }

  // ── 持仓面板 ──────────────────────────────────────────
  function togglePositionPanel() {
    if (!currentData) return;
    const panel = card.querySelector(".sqc-position-panel");
    const isVisible = panel.style.display !== "none";
    panel.style.display = isVisible ? "none" : "block";

    if (!isVisible) {
      // 填入当前价作为默认买入价
      const defaultPrice = (currentData.price != null && !isNaN(currentData.price))
        ? currentData.price.toFixed(2)
        : "";
      card.querySelector(".sqc-pos-cost").value = defaultPrice;
      card.querySelector(".sqc-pos-qty").value = "100";

      // 检查是否已有持仓
      safeSendMessage(
        { action: "getPosition", secid: currentData.secid },
        (resp) => {
          if (!card || !resp || !resp.success || !resp.data) return;
          const pos = resp.data;
          const infoEl = card.querySelector(".sqc-position-info");
          const currentPrice = currentData.price || 0;
          const profit = (currentPrice - pos.costPrice) * pos.quantity;
          const profitPct = pos.costPrice > 0 ? ((currentPrice - pos.costPrice) / pos.costPrice) * 100 : 0;
          const isProfit = profit >= 0;
          const cls = isProfit ? "sqc-up" : "sqc-down";
          infoEl.style.display = "block";
          infoEl.innerHTML = `
            <div class="sqc-pos-existing">
              <span>已有持仓：${pos.quantity} 股 @ ${safeNum(pos.costPrice)}</span>
              <span class="${cls}" style="font-weight:600;">
                ${isProfit ? "+" : ""}${profit.toFixed(2)} (${isProfit ? "+" : ""}${profitPct.toFixed(2)}%)
              </span>
              <span class="sqc-pos-remove" data-id="${pos.id}" title="删除持仓">移除</span>
            </div>
          `;
          // 回填到输入框
          card.querySelector(".sqc-pos-cost").value = pos.costPrice;
          card.querySelector(".sqc-pos-qty").value = pos.quantity;
          // 绑定移除
          infoEl.querySelector(".sqc-pos-remove").addEventListener("click", (e) => {
            e.stopPropagation();
            safeSendMessage(
              { action: "removePosition", id: pos.id },
              () => {
                if (!card) return;
                infoEl.style.display = "none";
                infoEl.innerHTML = "";
                showPositionToast("持仓已移除");
              }
            );
          });
          if (card._lastRect) positionCard(card._lastRect);
        }
      );
    }
  }

  function savePosition() {
    if (!currentData) return;
    const cost = parseFloat(card.querySelector(".sqc-pos-cost").value);
    const qty = parseFloat(card.querySelector(".sqc-pos-qty").value);
    if (isNaN(cost) || isNaN(qty) || qty <= 0) {
      showPositionToast("请输入有效的买入价和数量");
      return;
    }

    safeSendMessage(
      {
        action: "addPosition",
        position: {
          secid: currentData.secid,
          code: currentData.code,
          name: currentData.name,
          costPrice: cost,
          quantity: qty,
        },
      },
      () => {
        if (!card) return;
        showPositionToast("✅ 持仓已保存");
        // 刷新面板
        togglePositionPanel();
        togglePositionPanel();
      }
    );
  }

  function showPositionToast(msg) {
    const panel = card.querySelector(".sqc-position-panel");
    const toast = document.createElement("div");
    toast.className = "sqc-pos-toast";
    toast.textContent = msg;
    panel.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
  }

  // ── 格式化辅助 ──────────────────────────────────────
  function formatVolume(vol) {
    if (!vol && vol !== 0) return "--";
    if (vol >= 100000000) return (vol / 100000000).toFixed(2) + "亿手";
    if (vol >= 10000) return (vol / 10000).toFixed(2) + "万手";
    return vol + "手";
  }

  function formatAmount(amt) {
    if (!amt && amt !== 0) return "--";
    if (amt >= 100000000) return (amt / 100000000).toFixed(2) + "亿";
    if (amt >= 10000) return (amt / 10000).toFixed(2) + "万";
    return amt.toFixed(0);
  }

  // ════════════════════════════════════════════════════
  // 触发方式 1：mouseup 自动弹卡
  // ════════════════════════════════════════════════════
  document.addEventListener(
    "mouseup",
    (e) => {
      // 点击在卡片内不处理
      if (card && card.contains(e.target)) return;
      // 扩展上下文检查
      if (!isContextValid()) return;
      const selection = window.getSelection();
      const text = selection ? selection.toString().trim() : "";
      if (!looksLikeStock(text)) return;
      // 确保有有效 range
      if (!selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      showCardAt(rect, text);
    },
    true
  );

  // ════════════════════════════════════════════════════
  // 触发方式 2 & 3：右键菜单 / 快捷键
  // ════════════════════════════════════════════════════
  try {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "QUERY_STOCK") {
      const selection = window.getSelection();
      let rect = getDefaultRect();
      if (selection && selection.rangeCount > 0) {
        const r = selection.getRangeAt(0).getBoundingClientRect();
        if (r.width > 0) rect = r;
      }
      showCardAt(rect, request.keyword);
    }

    if (request.type === "QUERY_SELECTED") {
      const selection = window.getSelection();
      const text = selection ? selection.toString().trim() : "";
      if (!text) return;
      let rect = getDefaultRect();
      if (selection.rangeCount > 0) {
        const r = selection.getRangeAt(0).getBoundingClientRect();
        if (r.width > 0) rect = r;
      }
      showCardAt(rect, text);
    }
  });
  } catch (e) {
    console.warn("[选股助手] onMessage 注册失败:", e.message);
  }

  function getDefaultRect() {
    return {
      left: window.innerWidth / 2 - 150,
      top: window.innerHeight / 2,
      width: 0, height: 0,
      bottom: window.innerHeight / 2,
    };
  }

  // ════════════════════════════════════════════════════
  // 公共：在指定位置弹卡
  // ════════════════════════════════════════════════════
  function showCardAt(rect, keyword) {
    // 检查扩展上下文是否有效
    if (!isContextValid()) {
      console.warn("[选股助手] 扩展上下文已失效，请刷新页面后重试");
      return;
    }
    hideCard();
    pinned = false;
    card = createCard();
    card._lastRect = rect;
    positionCard(rect);
    card.classList.add("sqc-show");

    safeSendMessage(
      { action: "getQuote", keyword },
      (resp) => {
        if (!card) return;
        if (!resp) {
          showError("扩展可能已更新，请刷新页面后重试");
          return;
        }
        if (!resp.success) {
          showError(resp?.error || "未找到该股票");
          return;
        }
        renderQuote(resp.data);
        card._lastRect = rect;
        positionCard(rect);
      }
    );
  }

  // ════════════════════════════════════════════════════
  // 滚动处理：防抖，滚动停止 600ms 后如果鼠标不在卡片上才隐藏
  // ════════════════════════════════════════════════════
  window.addEventListener(
    "scroll",
    () => {
      if (!card || pinned) return;
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        if (!card || pinned) return;
        // 检查鼠标是否还在卡片上
        if (mouseOnCard) return; // 在卡片上就不隐藏
        // 卡片跟着选中文本滚动消失了，隐藏卡片
        hideCard();
      }, 600);
    },
    true
  );

  // ════════════════════════════════════════════════════
  // 点击空白处隐藏（仅当不是固定、且不是在选词操作时）
  // ════════════════════════════════════════════════════
  document.addEventListener("mousedown", (e) => {
    if (!card || pinned) return;
    if (card.contains(e.target)) return;
    // 如果用户正在选词（有选中文本），不隐藏
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) return;
    hideCard();
  });

  // ════════════════════════════════════════════════════
  // 按 Esc 关闭卡片
  // ════════════════════════════════════════════════════
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && card) {
      hideCard();
    }
  });
})();
