/* 由 server.js 机械拆分而来，行为未改动。 */
const { EM } = require('../config.js');
const { num, round } = require('../lib/format.js');
const { getJSON } = require('../lib/http.js');
const { secidOf } = require('../lib/secid.js');
const { mapLimit } = require('../lib/util.js');
const { createCache } = require('../lib/cache.js');

const CLIST_HOSTS = [
  /* push2delay 实测最稳定：主域 push2 的 clist 常被按 IP 封禁（fetch failed），
     82.push2 同样不可用。把可用域名放首位能省掉一次必然失败的请求。 */
  'https://push2delay.eastmoney.com',
  'https://push2.eastmoney.com',
  'https://82.push2.eastmoney.com'
];
async function clistGet(fs, fid, fields, opt = {}) {
  const r = await clistPage(fs, fid, fields, opt);
  if (!r.arr.length) throw new Error('行情列表源不可用');
  return r.arr;
}
/* 带分页信息的版本：需要 data.total 时用（东财 clist 的 pz 硬上限是 100，
   超过必须翻页，所以 total 只能从第一次请求里拿） */
async function clistPage(fs, fid, fields, opt = {}) {
  const { po = 1, pz = 30, pn = 1 } = opt;
  const qs = `pn=${pn}&pz=${Math.min(100, pz)}&po=${po}&np=1&fltt=2&invt=2&fid=${fid}` +
    `&fs=${encodeURIComponent(fs)}&fields=${fields}`;
  let lastErr;
  for (const host of CLIST_HOSTS) {
    try {
      /* 主域失败很快，每个域名只给 1 次机会，失败立刻换下一个 */
      const j = await getJSON(`${host}/api/qt/clist/get?${qs}`, {}, 1);
      const diff = j?.data?.diff;
      if (diff) {
        const arr = Array.isArray(diff) ? diff : Object.values(diff);
        if (arr.length) return { total: num(j?.data?.total), arr };
      }
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('行情列表源不可用');
}

/* 全市场翻页拉取（东财 clist pz 硬上限 100，超过必须分页）。
   复用全局闸门限流，串行翻页避免触发东财风控；maxPages 兜底防止异常无限翻页。
   用于把「预测 PP」的截面样本从「活跃上涨前 40 只」扩展到「全市场 A 股」。
   带短时内存缓存（CLIST_TTL）：全市场列表变化慢，切换周期/刷新时命中可省掉
   ~23 页翻页（约占首次耗时的 1/3），是二次加载提速的关键。 */
const CLIST_TTL = 2 * 60 * 1000;
const clistCache = createCache({ name: 'clist', ttl: CLIST_TTL, max: 64 });

async function clistAll(fs, fid, fields, { po = 1, pageSize = 100, maxPages = 80 } = {}) {
  const ck = `${fs}|${fid}|${fields}|${pageSize}`;
  /* 统一缓存：并发的相同请求会合并成一次上游调用。
     原先每个并发请求各自翻 20+ 页，既打满闸门又容易触发东财限流。 */
  const { data } = await clistCache.wrap(ck, async () => {
    const first = await clistPage(fs, fid, fields, { po, pz: pageSize, pn: 1 });
    const total = first.total || 0;
    const pages = Math.min(maxPages, Math.max(1, Math.ceil(total / pageSize)));
    const rows = first.arr.slice();
    if (pages > 1) {
      const pns = [];
      for (let p = 2; p <= pages; p++) pns.push(p);
      /* 翻页并发降到 3：既要覆盖全市场几千只，又不能长时间占满全局闸门抢前台请求 */
      const rest = await mapLimit(pns, 3, pn =>
        clistPage(fs, fid, fields, { po, pz: pageSize, pn }).catch(() => null));
      rest.forEach(r => { if (r && r.arr) rows.push(...r.arr); });
    }
    return { total, arr: rows };
  });
  return data;
}

/* ---------- 批量快照（ulist.np） ----------
   clist 在本机只能拿到代码/名称，价格类字段一律返回 "-"，
   所以「先 clist 取代码清单，再 ulist.np 批量取行情」是唯一能拿到
   真实价格 + 成交额的组合。实测 ulist.np 一次 100 个 secid 稳定返回。

   secids 按 BATCH 切块并发请求，单块失败不影响其余块（返回空数组）。 */
async function ulistBatch(secids, fields, batch = 100) {
  const out = [];
  const chunks = [];
  for (let i = 0; i < secids.length; i += batch) chunks.push(secids.slice(i, i + batch));
  const parts = await Promise.all(chunks.map(async (ch) => {
    try {
      const j = await getJSON(`${EM}/api/qt/ulist.np/get?secids=${ch.join(',')}` +
        `&fields=${fields}&fltt=2&invt=2`);
      const d = j?.data?.diff;
      return d ? (Array.isArray(d) ? d : Object.values(d)) : [];
    } catch (e) {
      return [];
    }
  }));
  parts.forEach(p => p.forEach(x => out.push(x)));
  return out;
}
/* 把 ulist 的原始行规整成 { name, code, secid, price, pct, change, amount }，
   并丢掉行情缺失的行（f2 为 "-" 说明这只标的当前没有快照） */
function shapeQuote(x) {
  const price = (x.f2 === '-' || x.f2 == null) ? null : round(x.f2);
  if (price == null) return null;
  return {
    name: String(x.f14 || ''),
    code: String(x.f12 || ''),
    secid: secidOf(x.f13, x.f12),
    price,
    pct: round(x.f3 === '-' ? 0 : x.f3),
    change: round(x.f4 === '-' ? 0 : x.f4),
    amount: round(num(x.f6) / 1e8, 2)      // 成交额（亿元）
  };
}

/* 并发受限的 map：避免一次性打爆上游被限流 */

function parseList(d) {
  if (!d || !d.data || !Array.isArray(d.data.diff)) return [];
  const src = Array.isArray(d.data.diff) ? d.data.diff : Object.values(d.data.diff);
  return src.map(x => ({
    code: String(x.f12 || ''),
    secid: secidOf(x.f13, x.f12),
    name: x.f14 || '',
    price: round(x.f2),
    pct: round(x.f3),
    change: round(x.f4),
    turnover: round(num(x.f6) / 1e8, 2),      // 元 → 亿元
    volume: num(x.f5),
    amplitude: round(x.f7),
    rate: round(x.f8),
    mktcap: round(num(x.f20) / 1e8, 2)        // 元 → 亿元
  })).filter(s => s.code);
}

/* ===================================================================
   API 处理器
   =================================================================== */

module.exports = { CLIST_HOSTS, CLIST_TTL, clistAll, clistCache, clistGet, clistPage, parseList, shapeQuote, ulistBatch };
