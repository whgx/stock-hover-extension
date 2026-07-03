/**
 * popup.js (v4.0) — Popup 页面逻辑
 * 功能：实时模糊搜索 + 下拉候选 + 自选股管理 + 持仓管理（增删改） + 预警管理（增删改）
 */

// ════════════════════════════════════════════════════
// 全局状态
// ════════════════════════════════════════════════════
let currentTab = "watchlist";
let searchDebounceTimer = null;
let searchResults = [];
let searchHighlightIndex = -1;

// ════════════════════════════════════════════════════
// Toast 提示
// ════════════════════════════════════════════════════
function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 1500);
}

// ════════════════════════════════════════════════════
// 安全格式化
// ════════════════════════════════════════════════════
function safeNum(v, decimals = 2) {
  if (v == null || isNaN(v)) return "--";
  return Number(v).toFixed(decimals);
}

// ════════════════════════════════════════════════════
// 初始化
// ════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", () => {
  // ── Tab 切换 ──────────────────────────────────────
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
      tab.classList.add("active");
      currentTab = tab.dataset.tab;
      document.getElementById("tab-" + currentTab).classList.add("active");
      hideSearchDropdown();
      document.getElementById("searchInput").focus();

      if (currentTab === "watchlist") loadWatchlist();
      if (currentTab === "alerts") loadAlerts();
      if (currentTab === "portfolio") loadPortfolio();
    });
  });

  // ── 搜索框：实时模糊搜索 ──────────────────────────
  const searchInput = document.getElementById("searchInput");
  searchInput.addEventListener("input", () => {
    const keyword = searchInput.value.trim();
    if (!keyword || keyword.length < 1) {
      hideSearchDropdown();
      return;
    }
    // 防抖 250ms
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => doSearch(keyword), 250);
  });

  // 键盘导航：上下选择，回车确认，Esc 关闭
  searchInput.addEventListener("keydown", (e) => {
    const dropdown = document.getElementById("searchDropdown");
    if (!dropdown.classList.contains("show")) {
      if (e.key === "Enter") {
        const keyword = searchInput.value.trim();
        if (keyword) doSearch(keyword);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      searchHighlightIndex = Math.min(searchHighlightIndex + 1, searchResults.length - 1);
      renderSearchResults();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      searchHighlightIndex = Math.max(searchHighlightIndex - 1, 0);
      renderSearchResults();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (searchHighlightIndex >= 0 && searchResults[searchHighlightIndex]) {
        onSearchItemSelect(searchResults[searchHighlightIndex]);
      }
    } else if (e.key === "Escape") {
      hideSearchDropdown();
    }
  });

  // 点击其他地方关闭下拉
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-bar")) hideSearchDropdown();
  });

  // ── 刷新按钮 ──────────────────────────────────────
  document.getElementById("refreshBtn").addEventListener("click", (e) => {
    e.preventDefault();
    if (currentTab === "watchlist") loadWatchlist();
    if (currentTab === "alerts") loadAlerts();
    if (currentTab === "portfolio") loadPortfolio();
    showToast("已刷新");
  });

  // ── 打开工作台 ────────────────────────────────────
  const openDash = (e) => {
    if (e) e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  };
  document.getElementById("openDashboard")?.addEventListener("click", openDash);
  document.getElementById("openDashboardFooter")?.addEventListener("click", openDash);

  // 初始加载
  loadWatchlist();
  loadAllCounts();
});

// ════════════════════════════════════════════════════
// 搜索逻辑
// ════════════════════════════════════════════════════
function doSearch(keyword) {
  const dropdown = document.getElementById("searchDropdown");
  dropdown.innerHTML = '<div class="search-loading">搜索中...</div>';
  dropdown.classList.add("show");
  searchHighlightIndex = -1;

  chrome.runtime.sendMessage({ action: "searchList", keyword }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.success) {
      dropdown.innerHTML = '<div class="search-empty">搜索失败，请重试</div>';
      return;
    }
    searchResults = resp.data ?? [];
    renderSearchResults();
  });
}

