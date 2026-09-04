/* 由 server.js 机械拆分而来，行为未改动。 */
const { EMD } = require('../config.js');
const { num, round } = require('../lib/format.js');
const { getJSONFailover } = require('../lib/http.js');
const { ok } = require('../lib/respond.js');
const { createCache } = require('../lib/cache.js');
const { secidOf } = require('../lib/secid.js');
const H = {};

/* 龙虎榜收盘后（约 18:00）才更新，缓存 5 分钟足够。
   首次需实时爬东财 datacenter 两个接口（个股汇总 + 1500 条营业部明细），
   无缓存时耗时数秒——此前该路由是全站唯一没缓存的行情页数据源，
   前端切换路由重挂载就重新爬一遍，表现为「一直加载中、切换后无数据」。
   wrap 自带 in-flight 合并（并发/快速切换只爬一次）+ stale 兜底（上游
   失败时返回旧值而非报错空白）。 */
const youziCache = createCache({ name: 'youzi', ttl: 5 * 60 * 1000, max: 4, staleTtl: 60 * 60 * 1000 });

const LHB_DETAIL = `${EMD}/api/data/v1/get?reportName=RPT_OPERATEDEPT_TRADE_DETAILS&columns=ALL`;
const LHB_STOCK  = `${EMD}/api/data/v1/get?reportName=RPT_DAILYBILLBOARD_DETAILSNEW&columns=ALL`;

/* 知名游资名号归类规则：命中即归入该游资（按优先级从上到下匹配，命中第一条即止）。
   规则口径参考市场公认的游资席位别称，尽量覆盖目标站出现的名号。 */
function youziNameOf(dept) {
  const d = String(dept || '');
  const R = [
    [/机构专用/, '机构专用'],
    [/沪股通专用/, '沪股通专用'],
    [/深股通专用/, '深股通专用'],
    [/东北证券佛山分公司/, '佛山系'],
    [/桑田路/, '宁波桑田路'],
    [/华鑫证券.*(?:上海|深圳|北京|成都|南京|武汉|西安|合肥|广州|天津)/, '量化打板'],
    [/华鑫证券/, '量化打板'],
    [/开源证券.*西安/, '量化基金'],
    [/拉萨团结路|拉萨东环路|东财.*拉萨|东方财富.*拉萨/, '拉萨天团'],
    [/国泰海通.*上海江苏路|国泰君安.*上海江苏路|上海江苏路/, '章盟主'],
    [/国泰海通.*上海新闸路|上海新闸路/, '欢乐海岸'],
    [/中信证券.*上海溧阳路|上海溧阳路/, '炒股养家'],
    [/中国银河.*绍兴|银河.*绍兴/, '赵老哥'],
    [/国泰海通.*上海延安路|上海延安路/, '方新侠'],
    [/国泰海通.*重庆观音桥|重庆观音桥/, '作手新一'],
    [/国泰海通.*上海分公司|国泰君安.*上海分公司/, '上海超短帮'],
    [/国泰海通.*北京知春路|北京知春路/, '苏南帮'],
    [/华泰证券.*深圳益田路|深圳益田路/, '欢乐海岸'],
    [/招商证券.*深圳深南东路|深南东路/, '招商深南东'],
    [/中信证券.*北京中关村|北京中关村/, '北京中关村'],
    [/国泰海通.*温州|温州/, '温州帮'],
    [/国盛证券.*宁波桑田路/, '宁波桑田路'],
    [/东亚前海.*上海|思明南路/, '思明南路'],
    [/上塘路/, '上塘路'],
    [/成都系|国泰海通.*成都北一环路/, '成都系']
  ];
  for (const [re, name] of R) if (re.test(d)) return name;
  return null; // 未命中知名名号 → 用营业部简称兜底
}

