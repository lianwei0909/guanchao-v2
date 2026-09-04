/* 由 server.js 机械拆分而来，行为未改动。 */
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { scrypt } = require('crypto');
const { promisify } = require('util');
const scryptAsync = promisify(scrypt);
const { SYNC_DIR } = require('../config.js');
const { fail, ok, readBody } = require('../lib/respond.js');
const H = {};

const USER_RE = /^[A-Za-z0-9_\-\u4e00-\u9fa5]{2,24}$/;

function checkCred(user, pass) {
  const u = String(user || '').trim();
  const p = String(pass || '');
  if (!USER_RE.test(u)) return '昵称需为 2-24 位中英文、数字、下划线或短横线';
  if (p.length < 6 || p.length > 64) return '口令需为 6-64 位';
  return null;
}
async function syncKey(user, pass) {
  const buf = await scryptAsync(String(pass), 'hqt-sync:' + String(user).trim().toLowerCase(),
    24, { N: 16384, r: 8, p: 1 });
  return buf.toString('hex');
}
function syncFile(key) { return path.join(SYNC_DIR, key + '.json'); }

/* 只保留白名单字段并限长，避免客户端塞进任意内容 */
function cleanWatchlist(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [], seen = {};
  for (const it of arr.slice(0, 200)) {
    if (!it || typeof it !== 'object') continue;
    const code = String(it.code || '').trim().slice(0, 16);
    if (!code || seen[code]) continue;
    seen[code] = 1;
    out.push({
      code,
      name: String(it.name || code).trim().slice(0, 40),
      secid: /^[0-9]{1,3}\.[A-Za-z0-9]{1,12}$/.test(String(it.secid || '').trim()) ? String(it.secid).trim() : '',
      ts: Number(it.ts) || 0
    });
  }
  return out;
}
async function readSync(key) {
  try { return JSON.parse(await fsp.readFile(syncFile(key), 'utf8')); }
  catch (e) { return null; }
}

async function syncPull(res, q, req) {
  const b = await readBody(req, res);
  const bad = checkCred(b.user, b.pass);
  if (bad) return fail(res, bad, 400);
  const rec = await readSync(await syncKey(b.user, b.pass));
  if (!rec) return fail(res, '云端还没有数据，请先上传', 404);
  ok(res, { watchlist: rec.watchlist || [], updatedAt: rec.updatedAt, count: (rec.watchlist || []).length });
}

async function syncPush(res, q, req) {
  const b = await readBody(req, res);
  const bad = checkCred(b.user, b.pass);
  if (bad) return fail(res, bad, 400);
  const list = cleanWatchlist(b.watchlist);
  const key = await syncKey(b.user, b.pass);
  const prev = await readSync(key);
  /* 防止误覆盖：客户端需带上它拉取时看到的版本，不一致说明被别处改过 */
  if (prev && b.baseUpdatedAt && prev.updatedAt !== b.baseUpdatedAt) {
    return fail(res, '云端已被其他设备更新，请重新拉取后再上传', 409);
  }
  const rec = {
    user: String(b.user).trim(),
    updatedAt: new Date().toISOString(),
    watchlist: list
  };
  await fsp.mkdir(SYNC_DIR, { recursive: true });
  await fsp.writeFile(syncFile(key), JSON.stringify(rec), 'utf8');
  ok(res, { updatedAt: rec.updatedAt, count: list.length });
}
H['/sync/pull'] = syncPull;
H['/sync/push'] = syncPush;

/* ===================================================================
   新增：对标参考站的 11 个股票页
   =================================================================== */

/* ---------- 股票排行：市场 × 维度 ----------
   市场：all 全部A股 / sh 沪A / sz 深A / cyb 创业板 / kcb 科创板 / bj 北交所
   维度：changePct 涨幅 / changePctD 跌幅 / amount 成交额 / turnover 换手
        volumeRatio 量比 / amplitude 振幅 / mainNetInflow 主力净流入 / pe 市盈率 */

Object.assign(H, { USER_RE, checkCred, cleanWatchlist, readSync, syncFile, syncKey, syncPull, syncPush });
module.exports = H;
