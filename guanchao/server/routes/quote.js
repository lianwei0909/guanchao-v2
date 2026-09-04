/* 由 server.js 机械拆分而来，行为未改动。 */
const { EM, EM2, EMD, EMX } = require('../config.js');
const { clistGet } = require('../datasource/em.js');
const { num, round, today } = require('../lib/format.js');
const { getJSON, getJSONFailover, hostHealth } = require('../lib/http.js');
const { ok } = require('../lib/respond.js');
const { emSecid, resolve, secidOf } = require('../lib/secid.js');
const cacheStats = require('../lib/cache.js').stats;
const { stats: errorStats } = require('../lib/monitor.js');
const { stats: gateStats } = require('../lib/gate.js');
const H = {};

/* 健康检查：除存活外，把「上游降级 / 缓存命中 / 错误概况 / 闸门水位 / 内存」
   一并暴露，便于守护与排障直接读一个接口。 */
H['/health'] = async (res) => {
  const hosts = {};
  for (const [h, v] of hostHealth) {
    hosts[h] = { fails: v.fails, cooldownLeftMs: Math.max(0, v.until - Date.now()) };
  }
  ok(res, {
    ts: Date.now(),
    uptimeSec: Math.round(process.uptime()),
    degraded: hosts,
    note: Object.keys(hosts).length
      ? '有域名处于降级/冷却中，请求已自动切到备用域'
      : '全部上游正常',
    /* 缓存命中/合并情况：coalesced 表示被合并掉的重复上游请求数 */
    caches: cacheStats(),
    /* 当日错误概况：total 总数 / kinds 去重后的种类数 / last 最近一条 */
    errors: errorStats(),
    /* 并发闸门水位：fg 前台 / bg 后台，pending 为排队等待数 */
    gate: gateStats(),
    memMB: Math.round(process.memoryUsage().rss / 1048576)
  });
};

/* 允许 POST 的接口白名单，其余一律 405 */

const INDEX_SET = [
  /* A 股核心 */
  ['1.000001', '上证指数'], ['0.399001', '深证成指'], ['0.399006', '创业板指'],
  ['1.000688', '科创50'], ['0.899050', '北证50'], ['1.000300', '沪深300'],
  ['1.000016', '上证50'], ['1.000905', '中证500'], ['1.000852', '中证1000'],
  ['0.399330', '深证100'], ['1.000009', '上证380'], ['0.399303', '国证2000'],
  /* 港股 / 全球
     市场码实测（写错会静默返回 null，务必用搜索接口反查确认）：
       恒生指数 100.HSI   恒生科技 124.HSTECH   国企指数 100.HSCEI   红筹 124.HSCCI
       日经 100.N225      道琼斯 100.DJIA       纳斯达克 100.NDX     标普 100.SPX
     注意 116.HSI / 105.NDX / 100.NIXX 都是错的 */
  ['100.HSI', '恒生指数'], ['124.HSTECH', '恒生科技'],
  ['100.HSCEI', '国企指数'], ['124.HSCCI', '红筹指数'],
  ['100.N225', '日经225'], ['100.DJIA', '道琼斯'],
  ['100.NDX', '纳斯达克'], ['100.SPX', '标普500'],
  ['100.TWII', '台湾加权'], ['100.KS11', '韩国KOSPI']
];
H['/indices'] = async (res, q) => {
  /* scope=ashare 时只返回 A股指数（上证/深证/创业板/科创/北证/沪深300 等），
     排除港股与全球指数；顶部滚动条不传 scope，保留全球概览 */
  const scope = q.get('scope') || '';
  const set = scope === 'ashare'
    ? INDEX_SET.filter(([sid]) => sid.startsWith('1.') || sid.startsWith('0.'))
    : INDEX_SET;
  const ids = set.map(x => x[0]);
  /* push2 主域在部分网络下对较大量级请求会偶发「连接被重置 / 502」，
     用 push2delay 兜底（同一份行情，仅 15 分钟延时，对指数完全可接受）。 */
  let j = null;
  try {
    j = await getJSONFailover([
      `${EM}/api/qt/ulist.np/get?secids=${ids.join(',')}&fields=f2,f3,f4,f6,f12,f14,f15,f16,f17,f18&fltt=2&invt=2`,
      `${EM2}/api/qt/ulist.np/get?secids=${ids.join(',')}&fields=f2,f3,f4,f6,f12,f14,f15,f16,f17,f18&fltt=2&invt=2`
    ]);
  } catch (e) { j = null; }
  const arr = j?.data?.diff ? (Array.isArray(j.data.diff) ? j.data.diff : Object.values(j.data.diff)) : [];
  /* f12 返回的是不带市场前缀的代码，需按请求顺序回挂 secid，
     否则「000001」在详情页会被误判成平安银行 */
  const map = {};
  arr.forEach(x => { map[String(x.f12)] = x; });
  ok(res, INDEX_SET.map(([sid, fallback]) => {
    const code = sid.slice(sid.indexOf('.') + 1);
    const x = map[code];
    if (!x) return null;
    return {
      secid: sid, name: x.f14 || fallback, code,
      price: round(x.f2), change: round(x.f4), pct: round(x.f3),
      amount: round(num(x.f6) / 1e8, 2),      // 成交额（亿元）
      high: round(x.f15), low: round(x.f16),
      open: round(x.f17), preClose: round(x.f18)
    };
  }).filter(Boolean));
};

