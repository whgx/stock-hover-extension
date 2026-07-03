/**
 * background.js — Service Worker (v4.1)
 * 功能：搜索股票 + 获取行情 + 分时数据 + 右键菜单 + 快捷键 + 自选股存储 + 价格预警
 *       + 资金流向 + 相关个股 + 公告列表 + 持仓盈亏跟踪 + 批量搜索(getSecid查行情)
 * v4.1 修复：push2 行情接口添加 Referer/User-Agent 头 + 腾讯接口 fallback
 */

// 东方财富请求头（防 Referer 校验导致空响应）
const EM_HEADERS = {
  "Referer": "https://quote.eastmoney.com/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

// 统一的 fetch 封装：带请求头
async function fetchWithHeaders(url) {
  const resp = await fetch(url, { headers: EM_HEADERS });
  return resp.json();
}

// ════════════════════════════════════════════════════════════
// 1. 搜索股票（中文名称 → secid）
// ════════════════════════════════════════════════════════════
async function searchStock(keyword) {
  const list = await searchStockList(keyword);
  if (!list || list.length === 0) return null;
  let best = list.find((i) => i.name === keyword || i.code === keyword);
  if (!best) best = list[0];
  return { secid: best.secid, code: best.code, name: best.name };
}

// 批量搜索：返回多条结果（用于 Popup 下拉候选）
async function searchStockList(keyword) {
  const url =
    "https://searchapi.eastmoney.com/api/suggest/get?" +
    "input=" + encodeURIComponent(keyword) +
    "&type=14&token=D43BF722C8E33BDC906FB84D85A3F42B&count=10";
  try {
    const json = await fetchWithHeaders(url);
    const list = json?.QuotationCodeTable?.Data ?? [];
    if (list.length === 0) return [];
    return list.map((i) => ({
      secid: i.QuoteID,
      code: i.Code,
      name: i.Name,
      marketType: marketName(i.QuoteID),
    }));
  } catch (e) {
    console.error("[行情助手] 搜索失败:", e);
    return [];
  }
}

// 根据 secid 前缀返回市场名称
function marketName(secid) {
  const prefix = (secid || "").split(".")[0];
  const map = { "0": "深A", "1": "沪A", "105": "美股", "106": "美股", "116": "港股" };
  return map[prefix] || "";
}

// ════════════════════════════════════════════════════════════
// 2. 主入口：关键词 → 行情数据
// ════════════════════════════════════════════════════════════
async function smartSearch(keyword) {
  const trimmed = keyword.trim();
  const baseUrl =
    "https://push2.eastmoney.com/api/qt/stock/get?" +
    "ut=fa5fd1943c7b386f172d6893dbfd32&fltt=2" +
    "&fields=f43,f44,f45,f46,f47,f48,f57,f58,f60,f107,f169,f170,f171&secid=";

  let secid = null;

  if (/^\d{5,6}$/.test(trimmed)) {
    const candidates = [];
    if (/^(60|68|90|11|13)/.test(trimmed)) candidates.push("1." + trimmed);
    if (/^(00|30|12|15)/.test(trimmed)) candidates.push("0." + trimmed);
    candidates.push("116." + trimmed); // 港股
    // 如果没有匹配前缀，尝试搜索接口回退
    if (candidates.length === 0) {
      const stock = await searchStock(trimmed);
      if (stock) {
        const data = await fetchQuote(baseUrl + stock.secid);
        if (data && data.f58) return { secid: stock.secid, ...data };
        // 腾讯 fallback
        const tcData = await fetchQuoteTencent(stock.secid);
        if (tcData) return { secid: stock.secid, ...tcData };
      }
      return null;
    }
    for (const sid of candidates) {
      const data = await fetchQuote(baseUrl + sid);
      if (data && data.f58) return { secid: sid, ...data };
    }
    // 东方财富所有候选都没找到，最后尝试搜索接口
    const stock = await searchStock(trimmed);
    if (stock) {
      const data = await fetchQuote(baseUrl + stock.secid);
      if (data && data.f58) return { secid: stock.secid, ...data };
      // 腾讯 fallback
      const tcData = await fetchQuoteTencent(stock.secid);
      if (tcData) return { secid: stock.secid, ...tcData };
    }
    // 最后兜底：尝试所有候选的腾讯接口
    for (const sid of candidates) {
      const tcData = await fetchQuoteTencent(sid);
      if (tcData) return { secid: sid, ...tcData };
    }
    return null;
  }

  const stock = await searchStock(trimmed);
  if (!stock) return null;
  secid = stock.secid;
  const data = await fetchQuote(baseUrl + secid);
  if (data && data.f58) return { secid, ...data };
  // 腾讯 fallback
  const tcData = await fetchQuoteTencent(secid);
  if (tcData) return { secid, ...tcData };
  return null;
}

async function fetchQuote(fullUrl) {
  try {
    const json = await fetchWithHeaders(fullUrl);
    return json?.data ?? null;
  } catch (e) {
    console.error("[行情助手] 获取行情失败:", e);
    return null;
  }
}

// ════════════════════════════════════════════════════════════
// 2b. 腾讯接口 fallback（当东方财富 push2 不可用时）
// ════════════════════════════════════════════════════════════
function secidToTencentCode(secid) {
  const [market, code] = secid.split(".");
  // 0.开头 → sz, 1.开头 → sh, 116.开头 → hk, 105./106. → us
  if (market === "0") return "sz" + code;
  if (market === "1") return "sh" + code;
  if (market === "116") return "hk" + code;
  // 美股：腾讯格式 usAAPL 等（不太稳定，但兜底）
  if (market === "105" || market === "106") return "us" + code;
  return null;
}

async function fetchQuoteTencent(secid) {
  const tcode = secidToTencentCode(secid);
  if (!tcode) return null;
  const url = "https://qt.gtimg.cn/q=" + tcode;
  try {
    const resp = await fetch(url);
    // 腾讯返回 GBK 编码，需要手动解码
    const buffer = await resp.arrayBuffer();
    const text = new TextDecoder("gbk").decode(buffer);
    // 腾讯返回格式：v_sh600519="1~贵州茅台~600519~1690.00~...";
    const match = text.match(/v_\w+="([^"]+)"/);
    if (!match) return null;
    const parts = match[1].split("~");
    if (parts.length < 50) return null;
    // 解析腾讯字段（索引参考）
    // parts[1]=名称, parts[2]=代码, parts[3]=当前价, parts[4]=昨收,
    // parts[5]=今开, parts[6]=成交量(手), parts[7]=外盘, parts[8]=内盘,
    // parts[31]=涨跌, parts[32]=涨跌幅, parts[33]=最高, parts[34]=最低,
    // parts[36]=成交额(万), parts[43]=振幅, parts[44]=流通市值(亿)
    return {
      f43: parseFloat(parts[3]) || 0,        // 当前价
      f44: parseFloat(parts[33]) || 0,        // 最高
      f45: parseFloat(parts[34]) || 0,        // 最低
      f46: parseFloat(parts[5]) || 0,         // 今开
      f47: parseFloat(parts[6]) * 100 || 0,   // 成交量（手→股）
      f48: parseFloat(parts[37]) * 10000 || 0, // 成交额（万→元）
      f57: parts[2],                          // 代码
      f58: parts[1],                          // 名称
      f60: parseFloat(parts[4]) || 0,         // 昨收
      f107: 0,                                // 市场类型（腾讯无此字段）
      f169: parseFloat(parts[31]) || 0,       // 涨跌额
      f170: parseFloat(parts[32]) || 0,       // 涨跌幅
      f171: parseFloat(parts[43]) || 0,       // 振幅
      _source: "tencent",
    };
  } catch (e) {
    console.error("[行情助手] 腾讯接口失败:", e);
    return null;
  }
}

