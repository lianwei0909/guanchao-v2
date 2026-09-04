/* 零依赖进程守护：拉起 web / ML 子进程，异常退出即自动重启（指数退避）。

   为什么不用 PM2：本项目服务端坚持「零新增依赖」，且当前环境为 Node v24，
   PM2 存在兼容不确定性。若更偏好 PM2，仓库已附 ecosystem.config.cjs，
   两者任选其一即可，不要同时启用（会抢端口）。

   机制：
     - 子进程退出 → 按 minUptime 判定是否「稳定启动过」：
       稳定运行过则重置失败计数；否则失败计数 +1 并指数退避重启（2s→4s→8s…30s 封顶）。
     - 连续快速失败超过 maxRestart 次，停止重启**该**进程，其余进程不受影响。
     - 各进程 stdout/stderr 追加写入 logs/<name>.out.log / .err.log（fd 复用，不泄漏）。

   用法：
     node server/watchdog.js                      守护 web + ML
     $env:WATCHDOG_ML='0'; node server/watchdog.js 只守护 web
   开机自启（Windows）：任务计划程序 → 登录时执行 node <项目路径>\server\watchdog.js */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const APPS = [
  {
    name: 'web',
    cmd: process.execPath,
    args: [path.join(__dirname, 'index.js')],
    cwd: ROOT,
    minUptime: 20000,   // 稳定运行 20s 以上视为健康启动
    maxRestart: 10
  }
];

/* ML 服务（Python）。
   解释器优先级：环境变量 ML_PYTHON > data/watchdog.json 的 mlPython > 'python'。
   注意：本机实测 `python` / `python3` 都不在 PATH 里（ML 服务此前是用完整路径启动的），
   不显式指定会导致 ml 进程 ENOENT 并快速失败，因此支持上面两种方式覆盖。
   data/ 已被 gitignore，适合放这类与环境相关的本地配置。 */
function resolvePython() {
  if (process.env.ML_PYTHON) return process.env.ML_PYTHON;
  try {
    const p = path.join(ROOT, 'data', 'watchdog.json');
    if (fs.existsSync(p)) {
      const c = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
      if (c.mlPython) return c.mlPython;
    }
  } catch (e) { /* 配置缺失或损坏：回退到默认 */ }
  return 'python';
}

/* 设为 WATCHDOG_ML=0 可关闭，便于仅跑 Node 做调试 */
if (process.env.WATCHDOG_ML !== '0') {
  APPS.push({
    name: 'ml',
    cmd: resolvePython(),
    args: [path.join(ROOT, 'ml_service', 'service.py')],
    cwd: ROOT,
    minUptime: 15000,
    maxRestart: 5
  });
}

const BASE_DELAY = 2000;
const MAX_DELAY = 30000;

/* 日志轮转：单文件超过 20MB 即切分，最多保留 5 份历史。
   子进程日志是持续追加的，长期运行不轮转会静默吃掉磁盘。 */
const LOG_MAX_BYTES = 20 * 1024 * 1024;
const LOG_KEEP = 5;

function sizeOf(p) {
  try { return fs.statSync(p).size; } catch (e) { return 0; }
}
function pruneOld(p) {
  const dir = path.dirname(p);
  const base = path.basename(p).replace(/\.log$/, '');
  try {
    /* 文件名含 ISO 时间戳，字典序即时间序 */
    const olds = fs.readdirSync(dir)
      .filter((f) => f.startsWith(base + '.') && f.endsWith('.log'))
      .sort()
      .reverse();
    for (const f of olds.slice(LOG_KEEP)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* 删除失败不影响启动 */ }
    }
  } catch (e) { /* 目录不可读：跳过清理 */ }
}

function log(msg, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg, ...fields });
  console.log(line);
  try { fs.appendFileSync(path.join(LOG_DIR, 'watchdog.log'), line + '\n'); } catch (e) { /* 日志失败不应影响守护 */ }
}

