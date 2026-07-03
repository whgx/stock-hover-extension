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
chrome.commands.onCommand.addListener((command) => {
  if (command !== "search-stock") return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { type: "QUERY_SELECTED" });
    }
  });
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
// 9. 消息路由中心
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

      default:
        return { success: false, error: "未知操作" };
    }
  };

  handler()
    .then(sendResponse)
    .catch((e) => sendResponse({ success: false, error: String(e) }));

  return true; // 异步响应
});
