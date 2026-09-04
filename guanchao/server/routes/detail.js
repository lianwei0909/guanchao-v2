/* 由 server.js 机械拆分而来，行为未改动。 */
const { EM, EM2, EMH } = require('../config.js');
const { num, round } = require('../lib/format.js');
const { getJSON, getJSONFailover, getText } = require('../lib/http.js');
const { fail, ok } = require('../lib/respond.js');
const { emSecid, resolve, txSymOf } = require('../lib/secid.js');
const { createCache } = require('../lib/cache.js');
const H = {};

async function detailTX(r) {
  const txt = await getText(`https://qt.gtimg.cn/q=${txSymOf(r)}`);
  const m = txt.match(/="([\s\S]*?)"\s*;?\s*$/m);
  if (!m) throw new Error('腾讯快照解析失败');
  const a = m[1].split('~');
  if (!a[3]) throw new Error('腾讯快照无行情');
  const n = i => num(a[i]);
  return {
    code: a[2] || r.code, name: (a[1] || '').replace(/\s+/g, ''),
    secid: emSecid(r),
    price: num(a[3]), preClose: num(a[4]), open: num(a[5]),
    high: n(33), low: n(34), avg: n(51),
    change: n(31), pct: n(32), amplitude: n(43),
    volume: n(36), turnover: round(n(37) / 1e4, 2),   // 万元 → 亿元
    rate: n(38), volRatio: n(49),
    floatCap: n(44), mktcap: n(45), pb: n(46),
    limitUp: n(47), limitDown: n(48),
    pe: n(39), peStatic: n(53)
  };
}
async function detailEM(r) {
  const url = `${EM}/api/qt/stock/get?secid=${emSecid(r)}&fields=f43,f44,f45,f46,f47,f48,f50,f51,f52,f57,f58,f59,f60,f116,f117,f162,f167,f168,f169,f170,f171,f86`;
  const j = await getJSON(url);
  const d = j?.data;
  if (!d || !d.f58) throw new Error('东财未查询到该标的');
  const dec = Math.pow(10, num(d.f59));
  const p = v => (v === '-' || v === null || v === undefined) ? 0 : round(num(v) / dec, 2);
  const r100 = v => (v === '-' || v === null || v === undefined) ? 0 : round(num(v) / 100, 2);
  return {
    code: String(d.f57 || r.code), name: d.f58, secid: emSecid(r), price: p(d.f43),
    high: p(d.f44), low: p(d.f45), open: p(d.f46), preClose: p(d.f60),
    limitUp: p(d.f51), limitDown: p(d.f52),
    change: p(d.f169 === undefined ? (num(d.f43) - num(d.f60)) / 1 : d.f169),
    pct: r100(d.f170), amplitude: r100(d.f171),
    volume: num(d.f47), turnover: round(num(d.f48) / 1e8, 2),
    rate: r100(d.f168), volRatio: r100(d.f50),
    mktcap: round(num(d.f116) / 1e8, 2), floatCap: round(num(d.f117) / 1e8, 2),
    pe: r100(d.f162), pb: r100(d.f167), avg: 0, peStatic: 0
  };
}
H['/detail'] = async (res, q) => {
  const r = resolve(q);
  if (!r.code) return fail(res, '缺少 code 参数', 400);
  try {
    return ok(res, await detailTX(r));
  } catch (e1) {
    try { return ok(res, await detailEM(r)); }
    catch (e2) { return fail(res, '行情源不可用: ' + e2.message); }
  }
};

/* ---------- K 线 ----------
   period: day / week / month / 5 / 15 / 30 / 60（分钟）
   数据源（并行竞速，取首个非空；结果按 code|period|limit|fq 缓存 10 分钟）：
     · 港股：腾讯 hkfqkline（日/周/月全量可用）→ 东财兜底
     · A 股：腾讯 fqkline → 新浪 → 东财兜底
     · 美股：腾讯 usfqkline 实测仅 2 根、东财/Sina/Yahoo/Stooq 均无美股历史 K 线，
             故美股「日K/周K/月K」数据源暂不可用，仅分时（/minute）可用，直接提示。 */