function renderSearchResults() {
  const dropdown = document.getElementById("searchDropdown");
  if (searchResults.length === 0) {
    dropdown.innerHTML = '<div class="search-empty">未找到匹配的股票</div>';
    return;
  }

  dropdown.innerHTML = searchResults
    .map((item, idx) => {
      const hlClass = idx === searchHighlightIndex ? " highlighted" : "";
      return `
      <div class="search-item${hlClass}" data-index="${idx}">
        <span class="search-item-name">${item.name}</span>
        <span class="search-item-code">${item.code}</span>
        ${item.marketType ? `<span class="search-item-market">${item.marketType}</span>` : ""}
        <div class="search-item-actions">
          ${currentTab === "watchlist" ? `<button class="search-action-btn star" data-act="star" data-index="${idx}">+自选</button>` : ""}
          ${currentTab === "alerts" ? `<button class="search-action-btn" data-act="alert" data-index="${idx}">+预警</button>` : ""}
          ${currentTab === "portfolio" ? `<button class="search-action-btn pos" data-act="position" data-index="${idx}">+持仓</button>` : ""}
        </div>
      </div>`;
    })
    .join("");

  // 绑定点击事件
  dropdown.querySelectorAll(".search-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      const btn = e.target.closest(".search-action-btn");
      const idx = parseInt(el.dataset.index);
      if (btn) {
        e.stopPropagation();
        const act = btn.dataset.act;
        onSearchItemAction(searchResults[idx], act);
      } else {
        onSearchItemSelect(searchResults[idx]);
      }
    });
  });
}

function onSearchItemSelect(item) {
  // 根据当前 Tab 决定默认操作
  if (currentTab === "watchlist") onSearchItemAction(item, "star");
  else if (currentTab === "alerts") onSearchItemAction(item, "alert");
  else if (currentTab === "portfolio") onSearchItemAction(item, "position");
  else onSearchItemAction(item, "star");
}

function onSearchItemAction(item, action) {
  if (action === "star") {
    chrome.runtime.sendMessage(
      {
        action: "addToWatchlist",
        stock: { secid: item.secid, code: item.code, name: item.name },
      },
      (resp) => {
        if (resp && resp.success) {
          showToast(`已添加「${item.name}」到自选`);
          hideSearchDropdown();
          document.getElementById("searchInput").value = "";
          loadWatchlist();
          loadAllCounts();
        }
      }
    );
  } else if (action === "alert") {
    showAddAlertPanel(item);
  } else if (action === "position") {
    showAddPositionPanel(item);
  }
}

function hideSearchDropdown() {
  document.getElementById("searchDropdown").classList.remove("show");
  searchHighlightIndex = -1;
}

// ════════════════════════════════════════════════════
// 自选股列表
// ════════════════════════════════════════════════════
function loadWatchlist() {
  chrome.runtime.sendMessage({ action: "getWatchlistQuotes" }, (resp) => {
    const container = document.getElementById("watchlistContainer");
    if (chrome.runtime.lastError || !resp || !resp.success) {
      container.innerHTML = '<div class="empty"><div class="empty-icon">📈</div>加载失败，请重试</div>';
      updateCount("watchlistCount", 0);
      return;
    }

    const list = resp.data ?? [];
    updateCount("watchlistCount", list.length);

    if (list.length === 0) {
      container.innerHTML =
        '<div class="empty"><div class="empty-icon">⭐</div>暂无自选股<br><span style="font-size:12px">上方搜索框输入股票名称或代码添加</span></div>';
      return;
    }

    container.innerHTML = list
      .map((s) => {
        const price = safeNum(s.price);
        const changePct = safeNum(s.changePercent);
        const change = safeNum(s.change);
        const isUp = (s.change || 0) >= 0;
        const cls = isUp ? "up" : "down";
        const sign = isUp ? "+" : "";
        return `
        <div class="stock-row">
          <div class="stock-info">
            <span class="stock-name">${s.name || "--"}</span>
            <span class="stock-code">${s.code || "--"}</span>
          </div>
          <div class="stock-price-info">
            <div class="stock-price ${cls}">${price}</div>
            <div class="stock-pct ${cls}">${sign}${changePct}%</div>
          </div>
          <span class="remove-btn" data-secid="${s.secid}" title="移除">×</span>
        </div>`;
      })
      .join("");

    container.querySelectorAll(".remove-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        chrome.runtime.sendMessage(
          { action: "removeFromWatchlist", secid: btn.dataset.secid },
          () => {
            loadWatchlist();
            loadAllCounts();
          }
        );
      });
    });
  });
}

