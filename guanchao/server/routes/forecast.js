const path = require('node:path');
const fsp = require('node:fs/promises');

const { clistAll } = require('../datasource/em.js');
const { closeSeries, klineMultiSource } = require('../datasource/tx.js');
const { num, round, todayDash } = require('../lib/format.js');
const { log } = require('../lib/logger.js');
const { ok } = require('../lib/respond.js');
const { secidOf } = require('../lib/secid.js');
const { mapLimit } = require('../lib/util.js');
const { createCache } = require('../lib/cache.js');
const { withTier } = require('../lib/gate.js');
const { DATA_DIR } = require('../config.js');
const H = {};

/* 技术面候选集大小：全市场几千只逐只拉 K 线既慢又易触发上游限流，
   只在「成交额活跃 Top N」上做横截面（与量化选股实务一致）。
   默认 150：输出仅 20 行，150 的池子已完全够用，回源量较原 300 减半。
   可用环境变量 FC_MAX_TECH 覆盖（机器性能 / 网络条件不同时调大）。 */
const FC_MAX_TECH = Number(process.env.FC_MAX_TECH) || 150;
/* K 线统一拉取长度。原先 ultra 取 20 根、short 取 60 根，同为日线却因
   缓存键含 limit（tx.js: `MS|mkt|code|period|limit`）而各自回源一次；
   统一到 120 根后 ultra 与 short 共享同一份缓存，一次「重新预测」的
   回源量由 1200 降到 900。副作用是 ultra 也有了 >=60 根样本，
   8 项横截面因子不再恒为 null（原先因样本不足直接跳过）。 */
const FC_BARS = 120;
/* 技术面拉取并发（走 bg 档闸门，不抢前台预算） */
const FC_CONC = 6;
/* 最终返回条数 */
const FC_TOP = 20;
/* 磁盘缓存目录：同日内进程重启也能秒回（原先全在内存，重启即冷启动） */
const FC_DIR = path.join(DATA_DIR, 'forecast');

const FORECAST_HORIZONS = {
  ultra: {
    label: '超短线', window: '1~3 天', period: 'day', bars: 20,
    ma: [3, 5, 10, 20], hiLo: 5, devMax: 8,
    w: { bull: 25, cash: 35, vol: 30, safe: 10 },   // 超短线：最重资金+量能，抓即时动量，门槛最高
    threshold: 55, view: { strong: 85, bull: 70, bias: 60 }
  },
  short: {
    label: '短线', window: '1~2 周', period: 'day', bars: 60,
    ma: [5, 10, 20, 60], hiLo: 10, devMax: 10,
    w: { bull: 30, cash: 30, vol: 25, safe: 15 },   // 短线：重资金+量能，噪音大故门槛更高
    threshold: 55, view: { strong: 85, bull: 70, bias: 60 }
  },
  mid: {
    label: '中线', window: '1~3 个月', period: 'week', bars: 60,
    ma: [3, 8, 13, 26], hiLo: 8, devMax: 20,
    w: { bull: 40, cash: 25, vol: 20, safe: 15 },   // 中线：四项均衡
    threshold: 50, view: { strong: 85, bull: 70, bias: 60 }
  },
  long: {
    label: '长线', window: '6~12 个月', period: 'month', bars: 60,
    ma: [3, 6, 12, 24], hiLo: 6, devMax: 30,
    w: { bull: 50, cash: 15, vol: 10, safe: 25 },   // 长线：重趋势多头+位置安全，门槛略低
    threshold: 45, view: { strong: 85, bull: 70, bias: 60 }
  }
};

