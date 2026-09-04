/* 由 server.js 机械拆分而来，行为未改动。 */
const { EMX, FY, FY_IDX_CODES, FY_KEY, UA } = require('../config.js');
const { num, round } = require('../lib/format.js');
const { fail, ok } = require('../lib/respond.js');
const { createCache } = require('../lib/cache.js');
const { log } = require('../lib/logger.js');
const H = {};

const FY_TTL = 300000;  // 实测同花顺约 20 秒/次限流，缓存放宽到 5 分钟，避免把密钥打废
/* 市场统计与指数快照拆成两个缓存：原实现共用一个时间戳 t，
   会导致其中一项刷新时把另一项的"年龄"也一起重置。 */
const fyStatCache = createCache({ name: 'fuyao-stat', ttl: FY_TTL, max: 4 });
const fyIdxCache = createCache({ name: 'fuyao-indices', ttl: FY_TTL, max: 4 });

/* 同花顺限流实测：约 20 秒/次，连续请求直接返回 429（request limit exceeded）。
   所有 fuyao 请求串行排队 + 最小间隔 + 429 指数退避，避免把密钥打废。 */
const FY_GAP = 20000;
let fyLast = 0;
let fyChain = Promise.resolve();
const fyDelay = ms => new Promise(r => setTimeout(r, ms));

async function fyGetRaw(fyPath) {
  const hdrs = { 'X-api-key': FY_KEY, 'User-Agent': UA };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(FY + fyPath, { signal: ctrl.signal, headers: hdrs });
    clearTimeout(timer);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (j.code === 429) { const e = new Error('fuyao 429 rate limited'); e.fy429 = true; throw e; }
    if (j.code !== 0 && j.code !== 200) throw new Error(j.message || 'fuyao error ' + j.code);
    return j.data;
  } catch (e) { clearTimeout(timer); throw e; }
}

async function fyGet(fyPath) {
  if (!FY_KEY) throw new Error('FY_API_KEY 未配置');
  const run = async () => {
    const wait = Math.max(0, fyLast + FY_GAP - Date.now());
    if (wait > 0) await fyDelay(wait);
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try {
        const d = await fyGetRaw(fyPath);
        fyLast = Date.now();
        return d;
      } catch (e) {
        lastErr = e;
        fyLast = Date.now();
        if (i < 2) await fyDelay(e.fy429 ? [20000, 40000][i] : 3000);
      }
    }
    throw lastErr;
  };
  /* 串行化：后一个请求必须等前一个走完，保证相邻间隔 >= FY_GAP */
  const p = fyChain.then(run, run);
  fyChain = p.catch(() => {});
  return p;
}

/* 市场统计：从全市场行情快照聚合涨跌家数 / 成交额
   （同花顺不提供一站式「涨跌家数汇总」接口，需从行情快照分页聚合） */
let fyStatBusy = false;

/* 全市场快照分页拉取：total≈5566 但单次 limit 上限 5000，
   只取第一页会漏掉约 566 只（≈10%），涨跌家数因此失真 —— 必须翻页取全量。
   注：原实现还多请求了一次指数快照（只用来算 amount，而 amount 最终被
   全市场快照的 sAmt 覆盖，结果根本没用上），这里已删除，省下一次请求。 */
async function fetchFuyaoStat() {
  let all = [], total = 0;
  for (let offset = 0; offset < 20000; offset += 5000) {
    const j = await fyGet(`/api/a-share/prices/snapshot?limit=5000&offset=${offset}`);
    const items = j?.item || [];
    if (j?.total) total = j.total;
    all = all.concat(items);
    if (items.length < 5000) break;   // 已取完
  }
  if (!all.length) return null;

  let up = 0, down = 0, flat = 0, amt = 0;
  all.forEach(x => {
    const p = num(x.price_change_ratio_pct);
    if (p > 0.001) up++; else if (p < -0.001) down++; else flat++;
    amt += num(x.turnover);
  });
  const valid = up + down + flat;
  const pctOf = n => valid ? round(n * 100 / valid, 1) : 0;

  return {
    source: 'ths',
    total: total || all.length,
    sample: valid,
    up, down, flat,
    upPct: pctOf(up), downPct: pctOf(down), flatPct: pctOf(flat),
    amount: round(amt / 1e12, 3),
    amountYi: round(amt / 1e8, 2),
    mainFlow: null,           /* 同花顺无全市场主力净流入汇总接口，由东财补 */
    partial: false,
    updatedAt: new Date().toISOString()
  };
}