// ════════════════════════════════════════════════════
// 价格预警 — 列表 + 添加 + 编辑 + 删除
// ════════════════════════════════════════════════════
function loadAlerts() {
  chrome.runtime.sendMessage({ action: "getAlerts" }, (resp) => {
    const container = document.getElementById("alertsContainer");
    if (!resp || !resp.success) {
      container.innerHTML = '<div class="empty"><div class="empty-icon">🔔</div>加载失败</div>';
      updateCount("alertsCount", 0);
      return;
    }

    const alerts = resp.data ?? [];
    updateCount("alertsCount", alerts.length);

    if (alerts.length === 0) {
      container.innerHTML =
        '<div class="empty"><div class="empty-icon">🔔</div>暂无价格预警<br><span style="font-size:12px">搜索股票后点击「+预警」添加</span></div>';
      return;
    }

    const typeLabel = { above: "涨到", below: "跌到", pct: "涨跌幅达" };
    const typeUnit = { above: "元", below: "元", pct: "%" };

    container.innerHTML = alerts
      .map((a) => {
        const triggeredCls = a.triggered ? " alert-triggered" : "";
        return `
        <div class="alert-row${triggeredCls}" data-id="${a.id}">
          <div class="alert-info">
            <div class="alert-title">${a.name} (${a.code})</div>
            <div class="alert-desc">${typeLabel[a.type]} ${a.target} ${typeUnit[a.type]} ${
          a.triggered ? "· 已触发" : "· 监控中"
        }</div>
          </div>
          <span class="alert-edit-btn" data-id="${a.id}" data-action="edit">编辑</span>
          <span class="remove-btn" data-id="${a.id}" title="删除">×</span>
        </div>`;
      })
      .join("");

    // 编辑按钮
    container.querySelectorAll(".alert-edit-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const alert = alerts.find((a) => a.id === id);
        if (alert) showEditAlertPanel(alert);
      });
    });

    // 删除按钮
    container.querySelectorAll(".remove-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        chrome.runtime.sendMessage(
          { action: "removeAlert", id: btn.dataset.id },
          () => {
            loadAlerts();
            loadAllCounts();
          }
        );
      });
    });
  });
}

// 添加预警面板（搜索结果触发）
function showAddAlertPanel(item) {
  hideSearchDropdown();
  document.getElementById("searchInput").value = "";
  const container = document.getElementById("alertsContainer");

  // 在列表顶部插入编辑面板
  const panel = document.createElement("div");
  panel.className = "edit-panel";
  panel.id = "alertEditPanel";

  chrome.runtime.sendMessage({ action: "getQuoteBySecid", secid: item.secid }, (resp) => {
    const currentPrice = resp?.success ? safeNum(resp.data.price, 2) : "--";
    panel.innerHTML = `
      <div class="edit-panel-title">🔔 添加预警 — ${item.name} (${item.code})</div>
      <div class="edit-panel-row">
        <label>当前价</label>
        <input type="text" value="${currentPrice}" disabled style="background:#f8f9fa;cursor:not-allowed" />
      </div>
      <div class="edit-panel-row">
        <label>条件</label>
        <select id="alertType">
          <option value="above">涨到</option>
          <option value="below">跌到</option>
          <option value="pct">涨跌幅达</option>
        </select>
        <input id="alertTarget" type="number" placeholder="目标值" step="0.01" style="flex:1" />
        <span id="alertUnit" style="font-size:12px;color:#888;width:20px">元</span>
      </div>
      <div class="edit-panel-actions">
        <button class="btn-cancel" onclick="document.getElementById('alertEditPanel').remove()">取消</button>
        <button class="btn-save" id="alertSaveBtn">设置预警</button>
      </div>
    `;
    container.insertBefore(panel, container.firstChild);

    // 条件切换时更新单位
    document.getElementById("alertType").addEventListener("change", (e) => {
      document.getElementById("alertUnit").textContent = e.target.value === "pct" ? "%" : "元";
    });

    // 保存按钮
    document.getElementById("alertSaveBtn").addEventListener("click", () => {
      const type = document.getElementById("alertType").value;
      const target = parseFloat(document.getElementById("alertTarget").value);
      if (isNaN(target) || target <= 0) {
        showToast("请输入有效目标值");
        return;
      }
      chrome.runtime.sendMessage(
        {
          action: "addAlert",
          alert: { secid: item.secid, code: item.code, name: item.name, type, target },
        },
        () => {
          showToast(`已设置「${item.name}」预警`);
          panel.remove();
          loadAlerts();
          loadAllCounts();
        }
      );
    });
  });
}