// ════════════════════════════════════════════════════════════
// 3. 获取分时图数据（用于迷你 K 线图）
// ════════════════════════════════════════════════════════════
async function fetchTrendData(secid) {
  // 东方财富分时数据接口，返回当天每分钟的价格
  const url =
    "https://push2his.eastmoney.com/api/qt/stock/trends2/get?" +
    "ut=fa5fd1943c7b386f172d6893dbfd32" +
    "&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13" +
    "&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61" +
    "&ndays=1&iscr=0&secid=" + secid;

  try {
    const resp = await fetch(url);
    const json = await resp.json();
    const trends = json?.data?.trends ?? [];
    if (trends.length === 0) return null;

    // 解析格式: "2026-07-03 09:30,price,avg,open,high,vol,..."
    // parts[0]=时间 parts[1]=价格 parts[2]=均价 parts[3]=开 parts[4]=高 parts[5]=成交量(手)
    const points = trends.map((t) => {
      const parts = t.split(",");
      return {
        time: parts[0],
        price: parseFloat(parts[1]),
        avg: parseFloat(parts[2]),
        vol: parseFloat(parts[5]),
      };
    });

    return {
      preClose: json?.data?.preClose ?? 0,
      points,
    };
  } catch (e) {
    console.error("[行情助手] 分时数据获取失败:", e);
    return null;
  }
}

// ════════════════════════════════════════════════════════════
// 4. 组装行情数据
// ════════════════════════════════════════════════════════════
function buildQuoteResult(data) {
  return {
    secid: data.secid,
    code: data.f57,
    name: data.f58,
    price: data.f43,
    change: data.f169,
    changePercent: data.f170,
    high: data.f44,
    low: data.f45,
    open: data.f46,
    preClose: data.f60,
    volume: data.f47,
    amount: data.f48,
    amplitude: data.f171,
    market: data.f107,
  };
}

// ════════════════════════════════════════════════════════════
// 5. 右键菜单注册
// ════════════════════════════════════════════════════════════
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "query-stock",
    title: '查询股票行情: "%s"',
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "query-stock" || !info.selectionText) return;
  // 向当前标签页的 content script 发送指令
  chrome.tabs.sendMessage(tab.id, {
    type: "QUERY_STOCK",
    keyword: info.selectionText.trim(),
  });
});

// ════════════════════════════════════════════════════════════
// 6. 快捷键 (Alt+S)
// ════════════════════════════════════════════════════════════
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "search-stock") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "QUERY_SELECTED" });
      }
    });
  } else if (command === "open-dashboard") {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  } else if (command === "open-side-panel") {
    try {
      const win = await chrome.windows.getCurrent();
      chrome.sidePanel.open({ windowId: win.id }).catch(() => {});
    } catch(e) {}
  }
});

// ════════════════════════════════════════════════════════════
// 7. 自选股存储 (chrome.storage.local)
// ════════════════════════════════════════════════════════════
const STORAGE_KEY = "watchlist";

async function getWatchlist() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] ?? [];
}

async function addToWatchlist(stock) {
  const list = await getWatchlist();
  if (list.some((s) => s.secid === stock.secid)) return list;
  list.push(stock);
  await chrome.storage.local.set({ [STORAGE_KEY]: list });
  return list;
}

async function removeFromWatchlist(secid) {
  const list = await getWatchlist();
  const filtered = list.filter((s) => s.secid !== secid);
  await chrome.storage.local.set({ [STORAGE_KEY]: filtered });
  return filtered;
}

async function isInWatchlist(secid) {
  const list = await getWatchlist();
  return list.some((s) => s.secid === secid);
}

// ════════════════════════════════════════════════════════════
// 8. 价格预警 (alarms + notifications)
// ════════════════════════════════════════════════════════════
const ALERTS_KEY = "price_alerts";

