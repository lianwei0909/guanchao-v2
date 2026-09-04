/* 并发闸门（分级 + 前后台隔离）
   背景：原先全局只有一把锁（GATE_MAX=6 / GATE_GAP=110ms ≈ 9 req/s），
   前台「看行情」与后台「全市场扫描」抢同一份预算 —— 预测一跑全站就卡。
   这里拆成两级，各自独立计数，后台刻意压得比前台小，保证前台永远有余量：
     fg 前台：用户直接等待的请求（行情 / 详情 / 排行 …）
     bg 后台：预计算 / 回测 / 预热，慢也无所谓，但不能拖垮前台

   调用方式对既有代码零改动：http.js 仍直接 gateAcquire() / gateRelease()。
   后台任务用 withTier('bg', async () => { ... }) 包一层，其内部（含异步嵌套）
   的所有取数都会自动走 bg 档 —— 基于 AsyncLocalStorage 传递上下文。 */
const { AsyncLocalStorage } = require('node:async_hooks');

const TIERS = {
  fg: { max: 6, gap: 110 },   // 前台 ≈9 req/s
  bg: { max: 3, gap: 150 }    // 后台 ≈6.7 req/s，且不影响前台
};

function makeTier(name, { max, gap }) {
  let active = 0;
  let last = 0;
  const queue = [];
  function pump() {
    if (!queue.length || active >= max) return;
    const wait = Math.max(0, last + gap - Date.now());
    if (wait > 0) { setTimeout(pump, wait); return; }
    active++;
    last = Date.now();
    queue.shift()();
  }
  return {
    name,
    acquire: () => new Promise((resolve) => { queue.push(resolve); pump(); }),
    release: () => { active--; pump(); },
    get active() { return active; },
    get pending() { return queue.length; }
  };
}

const tiers = {
  fg: makeTier('fg', TIERS.fg),
  bg: makeTier('bg', TIERS.bg)
};

/* 当前调用上下文所属档位：默认前台 */
const als = new AsyncLocalStorage();
function currentTier() {
  return als.getStore() || 'fg';
}

function gateAcquire() { return tiers[currentTier()].acquire(); }
function gateRelease() { return tiers[currentTier()].release(); }

/** 在指定档位下执行 fn；其内部（含异步嵌套）的取数都走该档位 */
function withTier(tier, fn) { return als.run(tier, fn); }

module.exports = {
  TIERS,
  tiers,
  withTier,
  gateAcquire,
  gateRelease,
  /* 兼容旧导出：原先导出的是数字快照，恒为 0，监控读取失真 */
  get gateActive() { return tiers.fg.active; },
  stats: () =>
    Object.fromEntries(
      Object.entries(tiers).map(([k, t]) => [k, { active: t.active, pending: t.pending, max: TIERS[k].max }])
    )
};