class App {
  constructor(cfg) {
    this.cfg = cfg;
    this.child = null;
    this.fails = 0;
    this.timer = null;
    this.stopped = false;
    this.startedAt = 0;
    this.outPath = path.join(LOG_DIR, `${cfg.name}.out.log`);
    this.errPath = path.join(LOG_DIR, `${cfg.name}.err.log`);
    this.out = null;
    this.err = null;
  }

  openLogs() {
    this.out = fs.openSync(this.outPath, 'a');
    this.err = fs.openSync(this.errPath, 'a');
  }

  closeLogs() {
    for (const k of ['out', 'err']) {
      if (this[k] == null) continue;
      try { fs.closeSync(this[k]); } catch (e) { /* 已关闭 */ }
      this[k] = null;
    }
  }

  /* 超过阈值就切一份带时间戳的历史文件，并按需淘汰最旧的 */
  rotateLogs() {
    for (const p of [this.outPath, this.errPath]) {
      if (sizeOf(p) < LOG_MAX_BYTES) continue;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      try {
        fs.renameSync(p, p.replace(/\.log$/, `.${stamp}.log`));
        pruneOld(p);
        log('log rotated', { file: path.basename(p) });
      } catch (e) { /* 轮转失败不应阻断启动 */ }
    }
  }

  start() {
    if (this.stopped || this.child) return;
    /* 每次（重新）拉起前轮转并重建 fd：既防止磁盘被日志吃满，
       也避免「每次 spawn 都 openSync」导致的句柄泄漏 */
    this.closeLogs();
    this.rotateLogs();
    this.openLogs();
    this.startedAt = Date.now();
    const { cmd, args, cwd } = this.cfg;
    this.child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', this.out, this.err],
      env: process.env,
      windowsHide: true
    });
    this.exited = false;   // 防止 spawn 失败时 error 与 exit 双触发重复计数
    this.child.on('exit', (code, signal) => this.onExit(code, signal));
    this.child.on('error', (e) => {
      /* 常见于解释器不存在（python 不在 PATH）：按快速失败计数处理并给出可操作的提示 */
      log('spawn error', {
        app: this.cfg.name,
        err: e.message,
        ...(e.code === 'ENOENT'
          ? { hint: '解释器不存在：请设置环境变量 ML_PYTHON，或在 data/watchdog.json 中写 { "mlPython": "完整路径/python.exe" }' }
          : {})
      });
      this.child = null;
      this.onExit(null, null);
    });
    log('started', { app: this.cfg.name, pid: this.child.pid });
  }

  onExit(code, signal) {
    if (this.exited) return;   // error 事件已处理过，忽略随后的 exit
    this.exited = true;
    const uptime = Date.now() - (this.startedAt || Date.now());
    this.child = null;
    log('exited', { app: this.cfg.name, code, signal, uptimeMs: uptime });
    if (this.stopped) return;

    if (uptime > this.cfg.minUptime) this.fails = 0;   // 稳定运行过 → 重置
    else this.fails += 1;

    if (this.fails > this.cfg.maxRestart) {
      log('give up', {
        app: this.cfg.name,
        fails: this.fails,
        hint: '连续快速失败，已停止重启该进程（其余进程不受影响）'
      });
      return;
    }
    this.scheduleRestart();
  }

  scheduleRestart() {
    if (this.stopped) return;
    const delay = Math.min(BASE_DELAY * Math.pow(2, Math.max(0, this.fails - 1)), MAX_DELAY);
    log('restart scheduled', { app: this.cfg.name, delayMs: delay, fails: this.fails });
    this.timer = setTimeout(() => { this.timer = null; this.start(); }, delay);
  }

  stop() {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.child && this.child.pid) {
      try { this.child.kill(); } catch (e) { /* 已退出 */ }
    }
  }
}

const apps = APPS.map((c) => new App(c));
apps.forEach((a) => a.start());

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('watchdog stopping', { signal });
  apps.forEach((a) => a.stop());
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => {
  /* 守护进程自身绝不退出：记录后继续看护子进程 */
  log('watchdog error', { err: e.message, stack: e.stack });
});