async function getAlerts() {
  const data = await chrome.storage.local.get(ALERTS_KEY);
  return data[ALERTS_KEY] ?? [];
}

async function addAlert(alert) {
  const alerts = await getAlerts();
  alert.id = Date.now().toString();
  alert.triggered = false;
  alerts.push(alert);
  await chrome.storage.local.set({ [ALERTS_KEY]: alerts });
  return alert;
}

async function removeAlert(id) {
  const alerts = await getAlerts();
  const filtered = alerts.filter((a) => a.id !== id);
  await chrome.storage.local.set({ [ALERTS_KEY]: filtered });
  return filtered;
}

// 注册定时器：每 1 分钟检查一次预警
chrome.alarms.create("check-alerts", { periodInMinutes: 1 });

// 直接通过 secid 获取价格（不经过 smartSearch，更快更准确）
async function getPriceBySecid(secid) {
  const url =
    "https://push2.eastmoney.com/api/qt/stock/get?" +
    "ut=fa5fd1943c7b386f172d6893dbfd32&fltt=2" +
    "&fields=f43,f58,f169,f170&secid=" + secid;
  let d = await fetchQuote(url);
  if (!d || !d.f43) {
    // 腾讯 fallback
    d = await fetchQuoteTencent(secid);
  }
  if (!d || !d.f43) return null;
  return {
    name: d.f58,
    price: d.f43,
    change: d.f169,
    changePercent: d.f170,
  };
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "check-alerts") return;
  const alerts = await getAlerts();
  let changed = false;
  for (const a of alerts) {
    if (a.triggered) continue;
    const quote = await getPriceBySecid(a.secid);
    if (!quote) continue;
    const price = quote.price;
    let shouldTrigger = false;
    let msg = "";

    if (a.type === "above" && price >= a.target) {
      shouldTrigger = true;
      msg = `${quote.name} 已涨至 ${price.toFixed(2)}（目标 ${a.target}）`;
    } else if (a.type === "below" && price <= a.target) {
      shouldTrigger = true;
      msg = `${quote.name} 已跌至 ${price.toFixed(2)}（目标 ${a.target}）`;
    } else if (a.type === "pct" && Math.abs(quote.changePercent) >= Math.abs(a.target)) {
      shouldTrigger = true;
      const direction = quote.changePercent >= 0 ? "涨" : "跌";
      msg = `${quote.name} 已${direction} ${Math.abs(quote.changePercent).toFixed(2)}%`;
    }

    if (shouldTrigger) {
      chrome.notifications.create(a.id, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "价格预警触发",
        message: msg,
        priority: 2,
      });
      a.triggered = true;
      changed = true;
    }
  }
  if (changed) {
    await chrome.storage.local.set({ [ALERTS_KEY]: alerts });
  }
});

// ════════════════════════════════════════════════════════════
// 10. 资金流向数据
// ════════════════════════════════════════════════════════════
async function fetchFundFlow(secid) {
  const url =
    "https://push2.eastmoney.com/api/qt/stock/get?" +
    "ut=fa5fd1943c7b386f172d6893dbfd32&fltt=2" +
    "&fields=f57,f58,f62,f135,f136,f137,f138,f184,f466,f468&secid=" + secid;
  try {
    const d = await fetchQuote(url);
    if (!d || !d.f57) return null;
    return {
      main: d.f62,          // 主力净流入（元）
      superLarge: d.f135,   // 超大单净流入（元）
      large: d.f136,        // 大单净流入（元）
      medium: d.f137,       // 中单净流入（元）
      small: d.f138,        // 小单净流入（元）
    };
  } catch (e) {
    console.error("[行情助手] 资金流向获取失败:", e);
    return null;
  }
}

// ════════════════════════════════════════════════════════════
// 11. 相关个股（同行业/同板块）
// ════════════════════════════════════════════════════════════
async function fetchRelatedStocks(secid) {
  // 通过 secid 提取市场前缀和代码
  const [market, code] = secid.split(".");
  
  // 先通过东方财富个股板块接口查找该股所属的行业板块
  // 使用 f127~f134 字段获取行业板块代码
  const sectorUrl =
    "https://push2.eastmoney.com/api/qt/stock/get?" +
    "ut=fa5fd1943c7b386f172d6893dbfd32&fltt=2" +
    "&fields=f127,f128,f129,f130&secid=" + secid;
  
  try {
    const sectorData = await fetchQuote(sectorUrl);
    // f127=所属行业板块代码, f128=所属行业板块名称
    // f129=所属概念板块代码, f130=所属概念板块名称
    const boardCode = sectorData?.f127;
    const boardName = sectorData?.f128;
    
    if (!boardCode) {
      // 备选方案：根据代码前缀推断行业
      return null;
    }
    
    // 拉取该行业板块的成份股
    const listUrl =
      "https://push2.eastmoney.com/api/qt/clist/get?" +
      "ut=fa5fd1943c7b386f172d6893dbfd32&fltt=2" +
      "&fields=f12,f14,f3,f2&pn=1&pz=6&fs=b:" + boardCode;
    
    const resp = await fetch(listUrl, { headers: EM_HEADERS });
    const json = await resp.json();
    const diff = json?.data?.diff ?? {};
    const items = Array.isArray(diff) ? diff : Object.values(diff);
    
    // 过滤掉当前股票
    const related = items
      .filter((i) => i.f12 !== code)
      .slice(0, 5)
      .map((i) => ({
        code: i.f12,
        name: i.f14,
        changePercent: i.f3,
        price: i.f2,
        secid: (market === "1" ? "1." : "0.") + i.f12,
      }));
    
    return { boardName: boardName || "同行业", stocks: related };
  } catch (e) {
    console.error("[行情助手] 相关个股获取失败:", e);
    return null;
  }
}

