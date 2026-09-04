/* 由 server.js 机械拆分而来，行为未改动。 */
const { EM } = require('../config.js');
const { clistPage } = require('../datasource/em.js');
const { num, round } = require('../lib/format.js');
const { getJSON } = require('../lib/http.js');
const { fail, ok } = require('../lib/respond.js');
const { secidOf } = require('../lib/secid.js');
const { mapLimit } = require('../lib/util.js');
const { createCache } = require('../lib/cache.js');
const H = {};

const A_SHARE_FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';
/* 慢层（主力净流入合计）翻 56 页成本高、且变化慢，缓存放宽到 5 分钟。
   配合定时预热后，用户请求基本永远命中热缓存。 */
const MST_TTL = 300000;
const mstSlowCache = createCache({ name: 'market-stat-slow', ttl: MST_TTL, max: 4 });

/* 快层（原「快速模式」升级）：约 6 个请求，亚秒级返回除主力净流入合计外的全部指标。
   涨跌家数取指数自带统计字段 f104/f105/f106（上证 + 深证求和），
   成交额取两市 f6 之和，各维度 TOP10 用「按该字段排序的第一页」直接得到。
   只有主力净流入合计必须翻全量 —— 交给慢层 marketStatFull 后台补齐。 */
const F_TOP = 'f2,f3,f6,f12,f13,f14,f62';
async function marketStatFast() {
  const idx = await getJSON(`${EM}/api/qt/ulist.np/get` +
    `?secids=1.000001,0.399001&fields=f6,f12,f14,f104,f105,f106&fltt=2&invt=2`);
  const d = idx?.data?.diff;
  const arr = d ? (Array.isArray(d) ? d : Object.values(d)) : [];
  let up = 0, down = 0, flat = 0, amount = 0;
  arr.forEach(x => {
    up += num(x.f104); down += num(x.f105); flat += num(x.f106);
    amount += num(x.f6);
  });
  const valid = up + down + flat;
  const pctOf = n => valid ? round(n * 100 / valid, 1) : 0;

  /* 各维度 TOP10：每个维度只需 1 个「按该字段排序的第一页」请求（共 5 个，并发）。
     这是「快慢分层」的核心 —— 翻 56 页只为算主力净流入合计，
     涨跌家数 / 成交额 / 各维度 TOP10 都不需要全量。 */
  const [rUp, rDown, rAmt, rIn, rOut] = await Promise.all([
    clistPage(A_SHARE_FS, 'f3',  F_TOP, { po: 1, pz: 10, pn: 1 }).catch(() => ({ total: 0, arr: [] })),
    clistPage(A_SHARE_FS, 'f3',  F_TOP, { po: 0, pz: 10, pn: 1 }).catch(() => ({ total: 0, arr: [] })),
    clistPage(A_SHARE_FS, 'f6',  F_TOP, { po: 1, pz: 10, pn: 1 }).catch(() => ({ total: 0, arr: [] })),
    clistPage(A_SHARE_FS, 'f62', F_TOP, { po: 1, pz: 10, pn: 1 }).catch(() => ({ total: 0, arr: [] })),
    clistPage(A_SHARE_FS, 'f62', F_TOP, { po: 0, pz: 10, pn: 1 }).catch(() => ({ total: 0, arr: [] }))
  ]);

  const mk = (r) => (r.arr || []).slice(0, 10).map((x, i) => ({
    rank: i + 1, name: String(x.f14 || ''), code: String(x.f12 || ''),
    secid: secidOf(x.f13, x.f12), price: round(x.f2),
    pct: round(x.f3), amount: round(num(x.f6) / 1e8, 2), flow: round(num(x.f62) / 1e8, 2)
  }));
  const topUp = mk(rUp);
  const topDown = mk(rDown);
  const topAmt = mk(rAmt);
  const topFlowIn = mk(rIn);
  const topFlowOut = mk(rOut);
  /* 平盘抽样：涨幅升序首页里取 pct 恰为 0 的项（平盘榜本就是抽样展示） */
  const topFlat = (rDown.arr || []).filter(x => num(x.f3) === 0).slice(0, 10).map((x, i) => ({
    rank: i + 1, name: String(x.f14 || ''), code: String(x.f12 || ''),
    secid: secidOf(x.f13, x.f12), price: round(x.f2),
    pct: round(x.f3), amount: round(num(x.f6) / 1e8, 2), flow: round(num(x.f62) / 1e8, 2)
  }));

  return {
    total: rUp.total || valid,
    sample: valid,
    up, down, flat,
    upPct: pctOf(up), downPct: pctOf(down), flatPct: pctOf(flat),
    amount: round(amount / 1e12, 3),
    amountYi: round(amount / 1e8, 2),
    mainFlow: null,                 // 需全量翻页，由慢层补齐
    top10: topUp,                   // 兼容旧字段名
    topUp, topDown, topAmt, topFlowIn, topFlowOut, topFlat,
    suspend: null,                  // 指数字段无法区分停牌，置 null 表示未知
    source: 'em',                   // 数据来源：em=东方财富 / ths=同花顺
    partial: true,                  // mainFlow 尚未就绪
    updatedAt: new Date().toISOString()
  };
}

