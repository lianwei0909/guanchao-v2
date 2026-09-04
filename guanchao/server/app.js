/* HTTP 应用层：路由分发 + 静态托管 + CORS + 限流 + 访问日志
   只负责「协议层」的事，业务实现都在 routes/ 各模块里。 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');

const { CORS_ORIGIN, DIST_DIR, MIME, ROOT, ROUTE_METHODS } = require('./config.js');
const { fail } = require('./lib/respond.js');
const { log, nextId } = require('./lib/logger.js');
const { API } = require('./routes/index.js');
const { reportError } = require('./lib/monitor.js');

/** 慢请求阈值（ms），超过则额外打一条 warn。可用 SLOW_MS 覆盖 */
const SLOW_MS = Number(process.env.SLOW_MS || 3000);

/* ---------------- 客户端限流（令牌桶 / 每 IP） ----------------
   原先只有面向上游的并发闸门，没有任何客户端侧限制，
   单个页面异常轮询就能把进程打满。RATE_PER_MIN=0 可关闭。 */
const RATE_PER_MIN = Number(process.env.RATE_PER_MIN || 600);
const buckets = new Map();

function allow(ip) {
  if (!RATE_PER_MIN) return true;
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) {
    b = { tokens: RATE_PER_MIN, t: now };
    buckets.set(ip, b);
  }
  b.tokens = Math.min(RATE_PER_MIN, b.tokens + ((now - b.t) / 60000) * RATE_PER_MIN);
  b.t = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/* 防止桶无限增长（换 IP / 扫描场景） */
setInterval(() => {
  if (buckets.size < 5000) return;
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [ip, b] of buckets) if (b.t < cutoff) buckets.delete(ip);
}, 5 * 60 * 1000).unref();

/* ---------------- 静态托管 ----------------
   优先托管 dist/（Vue 构建产物）；未构建时回退到项目根，
   便于开发期直接用 9000 端口访问源码入口。 */
function staticBase() {
  return fs.existsSync(path.join(DIST_DIR, 'index.html')) ? DIST_DIR : ROOT;
}

function serveStatic(req, res, pathname) {
  const base = staticBase();
  let fp = path.join(base, pathname === '/' ? 'index.html' : decodeURIComponent(pathname));
  // 防目录穿越
  if (!fp.startsWith(base)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) fp = path.join(base, 'index.html'); // SPA 回退
    const ext = path.extname(fp).toLowerCase();
    /* Vite 产物带内容哈希，可长缓存；入口 HTML 必须不缓存，否则发版后用户拿不到新版本 */
    const immutable = /^\/assets\//.test(pathname) || /-[A-Za-z0-9_]{8,}\.\w+$/.test(pathname);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': immutable
        ? 'public, max-age=31536000, immutable'
        : (ext === '.html' ? 'no-cache' : 'public, max-age=300')
    });
    fs.createReadStream(fp).pipe(res);
  });
}

/* ---------------- 服务器 ---------------- */
const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const rid = nextId();
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = u.pathname.replace(/\/+$/, '') || '/';
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '-';

  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Request-Id', rid);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (pathname.startsWith('/api/')) {
    if (!allow(ip)) {
      log.warn('rate limited', { rid, ip, path: pathname });
      return fail(res, '请求过于频繁，请稍后再试', 429);
    }
    const key = pathname.slice('/api'.length);
    const h = API[key];
    if (!h) return fail(res, '未知接口: ' + pathname, 404);
    /* 方法白名单：未声明的接口只允许 GET，避免写操作被 <img src> 跨站触发 */
    const methods = ROUTE_METHODS[key] || ['GET'];
    if (!methods.includes(req.method)) {
      return fail(res, `该接口仅支持 ${methods.join(' / ')}`, 405);
    }
    try {
      await h(res, u.searchParams, req);
      const ms = Date.now() - started;
      log.info('api', { rid, ip, path: pathname, ms });
      /* 慢请求单独打 warn：为 P50/P95 基线与性能回归提供抓手 */
      if (ms > SLOW_MS) log.warn('api slow', { rid, path: pathname, ms });
    } catch (e) {
      const ms = Date.now() - started;
      log.error('api error', { rid, ip, path: pathname, ms, err: e.message });
      reportError(e, { rid, path: pathname });
      fail(res, e.message || '上游数据获取失败');
    }
    return;
  }

  serveStatic(req, res, pathname);
});

/* ---------------- 连接级超时 ----------------
   防止慢客户端 / 慢上游长期占用连接导致 fd 与内存堆积。
   注意 requestTimeout 只约束「接收完整请求」的时长，不限制响应时长，
   因此不会影响 /api/ml/predict 这类最长 240s 的训练型接口。 */
server.headersTimeout = 20000;    // 请求头必须在 20s 内到达
server.requestTimeout = 120000;   // 完整请求体必须在 120s 内收完

module.exports = { server, API };