// ════════════════════════════════════════════════════════════
// 12. 公告列表
// ════════════════════════════════════════════════════════════
async function fetchAnnouncements(secid) {
  const [market, code] = secid.split(".");
  const pureCode = code.replace(/\./g, "");
  
  const url =
    "https://np-anotice-stock.eastmoney.com/api/security/ann?" +
    "page_size=5&page_index=1&ann_type=A&client_source=web&stock_list=" + pureCode;
  
  try {
    const resp = await fetch(url);
    const json = await resp.json();
    const items = json?.data?.list ?? [];
    
    return items.map((item) => ({
      title: item.title || "",
      date: (item.notice_date || "").slice(0, 10),
      url: "https://np-anotice-stock.eastmoney.com/api/security/ann?stock_list=" + pureCode,
      artCode: item.art_code || "",
    }));
  } catch (e) {
    console.error("[行情助手] 公告获取失败:", e);
    return [];
  }
}

// ════════════════════════════════════════════════════════════
// 13. 持仓盈亏跟踪 (chrome.storage.local)
// ════════════════════════════════════════════════════════════
const PORTFOLIO_KEY = "portfolio";

async function getPortfolio() {
  const data = await chrome.storage.local.get(PORTFOLIO_KEY);
  return data[PORTFOLIO_KEY] ?? [];
}

async function addPosition(position) {
  const list = await getPortfolio();
  // 如果同一 secid 已有持仓，累加数量，重新计算加权成本
  const existing = list.find((p) => p.secid === position.secid);
  if (existing) {
    const totalQty = existing.quantity + position.quantity;
    const totalCost = existing.costPrice * existing.quantity + position.costPrice * position.quantity;
    existing.costPrice = totalCost / totalQty;
    existing.quantity = totalQty;
    existing.name = position.name || existing.name;
    existing.code = position.code || existing.code;
  } else {
    position.id = Date.now().toString();
    position.addedAt = Date.now();
    list.push(position);
  }
  await chrome.storage.local.set({ [PORTFOLIO_KEY]: list });
  return list;
}

async function updatePosition(id, updates) {
  const list = await getPortfolio();
  const pos = list.find((p) => p.id === id);
  if (!pos) return list;
  if (updates.costPrice != null) pos.costPrice = parseFloat(updates.costPrice);
  if (updates.quantity != null) pos.quantity = parseFloat(updates.quantity);
  await chrome.storage.local.set({ [PORTFOLIO_KEY]: list });
  return list;
}

async function removePosition(id) {
  const list = await getPortfolio();
  const filtered = list.filter((p) => p.id !== id);
  await chrome.storage.local.set({ [PORTFOLIO_KEY]: filtered });
  return filtered;
}

async function getPosition(secid) {
  const list = await getPortfolio();
  return list.find((p) => p.secid === secid) || null;
}

// 批量获取持仓的实时行情+盈亏
async function getPortfolioQuotes() {
  const list = await getPortfolio();
  const baseUrl =
    "https://push2.eastmoney.com/api/qt/stock/get?" +
    "ut=fa5fd1943c7b386f172d6893dbfd32&fltt=2" +
    "&fields=f43,f57,f58,f169,f170&secid=";
  const results = [];
  for (const p of list) {
    let d = await fetchQuote(baseUrl + p.secid);
    if (!d || !d.f58) {
      // 腾讯 fallback
      d = await fetchQuoteTencent(p.secid);
    }
    if (d && d.f58) {
      const currentPrice = d.f43 ?? 0;
      const profit = (currentPrice - p.costPrice) * p.quantity;
      const profitPct = p.costPrice > 0 ? ((currentPrice - p.costPrice) / p.costPrice) * 100 : 0;
      results.push({
        id: p.id,
        secid: p.secid,
        code: d.f57 || p.code,
        name: d.f58 || p.name,
        costPrice: p.costPrice,
        quantity: p.quantity,
        currentPrice,
        change: d.f169 ?? 0,
        changePercent: d.f170 ?? 0,
        profit,
        profitPct,
        marketValue: currentPrice * p.quantity,
        totalCost: p.costPrice * p.quantity,
      });
    } else {
      // 行情获取失败也展示基本信息
      results.push({
        id: p.id,
        secid: p.secid,
        code: p.code,
        name: p.name,
        costPrice: p.costPrice,
        quantity: p.quantity,
        currentPrice: null,
        change: 0,
        changePercent: 0,
        profit: 0,
        profitPct: 0,
        marketValue: 0,
        totalCost: p.costPrice * p.quantity,
      });
    }
  }
  return results;
}

// ════════════════════════════════════════════════════════════
// 14. K线数据（日K + 均线）
// ════════════════════════════════════════════════════════════
async function fetchKlineData(secid, count = 120) {
  const url =
    "https://push2his.eastmoney.com/api/qt/stock/kline/get?" +
    "ut=fa5fd1943c7b386f172d6893dbfd32" +
    "&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13" +
    "&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61" +
    "&klt=101&fqt=1&secid=" + secid +
    "&lmt=" + count;

  try {
    const resp = await fetch(url);
    const json = await resp.json();
    const klines = json?.data?.klines ?? [];
    if (klines.length === 0) return null;

    // 格式: "2025-01-02,open,close,high,low,volume,amount,amplitude,pct,change,turnover"
    const candles = klines.map((k) => {
      const parts = k.split(",");
      return {
        date: parts[0],
        open: parseFloat(parts[1]),
        close: parseFloat(parts[2]),
        high: parseFloat(parts[3]),
        low: parseFloat(parts[4]),
        volume: parseFloat(parts[5]),
        amount: parseFloat(parts[6]),
        pct: parseFloat(parts[9]),
      };
    });

    // 计算 MA 均线
    const ma = (period) => {
      const result = [];
      for (let i = 0; i < candles.length; i++) {
        if (i < period - 1) { result.push(null); continue; }
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += candles[j].close;
        result.push(sum / period);
      }
      return result;
    };

    return {
      name: json?.data?.name || "",
      code: json?.data?.code || "",
      candles,
      ma5: ma(5),
      ma10: ma(10),
      ma20: ma(20),
    };
  } catch (e) {
    console.error("[行情助手] K线数据获取失败:", e);
    return null;
  }
}