/* ---------- 批量个股行情 ---------- */
H['/quotes'] = async (res, q) => {
  const codes = (q.get('codes') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!codes.length) return ok(res, []);
  /* 市场码必须走 resolve() 判定，不能图省事用 secidOf(undefined, c)：
     那只按 A 股前缀猜（6/9/5/11 → 沪，其余 → 深），于是
       00700 → 0.00700（港股被当成深市）→ 上游认不出，整条丢弃
       NVDA  → 0.NVDA（美股被当成深市）→ 同样丢弃
     表现就是：自选股里的港股/美股查得到代码、却永远显示不出行情。
     resolve() 已经按「纯字母=美股105 / 5位数字=港股116 / 其余=A股」分好了。 */
  const ids = codes.map(c => emSecid(resolve(new URLSearchParams({ code: c })))).join(',');
  /* push2 主域在部分网络下偶发「连接被重置 / 502」，用 push2delay 兜底
     （同一份行情，仅 15 分钟延时，对自选股刷新完全可接受） */
  let j = null;
  try {
    j = await getJSONFailover([
      `${EM}/api/qt/ulist.np/get?secids=${ids}&fields=f2,f3,f4,f6,f7,f8,f12,f13,f14,f20&fltt=2&invt=2`,
      `${EM2}/api/qt/ulist.np/get?secids=${ids}&fields=f2,f3,f4,f6,f7,f8,f12,f13,f14,f20&fltt=2&invt=2`
    ]);
  } catch (e) { j = null; }
  const arr = j?.data?.diff ? (Array.isArray(j.data.diff) ? j.data.diff : Object.values(j.data.diff)) : [];
  ok(res, arr.map(x => ({
    code: String(x.f12), secid: secidOf(x.f13, x.f12), name: x.f14,
    price: round(x.f2), pct: round(x.f3), change: round(x.f4),
    turnover: round(num(x.f6) / 1e8, 2),
    amplitude: round(x.f7), rate: round(x.f8),
    mktcap: round(num(x.f20) / 1e8, 2)
  })).filter(s => s.code));
};