async function forecastList(horizon = 'mid') {
  /* 周期配置：决定取哪种 K 线、回看多长、均线窗口、近 N 高低点、不追高阈值、
     打分权重与入选门槛。 */
  const H = FORECAST_HORIZONS[horizon] || FORECAST_HORIZONS.mid;
  const [W5, W10, W20, W60] = H.ma;

  /* 第一层：全市场 A 股截面样本（不再只取成交额前 40）。
     东财 clist 翻页拉取全部沪深 A 股（m:0 沪市 + m:1 深市，含主板/创业板），
     仅做最宽松的基础过滤（有报价、非停牌、价格>0），把「横截面」范围扩到全市场，
     让四维判定与 8 因子 z-score 在真正的「全市场相对位置」上计算。
     字段口径（东财 f 字段）：
       f2 现价 f3 涨跌幅 f6 成交额 f8 换手率 f9 PE(动) f10 量比 f14 名称
       f20 总市值 f23 PB f62 主力净流入 f115 PE(TTM) */
  const fs = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';
  const fields = 'f2,f3,f5,f6,f7,f8,f9,f10,f12,f13,f14,f20,f23,f62,f115';
  const { arr } = await clistAll(fs, 'f6', fields, { po: 1, pageSize: 100, maxPages: 80 });
  const cands = arr.map(x => ({
    code: String(x.f12 || ''),
    secid: secidOf(x.f13, x.f12),
    mkt: String(x.f13 || ''),
    name: x.f14 || '',
    price: round(x.f2), pct: round(x.f3),
    amount: round(num(x.f6) / 1e8, 4),
    turnover: round(x.f8), pe: round(x.f9),
    peTtm: round(x.f115),                 // PE(TTM)，比动态 PE 更稳定
    pb: round(x.f23),                     // 市净率（基本面估值字段）
    volumeRatio: round(x.f10),
    mktcap: round(num(x.f20) / 1e8, 2),
    mainNetInflow: round(num(x.f62) / 1e8, 4)   // 主力净流入（资金面字段）
  })).filter(s => s.code && s.price > 0 && (s.mkt === '0' || s.mkt === '1'));

  /* 流动性初筛：全市场几千只里大量是僵尸股/停牌边缘股（成交额极低），
     对它们逐只拉 K 线既慢又无信号价值。这里按「当日成交额」设一个很宽松的门槛
     （A 股主板正常标的日成交额普遍 > 数千万元），滤掉无效样本后再做技术面计算。
     门槛刻意放低，只为剔除极端无效样本，不改变「全市场截面」的本质。 */
  const liquid = cands.filter(c => c.amount >= 0.05);   // 成交额 ≥ 500 万元
  const sampleSize = cands.length;                        // 全市场截面总样本数（供前端展示）

  /* 第二层：技术面候选收敛。
     「全市场 A 股」的横截面主要体现在基本面/资金面字段（clist 已全市场覆盖）；
     而技术面（均线多头 / 8 因子）需要逐只拉腾讯 K 线，对全市场几千只并发拉取会
     触发腾讯限流（实测并发过高时全部失败 → items=0）。因此技术面只在「成交额活跃
     Top N」候选上做横截面——这与实际量化选股一致：僵尸股/极低成交样本不参与技术筛选。
     按成交额降序取 FC_MAX_TECH 只进入技术面计算。 */
  const tech = liquid.slice().sort((a, b) => b.amount - a.amount).slice(0, FC_MAX_TECH);
  /* 整段技术面拉取走 bg 档闸门：即使回源上百次也不抢占前台请求预算 */
  const base = await withTier('bg', () => mapLimit(tech, FC_CONC, async (c) => {
    try {
      /* 多源取 K 线（腾讯→新浪→东财），避免腾讯 fqkline 限流 501 清空整页。
         统一按 FC_BARS 拉取，让同周期不同 horizon 共享 K 线缓存 */
      const ks = await klineMultiSource({ mkt: c.mkt, sym: c.code, code: c.code }, H.period, Math.max(FC_BARS, H.bars));
      /* K 线不可用时（腾讯限流 / 网络抖动）不整只丢弃，而是用列表里已有的
         资金 / 量比信号兜底打分，避免瞬时上游失败把整页清空成「今日无符合条件标的」。 */
      const hasKs = !!(ks && ks.length >= W60);
      let cl = null, last = c.price, ma5 = c.price, ma10 = c.price, ma20 = c.price,
          ma60 = c.price, hi20 = round(c.price * 1.06, 2), lo20 = round(c.price * 0.9, 2),
          dev = 0, bull = false, safe = true;
      if (hasKs) {
        cl = closeSeries(ks);
        last = cl[cl.length - 1];
        const maN = n => cl.slice(-n).reduce((a, b) => a + b, 0) / n;
        ma5 = maN(W5); ma10 = maN(W10); ma20 = maN(W20); ma60 = maN(W60);
        /* 近 N 根高低点（txKline 行序：[日期, 开, 收, 高, 低, 量]），N 随周期变化 */
        const w = ks.slice(-H.hiLo);
        hi20 = Math.max.apply(null, w.map(k => num(k[3])));
        lo20 = Math.min.apply(null, w.map(k => num(k[4])));
        /* 多头排列：MA(W5) > MA(W10) > MA(W20) > MA(W60)，且价在最短均线之上 */
        bull = ma5 > ma10 && ma10 > ma20 && ma20 > ma60 && last > ma5;
        /* 位置：不追高（偏离最长均线不超过 devMax%） */
        dev = (last / ma20 - 1) * 100;
        safe = dev < H.devMax;
      }
      const cash = (c.mainNetInflow || 0) > 0;
      const vol = (c.volumeRatio || 0) > 1;
      const raw = hasKs ? rawFactors(cl, ks) : null;   // 8 个原始因子（未归一化）
      return { c, hasKs, last, ma5, ma10, ma20, ma60, hi20, lo20, dev, bull, safe, cash, vol, raw };
    } catch (e) { return null; /* 单只失败跳过 */ }
  }));
  const items = base.filter(Boolean);

  /* 第三层：横截面归一化——在候选池（活跃上涨 A 股）内对所有原始因子做 z-score，
     才是真正的横截面：因子「越大越好」方向已统一，按池内均值/标准差标准化后等权合成。
     单票时序视角已废弃（旧版用经验阈值 clamp，量纲错乱）。 */
  const withRaw = items.filter(it => it.raw);
  const zs = crossSection(withRaw.map(it => it.raw));
  const zByCode = {};
  withRaw.forEach((it, i) => { zByCode[it.c.code] = zs[i]; });

  /* 第四层：按周期权重合成综合评分，过入选门槛，算技术位 */
  const rows = items.map((it) => scoreRow(it, H, zByCode[it.c.code] || null));
  return {
    list: rows.filter(Boolean).sort((a, b) => b.score - a.score || b.netRatio - a.netRatio),
    sampleSize,                                 // 全市场截面样本数（流动性过滤前，用于展示量级）
    techSize: tech.length                       // 真正参与技术面横截面的样本数（口径透明）
  };
}

