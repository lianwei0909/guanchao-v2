/* ML 预测服务代理层（Node → Python ML 服务）。
   后端 Python 服务（ml_service/service.py，默认 http://127.0.0.1:8800）实现了
   随机森林 / SVM / XGBoost / LSTM / Transformer / 集成 + 回测。
   本模块只负责把 /api/ml/* 的请求转发到 Python，并把结果透传给前端，
   不引入任何 ML 计算，保持 Node 端「零新增依赖」。

   接口：
     GET  /api/ml/status      -> Python /health
     POST /api/ml/predict     -> Python /predict  {codes?, period, horizon, limit}
     POST /api/ml/backtest    -> Python /backtest {codes?, period, horizon, limit}
*/
const { ok, fail, readBody } = require('../lib/respond.js');
const { ML_SERVICE_URL } = require('../config.js');

const H = {};

/* 统一转发：把请求体 POST 到 Python 对应端点，再透传 JSON。
   训练型接口（predict/backtest）耗时较长，首训多模型可能达数分钟，给 1200s 超时。 */
async function proxy(res, pyPath, body, timeoutMs = 1200000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const upstream = await fetch(ML_SERVICE_URL.replace(/\/$/, '') + pyPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ac.signal
    });
    const txt = await upstream.text();
    clearTimeout(timer);
    if (!upstream.ok) {
      return fail(res, 'ML 服务返回错误(' + upstream.status + '): ' + txt.slice(0, 200), 502);
    }
    let obj;
    try { obj = JSON.parse(txt); }
    catch (e) { return fail(res, 'ML 服务响应非 JSON: ' + txt.slice(0, 200), 502); }
    return ok(res, obj);
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      return fail(res, 'ML 服务请求超时（训练耗时超过 ' + (timeoutMs / 1000) + 's），请减少股票数量或稍后重试', 504);
    }
    // 连不上 Python 服务：通常是服务未启动
    return fail(res, '无法连接 ML 服务（' + ML_SERVICE_URL + '）：' + e.message +
      '。请先启动 Python 服务：python ml_service/service.py', 503);
  }
}

H['/ml/status'] = async (res) => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const r = await fetch(ML_SERVICE_URL.replace(/\/$/, '') + '/health', { signal: ac.signal });
    const obj = await r.json();
    clearTimeout(timer);
    return ok(res, { mlService: ML_SERVICE_URL, online: true, engines: obj });
  } catch (e) {
    clearTimeout(timer);
    return ok(res, { mlService: ML_SERVICE_URL, online: false, error: e.message });
  }
};

H['/ml/predict'] = async (res, q, req) => {
  let body = {};
  try { body = await readBody(req, res); }
  catch (e) { return fail(res, e.message, 400); }
  return proxy(res, '/predict', body, 1200000);
};

H['/ml/backtest'] = async (res, q, req) => {
  let body = {};
  try { body = await readBody(req, res); }
  catch (e) { return fail(res, e.message, 400); }
  return proxy(res, '/backtest', body, 1200000);
};

module.exports = H;
