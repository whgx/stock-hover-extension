/**
 * settings.js (v8.0) — 设置页面逻辑
 * 主题切换 / 刷新频率 / 数据导入导出 / CSV / 清空
 */

// ── 加载设置 ──
function loadSettings() {
  chrome.storage.local.get(["settings"], (result) => {
    const s = result.settings || {};
    document.getElementById("themeMode").value = s.themeMode || "auto";
    document.getElementById("refreshInterval").value = s.refreshInterval || 5;
    document.getElementById("alertInterval").value = s.alertInterval || 30;
  });
}

// ── 保存设置 ──
function saveSettings() {
  const settings = {
    themeMode: document.getElementById("themeMode").value,
    refreshInterval: parseInt(document.getElementById("refreshInterval").value) || 5,
    alertInterval: parseInt(document.getElementById("alertInterval").value) || 30,
  };
  chrome.storage.local.set({ settings }, () => {
    showToast("设置已保存");
  });
}

// ── 数据统计 ──
function loadDataStats() {
  chrome.storage.local.get(["watchlist", "portfolio", "alerts"], (result) => {
    document.getElementById("statWatchlist").textContent = (result.watchlist || []).length;
    document.getElementById("statPortfolio").textContent = (result.portfolio || []).length;
    document.getElementById("statAlerts").textContent = (result.alerts || []).length;
  });
}

// ── 导出 JSON ──
function exportJSON() {
  chrome.storage.local.get(["watchlist", "portfolio", "alerts", "settings"], (result) => {
    const data = {
      exportDate: new Date().toISOString(),
      watchlist: result.watchlist || [],
      portfolio: result.portfolio || [],
      alerts: result.alerts || [],
      settings: result.settings || {},
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "stock-assistant-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(url);
    showToast("已导出 JSON 文件");
  });
}

// ── 导出 CSV ──
function exportCSV() {
  chrome.storage.local.get(["portfolio"], (result) => {
    const portfolio = result.portfolio || [];
    if (portfolio.length === 0) {
      showToast("暂无持仓数据");
      return;
    }
    const header = "名称,代码,数量,成本价,买入日期\n";
    const rows = portfolio.map((p) =>
      '"' + (p.name || "") + '","' + (p.code || "") + '",' + (p.quantity || 0) + ',' + (p.avgCost || 0) + ',"' + (p.buyDate || "") + '"'
    ).join("\n");
    const csv = "\uFEFF" + header + rows; // BOM for Excel
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "portfolio-" + new Date().toISOString().slice(0, 10) + ".csv";
    a.click();
    URL.revokeObjectURL(url);
    showToast("已导出 CSV 文件");
  });
}

// ── 导入 JSON ──
function importJSON(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (!data.watchlist && !data.portfolio && !data.alerts) {
        showToast("文件格式不正确");
        return;
      }
      const toSet = {};
      if (data.watchlist) toSet.watchlist = data.watchlist;
      if (data.portfolio) toSet.portfolio = data.portfolio;
      if (data.alerts) toSet.alerts = data.alerts;
      if (data.settings) toSet.settings = data.settings;
      chrome.storage.local.set(toSet, () => {
        showToast("导入成功！");
        loadDataStats();
      });
    } catch (err) {
      showToast("文件解析失败");
    }
  };
  reader.readAsText(file);
}

// ── 清空数据 ──
function clearAllData() {
  if (!confirm("确定要清空所有数据吗？此操作不可恢复！")) return;
  if (!confirm("再次确认：所有自选股、持仓、预警将被永久删除！")) return;
  chrome.storage.local.remove(["watchlist", "portfolio", "alerts"], () => {
    showToast("已清空所有数据");
    loadDataStats();
  });
}

// ── Toast ──
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2000);
}

// ── 事件绑定 ──
document.addEventListener("DOMContentLoaded", () => {
  loadSettings();
  loadDataStats();

  document.getElementById("themeMode").addEventListener("change", saveSettings);
  document.getElementById("refreshInterval").addEventListener("change", saveSettings);
  document.getElementById("alertInterval").addEventListener("change", saveSettings);
  document.getElementById("btnExport").addEventListener("click", exportJSON);
  document.getElementById("btnExportCSV").addEventListener("click", exportCSV);
  document.getElementById("btnImport").addEventListener("click", () => {
    document.getElementById("importFile").click();
  });
  document.getElementById("importFile").addEventListener("change", (e) => {
    if (e.target.files[0]) importJSON(e.target.files[0]);
    e.target.value = "";
  });
  document.getElementById("btnClear").addEventListener("click", clearAllData);
});