// 编辑已有预警
function showEditAlertPanel(alert) {
  const container = document.getElementById("alertsContainer");
  // 移除已有的编辑面板
  const existing = document.getElementById("alertEditPanel");
  if (existing) existing.remove();

  const panel = document.createElement("div");
  panel.className = "edit-panel";
  panel.id = "alertEditPanel";
  panel.innerHTML = `
    <div class="edit-panel-title">✏️ 编辑预警 — ${alert.name} (${alert.code})</div>
    <div class="edit-panel-row">
      <label>条件</label>
      <select id="alertEditType">
        <option value="above" ${alert.type === "above" ? "selected" : ""}>涨到</option>
        <option value="below" ${alert.type === "below" ? "selected" : ""}>跌到</option>
        <option value="pct" ${alert.type === "pct" ? "selected" : ""}>涨跌幅达</option>
      </select>
      <input id="alertEditTarget" type="number" value="${alert.target}" step="0.01" style="flex:1" />
      <span id="alertEditUnit" style="font-size:12px;color:#888;width:20px">${alert.type === "pct" ? "%" : "元"}</span>
    </div>
    <div class="edit-panel-actions">
      <button class="btn-cancel" onclick="document.getElementById('alertEditPanel').remove()">取消</button>
      <button class="btn-save" id="alertEditSaveBtn">保存修改</button>
    </div>
  `;

  // 插入到该预警行的上方
  const rows = container.querySelectorAll(".alert-row");
  let targetRow = null;
  rows.forEach((r) => {
    if (r.dataset.id === alert.id) targetRow = r;
  });
  if (targetRow) {
    container.insertBefore(panel, targetRow);
  } else {
    container.insertBefore(panel, container.firstChild);
  }

  // 条件切换
  document.getElementById("alertEditType").addEventListener("change", (e) => {
    document.getElementById("alertEditUnit").textContent = e.target.value === "pct" ? "%" : "元";
  });

  // 保存
  document.getElementById("alertEditSaveBtn").addEventListener("click", () => {
    const type = document.getElementById("alertEditType").value;
    const target = parseFloat(document.getElementById("alertEditTarget").value);
    if (isNaN(target) || target <= 0) {
      showToast("请输入有效目标值");
      return;
    }
    // 先删除再添加（简单实现 update）
    chrome.runtime.sendMessage(
      { action: "removeAlert", id: alert.id },
      () => {
        chrome.runtime.sendMessage(
          {
            action: "addAlert",
            alert: { secid: alert.secid, code: alert.code, name: alert.name, type, target },
          },
          () => {
            showToast("预警已更新");
            panel.remove();
            loadAlerts();
            loadAllCounts();
          }
        );
      }
    );
  });
}