/* ---------- 行情排行 ---------- */
H['/ranking'] = async (res, q) => {
  const type = q.get('type') || 'change';
  const fid = { change: 'f3', turnover: 'f6', amplitude: 'f7' }[type] || 'f3';
  const fs = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';   // 沪深主板+创业板（排除ST由前端过滤）
  const arr = await clistGet(fs, fid, 'f2,f3,f4,f6,f7,f8,f12,f13,f14,f20', { pz: 40 });
  ok(res, arr.map(x => ({
    code: String(x.f12 || ''), secid: secidOf(x.f13, x.f12), name: x.f14 || '',
    price: round(x.f2), pct: round(x.f3), change: round(x.f4),
    turnover: round(num(x.f6) / 1e8, 2), volume: num(x.f5),
    amplitude: round(x.f7), rate: round(x.f8),
    mktcap: round(num(x.f20) / 1e8, 2)
  })).filter(s => s.code).slice(0, 30));
};

/* ---------- 板块资金 ---------- */
H['/sectors'] = async (res, q) => {
  const type = q.get('type') === 'concept' ? 'm:90+t:3' : 'm:90+t:2';
  const arr = await clistGet(type, 'f3', 'f2,f3,f12,f14,f62,f104,f105,f128,f136', { pz: 24 });
  ok(res, arr.map(x => ({
    name: x.f14, code: String(x.f12),
    pct: round(x.f3),
    flow: round(num(x.f62) / 1e8, 2),      // 主力净流入（元→亿）
    lead: x.f128 || '',
    leadPct: round(x.f136),
    count: num(x.f104) + num(x.f105)
  })).filter(s => s.name));
};

/* ---------- 涨跌停池 ---------- */
H['/limit'] = async (res, q) => {
  const kind = q.get('kind') || 'up';
  const date = today();
  /* 各池排序字段不同：跌停池不支持按封板时间(fbt)排序，否则返回空池 */
  const MAP = {
    up:    { ep: 'getTopicZTPool', sort: 'fbt%3Aasc' },    // 封板时间
    down:  { ep: 'getTopicDTPool', sort: 'fund%3Aasc' },   // 封单额
    break: { ep: 'getTopicZBPool', sort: 'fbt%3Aasc' }
  };
  const cfg = MAP[kind] || MAP.up;
  const url = `${EMX}/${cfg.ep}?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=40&sort=${cfg.sort}&date=${date}`;
  const j = await getJSON(url);
  const arr = j?.data?.pool || [];
  ok(res, arr.slice(0, 30).map(x => ({
    code: String(x.c || ''),
    secid: secidOf(x.m, x.c),      // 涨停池用 m 表示市场：0=深 1=沪
    name: x.n || '',
    price: round(num(x.p) / 1000),
    pct: round(x.zdp),
    turnover: round(num(x.amount) / 1e8, 2),
    seal: kind === 'break'
      ? (num(x.zbc) + '次开板')
      : ('封单 ' + round(num(x.fund) / 1e8, 2) + '亿'),
    ladder: kind === 'up' && num(x.lbc) > 1 ? num(x.lbc) + '板' : ''
  })).filter(s => s.code));
};

/* ---------- 涨跌停统计 ---------- */
H['/limit-stats'] = async (res, q) => {
  const date = today();
  const [zt, dt, zb] = await Promise.all([
    getJSON(`${EMX}/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=1&sort=fbt%3Aasc&date=${date}`).catch(() => null),
    getJSON(`${EMX}/getTopicDTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=1&sort=fund%3Aasc&date=${date}`).catch(() => null),
    getJSON(`${EMX}/getTopicZBPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=1&sort=fbt%3Aasc&date=${date}`).catch(() => null)
  ]);
  const up = num(zt?.data?.tc) || (zt?.data?.pool || []).length;
  const down = num(dt?.data?.tc) || (dt?.data?.pool || []).length;
  const brk = num(zb?.data?.tc) || (zb?.data?.pool || []).length;
  ok(res, {
    up, down, break: brk,
    ratio: up + brk > 0 ? round(up / (up + brk) * 100, 1) : 0
  });
};

/* ---------- 龙虎榜 ----------
   龙虎榜在收盘后（约18:00）才发布，因此不能写死“今天”，
   取接口返回的“最近一个已发布交易日”的数据。 */