/* 从营业部全称里提取简称（去地域+去"证券/营业部"等后缀），作为未归类席位的游资名 */
function deptShort(dept) {
  let s = String(dept || '')
    .replace(/(股份有限公司|有限责任公司|有限公司|分公司|证券营业部|营业部|证券)/g, '')
    .replace(/(中国|股份|有限|责任)/g, '');
  // 取地域关键词（省/市/区前的核心名）
  const m = s.match(/([^省市区县]{1,6}(?:路|街|大道|广场|中心)?)/);
  s = m ? m[1] : s;
  return s.trim().slice(0, 8) || String(dept).slice(0, 8);
}

H['/youzi'] = async (res, q) => {
  const date = (q.get('date') || '').trim(); // 可选指定交易日，缺省取最新
  try {
    const { data } = await youziCache.wrap(date || 'latest', async () => {
    /* 1) 先取个股汇总，确定最新交易日（龙虎榜收盘后约 18:00 发布） */
  let jStock = null;
  try {
    jStock = await getJSONFailover([
      `${LHB_STOCK}&pageNumber=1&pageSize=300&sortColumns=TRADE_DATE,BILLBOARD_NET_AMT&sortTypes=-1,-1&source=WEB&client=WEB`,
      `${LHB_STOCK.replace('datacenter-web.eastmoney.com', 'datacenter.eastmoney.com')}&pageNumber=1&pageSize=300&sortColumns=TRADE_DATE,BILLBOARD_NET_AMT&sortTypes=-1,-1&source=WEB&client=WEB`
    ]);
  } catch (e) { jStock = null; }
  let stocks = (jStock?.result?.data) || [];
  const latest = String((stocks[0] || {}).TRADE_DATE || '').slice(0, 10);
  const day = date || latest;
  stocks = stocks.filter(x => String(x.TRADE_DATE || '').slice(0, 10) === day);

  /* 2) 营业部级明细必须按 TRADE_DATE 过滤（否则接口按全历史排序，拿不到当天数据） */
  let jDept = null;
  try {
    jDept = await getJSONFailover([
      `${LHB_DETAIL}&filter=(TRADE_DATE='${day}')&pageNumber=1&pageSize=1500&sortColumns=NET_AMT&sortTypes=-1&source=WEB&client=WEB`,
      `${LHB_DETAIL.replace('datacenter-web.eastmoney.com', 'datacenter.eastmoney.com')}&filter=(TRADE_DATE='${day}')&pageNumber=1&pageSize=1500&sortColumns=NET_AMT&sortTypes=-1&source=WEB&client=WEB`
    ]);
  } catch (e) { jDept = null; }
  let depts  = (jDept?.result?.data) || [];
  if (!stocks.length && !depts.length) return { date: day, kpi: {}, seatsRank: [], stocksRank: { buyTop: [], sellTop: [] }, hotSeats: [], detail: [] };

  const isInst = s => /机构专用/.test(s || '');

  /* ---- 个股维度 ---- */
  const MKT = { SH: '1', SZ: '0', BJ: '0' };
  const stockList = stocks.map(x => ({
    code: String(x.SECURITY_CODE || ''),
    secid: secidOf(MKT[x.MARKET], x.SECURITY_CODE),
    name: x.SECURITY_NAME_ABBR || '',
    price: round(x.CLOSE_PRICE),
    pct: round(x.CHANGE_RATE),
    net: round(num(x.BILLBOARD_NET_AMT) / 1e8, 4),
    buy: round(num(x.BILLBOARD_BUY_AMT) / 1e8, 4),
    sell: round(num(x.BILLBOARD_SELL_AMT) / 1e8, 4),
    turnover: round(num(x.TURNOVERRATE)),
    dealAmt: round(num(x.BILLBOARD_DEAL_AMT) / 1e8, 2),
    reason: x.EXPLANATION || '',
    inst: isInst(x.EXPLAIN)
  })).filter(s => s.code);

  /* ---- 营业部级明细 → 归入游资名号 ---- */
  const agg = {};
  const ensure = name => { if (!agg[name]) agg[name] = { name, depts: new Set(), rows: [], net: 0, stocks: new Set() }; return agg[name]; };
  depts.forEach(x => {
    const dept = x.OPERATEDEPT_NAME || '';
    const known = youziNameOf(dept);
    const name = known || ('@' + deptShort(dept));
    const g = ensure(name);
    g.depts.add(dept);
    const net = num(x.NET_AMT);
    g.net += net;
    if (num(x.ACT_BUY) > 0 || num(x.ACT_SELL) > 0) g.stocks.add(String(x.SECURITY_CODE || ''));
    g.rows.push({
      date: String(x.TRADE_DATE || '').slice(0, 10),
      code: String(x.SECURITY_CODE || ''),
      name: x.SECURITY_NAME_ABBR || '',
      dept,
      buy: round(num(x.ACT_BUY) / 1e8, 4),
      sell: round(num(x.ACT_SELL) / 1e8, 4),
      net: round(net / 1e8, 4)
    });
  });

  /* 游资榜单（排除纯机构专用，但保留"机构专用"作为对照项展示在净卖出榜） */
  const allSeats = Object.values(agg)
    .map(g => ({
      name: g.name.replace(/^@/, ''),
      rawName: g.name,
      isKnown: !g.name.startsWith('@'),
      net: round(g.net / 1e8, 4),
      stocks: g.stocks.size,
      depts: g.depts.size,
      initial: (g.name.startsWith('@') ? (g.name.slice(1) || '?') : g.name).slice(0, 1)
    }))
    .sort((a, b) => b.net - a.net);

  const seatsRank = allSeats.slice(0, 10);                 // 净买入 TOP10
  const seatsSellRank = allSeats.slice().reverse().slice(0, 10); // 净卖出 TOP10（负值在前）

  /* 明细区·按游资卡片（全部，含机构/股通，供搜索与画像） */
  const hotSeats = allSeats.map((s, i) => ({ ...s, rank: i + 1 }));

  /* KPI（口径贴近指标站“游资作战室”）
     机构专用 / 沪股通专用 / 深股通专用 属被动席位，不计入“游资净买”与“上榜游资” */
  const PASSIVE = /机构专用|股通专用/;
  const activeSeats = allSeats.filter(s => !(PASSIVE.test(s.name)));
  const netSum = activeSeats.reduce((a, s) => a + s.net, 0);          // 游资净买入合计（亿）
  const seatCount = allSeats.filter(s => s.isKnown && !PASSIVE.test(s.name)).length; // 上榜游资（知名）
  const dealAmt = stockList.reduce((a, s) => a + (s.dealAmt || 0), 0); // 龙虎榜成交（亿）
  const kpi = {
    netSum: round(netSum, 2),
    seatCount,
    stockCount: new Set(stockList.map(x => x.code)).size,
    dealAmt: round(dealAmt, 2),
    deptCount: new Set(depts.map(x => x.OPERATEDEPT_NAME)).size
  };

  /* 个股 TOP10 */
  const stocksRank = {
    buyTop: stockList.slice().sort((a, b) => b.net - a.net).slice(0, 10),
    sellTop: stockList.slice().sort((a, b) => a.net - b.net).slice(0, 10)
  };

  /* 全部明细（营业部级，按净额降序，供表格） */
  const detail = depts
    .map(x => ({
      date: String(x.TRADE_DATE || '').slice(0, 10),
      code: String(x.SECURITY_CODE || ''),
      name: x.SECURITY_NAME_ABBR || '',
      dept: x.OPERATEDEPT_NAME || '',
      youzi: youziNameOf(x.OPERATEDEPT_NAME) || deptShort(x.OPERATEDEPT_NAME),
      buy: round(num(x.ACT_BUY) / 1e8, 4),
      sell: round(num(x.ACT_SELL) / 1e8, 4),
      net: round(num(x.NET_AMT) / 1e8, 4)
    }))
    .sort((a, b) => b.net - a.net);

    return {
      date: day,
      latest,
      kpi,
      seatsRank,        // 游资净买入 TOP10
      seatsSellRank,    // 游资净卖出 TOP10
      stocksRank,       // 个股净买入/卖出 TOP10
      hotSeats,         // 按游资卡片列表
      detail            // 全部明细
    };
    }, { stale: true });
    ok(res, data);
  } catch (e) {
    /* 上游失败且无缓存/stale 可用：返回空结构而非报错，
       前端展示空态与说明，不再出现一直转圈的加载中 */
    ok(res, {
      date: '', kpi: {}, seatsRank: [], stocksRank: { buyTop: [], sellTop: [] },
      hotSeats: [], detail: [], note: '龙虎榜数据暂不可用，请稍后重试'
    });
  }
};