// ════════════════════════════════════════════════════════════
// 15. 大盘指数数据
// ════════════════════════════════════════════════════════════
async function fetchMarketIndices() {
  // 主要指数 secids
  const indices = [
    { secid: "1.000001", name: "上证指数", code: "000001" },
    { secid: "0.399001", name: "深证成指", code: "399001" },
    { secid: "0.399006", name: "创业板指", code: "399006" },
    { secid: "0.399005", name: "中小板指", code: "399005" },
    { secid: "1.000688", name: "科创50", code: "000688" },
    { secid: "116.HSI", name: "恒生指数", code: "HSI" },
    { secid: "100.NDX", name: "纳斯达克", code: "NDX" },
    { secid: "100.DJIA", name: "道琼斯", code: "DJIA" },
  ];

  const secidsParam = indices.map((i) => "secids=" + i.secid).join("&");
  const url =
    "https://push2.eastmoney.com/api/qt/ulist.np/get?" +
    "ut=fa5fd1943c7b386f172d6893dbfd32&fltt=2&" +
    "fields=f2,f3,f4,f12,f14,f104,f105,f6&" + secidsParam;

  try {
    const json = await fetchWithHeaders(url);
    const diff = json?.data?.diff ?? [];
    const results = [];
    for (const idx of indices) {
      const d = diff.find((x) => x.f12 === idx.code) || diff.find((x) => (x.f14 || "").includes(idx.name.slice(0, 2)));
      if (d) {
        results.push({
          ...idx,
          price: d.f2,
          pct: d.f3,
          change: d.f4,
          upCount: d.f104,
          downCount: d.f105,
          amount: d.f6,
        });
      } else {
        // 尝试腾讯 fallback
        const tcData = await fetchQuoteTencent(idx.secid);
        if (tcData) {
          results.push({
            ...idx,
            price: tcData.f43,
            pct: tcData.f170,
            change: tcData.f169,
            upCount: 0,
            downCount: 0,
            amount: tcData.f48,
          });
        }
      }
    }
    return results;
  } catch (e) {
    console.error("[行情助手] 指数数据获取失败:", e);
    // fallback：逐个用腾讯接口获取
    const results = [];
    for (const idx of indices) {
      const tcData = await fetchQuoteTencent(idx.secid);
      if (tcData) {
        results.push({
          ...idx,
          price: tcData.f43,
          pct: tcData.f170,
          change: tcData.f169,
          upCount: 0,
          downCount: 0,
          amount: tcData.f48,
        });
      }
    }
    return results;
  }
}

// ════════════════════════════════════════════════════════════
// 16. 板块数据（行业板块涨跌排行 → 热力图）
// ════════════════════════════════════════════════════════════
async function fetchSectorData() {
  // 行业板块排行
  const url =
    "https://push2.eastmoney.com/api/qt/clist/get?" +
    "ut=fa5fd1943c7b386f172d6893dbfd32&fltt=2&np=1&invt=2" +
    "&fid=f3&po=1&pz=50&pn=1" +
    "&fs=m:90+t:2" +   // 行业板块
    "&fields=f2,f3,f4,f8,f12,f14,f104,f105,f128,f140,f141";

  try {
    const resp = await fetch(url, { headers: EM_HEADERS });
    const json = await resp.json();
    const diff = json?.data?.diff ?? [];
    const items = Array.isArray(diff) ? diff : Object.values(diff);

    return items.map((i) => ({
      code: i.f12,
      name: i.f14,
      pct: i.f3,
      change: i.f4,
      turnover: i.f8,
      upCount: i.f104,
      downCount: i.f105,
      leader: i.f140,
      leaderPct: i.f141,
    }));
  } catch (e) {
    console.error("[行情助手] 板块数据获取失败:", e);
    return [];
  }
}

// ════════════════════════════════════════════════════════════
// 17. 涨跌停统计 / 市场情绪
// ════════════════════════════════════════════════════════════
async function fetchMarketSentiment() {
  // 涨停 / 跌停 / 涨跌家数
  const url =
    "https://push2.eastmoney.com/api/qt/clist/get?" +
    "ut=fa5fd1943c7b386f172d6893dbfd32&fltt=2&np=1" +
    "&fid=f3&po=1&pz=1&pn=1" +
    "&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048" +
    "&fields=f2,f3,f4,f12,f14";

  try {
    const resp = await fetch(url, { headers: EM_HEADERS });
    const json = await resp.json();
    const total = json?.data?.total ?? 0;

    // 获取涨家数 / 跌家数 / 平家数
    // 使用 f3 排序获取涨跌分布
    const upUrl =
      "https://push2.eastmoney.com/api/qt/clist/get?" +
      "ut=fa5fd1943c7b386f172d6893dbfd32&fltt=2&np=1" +
      "&fid=f3&po=1&pz=5000&pn=1" +
      "&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048" +
      "&fields=f3,f6";

    const upResp = await fetch(upUrl, { headers: EM_HEADERS });
    const upJson = await upResp.json();
    const allDiff = upJson?.data?.diff ?? [];
    const allItems = Array.isArray(allDiff) ? allDiff : Object.values(allDiff);

    let up = 0, down = 0, flat = 0;
    let limitUp = 0, limitDown = 0;
    for (const item of allItems) {
      const pct = item.f3;
      if (pct > 0) {
        up++;
        if (pct >= 9.9) limitUp++;
      } else if (pct < 0) {
        down++;
        if (pct <= -9.9) limitDown++;
      } else {
        flat++;
      }
    }

    return { total, up, down, flat, limitUp, limitDown };
  } catch (e) {
    console.error("[行情助手] 市场情绪获取失败:", e);
    return { total: 0, up: 0, down: 0, flat: 0, limitUp: 0, limitDown: 0 };
  }
}

