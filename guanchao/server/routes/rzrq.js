/* 融资融券（两融）：学习 go-stock 的 GetRzrqRank / GetRzrqTrend，
   数据源为同花顺 rzrqEnhance 接口（与 go-stock 一致，已 curl 实测可用）。
   不新增任何依赖：复用 lib/http.js 的 getJSON（含并发闸门 + 域名降级 + 指数退避）。
   字段口径（已实测）：
     - 走势 newIndexData：date[] / 融资余额(rzye,单位亿) / 融资净买入(rzjlr,亿)
       / 上证收盘(spj) / 上证涨幅(spzf,%)
     - 排名 getRankData：lrye 两融余额 / rzye 融资余额 / rqye 融券余额 / jmr 净买入额
       （单位均为千元，÷1e5 转亿元）；维度 type=ggList(个股)/hyList(行业)/gnList(概念) */
const { getJSON } = require('../lib/http.js');
const { ok } = require('../lib/respond.js');
const { round } = require('../lib/format.js');
const { createCache } = require('../lib/cache.js');

const H = {};
const BASE = 'https://eq.10jqka.com.cn/rzrqEnhance/index.php';
/* 覆盖 lib/http.js 默认的东财 Referer，否则同花顺会拒 */
const HEAD = { Referer: 'https://eq.10jqka.com.cn/' };

/* 10 分钟缓存：两融数据日内变化不大，前端轮询不会频繁打上游 */
const cache = createCache({ name: 'rzrq', ttl: 600000, max: 8 });

/* 全市场融资融券走势：融资余额 + 融资净买入 + 上证收盘/涨幅（取最近 30 个交易日） */
async function trend() {
  const j = await getJSON(`${BASE}?op=newIndexData`, HEAD, 2);
  const c = j && j.data && j.data.chart;
  if (!c || !c.date || !c.date.length) throw new Error('两融走势数据为空');
  const n = c.date.length;
  const start = Math.max(0, n - 30);
  const sliceNum = (a) => (Array.isArray(a) ? a.slice(start).map((x) => Number(x)) : []);
  return {
    updateTime: (j.data && j.data.updateTime) || '',
    unit: { rzye: c.rzyeUnit, rzjlr: c.rzjlrUnit, spj: c.spjUnit, spzf: c.spzfUnit },
    date: c.date.slice(start),
    rzye: sliceNum(c.rzye), // 融资余额（亿）
    rzjlr: sliceNum(c.rzjlr), // 融资净买入（亿）
    spj: sliceNum(c.spj), // 上证收盘
    spzf: sliceNum(c.spzf) // 上证涨幅（%）
  };
}

/* 融资融券余额排名：个股(ggList) / 行业(hyList) / 概念(gnList) */
async function rank(type, sortKey, len) {
  const t = ['ggList', 'hyList', 'gnList'].includes(type) ? type : 'ggList';
  const sk = sortKey || 'jmr';
  const L = Math.min(50, Math.max(1, Number(len) || 10));
  const url = `${BASE}?op=getRankData&type=${t}&sortKey=${sk}&sortType=desc&length=${L}`;
  const j = await getJSON(url, HEAD, 2);
  if (!j || j.errorCode !== 0) throw new Error('两融排名获取失败');
  const list = (j.data || []).map((x) => ({
    code: String(x.stockCode || x.code || ''),
    name: x.stockName || x.name || '',
    date: x.date ? new Date(Number(x.date) * 1000).toISOString().slice(0, 10) : '',
    lrye: round(Number(x.lrye) / 1e5, 2), // 两融余额（亿）
    lryeRate: round(x.lryeRate, 2),
    rzye: round(Number(x.rzye) / 1e5, 2), // 融资余额（亿）
    rzyeRate: round(x.rzyeRate, 2),
    rqye: round(Number(x.rqye) / 1e5, 2), // 融券余额（亿）
    rqyeRate: round(x.rqyeRate, 2),
    jmr: round(Number(x.jmr) / 1e5, 2), // 净买入额（亿）
    jmrRate: round(x.jmrRate, 2),
    close: round(x.close_price, 2),
    pct: round(x.close_profit, 2)
  }));
  return { type: t, list };
}

H['/rzrq'] = async (res, q) => {
  const op = q.get('op') || 'trend';
  if (op === 'rank') {
    const key = 'rank:' + (q.get('type') || 'ggList') + ':' + (q.get('sort') || 'jmr') + ':' + (q.get('len') || 10);
    const { data } = await cache.wrap(key, () => rank(q.get('type'), q.get('sort'), q.get('len')));
    return ok(res, data);
  }
  const { data } = await cache.wrap('trend', trend);
  ok(res, data);
};

module.exports = H;