/* ---------- 单只候选：综合评分 + 技术位（纯函数）----------
   抽成纯函数有两个目的：
     1. 可单测 —— 评分是整套选股的核心，原先埋在 forecastList 闭包里无法独立验证；
     2. 结构上杜绝 P0 复发 —— 历史缺陷正是在这个闭包里直接引用了外层并不存在的
        last / ma5 / ma10 / ma20 / ma60 / dev，导致每次调用都抛 ReferenceError、
        整个 /api/forecast 100% 失败。现在所有输入只能来自 it / cfg / z 三个入参。

   @param it   第二层产出的单只技术面数据
   @param cfg  FORECAST_HORIZONS 中的周期配置
   @param z    该股在横截面中的 z-score 合成分（无因子时为 null）
   @returns    入选则返回完整行；未达门槛返回 null */
function scoreRow(it, cfg, z) {
  const c = it.c;
  const ratio = c.amount > 0 ? (c.mainNetInflow || 0) / c.amount * 100 : 0;

  /* 综合评分：由「布尔命中加权」改为「连续强度加权」，结果可为 0~100 之间
     任意两位小数，不再局限于 0/5/25/30 等离散阶梯。各维度强度先压到 0~1
     再按周期权重合成；资金强度另按净流入占比连续加分。 */
  const sigm = (x) => 1 / (1 + Math.exp(-x));
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  /* 均线多头强度：四段相邻均线的正偏离度经 sigmoid 平均到 0~1（全多头→趋近 1） */
  const gaps = [it.last / it.ma5 - 1, it.ma5 / it.ma10 - 1, it.ma10 / it.ma20 - 1, it.ma20 / it.ma60 - 1];
  const bullScore = clamp01(gaps.reduce((a, x) => a + sigm(x * 12), 0) / gaps.length);
  /* 资金强度：主力净流入占比（%）映射，0%→0.5，越正越趋近 1 */
  const cashScore = clamp01(sigm(ratio * 0.3));
  /* 量能强度：量比相对 1 的偏离映射（量比=1→0.5） */
  const volScore = clamp01(sigm(((c.volumeRatio || 1) - 1) * 1.5));
  /* 位置安全：偏离最长均线 dev 越小越安全（dev<=0 视为满分） */
  const safeScore = clamp01((cfg.devMax - it.dev) / cfg.devMax);
  let score = cfg.w.bull * bullScore + cfg.w.cash * cashScore
    + cfg.w.vol * volScore + cfg.w.safe * safeScore;
  /* 资金强度连续加分：净流入占比每 1% 加 1 分（与原 5%→+5 / 10%→+10 同基准），上限 10 */
  score += Math.max(0, Math.min(10, ratio));
  score = Math.min(100, round(score, 2));

  if (score < cfg.threshold) return null;

  /* 周期因子合成分（横截面 z-score 等权合成，截尾 ±3 → 映射展示 25~95） */
  const qfScore = z ? Math.round(Math.max(0, Math.min(100, (z.composite / 3) * 35 + 60))) : null;

  /* ---- 预测结果（技术位，随周期变化）---- */
  const target = it.hi20 > it.last ? round(it.hi20, 2) : round(it.last * 1.06, 2);
  const below = [it.ma20, it.ma60, it.lo20].filter(v => v > 0 && v < it.last);
  const support = round(below.length ? Math.max.apply(null, below) : it.lo20, 2);
  const upside = round((target / it.last - 1) * 100, 2);
  const risk = round((it.last / support - 1) * 100, 2);
  const rr = risk >= 0.5 ? round(upside / risk, 2) : null;
  const view = score >= cfg.view.strong ? '强烈看多' : score >= cfg.view.bull ? '看多'
    : score >= cfg.view.bias ? '偏多' : '中性';

  return Object.assign({}, c, {
    ma5: round(it.ma5, 2), ma10: round(it.ma10, 2), ma20: round(it.ma20, 2), ma60: round(it.ma60, 2),
    dev: round(it.dev, 2), netRatio: round(ratio, 2),
    score, bull: it.bull, cash: it.cash, vol: it.vol, safe: it.safe,
    hi20: round(it.hi20, 2), lo20: round(it.lo20, 2),
    target, support, upside, risk, rr, view,
    qfScore, qf: it.raw ? Object.assign({}, it.raw, { composite: z ? round(z.composite, 2) : 0 }) : null
  });
}

