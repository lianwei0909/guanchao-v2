/* 由 server.js 机械拆分而来，行为未改动。 */
const { URL } = require('url');
const { UA } = require('../config.js');
const { gateAcquire, gateRelease } = require('./gate.js');
const { log } = require('./logger.js');

/* ---------- 上游主机熔断与自动降级 ----------
   实测故障：push2 主域在 Windows + schannel 下会触发 TLS renegotiation 并被 CDN
   断连（server closed abruptly）；密集请求时还会触发东财 IP 级临时限流，
   此时重试同一主机只是在浪费时间并加剧限流。
   策略：主域失败 → 自动轮换备用域；连续失败的域进入冷却期，期间直接跳过。 */
const HOST_FALLBACK = {
  'push2.eastmoney.com': ['push2delay.eastmoney.com', 'push2his.eastmoney.com'],
  'push2delay.eastmoney.com': ['push2his.eastmoney.com', 'push2.eastmoney.com'],
  'push2his.eastmoney.com': ['push2delay.eastmoney.com', 'push2.eastmoney.com']
};
const HOST_COOLDOWN_MS = 60 * 1000;   // 冷却 60 秒后再探活
const HOST_MAX_FAILS = 3;             // 连续失败 3 次进入冷却
const hostHealth = new Map();         // host -> { fails, until }

function hostBlocked(host) {
  const h = hostHealth.get(host);
  if (!h) return false;
  if (Date.now() < h.until) return true;      // 仍在冷却期
  hostHealth.delete(host);                    // 冷却结束 → 清空计数，重新探活
  return false;
}
function hostNoteFail(host) {
  const h = hostHealth.get(host) || { fails: 0, until: 0 };
  h.fails += 1;
  if (h.fails >= HOST_MAX_FAILS) h.until = Date.now() + HOST_COOLDOWN_MS;
  hostHealth.set(host, h);
}
function hostNoteOk(host) { hostHealth.delete(host); }   // 成功即恢复

/* 把 URL 展开成候选列表：原域在前，备用域在后 */
function hostCandidates(url) {
  const out = [url];
  try {
    const alts = HOST_FALLBACK[new URL(url).hostname] || [];
    for (const alt of alts) {
      const c = new URL(url);
      c.hostname = alt;
      out.push(c.toString());
    }
  } catch (e) { /* URL 解析失败：只保留原 URL */ }
  return out;
}

/* ---------- 同花顺（fuyao.aicubes.cn）数据源 ----------
   用于对齐市场级统计数据（涨跌家数、成交额、主力净流入、指数快照）
   与东方财富源互为补充：fuyao 覆盖市场概览/指数，东财覆盖个股明细/排行
   需配置 FY_API_KEY 环境变量或留空（留空则自动降级到东财源） */

async function getJSON(url, headers = {}, retries = 4) {
  /* 候选展开：每个域试 2 次，失败后轮换到下一个备用域（冷却中的域直接跳过）。
     这样单域限流 / TLS 断连时不会把重试预算全耗在同一台主机上。 */
  const cands = hostCandidates(url);
  const maxAttempts = Math.max(retries, cands.length * 2);
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    const cand = cands[Math.min(Math.floor(i / 2), cands.length - 1)];
    let host = '';
    try { host = new URL(cand).hostname; } catch (e) { /* 忽略解析失败 */ }
    if (host && hostBlocked(host)) continue;   // 该域正在冷却，换下一个

    await gateAcquire();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const r = await fetch(cand, {
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/', ...headers }
      });
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      gateRelease();
      if (host) hostNoteOk(host);
      return j;
    } catch (e) {
      clearTimeout(timer);
      gateRelease();
      lastErr = e;
      if (host) hostNoteFail(host);
      /* 指数退避：400 / 1200 / 3000ms —— 限流时需要更长的冷却 */
      if (i < maxAttempts - 1) await new Promise(r => setTimeout(r, [400, 1200, 3000][Math.min(i, 2)]));
    }
  }
  throw lastErr;
}

/* 主机回退：依次尝试多个 URL（通常用于同一份数据换不同上游主机），
   任一成功即返回；全部失败才抛错。配合 getJSON 自带的重试，最大化可用性。 */
async function getJSONFailover(urls) {
  let lastErr;
  for (const u of urls) {
    try { return await getJSON(u); } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('全部上游主机均不可用');
}

/* 取原始文本（有些接口返回的不是纯 JSON，如东财快讯的 `var ajaxResult={...}`） */
async function getJSON_Text(url, headers = {}, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    await gateAcquire();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const r = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/', ...headers }
      });
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const t = await r.text();
      gateRelease();
      return t;
    } catch (e) {
      clearTimeout(timer);
      gateRelease();
      lastErr = e;
      if (i < retries - 1) await new Promise(r => setTimeout(r, [400, 1200][i] || 2000));
    }
  }
  throw lastErr;
}


/* 取原始文本（腾讯 qt.gtimg.cn 返回 GBK）。
   原先是裸 fetch：既没有超时也不过闸门，上游不响应时会长期悬挂并脱离并发预算。
   另外 GBK 解码依赖 Node 的 full-icu，未编译进 ICU 的环境会抛 EncodingError ——
   这里兜底成 latin1 并告警，宁可拿到乱码也不让整个接口失败。 */
let gbkWarned = false;
async function getText(url, timeoutMs = 12000) {
  await gateAcquire();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Referer': 'https://gu.qq.com/' }
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch (e) {
      if (!gbkWarned) {
        gbkWarned = true;
        log.warn('GBK 解码不可用（Node 未编译 full-icu），已回退 latin1', { err: e.message });
      }
      return buf.toString('latin1');
    }
  } finally {
    clearTimeout(timer);
    gateRelease();
  }
}

module.exports = { HOST_COOLDOWN_MS, HOST_FALLBACK, HOST_MAX_FAILS, getJSON, getJSONFailover, getJSON_Text, getText, hostBlocked, hostCandidates, hostHealth, hostNoteFail, hostNoteOk };
