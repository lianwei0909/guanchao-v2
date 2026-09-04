/* 由 server.js 机械拆分而来，行为未改动。 */
const { EMH } = require('../config.js');
const { num } = require('../lib/format.js');
const { getJSON } = require('../lib/http.js');
const { emSecid, txSymOf } = require('../lib/secid.js');
const { createCache } = require('../lib/cache.js');

const TX_KL_TTL = 5 * 60 * 1000;
/* 空结果只缓存 30 秒：上游限流返回的空数据若按 5 分钟缓存，
   会让整页长时间拿不到数据（即"缓存穿透"）。 */
const TX_KL_EMPTY_TTL = 30 * 1000;
const txKlineCache = createCache({ name: 'tx-kline', ttl: TX_KL_TTL, max: 8000 });

async function txKline(sym, p = 'day', limit = 120, fq = 'qfq') {
  const ck = `${sym}|${p}|${limit}|${fq}`;
  const { data } = await txKlineCache.wrap(ck, async () => {
    /* 全市场截面要逐只拉几千根 K 线，腾讯虽不封 IP 但高频会瞬时限流返回空/报错，
       这里带指数退避重试 3 次，把偶发限流抖掉，显著降低「整页 items=0」的概率。 */
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const arr = await txKlineRange(sym, p, '', '', limit, fq);
        if (arr.length) return arr;
        /* 空数组也当作需要重试（腾讯限流时常返回 {}） */
        lastErr = new Error('empty');
      } catch (e) { lastErr = e; }
      await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    }
    /* 抛错不会被缓存，下次请求可立即重试 */
    throw lastErr || new Error('txKline failed');
  });
  return data;
}

/* 多源 K 线（腾讯 → 新浪 → 东财），任一成功即返回，统一成 [日期,开,收,高,低,量]。
   背景：腾讯 fqkline/get 前复权端点实测会被按 IP 限流返回 HTTP 501（尤其全市场
   截面批量拉取时），单靠腾讯会让「整页 items=0」。这里串联新浪/东财兜底——
   两者对 A 股日/周/月 K 线均稳定可用，彻底避免上游单点失效清空选股结果。
   仅覆盖 A 股（forecast 本就只处理沪深 A 股）。 */
async function klineMultiSource(r, period, limit) {
  const ck = `MS|${r.mkt}|${r.code}|${period}|${limit}`;
  const { data } = await txKlineCache.wrap(
    ck,
    async () => {
  const sym = txSymOf(r);
  /* 用 got 标记是否已拿到有效数据，所有成功路径统一汇聚到底部写缓存，
     避免中途 return 绕过缓存导致二次加载仍重复打上游。 */
  let got = false;
  /* 1) 腾讯（前复权，看盘口径） */
  let arr = await txKline(sym, period, limit, 'qfq').catch(() => []);
  if (arr.length >= limit * 0.5) got = true;
  /* 2) 新浪：scale 随周期变化（day=240 / week=1200 / month=7200） */
  if (!got) {
    const scale = { day: 240, week: 1200, month: 7200 }[period] || 240;
    try {
      const j = await getJSON(`https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sym}&scale=${scale}&ma=no&datalen=${limit}`,
        { Referer: 'https://finance.sina.com.cn/' });
      if (Array.isArray(j) && j.length) {
        arr = j.map(x => [String(x.day), num(x.open), num(x.close), num(x.high), num(x.low), num(x.volume)]);
        if (arr.length) got = true;
      }
    } catch (e) { /* 落到东财 */ }
  }
  /* 3) 东财兜底：fqt=1 前复权 */
  if (!got) {
    const FQT = { day: 101, week: 102, month: 103 }[period] || 101;
    try {
      const j = await getJSON(`${EMH}/api/qt/stock/kline/get?secid=${emSecid(r)}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=${FQT}&fqt=1&end=20500101&lmt=${limit}`);
      const d = j?.data;
      if (d && Array.isArray(d.klines) && d.klines.length) {
        arr = d.klines.map(s => {
          const a = String(s).split(',');
          return [a[0], num(a[1]), num(a[2]), num(a[3]), num(a[4]), num(a[5])];
        });
        if (arr.length) got = true;
      }
    } catch (e) { /* 忽略 */ }
  }
  const out = got ? arr : [];   // 未命中则空数组，交由上层 hasKs 兜底判定
  return out;
    },
    /* 无论命中哪个源（含空结果）都写缓存，避免重复打上游；空结果短缓存防穿透 */
    { ttl: (out) => (out.length ? TX_KL_TTL : TX_KL_EMPTY_TTL) }
  );
  return data;
}

/* 底层：带起止日期区间（分批拼接用）；start/end 为空表示不限 */
async function txKlineRange(sym, p, start, end, limit, fq) {
  const j = await getJSON(
    `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sym},${p},${start || ''},${end || ''},${limit},${fq || ''}`,
    { Referer: 'https://gu.qq.com/' });
  const node = j?.data?.[sym];
  const arr = node && ((fq ? node[fq + p] : null) || node[p]);
  return Array.isArray(arr) ? arr : [];
}
/* 取收盘价序列（腾讯格式 → number[]） */
function closeSeries(ks) { return ks.map(k => num(k[2])); }

/* ------------------------------------------------------------------
   腾讯 K 线分批拉取（D1 / A1 用）
   约束（REQUIREMENTS §5.7）：单次请求上限 500 根，超出时按日期区间分批 +
   拼接处按日期去重。
   实测：分段拉取时相邻两段会重复 1 个交易日（区间端点闭合），必须去重；
        分段取到的 hfq 值与整段拉取逐日比对 800 根，0 处偏差。
   ------------------------------------------------------------------ */
const TX_MAX_BARS = 500;
/* 按日期去重并升序合并 */
function mergeKlines(parts) {
  const m = new Map();
  parts.forEach(arr => (arr || []).forEach(row => {
    if (row && row[0]) m.set(String(row[0]), row);
  }));
  return Array.from(m.values()).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
/* 前一日（YYYY-MM-DD），用于下一批的区间上界 */
function prevDayStr(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
  if (!m) return '';
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}
async function txKlineBatched(sym, p, total, fq) {
  const need = Math.max(1, Math.min(num(total) || 1, 1500));
  const parts = [];
  let end = '', guard = 0;
  while (guard++ < 8) {
    const have = mergeKlines(parts).length;
    if (have >= need) break;
    const want = Math.min(TX_MAX_BARS, need - have + 2);
    const arr = await txKlineRange(sym, p, '', end, want, fq);
    if (!arr.length) break;
    parts.push(arr);
    /* 拿到的比想要的少 → 上游已无更早的历史，停止翻页 */
    if (arr.length < want) break;
    end = prevDayStr(String(arr[0][0]));
  }
  return mergeKlines(parts).slice(-need);
}

/* ------------------------------------------------------------------
   clist 列表请求（带域名降级）
   push2 主域的 clist 接口会被按 IP 封禁（表现为 fetch failed / other side closed），
   但同域 ulist 正常，且 push2delay 镜像可用 —— 因此逐个域名试。
   ------------------------------------------------------------------ */

module.exports = { TX_KL_EMPTY_TTL, TX_KL_TTL, TX_MAX_BARS, closeSeries, klineMultiSource, mergeKlines, prevDayStr, txKline, txKlineBatched, txKlineCache, txKlineRange };