H['/fuyao-stat'] = async (res, q) => {
  if (!FY_KEY) return ok(res, null);   /* 前端降级到东财 */
  const hit = fyStatCache.get('stat');
  if (hit !== null) return ok(res, hit);
  /* 无有效缓存：立即返回，后台异步拉取。
     同花顺限流约 20 秒/次，翻 2 页需 40+ 秒，绝不能让前端干等
     —— 所以这里刻意不用阻塞式的 wrap()。 */
  if (!fyStatBusy) {
    fyStatBusy = true;
    fetchFuyaoStat()
      .then(d => { if (d) fyStatCache.set('stat', d); })
      .catch(() => {})
      .finally(() => { fyStatBusy = false; });
  }
  /* 缓存已过期但还在 stale 窗口内时，先把旧值给前端，别返回空白 */
  const old = fyStatCache.peek('stat');
  return ok(res, old ? old.v : null);
};

/* 指数快照：批量取主要 A 股指数点位 */
let fyIdxBusy = false;

/* 批量快照中任一 thscode 不被支持会导致整批失败（实测 899050.TI → code 1002）。
   整批失败时二分重试并跳过失败分支，避免个别代码失效拖垮全部指数。
   递归内部走 fyGet 串行队列，不会突破 20 秒/次的限流。 */
async function fyGetIndicesSafe(codes) {
  try {
    const j = await fyGet('/api/a-share-index/prices/snapshot?thscodes=' + codes.join(','));
    return j?.item || [];
  } catch (e) {
    if (codes.length <= 1) return [];
    const mid = Math.ceil(codes.length / 2);
    const a = await fyGetIndicesSafe(codes.slice(0, mid));
    const b = await fyGetIndicesSafe(codes.slice(mid));
    return a.concat(b);
  }
}

async function fetchFuyaoIndices() {
  const items = (await fyGetIndicesSafe(FY_IDX_CODES)).map(x => ({
    /* 用 thscode 而非 ticker：ticker 是同花顺内部格式（000001.SH → "1A0001"），
       与前端代码表对不上；取 thscode 前缀得到 "000001"，与东财 code 格式一致。 */
    code: String(x.thscode || '').split('.')[0],
    name: '',   /* fuyao 快照不含名称，由前端映射 */
    price: round(x.last_price),
    pct: round(x.price_change_ratio_pct),
    change: round(x.price_change),
    amount: round(num(x.turnover) / 1e8, 2),   // 元→亿
    source: 'ths'
  })).filter(s => s.code && s.price > 0);
  return items.length ? items : null;
}

H['/fuyao-indices'] = async (res, q) => {
  if (!FY_KEY) return ok(res, null);
  const hit = fyIdxCache.get('idx');
  if (hit !== null) return ok(res, hit);
  /* 无缓存：立即返回，后台异步拉取（限流约 20 秒/次，不让前端等待） */
  if (!fyIdxBusy) {
    fyIdxBusy = true;
    fetchFuyaoIndices()
      .then(d => { if (d) fyIdxCache.set('idx', d); })
      .catch(() => {})
      .finally(() => { fyIdxBusy = false; });
  }
  const old = fyIdxCache.peek('idx');
  return ok(res, old ? old.v : null);
};

/* ---------- 涨跌停 / 炸板 / 连板（同花顺 fuyao 源） ----------
   文档：https://fuyao.aicubes.cn/docs/api-reference/limit-up-data/
   四个池：涨停 / 跌停 / 炸板 / 连板天梯。
   fuyao 限流约 20 秒/次，故按 kind 分别缓存（复用 FY_TTL=5 分钟），
   且限流失败时降级返回上一次的旧值，避免前端整块空白。 */
const FY_LIMIT = {
  up:     { path: '/api/a-share/special-data/limit-up-pool',    sort: 'continue_day_cnt' },
  down:   { path: '/api/a-share/special-data/limit-down-pool',  sort: 'last_limit_time' },
  break:  { path: '/api/a-share/special-data/limit-break-pool', sort: 'open_times' },
  ladder: { path: '/api/a-share/special-data/limit-up-ladder',  sort: '' }
};
/* kind -> data。开启 stale 兜底：限流/上游失败时返回上一次的结果，
   避免前端整块空白（旧代码需手写 hit 判断，这里由统一缓存接管）。 */
const fyLimitCache = createCache({ name: 'fuyao-limit', ttl: FY_TTL, max: 8, staleTtl: 60 * 60 * 1000 });