// ════════════════════════════════════════════════════════════
// 18. 龙虎榜数据
// ════════════════════════════════════════════════════════════
async function fetchDragonTiger() {
  const url =
    "https://datacenter-web.eastmoney.com/api/data/v1/get?" +
    "sortColumns=TRADE_DATE&sortTypes=-1&pageSize=20&pageNumber=1" +
    "&reportName=RPT_DAILYBILLBOARD_DETAILS" +
    "&columns=ALL&source=WEB&client=WEB";
  try {
    const resp = await fetch(url, { headers: EM_HEADERS });
    const json = await resp.json();
    const items = json?.result?.data ?? [];
    return items.map((i) => ({
      code: i.SECURITY_CODE,
      name: i.SECURITY_NAME_ABBR,
      price: i.CLOSE_PRICE,
      pct: i.PCT_CHANGE,
      netBuy: i.NET_AMOUNT,
      reason: i.EXPLAIN,
      date: i.TRADE_DATE?.slice(0, 10),
    }));
  } catch (e) {
    console.error("[行情助手] 龙虎榜获取失败:", e);
    return [];
  }
}

// ════════════════════════════════════════════════════════════
// 19. 涨停板/跌停板列表
// ════════════════════════════════════════════════════════════
async function fetchLimitBoard(type = "up") {
  // type: "up"=涨停, "down"=跌停
  const sortField = type === "up" ? "f3" : "f3";
  const sortDir = type === "up" ? "1" : "1";
  const filter = type === "up" ? "f3:>=9.8" : "f3:<=-9.8";
  const url =
    "https://push2.eastmoney.com/api/qt/clist/get?" +
    "ut=fa5fd1943c7b386f172d6893dbfd32&fltt=2&np=1" +
    "&fid=" + sortField + "&po=" + sortDir + "&pz=50&pn=1" +
    "&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048" +
    "&fields=f2,f3,f4,f5,f6,f7,f8,f12,f14,f15,f16,f17,f18";
  try {
    const resp = await fetch(url, { headers: EM_HEADERS });
    const json = await resp.json();
    const diff = json?.data?.diff ?? [];
    const items = Array.isArray(diff) ? diff : Object.values(diff);
    return items
      .filter((i) => type === "up" ? i.f3 >= 9.8 : i.f3 <= -9.8)
      .map((i) => ({
        code: i.f12,
        name: i.f14,
        price: i.f2,
        pct: i.f3,
        turnover: i.f8,
        amount: i.f6,
        amountStr: i.f6 >= 1e8 ? (i.f6 / 1e8).toFixed(2) + "亿" : (i.f6 / 1e4).toFixed(0) + "万",
      }));
  } catch (e) {
    console.error("[行情助手] 涨跌停获取失败:", e);
    return [];
  }
}

// ════════════════════════════════════════════════════════════
// 20. 个股新闻列表
// ════════════════════════════════════════════════════════════
async function fetchStockNews(code) {
  const url =
    "https://search-api-web.eastmoney.com/search/jsonp?" +
    "cb=jQuery&param=%7B%22uid%22%3A%22%22%2C%22keyword%22%3A%22" +
    encodeURIComponent(code) +
    "%22%2C%22type%22%3A%5B%22cmsArticleWebOld%22%5D%2C%22client%22%3A%22web%22%2C%22clientType%22%3A%22web%22%2C%22clientVersion%22%3A%22curr%22%2C%22param%22%3A%7B%22cmsArticleWebOld%22%3A%7B%22searchScope%22%3A%22default%22%2C%22sort%22%3A%22default%22%2C%22pageIndex%22%3A1%2C%22pageSize%22%3A10%7D%7D%7D";
  try {
    const resp = await fetch(url, { headers: EM_HEADERS });
    const text = await resp.text();
    // JSONP 格式解析
    const jsonStr = text.replace(/^jQuery\(?/, "").replace(/\);?$/, "");
    const json = JSON.parse(jsonStr);
    const items = json?.result?.cmsArticleWebOld?.list ?? [];
    return items.map((a) => ({
      title: a.title,
      date: a.date?.slice(0, 10),
      url: a.url,
      source: a.source,
    }));
  } catch (e) {
    console.error("[行情助手] 新闻获取失败:", e);
    return [];
  }
}

// ════════════════════════════════════════════════════════════
// 21. 个股财务指标
// ════════════════════════════════════════════════════════════
async function fetchFinanceData(code) {
  // code 需要带市场前缀：SH/SZ/BJ
  const marketCode = /^(6|9)/.test(code) ? "SH" : /^(0|3|2)/.test(code) ? "SZ" : "BJ";
  const url =
    "https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/MainTargetAjax?" +
    "type=0&code=" + marketCode + code;
  try {
    const resp = await fetch(url, { headers: EM_HEADERS });
    const json = await resp.json();
    const items = json?.data ?? [];
    if (items.length === 0) return null;
    const latest = items[0];
    return {
      reportDate: latest.REPORT_DATE?.slice(0, 10),
      pe: latest.PE_TTM,
      pb: latest.PB_LYR,
      roe: latest.ROEJQ,
      revenue: latest.YSTZ,
      netProfit: latest.SJLTZ,
      grossMargin: latest.XSMLL,
      netMargin: latest.JLL,
      revenueYoY: latest.YSYYSRZZL,
      profitYoY: latest.GJLRZZL,
      totalAssets: latest.ZCZZ,
      netAssets: latest.JZC,
      eps: latest.MGJYXJJE,
    };
  } catch (e) {
    console.error("[行情助手] 财务指标获取失败:", e);
    return null;
  }
}

