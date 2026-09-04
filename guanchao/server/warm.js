/* 由 server.js 机械拆分而来，行为未改动。
   （预热调度部分已加固：自调度 + in-flight 守卫，见文件下半部分） */
const { PORT } = require('./config.js');

const WARM_INTERVAL = 20000;
async function warmUpOnce() {
  const selfFetch = (p) =>
    fetch(`http://127.0.0.1:${PORT}${p}`).then((r) => r.json()).catch(() => null);
  await selfFetch('/api/market-stat?mode=fast');                    // 快层（15s TTL）
  await selfFetch('/api/sector-capital?type=industry&sort=flow');   // 行业（30s TTL）
  await selfFetch('/api/sector-capital?type=concept&sort=flow');    // 概念（30s TTL）
  await selfFetch('/api/market-stat');                              // 慢层由路由按 TTL 判断是否刷新
}

/* ---------- 自调度 + in-flight 守卫 ----------
   原先是 setInterval(warmUpOnce, 20000)，但 /api/market-stat 是全市场慢扫描：
   单轮耗时一旦超过 20s，setInterval 仍会继续叠加新一轮，
   多轮扫描并存 → 上游请求翻倍 + 打满全局并发闸门（表现为「服务卡死」）。
   改成「本轮跑完再排下一轮」，从机制上杜绝叠加。 */
let warmRunning = false;
let warmTimer = null;
let warmStopped = false;
const { log } = require('./lib/logger.js');

async function warmSchedule() {
  if (warmRunning) return;
  warmRunning = true;
  const t0 = Date.now();
  try {
    await warmUpOnce();
    log.debug('warm ok', { ms: Date.now() - t0 });
  } catch (e) {
    /* 预热失败不影响对外服务：仅记录，交给下一轮重试 */
    log.warn('warm failed', { err: e.message, ms: Date.now() - t0 });
  } finally {
    warmRunning = false;
  }
  if (warmStopped) return;
  warmTimer = setTimeout(warmSchedule, WARM_INTERVAL);
}

function startWarmUp() {
  if (warmTimer || warmRunning) return;
  warmStopped = false;
  warmSchedule();
}

function stopWarmUp() {
  warmStopped = true;
  if (warmTimer) { clearTimeout(warmTimer); warmTimer = null; }
}

/* 由 index.js 在服务就绪后延迟 5 秒启动，避开启动阶段 */

module.exports = { WARM_INTERVAL, startWarmUp, stopWarmUp, warmUpOnce };