/* ---------- 东财涨停池（降级源） ----------
   fuyao 限流约 20s/次且需密钥，失败时涨停/连板降级到东财 push2ex 涨停池：
   无需密钥、无严格限流。字段口径（实测）：
   p 价格×1000 · zdp 涨跌幅% · lbc 连板数 · fund 封单额(元) · fbt/lbt 首末封板
   时间(HHMMSS) · zbc 炸板次数 · zttj{days,ct} 几天几板 · hybk 行业 · hs 换手%。
   注意：seal_nextday / sign_level 为同花顺天梯专有，东财无对应字段（置 null）。 */
function emTimeFmt(t) {
  /* 东财时间数字省略前导零（92501 = 09:25:01），先补齐 6 位再截取 */
  const s = String(t || '').padStart(6, '0');
  return /^\d{6}$/.test(s) ? s.slice(0, 2) + ':' + s.slice(2, 4) : '';
}
async function emZTPool(date) {
  /* 东财要求必传 date（实测缺省返回 rc:102 data:null），缺省取上海时区当天 */
  const d = date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/-/g, '');
  const qs = new URLSearchParams({
    ut: '7eea3edcaed734bea9cbfc24409ed989', dpt: 'wz.ztzt',
    Pageindex: '0', pagesize: '1000', sort: 'fbt:asc', date: d
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(EMX + '/getTopicZTPool?' + qs, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error('东财涨停池 HTTP ' + r.status);
    const j = await r.json();
    const pool = (j && j.data && j.data.pool) || [];
    return pool.map(x => {
      const tj = x.zttj || {};
      const cont = tj.days === tj.ct;   // days 天 ct 板：相等即纯连板
      return {
        code: x.c || '',
        thscode: x.c ? x.c + (Number(x.m) === 1 ? '.SH' : '.SZ') : '',
        name: x.n || '',
        price: round(num(x.p) / 1000),
        pct: round(x.zdp),
        limitTime: emTimeFmt(x.fbt),
        reason: x.hybk || '',          // 东财给行业，非涨停原因
        boardText: cont ? (x.lbc > 1 ? x.lbc + '连板' : '首板')
                        : (tj.days || '-') + '天' + (tj.ct || '-') + '板',
        boardCnt: x.lbc == null ? null : x.lbc,
        sealMoney: x.fund == null ? null : round(x.fund / 1e8, 2),
        maxSeal: null,
        firstTime: '',
        lastTime: emTimeFmt(x.lbt),
        openTimes: x.zbc == null ? null : x.zbc,
        turnoverPct: x.hs == null ? null : round(x.hs),
        turnover: x.amount == null ? null : round(x.amount / 1e8, 2),
        isST: false, isNew: false,
        /* 天梯专有字段：降级源没有 */
        board: null, sealNext: null, signLevel: null, lastSeal: null, lastSealDate: ''
      };
    });
  } finally { clearTimeout(timer); }
}

H['/fuyao-limit'] = async (res, q) => {
  const kind = q.get('kind') || 'up';
  const cfg = FY_LIMIT[kind];
  if (!cfg) return fail(res, '未知类型：' + kind, 400);
  /* 未配密钥时涨停/连板仍可走东财降级（在下方 catch 中处理），其余池才直接报错 */
  if (!FY_KEY && kind !== 'up' && kind !== 'ladder') {
    return fail(res, '未配置同花顺密钥，请在 data/fuyao.json 中配置 apiKey');
  }

  const size = Math.min(200, Math.max(1, Number(q.get('size')) || 50));
  try {
    /* 统一缓存：命中直接返回；未命中时并发的同类请求合并为一次上游调用；
       上游限流/失败时自动降级到上一次结果（stale 兜底）。 */
    const { data } = await fyLimitCache.wrap(kind, async () => {
    const qs = cfg.sort ? `?page=1&size=${size}&sort_field=${cfg.sort}&sort_dir=desc` : '';
    const d = await fyGet(cfg.path + qs);
    const items = Array.isArray(d && d.item) ? d.item : [];
    let list, extra;

    if (kind === 'ladder') {
      /* 连板天梯是「日期 → 6 个板位 → 股票」的矩阵，上游固定返回近 30 个交易日。
         只取最新日摊平展示；历史窗口用于两件事：
         1. 回填「上次连板延续」—— seal_nextday（次日封板）对最新交易日恒为 null
            （还没有"次日"可回填），只有历史日期有 true/false；取该股最近一次
            连板的次日结果，展示其连板延续性的历史表现；
         2. 计算昨日连板晋级率（昨日窗口 seal_nextday=true 的占比）作为情绪指标。 */
      const BOARDS = ['seven_over', 'six_board', 'five_board', 'four_board', 'three_board', 'two_board'];
      const eachStock = (day, fn) => {
        if (!day) return;
        for (const b of BOARDS) for (const x of (day.boards && day.boards[b]) || []) fn(x);
      };
      /* 从旧到新扫历史（items[0] 为最新日，故从末尾扫到 i=1），后写覆盖，
         每股留下离今天最近的一次「连板次日结果」 */
      const lastSealMap = {};
      for (let i = items.length - 1; i >= 1; i--) {
        const d = items[i].date;
        eachStock(items[i], x => {
          if (x.ticker && x.seal_nextday != null) lastSealMap[x.ticker] = { seal: x.seal_nextday, date: d };
        });
      }
      /* 昨日连板晋级率 */
      let promTotal = 0, promHit = 0;
      eachStock(items[1], x => {
        if (x.seal_nextday != null) { promTotal++; if (x.seal_nextday) promHit++; }
      });
      const latest = items[0] || null;
      list = [];
      if (latest) {
        eachStock(latest, x => {
          const ls = (x.ticker && lastSealMap[x.ticker]) || null;
          list.push({
            code: x.ticker || '', thscode: x.thscode || '', name: x.name || '',
            board: x.board_num == null ? null : x.board_num,
            sealNext: x.seal_nextday == null ? null : x.seal_nextday,
            signLevel: x.sign_level == null ? null : x.sign_level,
            /* 上次连板延续（历史回填；首次连板为 null） */
            lastSeal: ls ? ls.seal : null,
            lastSealDate: ls ? ls.date : ''
          });
        });
      }
      extra = {
        date: (latest && latest.date) || '',
        promotion: promTotal ? Math.round((promHit * 100) / promTotal) : null,
        promTotal
      };
    } else {
      list = items.map(x => ({
        code: x.ticker || '', thscode: x.thscode || '', name: x.name || '',
        price: round(x.last_price),
        pct: round(x.price_change_ratio_pct),
        /* 涨停池专有 */
        limitTime: x.limit_up_time || '',
        reason: x.limit_up_reason || '',
        boardText: x.continue_day_text || '',
        boardCnt: x.continue_day_cnt == null ? null : x.continue_day_cnt,
        sealMoney: x.seal_money == null ? null : round(x.seal_money / 1e8, 2),
        maxSeal: x.max_seal_money == null ? null : round(x.max_seal_money / 1e8, 2),
        /* 跌停池专有 */
        firstTime: x.first_limit_time || '',
        lastTime: x.last_limit_time || '',
        /* 炸板池专有 */
        openTimes: x.open_times == null ? null : x.open_times,
        turnoverPct: x.turnover_ratio_pct == null ? null : round(x.turnover_ratio_pct),
        turnover: x.turnover == null ? null : round(x.turnover / 1e8, 2),
        isST: !!x.is_st,
        isNew: !!x.is_new
      }));
      extra = { total: (d && d.pagination && d.pagination.total) != null ? d.pagination.total : list.length };
    }

      return Object.assign({ kind: kind, list: list }, extra);
    }, { stale: true });
    ok(res, data);
  } catch (e) {
    /* 走到这里说明 fuyao 既无缓存也无 stale 可降级：涨停/连板再降到东财涨停池，
       而非直接报错留白（东财缺天梯专有的 sealNext/signLevel/晋级率，但
       连板数/封单额/几天几板齐全，够用且胜过空白）。 */
    if (kind === 'up' || kind === 'ladder') {
      try {
        const emList = await emZTPool('');
        if (kind === 'ladder') {
          const ladder = emList
            .filter(x => (x.boardCnt || 0) >= 2)
            .sort((a, b) => (b.boardCnt || 0) - (a.boardCnt || 0));
          return ok(res, { kind, list: ladder, date: '', source: 'em', promotion: null, promTotal: null });
        }
        return ok(res, { kind, list: emList, total: emList.length, source: 'em' });
      } catch (e2) {
        log.warn('em zt-pool fallback failed', { err: e2.message });
      }
    }
    fail(res, e instanceof Error ? e.message : '同花顺数据获取失败');
  }
};

/* ---------- 板块资金：行业 / 概念 / 地域 ---------- */

Object.assign(H, { FY_GAP, FY_LIMIT, FY_TTL, emZTPool, fetchFuyaoIndices, fetchFuyaoStat, fyChain, fyDelay, fyGet, fyGetIndicesSafe, fyGetRaw, fyIdxBusy, fyIdxCache, fyLast, fyLimitCache, fyStatBusy, fyStatCache });
module.exports = H;
