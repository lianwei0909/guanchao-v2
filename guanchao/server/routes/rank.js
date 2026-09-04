/* 由 server.js 机械拆分而来，行为未改动。 */
const { clistGet } = require('../datasource/em.js');
const { num, round } = require('../lib/format.js');
const { ok } = require('../lib/respond.js');
const { secidOf } = require('../lib/secid.js');
const H = {};

const RANK_MKT = {
  all: 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23',
  sh:  'm:1+t:2,m:1+t:23',
  sz:  'm:0+t:6,m:0+t:80',
  cyb: 'm:0+t:80',
  kcb: 'm:1+t:23',
  bj:  'm:0+t:81+s:2048'
};
const RANK_DIM = {
  changePct:     { fid: 'f3',  po: 1 },
  changePctD:    { fid: 'f3',  po: 0 },
  amount:        { fid: 'f6',  po: 1 },
  turnover:      { fid: 'f8',  po: 1 },
  volumeRatio:   { fid: 'f10', po: 1 },
  amplitude:     { fid: 'f7',  po: 1 },
  mainNetInflow: { fid: 'f62', po: 1 },
  pe:            { fid: 'f9',  po: 0 }
};
H['/rank'] = async (res, q) => {
  const mkt = RANK_MKT[q.get('mkt')] ? q.get('mkt') : 'all';
  const dim = RANK_DIM[q.get('dim')] ? q.get('dim') : 'changePct';
  const { fid, po } = RANK_DIM[dim];
  const pz = Math.min(100, Math.max(10, parseInt(q.get('limit')) || 50));
  const arr = await clistGet(RANK_MKT[mkt], fid,
    'f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f20,f23,f62', { po, pz });
  ok(res, arr.map(x => ({
    code: String(x.f12 || ''),
    secid: secidOf(x.f13, x.f12),
    name: x.f14 || '',
    price: round(x.f2),
    pct: round(x.f3),
    change: round(x.f4),
    amount: round(num(x.f6) / 1e8, 4),        // 成交额（亿元）
    amplitude: round(x.f7),
    turnover: round(x.f8),                    // 换手率 %
    pe: round(x.f9),
    volumeRatio: round(x.f10),                // 量比
    pb: round(x.f23),
    mktcap: round(num(x.f20) / 1e8, 2),       // 总市值（亿元）
    mainNetInflow: round(num(x.f62) / 1e8, 4) // 主力净流入（亿元）
  })).filter(s => s.code));
};

/* ---------- 全市场统计：涨跌家数 / 成交额 / 主力净流入 / 涨幅 TOP10 ----------
   东财 clist 的 pz 硬上限是 100（传 6000 也只回 100 条），要覆盖全市场 5500+ 只
   必须翻 56 页。串行要 8.6 秒，这里用并发 6 + 60 秒缓存，首次约 1.5 秒。 */

Object.assign(H, { RANK_DIM, RANK_MKT });
module.exports = H;