/* ===================================================================
   周线因子计算（移植自 quant_deliverables/features.py · compute_factors）
   输入：收盘价序列 cl（数组，升序，至少 60 根）；原始 K 线 ks（用于取成交量）。
   输出：{ composite, detail } —— composite 是 8 因子等权合成（已 MAD 标准化），
         detail 是每个因子的原始值 + 方向说明，供前端 tooltip 展示。

   设计原则（features.py 原文）：
     1. 全部「越大越好」方向，便于等权合成，不必逐因子记符号
     2. 只用 t 时刻及之前数据，因子在 t 收盘后算、交易在 t+1 发生
     3. 样本量小，因子控制在 8 个以内，30 个弱因子只会放大过拟合
   =================================================================== */
/* ===================================================================
   周期因子（8 个）计算 —— 拆成「原始值」+「横截面 z-score」两步。
   第一步 rawFactors 只算 8 个方向统一为「越大越好」的原始因子（不归一化）；
   第二步 crossSection 在候选池（活跃上涨 A 股）内做真正的横截面标准化。

   设计原则（features.py 原文）：
     1. 全部「越大越好」方向，便于等权合成，不必逐因子记符号
     2. 只用 t 时刻及之前数据，因子在 t 收盘后算、交易在 t+1 发生
     3. 样本量小，因子控制在 8 个以内，30 个弱因子只会放大过拟合
   =================================================================== */
