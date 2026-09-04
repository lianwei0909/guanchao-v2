/* 由 server.js 机械拆分而来，行为未改动。 */
const { EM } = require('../config.js');
const { closeSeries, txKline } = require('../datasource/tx.js');
const { num, round } = require('../lib/format.js');
const { getJSON } = require('../lib/http.js');
const { ok } = require('../lib/respond.js');
const { secidOf, txSymOf } = require('../lib/secid.js');
const { mapLimit } = require('../lib/util.js');
const H = {};

H['/compare'] = async (res, q) => {
  const raw = (q.get('codes') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 6);
  if (!raw.length) return ok(res, []);
  /* 支持 code 或 secid 两种传法 */
  const secids = raw.map(c => (c.indexOf('.') > 0 ? c : secidOf(undefined, c)));
  const url = `${EM}/api/qt/ulist.np/get?secids=${secids.join(',')}` +
    `&fields=f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f20,f23,f62&fltt=2&invt=2`;
  const j = await getJSON(url);
  const arr = j?.data?.diff ? (Array.isArray(j.data.diff) ? j.data.diff : Object.values(j.data.diff)) : [];
  const map = {};
  arr.forEach(x => { map[String(x.f12)] = x; });

  /* 并发取 K 线，算近 5 日 / 20 日涨幅 + 均线 */
  const out = await mapLimit(secids, 4, async (sid) => {
    const code = sid.slice(sid.indexOf('.') + 1);
    const x = map[code] || {};
    let k5 = null, k20 = null, ma5 = null, ma20 = null;
    try {
      const r = { mkt: sid.slice(0, sid.indexOf('.')), sym: code, code };
      const ks = await txKline(txSymOf(r), 'day', 120);
      if (ks && ks.length >= 21) {
        const cl = closeSeries(ks);
        const last = cl[cl.length - 1];
        k5 = round((last / cl[cl.length - 6] - 1) * 100, 2);
        k20 = round((last / cl[cl.length - 21] - 1) * 100, 2);
        ma5 = round(cl.slice(-5).reduce((a, b) => a + b, 0) / 5, 2);
        ma20 = round(cl.slice(-20).reduce((a, b) => a + b, 0) / 20, 2);
      }
    } catch (e) { /* K线失败不影响主指标 */ }

    return {
      code, secid: sid, name: x.f14 || code,
      price: round(x.f2), pct: round(x.f3), change: round(x.f4),
      amount: round(num(x.f6) / 1e8, 4),
      amplitude: round(x.f7), turnover: round(x.f8),
      pe: round(x.f9), volumeRatio: round(x.f10),
      pb: round(x.f23),
      mktcap: round(num(x.f20) / 1e8, 2),
      mainNetInflow: round(num(x.f62) / 1e8, 4),
      chg5: k5, chg20: k20, ma5, ma20
    };
  });
  ok(res, out.filter(Boolean));
};

/* ---------- 预测 PP：量化选股（均线多头 + 资金流入 + 量能） ----------
   打分逻辑原样抽成 forecastList()，供 /api/forecast 与 /api/backtest（默认股票池）复用；
   内部逻辑与上游字段口径未做任何改动。 */
/* 预测 PP 三种周期配置：K 线周期 / 回看根数 / 均线窗口 / 近 N 高低点 / 不追高阈值
   + 打分权重 w(多头/资金/量能/位置) + 入选门槛 threshold + 观点分级 view。
   短线看日 K（数日趋势）、中线看周 K（数周~数月趋势）、长线看月 K（跨年趋势）。
   权重设计：短线重资金+量能（抓即时动量），长线重趋势多头+位置安全（看大趋势）。 */

module.exports = H;
