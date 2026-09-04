/* 由 server.js 机械拆分而来，行为未改动。 */
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 9000;
/* 项目根目录：config.js 位于 server/ 下，需向上一级 */
const ROOT = path.resolve(__dirname, '..');
const SYNC_DIR = path.join(ROOT, 'data', 'sync');   // 云端自选存储目录
const DIST_DIR = path.join(ROOT, 'dist-build');           // Vue 构建产物
const DATA_DIR = path.join(ROOT, 'data');           // 运行期数据（同步/密钥/邮件配置）
/* 允许跨域的来源，逗号分隔；为空则回退到 '*'（本地开发便利） */
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

/* Python ML 预测服务地址（ml_service/service.py）。
   默认本机 8800；可经环境变量 ML_SERVICE_URL 覆盖（如部署到独立机器）。 */
const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://127.0.0.1:8800';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const EM = 'https://push2.eastmoney.com';       // 行情快照 / 列表
const EMH = 'https://push2his.eastmoney.com';   // K 线 / 分时
const EMX = 'https://push2ex.eastmoney.com';    // 涨跌停池
const EMD = 'https://datacenter-web.eastmoney.com'; // 龙虎榜
const EM2 = 'https://push2delay.eastmoney.com'; // push2 延时源（同一份行情，部分网络环境下 push2 主域偶发连接重置，用其兜底）

const FY = 'https://fuyao.aicubes.cn';
/* 密钥优先级：环境变量 FY_API_KEY > data/fuyao.json。
   绝不硬编码进代码，避免打包分发 / 提交仓库时泄露。 */
function loadFYKey() {
  if (process.env.FY_API_KEY) return process.env.FY_API_KEY;
  try {
    const p = path.join(ROOT, 'data', 'fuyao.json');
    if (fs.existsSync(p)) return (JSON.parse(fs.readFileSync(p, 'utf8')) || {}).apiKey || '';
  } catch (e) { /* 配置缺失或损坏：忽略，自动降级到东财源 */ }
  return '';
}
const FY_KEY = loadFYKey();

/* LLM 配置（AI 解读层用，学习 go-stock 的多模型接入思路，但零新增依赖）：
   优先级：环境变量 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL > data/llm.json。
   兼容 OpenAI Chat Completions 协议（DeepSeek / 通义 / 混元 / 硅基流动 等均可）。
   绝不硬编码密钥进代码。 */
function loadLLM() {
  if (process.env.LLM_API_KEY) {
    return {
      baseURL: process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1',
      apiKey: process.env.LLM_API_KEY,
      model: process.env.LLM_MODEL || 'deepseek-chat'
    };
  }
  try {
    const p = path.join(ROOT, 'data', 'llm.json');
    if (fs.existsSync(p)) {
      const c = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
      if (c.apiKey) {
        return {
          baseURL: c.baseURL || 'https://api.deepseek.com/v1',
          apiKey: c.apiKey,
          model: c.model || 'deepseek-chat'
        };
      }
    }
  } catch (e) { /* 配置缺失或损坏：忽略，返回 null 让前端提示未配置 */ }
  return null;
}

/* 同花顺指数 thscode 映射（与 INDEX_SET 对齐） */
/* 注意：'899050.TI'（北证50）实测返回 code=1002 Unknown thscode，
   且批量请求中任一代码不支持会导致整批失败，故已从列表中移除（实测其余 14 个均可用）。 */
const FY_IDX_CODES = [
  '000001.SH','399001.SZ','399006.SZ','000688.SH',
  '000300.SH','000905.SH','000852.SH','000016.SH',
  '399005.SZ','399673.SZ','399303.SZ','399312.SZ',
  '000932.SH','399004.SZ'
];


/* 接口允许的方法白名单（未声明的接口一律只允许 GET）。

   注意方向：早期实现是 `if (method === 'POST' && !POST_OK[key]) 405`，
   只拦住了「非白名单接口的 POST」，却没有阻止「写接口被 GET 调用」——
   于是 GET /api/mail/test 也会真的发信，而 GET 无需请求体，
   可被 <img src="http://host/api/mail/test"> 跨站触发（CSRF）。
   改为逐接口显式声明允许的方法，未声明即默认 GET。 */
const ROUTE_METHODS = {
  '/mail/config': ['GET', 'POST'],   // GET 返回脱敏配置（不下发口令），POST 保存
  '/mail/test': ['POST'],
  '/mail/check': ['POST'],
  '/sync/push': ['POST'],
  '/sync/pull': ['POST'],
  '/ai': ['POST'],
  '/ml/predict': ['POST'],
  '/ml/backtest': ['POST']
};

/* ---------- 指数看板（同花顺口径的一篮子核心指数） ----------
   上证 / 深证成指 / 创业板指 / 科创50 / 北证50 / 沪深300 / 上证50 /
   中证500 / 中证1000 / 深证100 / 上证380 / 国证2000
   字段：f2 现价 f3 涨跌幅 f4 涨跌额 f6 成交额 f15 最高 f16 最低 f17 开盘 f18 昨收
------------------------------------------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

/* ===================================================================
   云端自选同步
   无账号体系：昵称(作盐) + 口令 → scrypt 派生存储键，数据落本地 JSON 文件。
   口令不明文落地，服务端只存派生键与自选列表。
   注意定位：这是「自建服务的私人同步」，安全性取决于口令强度，
   不要用它存敏感信息，也不要把服务直接暴露到公网而不加 HTTPS。
   =================================================================== */

module.exports = {
  CORS_ORIGIN, DATA_DIR, DIST_DIR, EM, EM2, EMD, EMH, EMX,
  FY, FY_IDX_CODES, FY_KEY, MIME, ML_SERVICE_URL, PORT, ROOT, ROUTE_METHODS, SYNC_DIR, UA, loadFYKey, loadLLM
};
