/* 由 server.js 机械拆分而来，行为未改动。 */
const { createHash } = require('crypto');
const { EM } = require('../config.js');
const { txKlineBatched } = require('../datasource/tx.js');
const { num, round } = require('../lib/format.js');
const { getJSON } = require('../lib/http.js');
const { fail, ok } = require('../lib/respond.js');
const { txSymOf } = require('../lib/secid.js');
const { mapLimit } = require('../lib/util.js');
const { createCache } = require('../lib/cache.js');
const { forecastList } = require('./forecast.js');
const H = {};

const BT_WARMUP = 60;        // 指标预热：MA60 所需的最小历史
const BT_MAX_CODES = 30;
const BT_MAX_DAYS = 500;
const BT_HOLDS = [1, 5, 10, 20];
const BT_BENCH_SEC = '1.000300';   // 沪深300
const BT_BENCH_SYM = 'sh000300';
const BT_BENCH_NAME = '沪深300';

/* 结果缓存：TTL 10 分钟，key = sha1(codes 排序 + days + hold + minScore) */
const BT_TTL = 10 * 60 * 1000;
const btCache = createCache({ name: 'backtest', ttl: BT_TTL, max: 64 });
/* K 线缓存（L1）：切 hold 时不重打上游，这是「切换 <3s / 命中 <100ms」的关键。
   统一缓存已内置 in-flight 合并，原先手写的 KL_INFLIGHT 不再需要。 */
const KL_TTL = 30 * 60 * 1000;
const btKlineCache = createCache({ name: 'bt-kline', ttl: KL_TTL, max: 320 });

function cacheKeyOf(o) {
  return 'bt:' + createHash('sha1')
    .update([o.codes.join(','), o.days, o.hold, o.minScore].join('|')).digest('hex').slice(0, 16);
}
/* 取后复权日 K（带 L1 缓存 + 并发合并）。
   并发合并交给统一缓存：命中返回缓存，未命中时同 key 并发只打一次上游。 */
function klineCached(sym, bars, fq) {
  const key = (fq || 'hfq') + ':' + sym + ':' + bars;
  return btKlineCache
    .wrap(key, () => txKlineBatched(sym, 'day', bars, fq || 'hfq'))
    .then(r => r.data);
}

/* ---- 统计工具（口径见 REQUIREMENTS §4）---- */
function meanAt(arr, endIdx, n) {          // arr[endIdx-n+1 .. endIdx] 均值
  let s = 0;
  for (let k = endIdx - n + 1; k <= endIdx; k++) s += num(arr[k]);
  return s / n;
}
function medianOf(a) {
  const b = a.slice().sort((x, y) => x - y);
  const n = b.length;
  if (!n) return 0;
  return n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2;
}
/* 最大回撤：max(1 − nav_t / max_{s≤t} nav_s) */
function maxDrawdown(nav) {
  if (!nav.length) return 0;
  let peak = nav[0], mdd = 0;
  for (let i = 0; i < nav.length; i++) {
    if (nav[i] > peak) peak = nav[i];
    const d = peak > 0 ? 1 - nav[i] / peak : 0;
    if (d > mdd) mdd = d;
  }
  return mdd;
}

/* 扫描单只股票的信号：只用 t 日及之前的数据，避免未来函数 */
function scanSignals(ks, hold, windowDays, minScore) {
  const N = ks.length;
  if (N < BT_WARMUP + hold + 2) return [];
  const cl = ks.map(k => num(k[2]));
  const vl = ks.map(k => num(k[5]));
  const lastBuy = N - 1 - hold;
  const firstBuy = Math.max(BT_WARMUP, lastBuy - (windowDays - 1));
  const out = [];
  for (let i = firstBuy; i <= lastBuy; i++) {
    const ma5 = meanAt(cl, i, 5), ma10 = meanAt(cl, i, 10),
      ma20 = meanAt(cl, i, 20), ma60 = meanAt(cl, i, 60);
    if (!(ma20 > 0) || !(ma60 > 0)) continue;
    const bull = ma5 > ma10 && ma10 > ma20 && ma20 > ma60 && cl[i] > ma5;
    const avgVol5 = meanAt(vl, i - 1, 5);            // 前 5 日均量（不含当日）
    const vol = avgVol5 > 0 && vl[i] / avgVol5 > 1;  // 量比近似（K 线可推导）
    const dev = (cl[i] / ma20 - 1) * 100;
    const safe = dev < 15;
    const kScore = (bull ? 40 : 0) + (vol ? 20 : 0) + (safe ? 15 : 0);
    if (kScore < minScore) continue;
    const j = i + hold;
    if (!cl[i] || !cl[j]) continue;
    out.push({
      i, date: String(ks[i][0]), buy: cl[i],
      j, sellDate: String(ks[j][0]), sell: cl[j],
      ret: cl[j] / cl[i] - 1,
      bull, vol, safe, kScore
    });
  }
  return out;
}