// ════════════════════════════════════════════════════
// 持仓 — 列表 + 添加 + 编辑 + 删除
// ════════════════════════════════════════════════════
function loadPortfolio() {
  chrome.runtime.sendMessage({ action: "getPortfolioQuotes" }, (resp) => {
    const container = document.getElementById("portfolioContainer");
    if (chrome.runtime.lastError || !resp || !resp.success) {
      container.innerHTML = '<div class="empty"><div class="empty-icon">💼</div>加载失败，请重试</div>';
      updateCount("portfolioCount", 0);
      return;
    }

    const list = resp.data ?? [];
    updateCount("portfolioCount", list.length);

    if (list.length === 0) {
      container.innerHTML =
        '<div class="empty"><div class="empty-icon">💼</div>暂无持仓<br><span style="font-size:12px">搜索股票后点击「+持仓」录入</span></div>';
      return;
    }

    // 计算汇总
    let totalProfit = 0;
    let totalCost = 0;
    let totalMarketValue = 0;
    list.forEach((p) => {
      totalProfit += p.profit || 0;
      totalCost += p.totalCost || 0;
      totalMarketValue += p.marketValue || 0;
    });
    const totalProfitPct = totalCost > 0 ? (totalProfit / totalCost) * 100 : 0;
    const isProfit = totalProfit >= 0;
    const summaryCls = isProfit ? "up" : "down";

    let html = `
      <div class="portfolio-summary">
        <div class="portfolio-summary-label">总盈亏</div>
        <div class="portfolio-summary-val ${summaryCls}">
          ${isProfit ? "+" : ""}${totalProfit.toFixed(2)}
        </div>
        <div class="portfolio-summary-pct ${summaryCls}">
          ${isProfit ? "+" : ""}${totalProfitPct.toFixed(2)}%
        </div>
        <div style="font-size:11px;color:#aaa;margin-top:4px;">
          市值 ${totalMarketValue.toFixed(0)} · 成本 ${totalCost.toFixed(0)}
        </div>
      </div>
    `;

    html += list
      .map((p) => {
        const isUp = (p.profit || 0) >= 0;
        const cls = isUp ? "up" : "down";
        const sign = isUp ? "+" : "";
        const priceStr = safeNum(p.currentPrice);
        const profitStr = (p.profit != null && !isNaN(p.profit)) ? p.profit.toFixed(2) : "--";
        const profitPctStr = (p.profitPct != null && !isNaN(p.profitPct)) ? p.profitPct.toFixed(2) : "--";
        return `
        <div class="position-row" data-id="${p.id}">
          <div class="position-info-block">
            <div>
              <span class="position-name">${p.name || "--"}</span>
              <span class="position-code">${p.code || "--"}</span>
            </div>
            <div class="position-detail">
              ${p.quantity}股 @ ${p.costPrice.toFixed(2)} · 现价 ${priceStr}
            </div>
          </div>
          <div class="position-profit">
            <div class="position-profit-val ${cls}">${sign}${profitStr}</div>
            <div class="position-profit-pct ${cls}">${sign}${profitPctStr}%</div>
          </div>
          <span class="position-edit-btn" data-id="${p.id}" data-action="edit">编辑</span>
          <span class="remove-btn" data-id="${p.id}" title="删除持仓">×</span>
        </div>`;
      })
      .join("");

    container.innerHTML = html;

    // 编辑按钮
    container.querySelectorAll(".position-edit-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const pos = list.find((p) => p.id === id);
        if (pos) showEditPositionPanel(pos);
      });
    });

    // 删除按钮
    container.querySelectorAll(".remove-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        chrome.runtime.sendMessage(
          { action: "removePosition", id: btn.dataset.id },
          () => {
            loadPortfolio();
            loadAllCounts();
          }
        );
      });
    });
  });
}