// ════════════════════════════════════════════════════════════
// 22. 热门股票排行（涨幅/跌幅/成交额）
// ════════════════════════════════════════════════════════════
async function fetchHotStocks(rankType = "amount") {
  // rankType: "amount"(成交额) / "gainer"(涨幅) / "loser"(跌幅) / "turnover"(换手率)
  const fidMap = {
    amount: "f6",
    gainer: "f3",
    loser: "f3",
    turnover: "f8",
  };
  const po = rankType === "loser" ? "0" : "1";
  const url =
    "https://push2.eastmoney.com/api/qt/clist/get?" +
    "ut=fa5fd1943c7b386f172d6893dbfd32&fltt=2&np=1" +
    "&fid=" + (fidMap[rankType] || "f6") + "&po=" + po + "&pz=20&pn=1" +
    "&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048" +
    "&fields=f2,f3,f4,f5,f6,f7,f8,f12,f14,f15,f16,f17,f18";
  try {
    const resp = await fetch(url, { headers: EM_HEADERS });
    const json = await resp.json();
    const diff = json?.data?.diff ?? [];
    const items = Array.isArray(diff) ? diff : Object.values(diff);
    return items.map((i) => ({
      code: i.f12,
      name: i.f14,
      price: i.f2,
      pct: i.f3,
      change: i.f4,
      turnover: i.f8,
      amount: i.f6,
      amountStr: i.f6 >= 1e8 ? (i.f6 / 1e8).toFixed(2) + "亿" : (i.f6 / 1e4).toFixed(0) + "万",
      amplitude: i.f7,
    }));
  } catch (e) {
    console.error("[行情助手] 热门股获取失败:", e);
    return [];
  }
}

// ════════════════════════════════════════════════════════════
// V8: 条件选股器
// ════════════════════════════════════════════════════════════
async function runStockScreener(conditions) {
  const fid = conditions.sort || "f3";
  const url =
    "https://push2.eastmoney.com/api/qt/clist/get?" +
    "ut=fa5fd1943c7b386f172d6893dbfd32&fltt=2&np=1" +
    "&fid=" + fid + "&po=1&pz=200&pn=1" +
    "&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048" +
    "&fields=f2,f3,f6,f8,f9,f12,f14,f15,f16,f23,f84,f85,f100,f115,f128";

  try {
    const resp = await fetch(url, { headers: EM_HEADERS });
    const json = await resp.json();
    let diff = json?.data?.diff ?? [];
    let items = Array.isArray(diff) ? diff : Object.values(diff);

    // 客户端过滤
    items = items.filter((i) => {
      if (i.f2 == null || i.f2 < 0) return false; // 排除无价格/停牌

      // 涨跌幅过滤
      if (conditions.chg) {
        const pct = i.f3 ?? 0;
        const c = conditions.chg;
        if (c.op === "gte" && pct < c.v1) return false;
        if (c.op === "lte" && pct > c.v1) return false;
        if (c.op === "between" && (pct < c.v1 || pct > (c.v2 || Infinity))) return false;
      }

      // PE 过滤
      if (conditions.pe) {
        const pe = i.f9 ?? -999;
        if (pe < 0 && conditions.pe.v1 > 0) return false; // 亏损股默认排除
        const c = conditions.pe;
        if (c.op === "gte" && pe < c.v1) return false;
        if (c.op === "lte" && pe > c.v1) return false;
        if (c.op === "between" && (pe < c.v1 || pe > (c.v2 || Infinity))) return false;
      }

      // PB 过滤
      if (conditions.pb) {
        const pb = i.f23 ?? -999;
        if (pb < 0 && conditions.pb.v1 > 0) return false;
        const c = conditions.pb;
        if (c.op === "gte" && pb < c.v1) return false;
        if (c.op === "lte" && pb > c.v1) return false;
        if (c.op === "between" && (pb < c.v1 || pb > (c.v2 || Infinity))) return false;
      }

      // 成交额过滤
      if (conditions.amtMin && (i.f6 || 0) < conditions.amtMin) return false;

      // 换手率过滤
      if (conditions.turn) {
        const turn = i.f8 ?? 0;
        const c = conditions.turn;
        if (c.op === "gte" && turn < c.val) return false;
        if (c.op === "lte" && turn > c.val) return false;
      }

      return true;
    });

    // 取前 50 条
    items = items.slice(0, 50);

    return items.map((i) => ({
      code: i.f12,
      name: i.f14,
      price: i.f2,
      pct: i.f3,
      amount: i.f6,
      amountStr: i.f6 >= 1e8 ? (i.f6 / 1e8).toFixed(2) + "亿" : (i.f6 / 1e4).toFixed(0) + "万",
      turnover: i.f8,
      pe: i.f9 != null && i.f9 > 0 ? i.f9 : null,
      pb: i.f23 != null && i.f23 > 0 ? i.f23 : null,
    }));
  } catch (e) {
    console.error("[行情助手] 条件选股失败:", e);
    return [];
  }
}