H['/dragon'] = async (res, q) => {
  const type = q.get('type') || 'all';
  const url = `${EMD}/api/data/v1/get?reportName=RPT_DAILYBILLBOARD_DETAILSNEW&columns=ALL&pageNumber=1&pageSize=120&sortColumns=TRADE_DATE,BILLBOARD_NET_AMT&sortTypes=-1,-1&source=WEB&client=WEB`;
  const j = await getJSON(url);
  let arr = (j?.result?.data) || [];
  if (!arr.length) return ok(res, []);

  // 只保留最新交易日
  const latest = String(arr[0].TRADE_DATE || '').slice(0, 10);
  arr = arr.filter(x => String(x.TRADE_DATE || '').slice(0, 10) === latest);

  /* 机构 / 游资 过滤
     注意：是否机构参与写在 EXPLAIN 字段（如“3家机构买入”），
     EXPLANATION 只是上榜原因（如“日涨幅偏离值达到7%”）。 */
  if (type === 'inst') arr = arr.filter(x => /机构/.test(x.EXPLAIN || ''));
  if (type === 'hot') arr = arr.filter(x => !/机构/.test(x.EXPLAIN || ''));

  /* 龙虎榜只给出 MARKET("SH"/"SZ")，需映射成东财市场码 */
  const MKT = { SH: '1', SZ: '0', BJ: '0' };
  ok(res, arr.slice(0, 30).map(x => ({
    code: String(x.SECURITY_CODE || ''),
    secid: secidOf(MKT[x.MARKET], x.SECURITY_CODE),
    name: x.SECURITY_NAME_ABBR || '',
    price: round(x.CLOSE_PRICE),
    pct: round(x.CHANGE_RATE),
    net: round(num(x.BILLBOARD_NET_AMT) / 1e8, 2),
    buy: round(num(x.BILLBOARD_BUY_AMT) / 1e8, 2),
    sell: round(num(x.BILLBOARD_SELL_AMT) / 1e8, 2),
    reason: x.EXPLANATION || '',
    explain: x.EXPLAIN || ''
  })).filter(s => s.code));
};

/* ---------- 热榜（成交额榜 = 人气热度） ---------- */
H['/hot'] = async (res, q) => {
  const fs = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';
  const arr = await clistGet(fs, 'f6', 'f2,f3,f6,f8,f12,f13,f14', { pz: 24 });
  ok(res, arr.map((x, i) => ({
    code: String(x.f12 || ''),
    secid: secidOf(x.f13, x.f12),
    name: x.f14 || '',
    price: round(x.f2),
    pct: round(x.f3),
    /* 成交额（亿元）换算成人气值，越活跃越高 */
    heat: Math.round(num(x.f6) / 1e6),
    rank: i + 1,
    trend: round(x.f3) >= 0 ? 1 : -1
  })).filter(s => s.code).slice(0, 24));
};

/* ---------- 资讯：多渠道快讯聚合（东方财富 + 同花顺 + 新浪）----------
   东财 7×24 快讯 getlist_{id}（按地域/栏目划分）：
     101 证券要闻  102 宏观财经  103 个股公告  104 A股综合  105 综合
     106 宏观国际  107 外汇     108 债券      109 ETF/异动
     111 美国      114 日韩     118 国内政策  125 中国经济数据
     119 美联储/华尔街  126 美国经济数据
   注意：东财接口返回 `var ajaxResult={...}` 而非纯 JSON，必须先剥前缀再 parse。
   同花顺快讯 /tapp/news/push/stock/（data.list，ctime 为 unix 秒）、
   新浪财经滚动快讯 feed.mix.sina.com.cn/api/roll/get（result.data，ctime 为 unix 秒）。
   三源并行抓取后在服务端按「分类 tab + 关键词 + 来源 + 跨源去重」统一过滤。 */

Object.assign(H, { INDEX_SET });
module.exports = H;