/* 按信号等权逐日组合构建净值曲线
   - 每笔信号在 (t, t+hold] 区间内持有；当日组合收益 = 所有持仓当日收益的等权均值
   - 无持仓的交易日按空仓处理（收益 0），曲线在整段窗口上连续
   - 基准按同一条日期轴，用沪深300 的日收益同步推进 */
function buildNav(sigList, benchRows) {
  const axisSet = new Set();
  sigList.forEach(s => s.signals.forEach(x => { axisSet.add(x.date); axisSet.add(x.sellDate); }));
  (benchRows || []).forEach(r => axisSet.add(String(r[0])));
  const axis = Array.from(axisSet).sort();
  if (!axis.length) return { dates: [], portfolio: [], benchmark: [] };
  const idx = {}; axis.forEach((d, i) => { idx[d] = i; });
  const bmMap = {};
  (benchRows || []).forEach(r => { bmMap[String(r[0])] = num(r[2]); });

  const buckets = new Array(axis.length);
  sigList.forEach(s => {
    const cl = s.cl;
    s.signals.forEach(x => {
      for (let k = x.i + 1; k <= x.j; k++) {
        const d = String(s.dates[k]);
        const p = idx[d];
        if (p === undefined) continue;
        const prev = num(cl[k - 1]);
        if (!(prev > 0)) continue;
        (buckets[p] || (buckets[p] = [])).push(num(cl[k]) / prev - 1);
      }
    });
  });

  /* 把日期轴裁剪到「有持仓」的区间：
     基准序列比信号窗口多出 hold+预热 根，不裁剪的话基准曲线会提前起跑，
     两条净值线起点不同就无法比较。裁剪后两条曲线都从 1 开始。 */
  let lo = -1, hi = -1;
  for (let t = 0; t < axis.length; t++) {
    if (buckets[t] && buckets[t].length) { if (lo < 0) lo = t; hi = t; }
  }
  if (lo < 0) return { dates: [], portfolio: [], benchmark: [] };
  /* lo 是「第一个产生收益的交易日」（= 首个买入日的次日）。
     净值轴必须再往前取一天（首个买入日），否则 lo 这一天的收益会在下面的
     循环里被跳过（循环从 t=1 开始取 buckets[t+lo]）。 */
  const dates = axis.slice(Math.max(0, lo - 1), hi + 1);
  const off = axis.length - (hi + 1) >= 0 ? (lo - Math.max(0, lo - 1)) : 0;

  const navP = new Array(dates.length);
  const navB = new Array(dates.length);
  let p = 1, b = 1;
  navP[0] = 1; navB[0] = 1;
  let lastBm = bmMap[dates[0]];
  for (let t = 1; t < dates.length; t++) {
    const bt = buckets[t + lo - off];
    if (bt && bt.length) {
      let s = 0; bt.forEach(v => { s += v; });
      p *= (1 + s / bt.length);
    }
    const cv = bmMap[dates[t]];
    if (cv !== undefined) {
      if (lastBm > 0) b *= cv / lastBm;
      lastBm = cv;
    }
    navP[t] = p; navB[t] = b;
  }
  return { dates, portfolio: navP, benchmark: navB };
}

/* 收益分布直方图（单位 %） */
function buildHist(rets, bins) {
  const n = bins || 12;
  if (!rets.length) return [];
  const pcts = rets.map(r => r * 100);
  let mn = Math.min.apply(null, pcts), mx = Math.max.apply(null, pcts);
  if (mx - mn < 1e-9) { mn -= 0.5; mx += 0.5; }
  const w = (mx - mn) / n;
  const out = [];
  for (let k = 0; k < n; k++) out.push({ from: mn + k * w, to: mn + (k + 1) * w, count: 0 });
  pcts.forEach(v => {
    let k = Math.floor((v - mn) / w);
    if (k < 0) k = 0; if (k >= n) k = n - 1;
    out[k].count++;
  });
  return out.map(x => ({ from: round(x.from, 2), to: round(x.to, 2), count: x.count }));
}