// 添加持仓面板（搜索结果触发）
function showAddPositionPanel(item) {
  hideSearchDropdown();
  document.getElementById("searchInput").value = "";
  const container = document.getElementById("portfolioContainer");

  const panel = document.createElement("div");
  panel.className = "edit-panel";
  panel.id = "positionEditPanel";

  chrome.runtime.sendMessage({ action: "getQuoteBySecid", secid: item.secid }, (resp) => {
    const currentPrice = resp?.success ? safeNum(resp.data.price, 2) : "--";
    panel.innerHTML = `
      <div class="edit-panel-title">💼 添加持仓 — ${item.name} (${item.code})</div>
      <div class="edit-panel-row">
        <label>当前价</label>
        <input type="text" value="${currentPrice}" disabled style="background:#f8f9fa;cursor:not-allowed" />
      </div>
      <div class="edit-panel-row">
        <label>买入价</label>
        <input id="posCostPrice" type="number" placeholder="成本价" step="0.001" value="${currentPrice !== '--' ? currentPrice : ''}" />
      </div>
      <div class="edit-panel-row">
        <label>数量</label>
        <input id="posQuantity" type="number" placeholder="持有股数" step="1" min="1" />
      </div>
      <div class="edit-panel-actions">
        <button class="btn-cancel" onclick="document.getElementById('positionEditPanel').remove()">取消</button>
        <button class="btn-save" id="posSaveBtn">保存持仓</button>
      </div>
    `;
    container.insertBefore(panel, container.firstChild);

    document.getElementById("posSaveBtn").addEventListener("click", () => {
      const costPrice = parseFloat(document.getElementById("posCostPrice").value);
      const quantity = parseFloat(document.getElementById("posQuantity").value);
      if (isNaN(costPrice) || costPrice <= 0) {
        showToast("请输入有效买入价");
        return;
      }
      if (isNaN(quantity) || quantity <= 0) {
        showToast("请输入有效数量");
        return;
      }
      chrome.runtime.sendMessage(
        {
          action: "addPosition",
          position: {
            secid: item.secid,
            code: item.code,
            name: item.name,
            costPrice,
            quantity,
          },
        },
        () => {
          showToast(`已添加「${item.name}」持仓`);
          panel.remove();
          loadPortfolio();
          loadAllCounts();
        }
      );
    });
  });
}

// 编辑已有持仓
function showEditPositionPanel(pos) {
  const container = document.getElementById("portfolioContainer");
  const existing = document.getElementById("positionEditPanel");
  if (existing) existing.remove();

  const panel = document.createElement("div");
  panel.className = "edit-panel";
  panel.id = "positionEditPanel";
  panel.innerHTML = `
    <div class="edit-panel-title">✏️ 编辑持仓 — ${pos.name} (${pos.code})</div>
    <div class="edit-panel-row">
      <label>买入价</label>
      <input id="posEditCost" type="number" value="${pos.costPrice.toFixed(3)}" step="0.001" />
    </div>
    <div class="edit-panel-row">
      <label>数量</label>
      <input id="posEditQty" type="number" value="${pos.quantity}" step="1" min="1" />
    </div>
    <div class="edit-panel-actions">
      <button class="btn-cancel" onclick="document.getElementById('positionEditPanel').remove()">取消</button>
      <button class="btn-save" id="posEditSaveBtn">保存修改</button>
    </div>
  `;

  // 插入到该持仓行的上方
  const rows = container.querySelectorAll(".position-row");
  let targetRow = null;
  rows.forEach((r) => {
    if (r.dataset.id === pos.id) targetRow = r;
  });
  if (targetRow) {
    container.insertBefore(panel, targetRow);
  } else {
    container.insertBefore(panel, container.firstChild);
  }

  document.getElementById("posEditSaveBtn").addEventListener("click", () => {
    const costPrice = parseFloat(document.getElementById("posEditCost").value);
    const quantity = parseFloat(document.getElementById("posEditQty").value);
    if (isNaN(costPrice) || costPrice <= 0) {
      showToast("请输入有效买入价");
      return;
    }
    if (isNaN(quantity) || quantity <= 0) {
      showToast("请输入有效数量");
      return;
    }
    chrome.runtime.sendMessage(
      {
        action: "updatePosition",
        id: pos.id,
        updates: { costPrice, quantity },
      },
      () => {
        showToast("持仓已更新");
        panel.remove();
        loadPortfolio();
      }
    );
  });
}

// ════════════════════════════════════════════════════
// Tab 角标计数
// ════════════════════════════════════════════════════
function updateCount(elementId, count) {
  const el = document.getElementById(elementId);
  if (!el) return;
  if (count > 0) {
    el.textContent = count;
    el.classList.add("show");
  } else {
    el.classList.remove("show");
  }
}

function loadAllCounts() {
  chrome.runtime.sendMessage({ action: "getWatchlist" }, (resp) => {
    if (resp && resp.success) updateCount("watchlistCount", resp.data.length);
  });
  chrome.runtime.sendMessage({ action: "getAlerts" }, (resp) => {
    if (resp && resp.success) updateCount("alertsCount", resp.data.length);
  });
  chrome.runtime.sendMessage({ action: "getPortfolio" }, (resp) => {
    if (resp && resp.success) updateCount("portfolioCount", resp.data.length);
  });
}