/* 精确统计（翻 ~56 页）抽成独立函数，供 SWR 后台静默刷新复用 */
async function marketStatFull() {
  const F = 'f2,f3,f6,f12,f13,f14,f62';
  const first = await clistPage(A_SHARE_FS, 'f3', F, { po: 1, pz: 100, pn: 1 });
  const total = first.total || 0;
  const pages = Math.min(60, Math.ceil(total / 100));

  const rows = first.arr.slice();
  if (pages > 1) {
    const pns = [];
    for (let p = 2; p <= pages; p++) pns.push(p);
    /* 并发从 6 降到 3：56 个请求会长时间占满全局闸门，
       降低并发可减少对前台交互请求（个股详情、板块切换）的抢占 */
    const rest = await mapLimit(pns, 3, pn =>
      clistPage(A_SHARE_FS, 'f3', F, { po: 1, pz: 100, pn }).catch(() => null));
    rest.forEach(r => { if (r && r.arr) rows.push(...r.arr); });
  }

  /* 只统计慢层真正回传的字段。涨跌家数与成交额由快层提供（见下方说明），
     此前这里还维护了 up/down/flat/amount 四个计数器，但它们只被累加、
     从不参与返回，属重构遗留的死代码 —— 每轮对 5500 条数据做无谓计算。 */
  let flow = 0, valid = 0, suspend = 0;
  rows.forEach(x => {
    /* f3 为空 / '-' 通常是停牌或未报价。此前直接 return 静默跳过，
       导致东财口径（sample=5209）与同花顺（全部计入，sample=5566）的样本数
       对不上、且无法解释差额。这里改为单独计数并回传，由前端明示这部分。 */
    if (x.f3 == null || x.f3 === '-') { suspend++; return; }
    valid++;
    flow += num(x.f62);
  });

  /* 慢层只回传「必须全量翻页才能得到」的字段：
     涨跌家数 / 成交额 / 各维度 TOP10 均由快层提供，路由层负责合并，
     这里不再对 5500 条数据重复排序 6 次算 TOP10（省 CPU）。 */
  return {
    mainFlow: round(flow / 1e8, 2),
    suspend,
    sample: valid,
    total,
    partial: false,
    updatedAt: new Date().toISOString()
  };
}

/* 快速模式缓存：15 秒 TTL。
   走统一缓存后额外获得两点能力：
   1) 并发请求合并 —— 前端多标签页/多组件同时轮询时只打一次上游
   2) stale 兜底 —— 上游失败时返回过期数据，而不是把错误抛给用户 */
const MST_FAST_TTL = 15000;
const mstFastCache = createCache({
  name: 'market-stat-fast',
  ttl: MST_FAST_TTL,
  max: 4,
  staleTtl: 10 * 60 * 1000
});
let mstRefreshing = false;   // 防止并发触发多次后台全量刷新

H['/market-stat'] = async (res, q) => {
  /* ---- 快速模式：15 秒缓存 + 并发合并 + 失败兜底 ---- */
  if (q.get('mode') === 'fast') {
    const r = await mstFastCache.wrap('fast', () => marketStatFast(), { stale: true });
    return ok(res, r.data);
  }

  /* ---- 完整层 = 快层（准实时）+ 慢层（缓存的主力净流入 / 停牌数）----
     慢层要翻 56 页（实测约 7 秒），绝不能让用户等：
     这里先用快层立刻响应，慢层结果由后台刷新后并入。 */
  let quick;
  try {
    const r = await mstFastCache.wrap('fast', () => marketStatFast(), { stale: true });
    quick = r.data;
  } catch (e) {
    return fail(res, '行情源不可用，请稍后重试');
  }

  const slow = mstSlowCache.get('slow');
  ok(res, Object.assign({}, quick, slow || {}, {
    /* 慢层还没算出主力净流入时，前端显示「精确统计中…」 */
    partial: !(slow && slow.mainFlow != null)
  }));

  /* 后台刷新慢层，不阻塞上面的响应（缓存过期时 get 返回 null，即触发条件） */
  if (!mstRefreshing && !slow) {
    mstRefreshing = true;
    marketStatFull()
      .then(d => mstSlowCache.set('slow', d))
      .catch(() => {})
      .finally(() => { mstRefreshing = false; });
  }
};

/* ---------- 同花顺（fuyao.aicubes.cn）代理：市场统计 + 指数快照 ----------
   对标同花顺 A股市场页数据，作为「权威基准」对齐涨跌家数/成交额/主力净流入。
   未配置 FY_API_KEY 时自动降级返回 null，前端回退到东财源。 */

Object.assign(H, { A_SHARE_FS, F_TOP, MST_FAST_TTL, MST_TTL, marketStatFast, marketStatFull, mstFastCache, mstRefreshing, mstSlowCache });
module.exports = H;