/* 8 个原始因子（方向已统一「越大越好」），未归一化。供 crossSection 做横截面 z-score。 */
function rawFactors(cl, ks) {
  if (!cl || cl.length < 60) return null;
  const n = cl.length;
  const last = cl[n - 1];
  const slice = (from) => cl.slice(from < 0 ? n + from : from);
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const std = (arr) => {
    const m = mean(arr);
    return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, arr.length - 1));
  };
  const rets = [];
  for (let i = 1; i < n; i++) rets.push(cl[i] / cl[i - 1] - 1);

  /* ---- 8 个因子（原始值，方向已统一「越大越好」）---- */
  const mom_12_1 = last / cl[n - 13] - 1;                    // 12 期动量（跳最近 1 期）
  const ma60v = mean(slice(-60));                            // 60 期均线（判长期趋势方向）
  const ma20v = mean(slice(-20));
  const trend_dev = last / ma20v - 1;                        // 趋势位置（偏离 MA20）
  const ma20_4ago = mean(cl.slice(n - 24, n - 4));
  const trend_slope = ma20v / ma20_4ago - 1;                 // 均线斜率（趋势方向，>0 上行）
  /* 反转护栏（第三层逻辑衰减防护，对应文章"相关≠因果 / 低 PE 陷阱"）：
     纯"跌多就买"是统计伪相关——下跌可能由基本面恶化或趋势性走弱驱动，而非超卖反弹。
     仅当不处于长期下跌趋势（价在 MA60 之上 且 斜率非负）时，才对 4 期跌幅给反转加分；
     下跌趋势中的跌幅视为趋势性走弱、不奖励，避免把"接飞刀"误判为机会。 */
  let rev_4 = -(last / cl[n - 5] - 1);                       // 4 期反转（取负，跌多加分）
  if (last < ma60v || trend_slope < -0.03) rev_4 *= 0.35;    // 趋势向下：衰减反转加分（×0.35）
  const low_vol_12 = -std(rets.slice(-12));                  // 低波异象（取负，波动低加分）
  /* 量能趋势：近 4 日均成交额 / 近 12 日均成交额。腾讯 K 线行序 [日期,开,收,高,低,量]，
     无成交额字段时用 收盘价×成交量 近似（amount ≈ close × volume）。 */
  const amtSeries = (ks && ks.length) ? ks.map(k => num(k[2]) * num(k[5])) : cl;
  const av4 = mean(amtSeries.slice(-4)), av12 = mean(amtSeries.slice(-12));
  const amount_trend = av12 ? av4 / av12 : 1;                // 量能回暖
  const hi52 = Math.max.apply(null, slice(-52));
  const pos_52 = last / hi52 - 1;                            // 距 52 期高点回撤（越浅越好）
  const amps = [];
  for (let i = Math.max(1, n - 8); i < n; i++) amps.push(cl[i] / cl[i - 1] - 1);
  const low_amp_8 = -mean(amps);                             // 低振幅（取负，更稳加分）

  return { mom_12_1, rev_4, low_vol_12, amount_trend, trend_dev, trend_slope, pos_52, low_amp_8 };
}

/* 横截面 z-score：在传入的样本池（候选 A 股）内，对每个因子做稳健标准化，
   用 MAD（中位数绝对偏差）替代均值/标准差，截尾到 ±3。方向已统一「越大越好」，等权合成 composite。
   MAD 去极值：单只极端值（如一字跌停/突发利好）不会主导横截面合成（第二层稳健化思想）。
   这才是真正的横截面——单票在「全市场相对位置」上的信号，而非自身历史分位。 */