/* 游资画像：某游资名号下的关联营业部 + 近期交易明细 */
H['/youzi-portrait'] = async (res, q) => {
  const name = (q.get('name') || '').trim();
  if (!name) return ok(res, { depts: [], trades: [] });
  const day = (q.get('date') || '').trim();
  /* 有日期则精确过滤；无日期则拉最新一页再取最近交易日 */
  var url;
  if (day) {
    url = `${LHB_DETAIL}&filter=(TRADE_DATE='${day}')&pageNumber=1&pageSize=1500&sortColumns=NET_AMT&sortTypes=-1&source=WEB&client=WEB`;
  } else {
    url = `${LHB_DETAIL}&pageNumber=1&pageSize=1500&sortColumns=TRADE_DATE,NET_AMT&sortTypes=-1,-1&source=WEB&client=WEB`;
  }
  let j = null;
  try {
    j = await getJSONFailover([
      url,
      url.replace('datacenter-web.eastmoney.com', 'datacenter.eastmoney.com')
    ]);
  } catch (e) { j = null; }
  let depts = (j?.result?.data) || [];
  if (!depts.length) return ok(res, { name, depts: [], trades: [], note: j ? '' : '上游数据暂不可用，请稍后重试' });
  /* 无指定日期时，取接口返回的最新交易日 */
  const latest = String((depts[0] || {}).TRADE_DATE || '').slice(0, 10);
  const target = day || latest;
  depts = depts.filter(x => String(x.TRADE_DATE || '').slice(0, 10) === target);

  /* 匹配逻辑：先尝试知名游资精确匹配；未命中时回退到 deptShort 模糊匹配
     （覆盖主接口中 @未归类 游资，其名字由 deptShort 生成） */
  const matched = depts.filter(x => {
    const yn = youziNameOf(x.OPERATEDEPT_NAME);
    if (yn === name) return true;
    /* 未归类游资：name 是 deptShort 的结果（去掉了 @ 前缀），用 deptShort 再算一次比对 */
    if (!yn && deptShort(x.OPERATEDEPT_NAME) === name) return true;
    return false;
  });
  const deptSet = new Set(matched.map(x => x.OPERATEDEPT_NAME));
  const trades = matched
    .map(x => ({
      date: String(x.TRADE_DATE || '').slice(0, 10),
      code: String(x.SECURITY_CODE || ''),
      name: x.SECURITY_NAME_ABBR || '',
      dept: x.OPERATEDEPT_NAME || '',
      buy: round(num(x.ACT_BUY) / 1e8, 4),
      sell: round(num(x.ACT_SELL) / 1e8, 4),
      net: round(num(x.NET_AMT) / 1e8, 4)
    }))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

  ok(res, {
    name,
    depts: Array.from(deptSet),
    trades: trades.slice(0, 200)
  });
};

/* ---------- 暗盘监控：大宗交易（盘后大额协议转让） ---------- */
/* 大宗交易 / 暗盘监控。
   支持按交易日查询：date=YYYY-MM-DD（不传则取最近一个交易日）。
   实测东财支持 filter=(TRADE_DATE='YYYY-MM-DD') 精确过滤，据此实现历史日期回看。
   dates 返回近期可选交易日，供前端做日期选择。 */

Object.assign(H, { LHB_DETAIL, LHB_STOCK, deptShort, youziNameOf });
module.exports = H;
