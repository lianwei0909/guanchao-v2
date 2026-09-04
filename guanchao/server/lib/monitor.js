/* 轻量错误监控（零依赖）
   目标：让「服务到底有没有在报错、报什么错」可观测、可回溯。

   当前实现三件事：
     1. 按天落盘 data/errors/YYYY-MM-DD.ndjson（单行 JSON，便于检索/采集）
     2. 指纹去重：同一「路径+消息」在冷却期内只累计计数、不重复写盘，
        避免上游抖动时把磁盘刷爆
     3. stats() 供 /health 暴露当日错误概况

   若要接 Sentry 或邮件告警，只需在本文件的 reportError 里追加一个
   notify 实现（邮件通道需先 npm i nodemailer，当前未安装故静默降级）。 */
const fs = require('node:fs');
const path = require('node:path');

const { DATA_DIR } = require('../config.js');
const { log } = require('./logger.js');

const ERR_DIR = path.join(DATA_DIR, 'errors');
const COOLDOWN_MS = 5 * 60 * 1000;

const mem = { day: '', total: 0, kinds: new Map(), last: null };

function todayDash() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** 指纹：路径 + 消息前 80 字符，用于把同类错误归并计数 */
function fingerprint(e, ctx) {
  const msg = String((e && e.message) || e || 'unknown').slice(0, 80);
  return ctx && ctx.path ? `${ctx.path}|${msg}` : msg;
}

function reportError(e, ctx = {}) {
  const day = todayDash();
  if (mem.day !== day) {
    mem.day = day;
    mem.total = 0;
    mem.kinds.clear();
  }
  const fp = fingerprint(e, ctx);
  const agg = mem.kinds.get(fp) || { count: 0, lastAt: 0 };
  agg.count += 1;
  mem.total += 1;

  const rec = {
    ts: new Date().toISOString(),
    level: 'error',
    msg: String((e && e.message) || e),
    path: ctx.path || '',
    rid: ctx.rid || '',
    fingerprint: fp,
    count: agg.count,
    stack: e && e.stack ? String(e.stack).split('\n').slice(0, 6).join(' | ') : ''
  };
  mem.last = rec;

  const now = Date.now();
  if (now - agg.lastAt > COOLDOWN_MS) {
    agg.lastAt = now;
    try {
      fs.mkdirSync(ERR_DIR, { recursive: true });
      fs.appendFileSync(path.join(ERR_DIR, `${day}.ndjson`), JSON.stringify(rec) + '\n');
    } catch (err) {
      /* 落盘失败也要保证进程继续服务 */
      log.warn('monitor persist failed', { err: err.message });
    }
  }
  mem.kinds.set(fp, agg);
  return rec;
}

/** 供 /health 暴露：当日错误总数 / 种类数 / 最近一条 */
function stats() {
  return {
    day: mem.day || todayDash(),
    total: mem.total,
    kinds: mem.kinds.size,
    last: mem.last
  };
}

module.exports = { COOLDOWN_MS, ERR_DIR, reportError, stats };
