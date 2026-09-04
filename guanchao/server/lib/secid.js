/* 由 server.js 机械拆分而来，行为未改动。 */

function resolve(q) {
  const code = (q.get('code') || '').trim();
  const sid = (q.get('secid') || '').trim();
  if (sid) {
    const i = sid.indexOf('.');
    if (i > 0) return { code: code || sid.slice(i + 1), mkt: sid.slice(0, i), sym: sid.slice(i + 1) };
  }
  if (/^[A-Za-z]{1,8}$/.test(code)) return { code, mkt: '105', sym: code };   // 美股
  if (/^\d{5}$/.test(code)) return { code, mkt: '116', sym: code };           // 港股
  const mkt = /^(6|9|5|11)/.test(code) ? '1' : '0';
  return { code, mkt, sym: code };
}
/* 东财 secid */
function emSecid(r) { return r.mkt + '.' + r.sym; }
/* 由「市场码 f13 + 代码 f12」拼 secid；市场码缺失时按代码前缀兜底 */
function secidOf(mkt, code) {
  const c = String(code || '');
  if (!c) return '';
  const m = (mkt === undefined || mkt === null || mkt === '') ? (/^(6|9|5|11)/.test(c) ? 1 : 0) : Number(mkt);
  return m + '.' + c;
}
/* 腾讯 symbol：sh/sz/hk/us 前缀 */
function txSymOf(r) {
  const m = { '1': 'sh', '0': 'sz', '105': 'us', '106': 'us', '107': 'us', '116': 'hk', '128': 'hk' };
  /* 港股指数（100.HSI）与外盘指数（100.DJIA）在腾讯侧的符号不同：
     HSI 走 hk，而 DJIA/SPX 等没有对应，统一回落到 us 试一次 */
  if (r.mkt === '100') return /^[A-Z]/.test(r.sym) ? 'us' + r.sym : 'hk' + r.sym;
  return (m[r.mkt] || 'sh') + r.sym;
}
/* 美股 K 线需带交易所后缀：.OQ(纳斯达克) / .N(纽交所) / .A(美交所)
   实测 .OQ 对绝大多数代码通用，逐个试直到拿到足够行数 */

module.exports = { emSecid, resolve, secidOf, txSymOf };