const KLV_TTL = 10 * 60 * 1000;
const klvCache = createCache({ name: 'kline', ttl: KLV_TTL, max: 400 });
H['/kline'] = async (res, q) => {
  const r = resolve(q);
  if (!r.code) return fail(res, '缺少 code 参数', 400);
  const code = r.code;
  const period = q.get('period') || 'day';
  const limit = Math.min(parseInt(q.get('limit') || '120', 10) || 120, 500);
  /* D1：fq 透传 —— qfq(默认，看盘用) / hfq(回测与指标计算用) / '' */
  const fqRaw = (q.get('fq') || 'qfq').toLowerCase();
  const fq = fqRaw === 'hfq' ? 'hfq' : (fqRaw === 'none' || fqRaw === '0' ? '' : 'qfq');
  const FQT = { '': 0, qfq: 1, hfq: 2 }[fq];   // 东财兜底用的 fqt 映射

  const KLT = { day: 101, week: 102, month: 103, '5': 5, '15': 15, '30': 30, '60': 60 };
  const klt = KLT[period] || 101;
  const isMinute = [5, 15, 30, 60].indexOf(klt) > -1;
  const isUS = r.mkt === '105' || r.mkt === '106' || r.mkt === '107';
  const isHK = r.mkt === '116' || r.mkt === '128';

  /* 美股日K/周K/月K 数据源暂不可用（腾讯仅 2 根、东财/Sina/Yahoo/Stooq 均无美股历史K线），
     直接返回提示，避免空图让人误以为坏掉；美股分时由 /minute 提供。 */
  if (isUS && !isMinute) {
    return ok(res, { name: '', code, preClose: 0, klines: [], note: '美股日K/周K/月K 数据源暂不可用，仅支持分时' });
  }

  /* 命中缓存直接返回（切换周期 <100ms）；未命中时并发的同类请求合并为一次 */
  const ck = `KL|${r.mkt}|${r.sym}|${period}|${limit}|${fq}`;
  const { data } = await klvCache.wrap(ck, async () => {

  /* 统一结构：{ name, code, preClose, klines:[{t,o,c,h,l,v}] } */
  const shape = (name, list) => ({
    name: name || '', code,
    preClose: list.length > 1 ? num(list[list.length - 2].c) : 0,
    klines: list
  });

  /* 腾讯：按市场选专属端点（港股 hkfqkline / 美股 usfqkline / A股 fqkline） */
  async function tencent() {
    let sym, path;
    if (isHK) { sym = 'hk' + r.sym; path = 'hkfqkline'; }
    else if (isUS) { sym = 'us' + r.sym; path = 'usfqkline'; }
    else { sym = txSymOf(r); path = 'fqkline'; }
    const p = { day: 'day', week: 'week', month: 'month' }[period] || period;
    try {
      const j = await getJSON(`https://web.ifzq.gtimg.cn/appstock/app/${path}/get?param=${sym},${p},,${limit},${fq}`, { Referer: 'https://gu.qq.com/' });
      const node = j?.data?.[sym];
      if (!node) return null;
      const key = fq ? fq + p : p;            // qfqday / qfqweek / qfqmonth / day ...
      const arr = node[key] || node[p] || node.qfqday || node.day || null;
      if (!Array.isArray(arr) || !arr.length) return null;
      return arr.map(a => ({ t: String(a[0]), o: num(a[1]), c: num(a[2]), h: num(a[3]), l: num(a[4]), v: num(a[5]) }));
    } catch (e) { return null; }
  }

  /* 东财兜底：港股/美股日K 实测 dktotal=0 不可用，主要兜底 A 股；A股也走此路 */
  async function eastmoney() {
    try {
      const url = `${EMH}/api/qt/stock/kline/get?secid=${emSecid(r)}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=${klt}&fqt=${FQT}&end=20500101&lmt=${limit}`;
      const j = await getJSON(url);
      const d = j?.data;
      if (d && Array.isArray(d.klines) && d.klines.length) {
        return {
          name: d.name || '',
          list: d.klines.map(s => {
            const a = String(s).split(',');
            return { t: a[0], o: num(a[1]), c: num(a[2]), h: num(a[3]), l: num(a[4]), v: num(a[5]) };
          })
        };
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }

  /* 新浪：仅 A 股全周期 */
  async function sina() {
    try {
      const scale = { day: 240, week: 1200, month: 7200, '5': 5, '15': 15, '30': 30, '60': 60 }[period] || 240;
      const sym = txSymOf(r);
      const j = await getJSON(`https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sym}&scale=${scale}&ma=no&datalen=${limit}`,
        { Referer: 'https://finance.sina.com.cn/' });
      if (Array.isArray(j) && j.length) {
        return {
          name: '',
          list: j.map(x => ({ t: x.day, o: num(x.open), c: num(x.close), h: num(x.high), l: num(x.low), v: num(x.volume) }))
        };
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }

  /* 并行竞速：首个非空即采用（A股三源、港股两源、美股不会到这） */
  const tasks = [tencent(), eastmoney()];
  if (!isUS && !isHK) tasks.push(sina());
  const results = await Promise.allSettled(tasks);
  let chosen = null, name = '';
  for (const t of results) {
    if (t.status === 'fulfilled' && t.value && t.value.list && t.value.list.length) { chosen = t.value; break; }
  }
  if (!chosen) return shape('', []);
  if (chosen.name) name = chosen.name;
  return shape(name, chosen.list);
  });
  ok(res, data);
};

/* ---------- 分时 ---------- */
H['/minute'] = async (res, q) => {
  const r = resolve(q);
  if (!r.code) return fail(res, '缺少 code 参数', 400);
  /* push2his 主域偶发抖动/限流，依次回退到 push2 主域、push2delay 镜像，
     任一成功即返回；全部失败也降级为空数据（不再抛 502 让前端报错） */
  const mk = (host) => `${host}/api/qt/stock/trends2/get?secid=${emSecid(r)}&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f53,f56,f57,f58&iscr=0&ndays=1`;
  let j = null;
  try {
    j = await getJSONFailover([mk(EMH), mk(EM), mk(EM2)]);
  } catch (e) { j = null; }
  const d = j?.data;
  if (!d || !Array.isArray(d.trends)) return ok(res, { name: '', code: r.code, preClose: 0, points: [] });

  ok(res, {
    name: d.name || '',
    code: String(d.code || r.code),
    preClose: num(d.preClose) || 0,
    points: d.trends.map(s => {
      const a = String(s).split(',');
      return {
        t: (a[0] || '').slice(11, 16),   // HH:MM
        p: num(a[1]),                     // 价格
        v: num(a[2]),                     // 成交量（手）
        amt: num(a[3]) || 0,              // 成交额（元）
        avg: num(a[4])                    // 均价
      };
    })
  });
};

/* ---------- 全球指数（顶部滚动条） ---------- */
const GLOBAL_IDX = [
  ['1.000001', '上证指数'], ['0.399001', '深证成指'], ['0.399006', '创业板指'],
  ['1.000300', '沪深300'], ['1.000688', '科创50'], ['0.399005', '中小100'],
  ['100.HSI', '恒生指数'], ['100.TWII', '台湾加权'], ['100.N225', '日经225'],
  ['100.KS11', '韩国综合'], ['100.SENSEX', '印度SENSEX'], ['100.STI', '新加坡海峡'],
  ['100.DJIA', '道琼斯'], ['100.NDX', '纳斯达克100'], ['100.SPX', '标普500'],
  ['100.GDAXI', '德国DAX'], ['100.FTSE', '英国富时100']
];
H['/global'] = async (res, q) => {
  const secids = GLOBAL_IDX.map(x => x[0]).join(',');
  const j = await getJSON(`${EM}/api/qt/ulist.np/get?secids=${secids}&fields=f2,f3,f4,f12,f14&fltt=2&invt=2`);
  const src = j?.data?.diff ? (Array.isArray(j.data.diff) ? j.data.diff : Object.values(j.data.diff)) : [];
  const map = {};
  src.forEach(x => { map[String(x.f12)] = x; });
  ok(res, GLOBAL_IDX.map(([sid, name]) => {
    const code = sid.slice(sid.indexOf('.') + 1);
    const x = map[code] || {};
    return { secid: sid, code, name: x.f14 || name, price: round(x.f2), pct: round(x.f3), change: round(x.f4) };
  }));
};

/* ---------- 高抛低吸信号 ----------
   口径：分时价格相对均价线的偏离率 dev=(价-均价)/均价
   阈值按个股日内波动自适应：th = max(0.4%, 1.2σ)
   偏离上穿 th 后回落至 th/2 → 高抛；下穿 -th 后回升至 -th/2 → 低吸
   记录触发时刻（极值点），并附该时刻的价格与偏离幅度
------------------------------------------------------------------- */

Object.assign(H, { GLOBAL_IDX, KLV_TTL, detailEM, detailTX, klvCache });
module.exports = H;