/* ---------------- /api/backtest ---------------- */
H['/backtest'] = async (res, q) => {
  const t0 = Date.now();
  const days = Math.max(20, Math.min(parseInt(q.get('days') || '250', 10) || 250, BT_MAX_DAYS));
  const holdRaw = parseInt(q.get('hold') || '5', 10) || 5;
  const hold = BT_HOLDS.indexOf(holdRaw) > -1 ? holdRaw : 5;
  const minScore = Math.max(0, Math.min(parseInt(q.get('minScore') || '50', 10) || 50, 75));

  /* 1) 股票池：显式 codes 优先；否则取当前 forecast 推荐列表（上限 30） */
  let codes = (q.get('codes') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!codes.length) {
    codes = (await forecastList()).list.slice(0, BT_MAX_CODES).map(x => x.code);
  }
  codes = Array.from(new Set(codes)).slice(0, BT_MAX_CODES);
  if (!codes.length) return fail(res, '无可回测的股票池', 400);

  /* 2) 缓存（key = codes 排序 hash + days + hold + minScore） */
  const ckey = cacheKeyOf({ codes: codes.slice().sort(), days, hold, minScore });
  const hit = btCache.get(ckey);
  if (hit !== null) {
    return ok(res, Object.assign({}, hit, {
      meta: Object.assign({}, hit.meta, { cached: true, costMs: Date.now() - t0 })
    }));
  }

  /* 3) 拉取后复权日 K
     预热 60 根 + 最长持有期 20 根 + 窗口 days 根。
     注意：bar 数固定按「最长持有期」取，与本次 hold 无关 ——
     这样切换 hold 重跑时能命中 L1 K 线缓存，不必重新打上游。
     scanSignals 内部按 hold 反推起止索引，评估点恒为 days 个。 */
  const need = days + BT_HOLDS[BT_HOLDS.length - 1] + BT_WARMUP;
  const items = codes.map(c => {
    const i = c.indexOf('.');
    const code = i > 0 ? c.slice(i + 1) : c;
    const mkt = i > 0 ? c.slice(0, i) : (/^(6|9|5|11)/.test(code) ? '1' : '0');
    return { code, mkt, sym: txSymOf({ mkt, sym: code, code }) };
  });

  const [series, benchRows] = await Promise.all([
    mapLimit(items, 4, async (it) => {
      const ks = await klineCached(it.sym, need, 'hfq');
      if (!ks || ks.length < BT_WARMUP + hold + 2) return null;
      return {
        code: it.code, sym: it.sym,
        dates: ks.map(k => String(k[0])),
        cl: ks.map(k => num(k[2])),
        signals: scanSignals(ks, hold, days, minScore)
      };
    }),
    klineCached(BT_BENCH_SYM, need, 'hfq').catch(() => [])
  ]);

  /* 4) 名称（1 次批量快照请求，同样走闸门）
        只重试 1 次：名称是锦上添花，不能让它拖慢回测主流程
        （实测东财 push2 在部分网络下会持续 socket closed，重试 4 次要 4.6s） */
  const nameMap = {};
  try {
    const j = await getJSON(`${EM}/api/qt/ulist.np/get?secids=${items.map(it => it.mkt + '.' + it.code).join(',')}` +
      `&fields=f12,f14&fltt=2&invt=2`, {}, 1);
    const arr = j?.data?.diff ? (Array.isArray(j.data.diff) ? j.data.diff : Object.values(j.data.diff)) : [];
    arr.forEach(x => { nameMap[String(x.f12)] = x.f14 || ''; });
  } catch (e) { /* 名称失败不影响指标，回落为代码 */ }

  const valid = series.filter(Boolean);
  const skipped = items.filter(it => !series.find(s => s && s.code === it.code)).map(it => it.code);
  if (!valid.length) return fail(res, 'K 线数据不可用（' + items.length + ' 只全部拉取失败，上游可能限流）', 502);

  /* 5) 逐信号对齐基准，计算同期基准收益 */
  const benchDates = (benchRows || []).map(r => String(r[0])).sort();
  const benchCl = {};
  (benchRows || []).forEach(r => { benchCl[String(r[0])] = num(r[2]); });
  /* 取 date 当日基准收盘；缺失则向前找最近交易日 */
  function benchAt(date) {
    if (benchCl[date] !== undefined) return benchCl[date];
    let lo = 0, hi = benchDates.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (benchDates[mid] <= date) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best >= 0 ? benchCl[benchDates[best]] : 0;
  }

  const all = [];
  const perStock = valid.map(s => {
    let sum = 0;
    s.signals.forEach(x => {
      const b0 = benchAt(x.date), b1 = benchAt(x.sellDate);
      x.benchRet = (b0 > 0 && b1 > 0) ? b1 / b0 - 1 : null;
      sum += x.ret;
      all.push(Object.assign({ code: s.code, name: nameMap[s.code] || s.code }, x));
    });
    return {
      code: s.code, name: nameMap[s.code] || s.code,
      count: s.signals.length,
      avgReturn: s.signals.length ? round(sum / s.signals.length * 100, 3) : null
    };
  });

  const rets = all.map(x => x.ret);
  const wins = rets.filter(r => r > 0).length;
  const avgReturn = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const medianReturn = medianOf(rets);
  const benchRets = all.map(x => x.benchRet).filter(v => v != null);
  const benchAvg = benchRets.length ? benchRets.reduce((a, b) => a + b, 0) / benchRets.length : 0;

  /* 6) 净值曲线（等权逐日组合）与最大回撤 */
  const nav = buildNav(valid, benchRows);
  const portMdd = maxDrawdown(nav.portfolio);
  const benchMdd = maxDrawdown(nav.benchmark);
  const n0 = nav.benchmark.length ? nav.benchmark[nav.benchmark.length - 1] : 1;

  const dates = all.map(x => x.date).sort();

  const data = {
    meta: {
      codes, days, hold, minScore,
      benchmark: { secid: BT_BENCH_SEC, code: '000300', name: BT_BENCH_NAME },
      window: { start: dates[0] || '', end: dates[dates.length - 1] || '' },
      warmup: BT_WARMUP,
      barsNeeded: need,
      skipped: skipped,            // K 线拉取失败的股票（上游限流时会非空）
      cashUnknown: true,
      dimensions: { bull: 40, vol: 20, safe: 15, cash: '不可用（历史全市场资金快照不可得）' },
      note: '资金维度(cash/25分)历史不可得，回测仅覆盖 K 线可推导的 bull/vol/safe 三维（满分 75）；' +
        '命中阈值沿用线上 score>=50，且 50 分门槛蕴含 bull 必为真。价格一律用后复权(hfq)。',
      cached: false, costMs: Date.now() - t0
    },
    signals: {
      count: all.length,
      stockCount: valid.length,
      perStock
    },
    winRate: round(all.length ? wins / all.length * 100 : 0, 2),
    avgReturn: round(avgReturn * 100, 3),
    medianReturn: round(medianReturn * 100, 3),
    excess: round((avgReturn - benchAvg) * 100, 3),
    maxDrawdown: round(portMdd * 100, 2),
    benchmark: {
      code: '000300', name: BT_BENCH_NAME,
      avgReturn: round(benchAvg * 100, 3),
      periodReturn: round((n0 - 1) * 100, 3),
      maxDrawdown: round(benchMdd * 100, 2),
      samples: benchRets.length
    },
    nav: {
      dates: nav.dates,
      portfolio: nav.portfolio.map(v => round(v, 4)),
      benchmark: nav.benchmark.map(v => round(v, 4))
    },
    hist: buildHist(rets, 14),
    /* 明细最多返回 200 条，供前端抽样核对 */
    sample: all.sort((a, b) => (a.date < b.date ? -1 : 1)).slice(0, 200).map(x => ({
      code: x.code, name: x.name, date: x.date, buy: round(x.buy, 3),
      sellDate: x.sellDate, sell: round(x.sell, 3),
      ret: round(x.ret * 100, 3), benchRet: x.benchRet == null ? null : round(x.benchRet * 100, 3),
      bull: x.bull, vol: x.vol, safe: x.safe, kScore: x.kScore
    }))
  };

  btCache.set(ckey, data);
  ok(res, data);
};

/* ===================================================================
   邮件通知
   配置落盘 data/mail.json；按 intervalMin 巡检规则，命中即发信。
   规则：自选异动 / 指数异动 / 价格突破（一次性）/ 收盘日报
   冷却：同类事件默认 60 分钟，避免盘中反复轰炸
   =================================================================== */

Object.assign(H, { BT_BENCH_NAME, BT_BENCH_SEC, BT_BENCH_SYM, BT_HOLDS, BT_MAX_CODES, BT_MAX_DAYS, BT_TTL, BT_WARMUP, KL_TTL, btCache, btKlineCache, buildHist, buildNav, cacheKeyOf, klineCached, maxDrawdown, meanAt, medianOf, scanSignals });
module.exports = H;
