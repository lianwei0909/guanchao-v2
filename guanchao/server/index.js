/* 服务启动入口：只做装配与生命周期管理 */
const fs = require('fs');
const path = require('path');

const { DATA_DIR, DIST_DIR, PORT, SYNC_DIR } = require('./config.js');
const { server } = require('./app.js');
const { routes } = require('./routes/index.js');
const { startWarmUp } = require('./warm.js');
const { startNameMapSchedule } = require('./routes/news.js');
const { mailLoad, startMailSchedule } = require('./routes/mail.js');
const { log } = require('./lib/logger.js');
const { reportError } = require('./lib/monitor.js');

fs.mkdirSync(SYNC_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const hasDist = fs.existsSync(path.join(DIST_DIR, 'index.html'));

server.listen(PORT, () => {
  log.info('server started', {
    port: PORT,
    routes: routes.length,
    dist: hasDist,
    url: `http://localhost:${PORT}`
  });
  if (!hasDist) {
    log.warn('dist 未构建，静态资源回退到项目根目录；生产部署请先执行 npm run build');
  }
});

/* 后台调度：统一在入口启动，模块本身不再有 import 副作用 */
startNameMapSchedule();
mailLoad()
  .then(() => log.info('mail config loaded'))
  .catch((e) => log.warn('mail config load failed', { err: e.message }));
startMailSchedule();

/* 延迟 5 秒预热，避开启动阶段 */
setTimeout(startWarmUp, 5000);

/* 预测结果预计算：启动 15 秒后串行算出当日全部周期并落盘，
   让用户的首次访问也走「读盘秒回」路径（否则首访要等 46~104s 的全市场扫描）。
   已有当日缓存时会直接跳过；设 FORECAST_PREWARM=0 可关闭。 */
if (process.env.FORECAST_PREWARM !== '0') {
  setTimeout(() => {
    const { precomputeAll } = require('./routes/forecast.js');
    precomputeAll()
      .then(() => log.info('forecast prewarm done'))
      .catch((e) => log.warn('forecast prewarm error', { err: e.message }));
  }, 15000);
}

/* ---------------- 优雅退出 ---------------- */
let closing = false;
function shutdown(reason) {
  if (closing) return;
  closing = true;
  log.info('shutting down', { reason });
  server.close(() => {
    log.info('server closed');
    process.exit(0);
  });
  // 兜底：连接迟迟不断开时强制退出
  setTimeout(() => process.exit(0), 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/* ---------------- 异常退出策略 ----------------
   进程抛出未捕获异常时已处于不可知状态，此时再做「优雅关闭」只会让
   进行中的请求在半路被切断。改为：记录 → 非零码退出，
   由守护进程（server/watchdog.js 或 PM2）负责重启。
   退出码非 0 能让守护判定为「异常退出」并计入快速失败计数。 */
function exitAfterFlush(code) {
  /* stdout 重定向到文件时是同步写，这里只留一帧给日志落盘 */
  setTimeout(() => process.exit(code), 100).unref();
}

process.on('uncaughtException', (e) => {
  log.error('uncaughtException', { err: e.message, stack: e.stack });
  reportError(e, { path: 'uncaughtException' });
  exitAfterFlush(1);
});

process.on('unhandledRejection', (e) => {
  /* Promise 拒绝通常不会让进程进入不可恢复状态：记录并继续服务。
     关键是「不静默」——落盘到 data/errors/ 并由 /health 暴露计数。 */
  log.error('unhandledRejection', { err: e && e.message, stack: e && e.stack });
  reportError(e, { path: 'unhandledRejection' });
});