/* 中位数（MAD 去极值用） */
function median(arr) {
  const a = arr.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function crossSection(raws) {
  const keys = ['mom_12_1', 'rev_4', 'low_vol_12', 'amount_trend', 'trend_dev', 'trend_slope', 'pos_52', 'low_amp_8'];
  const stats = {};
  for (const k of keys) {
    const vals = raws.map(r => r[k]).filter(v => typeof v === 'number' && v === v);
    const med = median(vals);
    const mad = median(vals.map(v => Math.abs(v - med))) || 1e-9;  // 中位数绝对偏差
    stats[k] = { med, mad };   // MAD 稳健化：抵抗单只极端值主导横截面合成
  }
  return raws.map(r => {
    let sum = 0, cnt = 0;
    const z = {};
    for (const k of keys) {
      let zi = 0.6745 * (r[k] - stats[k].med) / stats[k].mad;  // 稳健 z：≈正态 z，抗极端值
      if (!isFinite(zi)) zi = 0;
      zi = Math.max(-3, Math.min(3, zi));   // 截尾，避免极端值主导合成
      z[k] = zi;
      sum += zi; cnt++;
    }
    z.composite = cnt ? sum / cnt : 0;       // 8 因子等权合成的截面得分
    return z;
  });
}
/* 预测结果缓存：预测过一次后，将结果保留至当天 24:00（次日 00:00）；
   超过 24:00（即跨自然日）后再次打开预测 PP 会自动重新预测。
   - 缓存键含「日期(YYYY-MM-DD) + 周期」，TTL 设为「距当天 24:00 的剩余毫秒数」，
     到点自动失效，无需定时清理；进程重启后内存清空，等价于重新预测。
   - force=1 绕过缓存强制重算（前端「重新预测」按钮用）。 */
/* 基准 TTL 仅作兜底；实际写入时用「距午夜剩余毫秒数」作为该条目的 TTL */
const fcCache = createCache({ name: 'forecast', ttl: 60 * 1000, max: 32 });
/* 计算当前时刻距「今天 24:00」的剩余毫秒数（即到次日 00:00） */
function msUntilMidnight() {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  return midnight.getTime() - now.getTime();
}
/* ---------- 磁盘持久化 ----------
   内存缓存（fcCache）在进程重启后全部丢失，导致每次重启都要重跑
   46~104s 的全市场扫描。同一交易日的选股结果本质上是稳定的，
   因此按「日期」落盘一份 JSON：重启后直接读盘返回（<80ms），
   也让「重新预测」的结果能被所有请求复用。
   文件按日切分，天然不会无限增长（需要时可清理 data/forecast）。 */
function fcFile(date) { return path.join(FC_DIR, `${date}.json`); }

async function fcReadDisk(date, h) {
  try {
    const all = JSON.parse(await fsp.readFile(fcFile(date), 'utf8')) || {};
    return all[h] || null;
  } catch (e) {
    return null;   // 文件不存在 / 损坏：按未命中处理
  }
}

async function fcWriteDisk(date, h, payload) {
  try {
    await fsp.mkdir(FC_DIR, { recursive: true });
    let all = {};
    try { all = JSON.parse(await fsp.readFile(fcFile(date), 'utf8')) || {}; } catch (e) { all = {}; }
    all[h] = { ...payload, savedAt: new Date().toISOString() };
    await fsp.writeFile(fcFile(date), JSON.stringify(all));
  } catch (e) {
    /* 落盘失败不应影响本次返回：内存缓存仍然生效 */
    log.warn('forecast persist failed', { horizon: h, err: e.message });
  }
}

/** 计算单周期结果（接口与预计算共用同一口径） */
async function fcCompute(h) {
  const cfg = FORECAST_HORIZONS[h] || FORECAST_HORIZONS.mid;
  const { list, sampleSize, techSize } = await forecastList(h);
  return {
    date: todayDash(),
    horizon: h,
    window: cfg.window,
    sampleSize,
    techSize,
    list: list.slice(0, FC_TOP)
  };
}

H['/forecast'] = async (res, q) => {
  const h = q.get('h') || 'mid';
  const force = q.get('force') === '1';
  const date = todayDash();

  /* 1) 磁盘缓存优先：同日内（含进程重启）直接秒回 */
  if (!force) {
    const disk = await fcReadDisk(date, h);
    if (disk) return ok(res, { ...disk, cached: true, from: 'disk' });
  }

  /* 2) 内存缓存：并发的同类请求合并为一次全市场计算；
        未命中才真正计算，并把结果落盘供后续（含重启后）复用 */
  const r = await fcCache.wrap(
    `${date}|${h}`,
    async () => {
      const payload = await fcCompute(h);
      await fcWriteDisk(date, h, payload);
      return payload;
    },
    { force, ttl: () => Math.max(60 * 1000, msUntilMidnight()) }
  );
  ok(res, { ...r.data, cached: r.cached, from: 'live' });
};

/** 预计算全部周期（串行 + bg 档闸门）。
    只在当日该周期磁盘缓存缺失时才算，重复调用无副作用。
    由 index.js 启动后延迟触发，让用户的首次访问也走秒回路径。 */
async function precomputeAll() {
  const date = todayDash();
  for (const h of Object.keys(FORECAST_HORIZONS)) {
    try {
      if (await fcReadDisk(date, h)) continue;
      const t0 = Date.now();
      const payload = await fcCompute(h);
      await fcWriteDisk(date, h, payload);
      log.info('forecast prewarmed', { horizon: h, rows: payload.list.length, ms: Date.now() - t0 });
    } catch (e) {
      log.warn('forecast prewarm failed', { horizon: h, err: e.message });
    }
  }
}

/* ===================================================================
   A1 历史回测系统（REQUIREMENTS A1 · 最高优先级）

   ---------- 数据可得性限制（务必先读，不得虚构数据源）----------
   1. 历史某日的全市场快照（当日成交额榜、当日主力净流入 f62）不可得，
      东财 clist 只返回实时数据 → 资金维度（forecast 的 cash / 25 分，
      以及资金强度加分）在回测中记为「不可用」，不参与打分。
   2. 因此回测只覆盖 K 线可推导的三维：
        bull 均线多头 40 分（MA5>MA10>MA20>MA60 且 收盘>MA5）
        vol  量比近似 20 分（当日量 / 前 5 日均量 > 1）
        safe 位置安全 15 分（偏离 MA20 < 15%）
      满分 75 分。命中规则沿用线上口径：kScore >= minScore（默认 50）。
      注意 50 分这一门槛本身蕴含 bull 必为真（非 bull 时上限 20+15=35），
      与线上「score>=50 入选」在 K 线维度上完全等价。
      资金维度由 A2 事后追踪补齐（追踪落盘时资金数据是真实的）。
   3. 所有价格一律用**后复权 hfq**（见 D1）。原因：前复权历史价在每次
      除权后整体平移，用它回测会产生「当时并不存在」的假买卖点。

   ---------- 实测记录（上游 hfq 口径，勿删）----------
   - 腾讯 qfq 与东财 fqt=1 数值完全一致（600519：1473.53 / 1467.54 / 1545.68 / 1506.51）
   - 但 hfq 序列跨源、乃至与同源 qfq 都**不对齐**：
       腾讯内部 hfq 与 qfq 的日收益近似成常数倍（≈1.245），
       qfq/hfq 比值逐日变化（500 个交易日里变 497 次），不是除权阶跃；
       腾讯 hfq 与东财 fqt=2 的 5 日区间收益也不同
       （600519 2024-11-08→2024-11-15：TX hfq −2.79% / EM hfq −4.90% / qfq −3.38%）
     → 结论：本环境上游的「后复权」是各源各自生成的序列，互相不可对齐。
       回测内部自洽（买卖价取自同一条 hfq 序列），
       但**不能**用东财 App 的后复权 K 线做跨源逐笔核对，
       验收改用「同一条上游序列手工复算」的方式（见 A1 验收说明）。
   =================================================================== */

Object.assign(H, {
  FC_BARS,
  FC_MAX_TECH,
  FC_TOP,
  FORECAST_HORIZONS,
  crossSection,
  fcCache,
  fcCompute,
  fcReadDisk,
  fcWriteDisk,
  forecastList,
  msUntilMidnight,
  precomputeAll,
  rawFactors,
  scoreRow
});
module.exports = H;
