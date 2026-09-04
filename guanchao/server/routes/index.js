/* 路由装配：各业务模块导出 H 对象，键为 '/xxx' 的即接口处理器，
   其余键是模块内部共享的 helper（被其它模块 import），这里跳过。 */
const MODULES = [
  './quote.js',
  './news.js',
  './detail.js',
  './signal.js',
  './sync.js',
  './rank.js',
  './market.js',
  './fuyao.js',
  './sector.js',
  './youzi.js',
  './dark.js',
  './financials.js',
  './compare.js',
  './forecast.js',
  './backtest.js',
  './mail.js',
  './rzrq.js',
  './calendar.js',
  './concept.js',
  './ai.js',
  './ml.js'
];

const API = {};
for (const m of MODULES) {
  const mod = require(m);
  for (const [k, v] of Object.entries(mod)) {
    if (k.startsWith('/')) API[k] = v;
  }
}

module.exports = { API, routes: Object.keys(API).sort() };
