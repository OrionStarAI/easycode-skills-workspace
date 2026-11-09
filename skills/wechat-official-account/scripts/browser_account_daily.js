// Copy into the signed-in WeChat content-analysis page's browser script tool.
// Replace only these two ISO-date placeholders before execution.
(async () => {
  const startDate = "__START_DATE__";
  const endDate = "__END_DATE__";
  const fail = (message) => ({ success: false, message });
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const chinaOffset = 8 * 60 * 60 * 1000;
  const dayMs = 24 * 60 * 60 * 1000;
  const parseDay = (text) => {
    if (!datePattern.test(text)) return null;
    const value = Date.parse(`${text}T00:00:00+08:00`);
    return Number.isFinite(value) && new Date(value + chinaOffset).toISOString().slice(0, 10) === text
      ? value : null;
  };
  const start = parseDay(startDate), end = parseDay(endDate);
  const today = new Date(Date.now() + chinaOffset).toISOString().slice(0, 10);
  if (start === null || end === null || startDate < "2025-11-01" || endDate >= today || end < start || end - start >= 31 * dayMs) {
    return fail("日期范围需在 2025-11-01 至北京时间昨日之间，且一次不超过 31 天。");
  }
  if (location.origin !== "https://mp.weixin.qq.com") return fail("请先打开并登录微信公众平台的内容分析页面。");
  const anchor = [...document.querySelectorAll("a")].find((a) => a.textContent.trim() === "下载数据明细");
  if (!anchor) return fail("未找到内容分析的数据明细入口，请确认已登录并打开内容分析。");
  let url;
  try { url = new URL(anchor.href); } catch { return fail("内容分析入口格式无效。"); }
  if (url.origin !== location.origin || url.pathname !== "/misc/appmsganalysis") return fail("内容分析入口无效。");
  url.searchParams.set("action", "get_article_stat_tendency_and_source");
  url.searchParams.set("begin_timestamp", String(Math.floor(start / 1000)));
  url.searchParams.set("end_timestamp", String(Math.floor((end + dayMs - 1000) / 1000)));
  url.searchParams.set("f", "json");
  url.searchParams.set("ajax", "1");
  try {
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) return fail("读取公众号后台数据失败，请检查登录状态后重试。");
    const data = await response.json();
    if (data?.base_resp?.ret !== 0 || !Array.isArray(data?.all_article_stat_tendency?.list)) {
      return fail("公众号后台未返回可识别的数据，请检查登录状态或改用后台导出报表。");
    }
    const validCount = (v) => v === null || v === undefined || (Number.isSafeInteger(v) && v >= 0);
    const byDay = new Map();
    for (const item of data.all_article_stat_tendency.list) {
      if (item?.scene !== 9999) continue;
      if (!Number.isSafeInteger(item.date) || !validCount(item.read_uv) || !validCount(item.share_uv) ||
          !validCount(item.collection_uv) || !validCount(item.source_uv) || !validCount(item.mass_pv)) {
        return fail("公众号后台返回的每日数据格式无效。");
      }
      const day = new Date(item.date * 1000 + chinaOffset).toISOString().slice(0, 10);
      if (day < startDate || day > endDate || byDay.has(day)) return fail("公众号后台返回的日期不匹配或重复。");
      byDay.set(day, item);
    }
    const daily = [];
    for (let ms = start; ms <= end; ms += dayMs) {
      const day = new Date(ms + chinaOffset).toISOString().slice(0, 10);
      const item = byDay.get(day);
      const readers = item?.read_uv ?? null;
      const previous = daily.length ? daily[daily.length - 1].readUsers : null;
      const change = readers !== null && previous !== null ? readers - previous : null;
      const rate = change !== null && previous ? Math.round(change / previous * 10000) / 100 : null;
      daily.push({ date: day, readUsers: readers, shareUsers: item?.share_uv ?? null,
        favoriteUsers: item?.collection_uv ?? null, originalPageUsers: item?.source_uv ?? null,
        articlesPublished: item?.mass_pv ?? null, changeFromPreviousDay: change, changeRateFromPreviousDay: rate });
    }
    const sourceNames = { 0: "公众号消息", 1: "聊天会话", 2: "朋友圈", 4: "公众号主页", 5: "其他", 6: "推荐", 7: "搜一搜" };
    const rawSources = data?.all_article_stat_source?.list;
    if (rawSources !== undefined && !Array.isArray(rawSources)) return fail("公众号后台返回的流量来源格式无效。");
    const sources = [];
    for (const item of rawSources ?? []) {
      if (!Number.isSafeInteger(item?.scene) || !validCount(item.read_uv)) return fail("公众号后台返回的流量来源格式无效。");
      sources.push({ scene: item.scene, name: sourceNames[item.scene] ?? null, readUsers: item.read_uv ?? null });
    }
    return { success: true, scope: "account", period: { start: startDate, end: endDate }, daily, sources };
  } catch {
    return fail("读取公众号后台数据失败，请检查登录状态或改用后台导出报表。");
  }
})()