// ════════════════════════════════════════════════════════════
// 22. 消息路由中心
// ════════════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const handler = async () => {
    switch (request.action) {
      // ── 通过 secid 直接获取行情 ──
      case "getQuoteBySecid": {
        const baseUrl =
          "https://push2.eastmoney.com/api/qt/stock/get?" +
          "ut=fa5fd1943c7b386f172d6893dbfd32&fltt=2" +
          "&fields=f43,f44,f45,f46,f47,f48,f57,f58,f60,f107,f169,f170,f171&secid=";
        let d = await fetchQuote(baseUrl + request.secid);
        if (!d || !d.f58) {
          // 腾讯 fallback
          d = await fetchQuoteTencent(request.secid);
        }
        if (!d || !d.f58) return { success: false, error: "获取行情失败" };
        return { success: true, data: buildQuoteResult({ secid: request.secid, ...d }) };
      }

      // ── 批量搜索（Popup 下拉候选）──
      case "searchList": {
        const results = await searchStockList(request.keyword);
        return { success: true, data: results };
      }

      // ── 获取行情 ──
      case "getQuote": {
        const data = await smartSearch(request.keyword);
        if (!data) return { success: false, error: "未找到匹配的股票" };
        return { success: true, data: buildQuoteResult(data) };
      }

      // ── 获取分时数据 ──
      case "getTrend": {
        const trend = await fetchTrendData(request.secid);
        if (!trend) return { success: false, error: "无分时数据" };
        return { success: true, data: trend };
      }

      // ── 自选股操作 ──
      case "getWatchlist":
        return { success: true, data: await getWatchlist() };

      case "addToWatchlist": {
        await addToWatchlist(request.stock);
        return { success: true };
      }

      case "removeFromWatchlist": {
        await removeFromWatchlist(request.secid);
        return { success: true };
      }

      case "checkWatchlist": {
        return { success: true, data: await isInWatchlist(request.secid) };
      }

      // ── 批量获取自选股行情（供 Popup 使用）──
      case "getWatchlistQuotes": {
        const list = await getWatchlist();
        const baseUrl =
          "https://push2.eastmoney.com/api/qt/stock/get?" +
          "ut=fa5fd1943c7b386f172d6893dbfd32&fltt=2" +
          "&fields=f43,f57,f58,f169,f170,f107&secid=";
        const results = [];
        for (const s of list) {
          let d = await fetchQuote(baseUrl + s.secid);
          if (!d || !d.f58) {
            // 腾讯 fallback
            d = await fetchQuoteTencent(s.secid);
          }
          if (d && d.f58) {
            results.push({
              secid: s.secid,
              code: d.f57 || s.code,
              name: d.f58,
              price: d.f43,
              change: d.f169,
              changePercent: d.f170,
            });
          }
        }
        return { success: true, data: results };
      }

      // ── 预警操作 ──
      case "getAlerts":
        return { success: true, data: await getAlerts() };

      case "addAlert": {
        const alert = await addAlert(request.alert);
        return { success: true, data: alert };
      }

      case "removeAlert": {
        await removeAlert(request.id);
        return { success: true };
      }

      // ── 资金流向 ──
      case "getFundFlow": {
        const flow = await fetchFundFlow(request.secid);
        if (!flow) return { success: false, error: "无资金流向数据" };
        return { success: true, data: flow };
      }

      // ── 相关个股 ──
      case "getRelatedStocks": {
        const related = await fetchRelatedStocks(request.secid);
        if (!related) return { success: false, error: "无相关个股数据" };
        return { success: true, data: related };
      }

      // ── 公告列表 ──
      case "getAnnouncements": {
        const anns = await fetchAnnouncements(request.secid);
        return { success: true, data: anns };
      }

      // ── 持仓操作 ──
      case "getPortfolio":
        return { success: true, data: await getPortfolio() };

      case "getPortfolioQuotes":
        return { success: true, data: await getPortfolioQuotes() };

      case "addPosition": {
        await addPosition(request.position);
        return { success: true };
      }

      case "updatePosition": {
        await updatePosition(request.id, request.updates);
        return { success: true };
      }

      case "removePosition": {
        await removePosition(request.id);
        return { success: true };
      }

      case "getPosition": {
        const pos = await getPosition(request.secid);
        return { success: true, data: pos };
      }

      // ── K线数据（Dashboard 使用）──
      case "getKline": {
        const kline = await fetchKlineData(request.secid, request.count || 120);
        if (!kline) return { success: false, error: "无K线数据" };
        return { success: true, data: kline };
      }

      // ── 大盘指数（Dashboard 使用）──
      case "getMarketIndices": {
        const indices = await fetchMarketIndices();
        return { success: true, data: indices };
      }

      // ── 板块数据（Dashboard 热力图）──
      case "getSectorData": {
        const sectors = await fetchSectorData();
        return { success: true, data: sectors };
      }

      // ── 市场情绪（涨跌停统计）──
      case "getMarketSentiment": {
        const sentiment = await fetchMarketSentiment();
        return { success: true, data: sentiment };
      }

      // ── 龙虎榜 ──
      case "getDragonTiger": {
        const data = await fetchDragonTiger();
        return { success: true, data };
      }

      // ── 涨停/跌停板 ──
      case "getLimitBoard": {
        const data = await fetchLimitBoard(request.type || "up");
        return { success: true, data };
      }

      // ── 个股新闻 ──
      case "getStockNews": {
        const data = await fetchStockNews(request.code);
        return { success: true, data };
      }

      // ── 财务指标 ──
      case "getFinance": {
        const data = await fetchFinanceData(request.code);
        if (!data) return { success: false, error: "无财务数据" };
        return { success: true, data };
      }

      // ── 热门股票排行 ──
      case "getHotStocks": {
        const data = await fetchHotStocks(request.rankType || "amount");
        return { success: true, data };
      }

      // ── V8: 条件选股器 ──
      case "screener": {
        const data = await runStockScreener(request.conditions || {});
        return { success: true, data };
      }

      default:
        return { success: false, error: "未知操作" };
    }
  };

  handler()
    .then(sendResponse)
    .catch((e) => sendResponse({ success: false, error: String(e) }));

  return true; // 异步响应
});
