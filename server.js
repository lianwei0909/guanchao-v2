/* ===================================================================
   行情通 · 后端服务
   静态托管 + 行情代理（数据源：东方财富公开接口）
   零外部依赖，Node 18+ 直接运行
   =================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { scrypt, createHash } = require('crypto');
const { promisify } = require('util');
const fsp = fs.promises;
const scryptAsync = promisify(scrypt);

const PORT = process.env.PORT || 9000;
const ROOT = __dirname;
const SYNC_DIR = path.join(ROOT, 'data', 'sync');   // 云端自选存储目录

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const EM = 'https://push2.eastmoney.com';       // 行情快照 / 列表
const EMH = 'https://push2his.eastmoney.com';   // K 线 / 分时
const EMX = 'https://push2ex.eastmoney.com';    // 涨跌停池
const EMD = 'https://datacenter-web.eastmoney.com'; // 龙虎榜
const EM2 = 'https://push2delay.eastmoney.com'; // push2 延时源（同一份行情，部分网络环境下 push2 主域偶发连接重置，用其兜底）

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

/* 同花顺指数 thscode 映射（与 INDEX_SET 对齐） */
/* 注意：'899050.TI'（北证50）实测返回 code=1002 Unknown thscode，
   且批量请求中任一代码不支持会导致整批失败，故已从列表中移除（实测其余 14 个均可用）。 */
const FY_IDX_CODES = [
  '000001.SH','399001.SZ','399006.SZ','000688.SH',
  '000300.SH','000905.SH','000852.SH','000016.SH',
  '399005.SZ','399673.SZ','399303.SZ','399312.SZ',
  '000932.SH','399004.SZ'
];

/* ---------------- 工具 ---------------- */
function jres(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}
function ok(res, data) { jres(res, 200, { ok: true, data }); }
function fail(res, msg, code = 502) { jres(res, code, { ok: false, msg }); }

/* 读取 JSON 请求体（带大小上限，防止被大 body 打爆）
   超限时要先回一个完整响应再断流 —— 直接 destroy() 会让客户端只看到
   ECONNRESET 网络错误，拿不到可读的 413 提示 */
function readBody(req, res, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        if (!res.headersSent) fail(res, '请求体过大（上限 ' + Math.round(limit / 1024) + 'KB）', 413);
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------
   上游请求闸门
   东方财富对高频请求会限流（表现为 fetch failed / socket closed），
   因此统一限并发 + 最小间隔，避免我们自己把上游打挂。
   ------------------------------------------------------------------ */
const GATE_MAX = 6;          // 最大并发
const GATE_GAP = 110;        // 相邻请求最小间隔（ms）
let gateActive = 0, gateLast = 0;
const gateQueue = [];

function gateAcquire() {
  return new Promise(resolve => {
    gateQueue.push(resolve);
    gatePump();
  });
}
function gatePump() {
  if (!gateQueue.length || gateActive >= GATE_MAX) return;
  const wait = Math.max(0, gateLast + GATE_GAP - Date.now());
  if (wait > 0) { setTimeout(gatePump, wait); return; }
  gateActive++;
  gateLast = Date.now();
  gateQueue.shift()();
}
function gateRelease() {
  gateActive--;
  gatePump();
}

/* 带重试的请求（上游偶发抖动 / 限流，指数退避重试 4 次） */
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

const num = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round = (v, d = 2) => Number(num(v).toFixed(d));

/* ===================================================================
   交易成本常量（REQUIREMENTS §4 · 唯一定义处，前端 api.js 有一份镜像）
   禁止在其它位置散落这些魔法数字。
   口径：
     佣金   万 2.5（0.025%），买卖双向，单笔最低 5 元
     印花税 卖出 0.05%
     过户费 0.001%，买卖双向
   双边成本 = 佣金×2 + 印花税 + 过户费×2
   按万元级金额估算约 0.152%（佣金触底 5 元），
   按大额（不触底）估算约 0.102%。
   =================================================================== */
const FEE = {
  commission: 0.00025,     // 佣金费率（万 2.5）
  commissionMin: 5,        // 单笔佣金下限（元）
  stampTax: 0.0005,        // 印花税（仅卖出）
  transfer: 0.00001        // 过户费（0.001%，双向）
};
/* 单边费用：dir='buy' | 'sell' */
function feeOf(amount, dir) {
  const a = Math.max(0, num(amount));
  const comm = Math.max(a * FEE.commission, FEE.commissionMin);
  const transfer = a * FEE.transfer;
  const stamp = dir === 'sell' ? a * FEE.stampTax : 0;
  return { commission: comm, transfer, stamp, total: comm + transfer + stamp };
}
/* 双边成本占金额比例（买入+卖出合计 / 金额） */
function roundTripCostPct(amount) {
  const a = Math.max(0, num(amount));
  if (a <= 0) return 0;
  return (feeOf(a, 'buy').total + feeOf(a, 'sell').total) / a;
}

/* ===================================================================
   标的解析
   市场码沿用东方财富：1=沪 0=深 105/106/107=美(纳斯达克/纽交所/美交所)
                       116=港股主板 128=港股创业板 100=港/外盘指数
   code 与 secid 二选一：
     - 传 secid（"1.000001"）时以它为准，指数/港美股必须靠它消除歧义
       （"000001" 既可能是上证指数也可能是平安银行）
     - 只传 code 时按形态推断：
         纯字母        → 美股（NVDA）
         5 位数字      → 港股（00700，腾讯、阿里都是 5 位）
         6/9/5/11 开头 → 沪市
         其余 6 位     → 深市
   =================================================================== */
function resolve(q) {
  const code = (q.get('code') || '').trim();
  const sid = (q.get('secid') || '').trim();
  if (sid) {
    const i = sid.indexOf('.');
    if (i > 0) return { code: code || sid.slice(i + 1), mkt: sid.slice(0, i), sym: sid.slice(i + 1) };
  }
  if (/^[A-Za-z]{1,8}$/.test(code)) return { code, mkt: '105', sym: code };   // 美股
  if (/^\d{5}$/.test(code)) return { code, mkt: '116', sym: code };           // 港股
  const mkt = /^(6|9|5|11)/.test(code) ? '1' : '0';
  return { code, mkt, sym: code };
}
/* 东财 secid */
function emSecid(r) { return r.mkt + '.' + r.sym; }
/* 由「市场码 f13 + 代码 f12」拼 secid；市场码缺失时按代码前缀兜底 */
function secidOf(mkt, code) {
  const c = String(code || '');
  if (!c) return '';
  const m = (mkt === undefined || mkt === null || mkt === '') ? (/^(6|9|5|11)/.test(c) ? 1 : 0) : Number(mkt);
  return m + '.' + c;
}
/* 腾讯 symbol：sh/sz/hk/us 前缀 */
function txSymOf(r) {
  const m = { '1': 'sh', '0': 'sz', '105': 'us', '106': 'us', '107': 'us', '116': 'hk', '128': 'hk' };
  /* 港股指数（100.HSI）与外盘指数（100.DJIA）在腾讯侧的符号不同：
     HSI 走 hk，而 DJIA/SPX 等没有对应，统一回落到 us 试一次 */
  if (r.mkt === '100') return /^[A-Z]/.test(r.sym) ? 'us' + r.sym : 'hk' + r.sym;
  return (m[r.mkt] || 'sh') + r.sym;
}
/* 美股 K 线需带交易所后缀：.OQ(纳斯达克) / .N(纽交所) / .A(美交所)
   实测 .OQ 对绝大多数代码通用，逐个试直到拿到足够行数 */
const US_SUFFIX = ['.OQ', '.N', '.A'];

/* 今日日期 YYYYMMDD */
function today() {
  const d = new Date();
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}
function todayDash() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* 腾讯日 K（供 /compare、/forecast 复用）
   返回原始数组，每项 [日期, 开, 收, 高, 低, 量]
   注意：腾讯的收盘价是第 3 个（索引 2），不是标准 OHLC 的第 2 个

   ---------- D1 复权切换（REQUIREMENTS D1）----------
   fq = 'qfq'（前复权，默认，保持历史行为）| 'hfq'（后复权）| ''（不复权）
   实测记录（改动前务必读）：
     - param 末段即复权参数，透传即可，无需改域名或路径
     - hfq 时返回节点 key 为 `hfq`+period（如 hfqday）；qfq 时为 `qfq`+period
     - 指数（如 sh000300）不参与复权：无论传 qfq/hfq 都只回 `day` 节点
       → 解析处统一写 node[fq+p] || node[p] 才能同时兼容个股与指数
     - 日期区间的格式必须是 YYYY-MM-DD，传 20240801 会返回 {"code":0,"msg":"param error"}
     - qfq 会多返回 1 根（limit=10 回 11 根），按日期去重后无影响
   口径约定：所有回测 / 指标计算（A1/A2/B 组）一律用 hfq；
             看盘 K 线保持 qfq。原因：前复权的历史价在每次除权后整体平移，
             用它回测会产生「当时并不存在」的假买卖点。 */
async function txKline(sym, p = 'day', limit = 120, fq = 'qfq') {
  return txKlineRange(sym, p, '', '', limit, fq);
}
/* 底层：带起止日期区间（分批拼接用）；start/end 为空表示不限 */
async function txKlineRange(sym, p, start, end, limit, fq) {
  const j = await getJSON(
    `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sym},${p},${start || ''},${end || ''},${limit},${fq || ''}`,
    { Referer: 'https://gu.qq.com/' });
  const node = j?.data?.[sym];
  const arr = node && ((fq ? node[fq + p] : null) || node[p]);
  return Array.isArray(arr) ? arr : [];
}
/* 取收盘价序列（腾讯格式 → number[]） */
function closeSeries(ks) { return ks.map(k => num(k[2])); }

/* ------------------------------------------------------------------
   腾讯 K 线分批拉取（D1 / A1 用）
   约束（REQUIREMENTS §5.7）：单次请求上限 500 根，超出时按日期区间分批 +
   拼接处按日期去重。
   实测：分段拉取时相邻两段会重复 1 个交易日（区间端点闭合），必须去重；
        分段取到的 hfq 值与整段拉取逐日比对 800 根，0 处偏差。
   ------------------------------------------------------------------ */
const TX_MAX_BARS = 500;
/* 按日期去重并升序合并 */
function mergeKlines(parts) {
  const m = new Map();
  parts.forEach(arr => (arr || []).forEach(row => {
    if (row && row[0]) m.set(String(row[0]), row);
  }));
  return Array.from(m.values()).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
/* 前一日（YYYY-MM-DD），用于下一批的区间上界 */
function prevDayStr(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
  if (!m) return '';
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}
async function txKlineBatched(sym, p, total, fq) {
  const need = Math.max(1, Math.min(num(total) || 1, 1500));
  const parts = [];
  let end = '', guard = 0;
  while (guard++ < 8) {
    const have = mergeKlines(parts).length;
    if (have >= need) break;
    const want = Math.min(TX_MAX_BARS, need - have + 2);
    const arr = await txKlineRange(sym, p, '', end, want, fq);
    if (!arr.length) break;
    parts.push(arr);
    /* 拿到的比想要的少 → 上游已无更早的历史，停止翻页 */
    if (arr.length < want) break;
    end = prevDayStr(String(arr[0][0]));
  }
  return mergeKlines(parts).slice(-need);
}

/* ------------------------------------------------------------------
   clist 列表请求（带域名降级）
   push2 主域的 clist 接口会被按 IP 封禁（表现为 fetch failed / other side closed），
   但同域 ulist 正常，且 push2delay 镜像可用 —— 因此逐个域名试。
   ------------------------------------------------------------------ */
const CLIST_HOSTS = [
  /* push2delay 实测最稳定：主域 push2 的 clist 常被按 IP 封禁（fetch failed），
     82.push2 同样不可用。把可用域名放首位能省掉一次必然失败的请求。 */
  'https://push2delay.eastmoney.com',
  'https://push2.eastmoney.com',
  'https://82.push2.eastmoney.com'
];
async function clistGet(fs, fid, fields, opt = {}) {
  const r = await clistPage(fs, fid, fields, opt);
  if (!r.arr.length) throw new Error('行情列表源不可用');
  return r.arr;
}
/* 带分页信息的版本：需要 data.total 时用（东财 clist 的 pz 硬上限是 100，
   超过必须翻页，所以 total 只能从第一次请求里拿） */
async function clistPage(fs, fid, fields, opt = {}) {
  const { po = 1, pz = 30, pn = 1 } = opt;
  const qs = `pn=${pn}&pz=${Math.min(100, pz)}&po=${po}&np=1&fltt=2&invt=2&fid=${fid}` +
    `&fs=${encodeURIComponent(fs)}&fields=${fields}`;
  let lastErr;
  for (const host of CLIST_HOSTS) {
    try {
      /* 主域失败很快，每个域名只给 1 次机会，失败立刻换下一个 */
      const j = await getJSON(`${host}/api/qt/clist/get?${qs}`, {}, 1);
      const diff = j?.data?.diff;
      if (diff) {
        const arr = Array.isArray(diff) ? diff : Object.values(diff);
        if (arr.length) return { total: num(j?.data?.total), arr };
      }
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('行情列表源不可用');
}

/* ---------- 批量快照（ulist.np） ----------
   clist 在本机只能拿到代码/名称，价格类字段一律返回 "-"，
   所以「先 clist 取代码清单，再 ulist.np 批量取行情」是唯一能拿到
   真实价格 + 成交额的组合。实测 ulist.np 一次 100 个 secid 稳定返回。

   secids 按 BATCH 切块并发请求，单块失败不影响其余块（返回空数组）。 */
async function ulistBatch(secids, fields, batch = 100) {
  const out = [];
  const chunks = [];
  for (let i = 0; i < secids.length; i += batch) chunks.push(secids.slice(i, i + batch));
  const parts = await Promise.all(chunks.map(async (ch) => {
    try {
      const j = await getJSON(`${EM}/api/qt/ulist.np/get?secids=${ch.join(',')}` +
        `&fields=${fields}&fltt=2&invt=2`);
      const d = j?.data?.diff;
      return d ? (Array.isArray(d) ? d : Object.values(d)) : [];
    } catch (e) {
      return [];
    }
  }));
  parts.forEach(p => p.forEach(x => out.push(x)));
  return out;
}
/* 把 ulist 的原始行规整成 { name, code, secid, price, pct, change, amount }，
   并丢掉行情缺失的行（f2 为 "-" 说明这只标的当前没有快照） */
function shapeQuote(x) {
  const price = (x.f2 === '-' || x.f2 == null) ? null : round(x.f2);
  if (price == null) return null;
  return {
    name: String(x.f14 || ''),
    code: String(x.f12 || ''),
    secid: secidOf(x.f13, x.f12),
    price,
    pct: round(x.f3 === '-' ? 0 : x.f3),
    change: round(x.f4 === '-' ? 0 : x.f4),
    amount: round(num(x.f6) / 1e8, 2)      // 成交额（亿元）
  };
}

/* 并发受限的 map：避免一次性打爆上游被限流 */
async function mapLimit(list, n, fn) {
  const out = new Array(list.length);
  let i = 0;
  const workers = new Array(Math.min(n, list.length)).fill(0).map(async () => {
    for (;;) {
      const idx = i++;
      if (idx >= list.length) return;
      try { out[idx] = await fn(list[idx], idx); }
      catch (e) { out[idx] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

/* clist 字段解析（行情列表通用） */
function parseList(d) {
  if (!d || !d.data || !Array.isArray(d.data.diff)) return [];
  const src = Array.isArray(d.data.diff) ? d.data.diff : Object.values(d.data.diff);
  return src.map(x => ({
    code: String(x.f12 || ''),
    secid: secidOf(x.f13, x.f12),
    name: x.f14 || '',
    price: round(x.f2),
    pct: round(x.f3),
    change: round(x.f4),
    turnover: round(num(x.f6) / 1e8, 2),      // 元 → 亿元
    volume: num(x.f5),
    amplitude: round(x.f7),
    rate: round(x.f8),
    mktcap: round(num(x.f20) / 1e8, 2)        // 元 → 亿元
  })).filter(s => s.code);
}

/* ===================================================================
   API 处理器
   =================================================================== */
const API = {};

/* 上游健康诊断：暴露各东财域的失败计数与冷却剩余时间。
   排查「行情源不可用」时先看这里——能立刻区分是单域限流还是整体网络故障。 */
API['/health'] = async (res) => {
  const hosts = {};
  for (const [h, v] of hostHealth) {
    hosts[h] = { fails: v.fails, cooldownLeftMs: Math.max(0, v.until - Date.now()) };
  }
  ok(res, {
    ts: Date.now(),
    uptimeSec: Math.round(process.uptime()),
    degraded: hosts,
    note: Object.keys(hosts).length
      ? '有域名处于降级/冷却中，请求已自动切到备用域'
      : '全部上游正常'
  });
};

/* 允许 POST 的接口白名单，其余一律 405 */
const POST_OK = { '/sync/pull': 1, '/sync/push': 1, '/mail/config': 1, '/mail/test': 1, '/mail/check': 1 };

/* ---------- 指数看板（同花顺口径的一篮子核心指数） ----------
   上证 / 深证成指 / 创业板指 / 科创50 / 北证50 / 沪深300 / 上证50 /
   中证500 / 中证1000 / 深证100 / 上证380 / 国证2000
   字段：f2 现价 f3 涨跌幅 f4 涨跌额 f6 成交额 f15 最高 f16 最低 f17 开盘 f18 昨收
------------------------------------------------------------------- */
const INDEX_SET = [
  /* A 股核心 */
  ['1.000001', '上证指数'], ['0.399001', '深证成指'], ['0.399006', '创业板指'],
  ['1.000688', '科创50'], ['0.899050', '北证50'], ['1.000300', '沪深300'],
  ['1.000016', '上证50'], ['1.000905', '中证500'], ['1.000852', '中证1000'],
  ['0.399330', '深证100'], ['1.000009', '上证380'], ['0.399303', '国证2000'],
  /* 港股 / 全球
     市场码实测（写错会静默返回 null，务必用搜索接口反查确认）：
       恒生指数 100.HSI   恒生科技 124.HSTECH   国企指数 100.HSCEI   红筹 124.HSCCI
       日经 100.N225      道琼斯 100.DJIA       纳斯达克 100.NDX     标普 100.SPX
     注意 116.HSI / 105.NDX / 100.NIXX 都是错的 */
  ['100.HSI', '恒生指数'], ['124.HSTECH', '恒生科技'],
  ['100.HSCEI', '国企指数'], ['124.HSCCI', '红筹指数'],
  ['100.N225', '日经225'], ['100.DJIA', '道琼斯'],
  ['100.NDX', '纳斯达克'], ['100.SPX', '标普500'],
  ['100.TWII', '台湾加权'], ['100.KS11', '韩国KOSPI']
];
API['/indices'] = async (res, q) => {
  /* scope=ashare 时只返回 A股指数（上证/深证/创业板/科创/北证/沪深300 等），
     排除港股与全球指数；顶部滚动条不传 scope，保留全球概览 */
  const scope = q.get('scope') || '';
  const set = scope === 'ashare'
    ? INDEX_SET.filter(([sid]) => sid.startsWith('1.') || sid.startsWith('0.'))
    : INDEX_SET;
  const ids = set.map(x => x[0]);
  /* push2 主域在部分网络下对较大量级请求会偶发「连接被重置 / 502」，
     用 push2delay 兜底（同一份行情，仅 15 分钟延时，对指数完全可接受）。 */
  let j = null;
  try {
    j = await getJSONFailover([
      `${EM}/api/qt/ulist.np/get?secids=${ids.join(',')}&fields=f2,f3,f4,f6,f12,f14,f15,f16,f17,f18&fltt=2&invt=2`,
      `${EM2}/api/qt/ulist.np/get?secids=${ids.join(',')}&fields=f2,f3,f4,f6,f12,f14,f15,f16,f17,f18&fltt=2&invt=2`
    ]);
  } catch (e) { j = null; }
  const arr = j?.data?.diff ? (Array.isArray(j.data.diff) ? j.data.diff : Object.values(j.data.diff)) : [];
  /* f12 返回的是不带市场前缀的代码，需按请求顺序回挂 secid，
     否则「000001」在详情页会被误判成平安银行 */
  const map = {};
  arr.forEach(x => { map[String(x.f12)] = x; });
  ok(res, INDEX_SET.map(([sid, fallback]) => {
    const code = sid.slice(sid.indexOf('.') + 1);
    const x = map[code];
    if (!x) return null;
    return {
      secid: sid, name: x.f14 || fallback, code,
      price: round(x.f2), change: round(x.f4), pct: round(x.f3),
      amount: round(num(x.f6) / 1e8, 2),      // 成交额（亿元）
      high: round(x.f15), low: round(x.f16),
      open: round(x.f17), preClose: round(x.f18)
    };
  }).filter(Boolean));
};

/* ---------- 批量个股行情 ---------- */
API['/quotes'] = async (res, q) => {
  const codes = (q.get('codes') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!codes.length) return ok(res, []);
  /* 市场码必须走 resolve() 判定，不能图省事用 secidOf(undefined, c)：
     那只按 A 股前缀猜（6/9/5/11 → 沪，其余 → 深），于是
       00700 → 0.00700（港股被当成深市）→ 上游认不出，整条丢弃
       NVDA  → 0.NVDA（美股被当成深市）→ 同样丢弃
     表现就是：自选股里的港股/美股查得到代码、却永远显示不出行情。
     resolve() 已经按「纯字母=美股105 / 5位数字=港股116 / 其余=A股」分好了。 */
  const ids = codes.map(c => emSecid(resolve(new URLSearchParams({ code: c })))).join(',');
  /* push2 主域在部分网络下偶发「连接被重置 / 502」，用 push2delay 兜底
     （同一份行情，仅 15 分钟延时，对自选股刷新完全可接受） */
  let j = null;
  try {
    j = await getJSONFailover([
      `${EM}/api/qt/ulist.np/get?secids=${ids}&fields=f2,f3,f4,f6,f7,f8,f12,f13,f14,f20&fltt=2&invt=2`,
      `${EM2}/api/qt/ulist.np/get?secids=${ids}&fields=f2,f3,f4,f6,f7,f8,f12,f13,f14,f20&fltt=2&invt=2`
    ]);
  } catch (e) { j = null; }
  const arr = j?.data?.diff ? (Array.isArray(j.data.diff) ? j.data.diff : Object.values(j.data.diff)) : [];
  ok(res, arr.map(x => ({
    code: String(x.f12), secid: secidOf(x.f13, x.f12), name: x.f14,
    price: round(x.f2), pct: round(x.f3), change: round(x.f4),
    turnover: round(num(x.f6) / 1e8, 2),
    amplitude: round(x.f7), rate: round(x.f8),
    mktcap: round(num(x.f20) / 1e8, 2)
  })).filter(s => s.code));
};

/* ---------- 行情排行 ---------- */
API['/ranking'] = async (res, q) => {
  const type = q.get('type') || 'change';
  const fid = { change: 'f3', turnover: 'f6', amplitude: 'f7' }[type] || 'f3';
  const fs = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';   // 沪深主板+创业板（排除ST由前端过滤）
  const arr = await clistGet(fs, fid, 'f2,f3,f4,f6,f7,f8,f12,f13,f14,f20', { pz: 40 });
  ok(res, arr.map(x => ({
    code: String(x.f12 || ''), secid: secidOf(x.f13, x.f12), name: x.f14 || '',
    price: round(x.f2), pct: round(x.f3), change: round(x.f4),
    turnover: round(num(x.f6) / 1e8, 2), volume: num(x.f5),
    amplitude: round(x.f7), rate: round(x.f8),
    mktcap: round(num(x.f20) / 1e8, 2)
  })).filter(s => s.code).slice(0, 30));
};

/* ---------- 板块资金 ---------- */
API['/sectors'] = async (res, q) => {
  const type = q.get('type') === 'concept' ? 'm:90+t:3' : 'm:90+t:2';
  const arr = await clistGet(type, 'f3', 'f2,f3,f12,f14,f62,f104,f105,f128,f136', { pz: 24 });
  ok(res, arr.map(x => ({
    name: x.f14, code: String(x.f12),
    pct: round(x.f3),
    flow: round(num(x.f62) / 1e8, 2),      // 主力净流入（元→亿）
    lead: x.f128 || '',
    leadPct: round(x.f136),
    count: num(x.f104) + num(x.f105)
  })).filter(s => s.name));
};

/* ---------- 涨跌停池 ---------- */
API['/limit'] = async (res, q) => {
  const kind = q.get('kind') || 'up';
  const date = today();
  /* 各池排序字段不同：跌停池不支持按封板时间(fbt)排序，否则返回空池 */
  const MAP = {
    up:    { ep: 'getTopicZTPool', sort: 'fbt%3Aasc' },    // 封板时间
    down:  { ep: 'getTopicDTPool', sort: 'fund%3Aasc' },   // 封单额
    break: { ep: 'getTopicZBPool', sort: 'fbt%3Aasc' }
  };
  const cfg = MAP[kind] || MAP.up;
  const url = `${EMX}/${cfg.ep}?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=40&sort=${cfg.sort}&date=${date}`;
  const j = await getJSON(url);
  const arr = j?.data?.pool || [];
  ok(res, arr.slice(0, 30).map(x => ({
    code: String(x.c || ''),
    secid: secidOf(x.m, x.c),      // 涨停池用 m 表示市场：0=深 1=沪
    name: x.n || '',
    price: round(num(x.p) / 1000),
    pct: round(x.zdp),
    turnover: round(num(x.amount) / 1e8, 2),
    seal: kind === 'break'
      ? (num(x.zbc) + '次开板')
      : ('封单 ' + round(num(x.fund) / 1e8, 2) + '亿'),
    ladder: kind === 'up' && num(x.lbc) > 1 ? num(x.lbc) + '板' : ''
  })).filter(s => s.code));
};

/* ---------- 涨跌停统计 ---------- */
API['/limit-stats'] = async (res, q) => {
  const date = today();
  const [zt, dt, zb] = await Promise.all([
    getJSON(`${EMX}/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=1&sort=fbt%3Aasc&date=${date}`).catch(() => null),
    getJSON(`${EMX}/getTopicDTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=1&sort=fund%3Aasc&date=${date}`).catch(() => null),
    getJSON(`${EMX}/getTopicZBPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=1&sort=fbt%3Aasc&date=${date}`).catch(() => null)
  ]);
  const up = num(zt?.data?.tc) || (zt?.data?.pool || []).length;
  const down = num(dt?.data?.tc) || (dt?.data?.pool || []).length;
  const brk = num(zb?.data?.tc) || (zb?.data?.pool || []).length;
  ok(res, {
    up, down, break: brk,
    ratio: up + brk > 0 ? round(up / (up + brk) * 100, 1) : 0
  });
};

/* ---------- 龙虎榜 ----------
   龙虎榜在收盘后（约18:00）才发布，因此不能写死“今天”，
   取接口返回的“最近一个已发布交易日”的数据。 */
API['/dragon'] = async (res, q) => {
  const type = q.get('type') || 'all';
  const url = `${EMD}/api/data/v1/get?reportName=RPT_DAILYBILLBOARD_DETAILSNEW&columns=ALL&pageNumber=1&pageSize=120&sortColumns=TRADE_DATE,BILLBOARD_NET_AMT&sortTypes=-1,-1&source=WEB&client=WEB`;
  const j = await getJSON(url);
  let arr = (j?.result?.data) || [];
  if (!arr.length) return ok(res, []);

  // 只保留最新交易日
  const latest = String(arr[0].TRADE_DATE || '').slice(0, 10);
  arr = arr.filter(x => String(x.TRADE_DATE || '').slice(0, 10) === latest);

  /* 机构 / 游资 过滤
     注意：是否机构参与写在 EXPLAIN 字段（如“3家机构买入”），
     EXPLANATION 只是上榜原因（如“日涨幅偏离值达到7%”）。 */
  if (type === 'inst') arr = arr.filter(x => /机构/.test(x.EXPLAIN || ''));
  if (type === 'hot') arr = arr.filter(x => !/机构/.test(x.EXPLAIN || ''));

  /* 龙虎榜只给出 MARKET("SH"/"SZ")，需映射成东财市场码 */
  const MKT = { SH: '1', SZ: '0', BJ: '0' };
  ok(res, arr.slice(0, 30).map(x => ({
    code: String(x.SECURITY_CODE || ''),
    secid: secidOf(MKT[x.MARKET], x.SECURITY_CODE),
    name: x.SECURITY_NAME_ABBR || '',
    price: round(x.CLOSE_PRICE),
    pct: round(x.CHANGE_RATE),
    net: round(num(x.BILLBOARD_NET_AMT) / 1e8, 2),
    buy: round(num(x.BILLBOARD_BUY_AMT) / 1e8, 2),
    sell: round(num(x.BILLBOARD_SELL_AMT) / 1e8, 2),
    reason: x.EXPLANATION || '',
    explain: x.EXPLAIN || ''
  })).filter(s => s.code));
};

/* ---------- 热榜（成交额榜 = 人气热度） ---------- */
API['/hot'] = async (res, q) => {
  const fs = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';
  const arr = await clistGet(fs, 'f6', 'f2,f3,f6,f8,f12,f13,f14', { pz: 24 });
  ok(res, arr.map((x, i) => ({
    code: String(x.f12 || ''),
    secid: secidOf(x.f13, x.f12),
    name: x.f14 || '',
    price: round(x.f2),
    pct: round(x.f3),
    /* 成交额（亿元）换算成人气值，越活跃越高 */
    heat: Math.round(num(x.f6) / 1e6),
    rank: i + 1,
    trend: round(x.f3) >= 0 ? 1 : -1
  })).filter(s => s.code).slice(0, 24));
};

/* ---------- 资讯：多渠道快讯聚合（东方财富 + 同花顺 + 新浪）----------
   东财 7×24 快讯 getlist_{id}（按地域/栏目划分）：
     101 证券要闻  102 宏观财经  103 个股公告  104 A股综合  105 综合
     106 宏观国际  107 外汇     108 债券      109 ETF/异动
     111 美国      114 日韩     118 国内政策  125 中国经济数据
     119 美联储/华尔街  126 美国经济数据
   注意：东财接口返回 `var ajaxResult={...}` 而非纯 JSON，必须先剥前缀再 parse。
   同花顺快讯 /tapp/news/push/stock/（data.list，ctime 为 unix 秒）、
   新浪财经滚动快讯 feed.mix.sina.com.cn/api/roll/get（result.data，ctime 为 unix 秒）。
   三源并行抓取后在服务端按「分类 tab + 关键词 + 来源 + 跨源去重」统一过滤。 */
const POLITICAL = /中共中央|政治局|总书记|国家主席|国务院总理|委员长|军委|全国人大|全国政协|外交部|国防部|统战部|中央会议|视察|考察调研/;
const NEWS_FEEDS = {
  all:   { ids: [101, 102, 103, 104, 105, 106], tag: '财经要闻' },
  a:     { ids: [101, 103, 104, 109, 118, 125], tag: 'A股' },
  us:    { ids: [111, 119, 126], tag: '美股' },
  hk:    { ids: [101, 102, 103, 104, 105, 106, 107, 109, 111, 114, 118, 119, 125], tag: '港股' },
  alert: { ids: [109, 101, 103, 104], tag: '异动' }
};
const NEWS_KW = {
  hk: /港股|恒生|港交所|南向|港股通|H股|北水|深港通|沪港通|中概股|中概|赴港上市|回归港股/,
  alert: /涨停|跌停|异动|拉升|跳水|封板|涨超|跌超|创新高|创新低|龙虎榜|大涨|大跌|刷新|逼近/,
  us: /美股|纳斯达克|道琼斯|标普|纽交所|美联储|非农|华尔街|美国/
};
const NEWS_SRCS = ['东方财富', '同花顺', '新浪财经'];

/* 文本归一化（跨源去重用） */
function nz(s) { return String(s || '').toLowerCase().replace(/\s+/g, ''); }

/* 东方财富 7×24 单栏目 */
async function kxFeed(id) {
  const txt = await getJSON_Text(
    `https://newsapi.eastmoney.com/kuaixun/v1/getlist_${id}_ajaxResult_20_1_.html`,
    { Referer: 'https://kuaixun.eastmoney.com/' });
  const body = txt.replace(/^\s*var\s+ajaxResult\s*=\s*/, '').replace(/;?\s*$/, '');
  let j;
  try { j = JSON.parse(body); } catch (e) { return []; }
  return j?.LivesList || [];
}

/* 同花顺快讯（7×24）：data.list 为数组，ctime 是 unix 秒 */
async function thsFeed() {
  const txt = await getJSON_Text(
    'https://news.10jqka.com.cn/tapp/news/push/stock/?page=1&tag=&track=website&pagesize=50',
    { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://news.10jqka.com.cn/' });
  let j; try { j = JSON.parse(txt); } catch (e) { return []; }
  const list = j?.data?.list || [];
  return list.map(x => ({
    src: '同花顺',
    key: String(x.seq || x.id || ''),
    title: String(x.title || '').trim(),
    summary: String(x.digest || x.short || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    time: Number(x.ctime) ? new Date(Number(x.ctime) * 1000).toISOString() : new Date().toISOString(),
    url: x.url || x.shareUrl || x.appUrl || ''
  })).filter(x => x.title);
}

/* 新浪财经滚动快讯：result.data 为数组，ctime 是 unix 秒 */
async function sinaFeed() {
  const txt = await getJSON_Text(
    'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&k=&num=30&page=1',
    { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' });
  let j; try { j = JSON.parse(txt); } catch (e) { return []; }
  const list = j?.result?.data || [];
  return list.map(x => ({
    src: '新浪财经',
    key: String(x.docid || x.url || ''),
    title: String(x.title || '').trim(),
    summary: String(x.summary || x.intro || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    time: Number(x.ctime) ? new Date(Number(x.ctime) * 1000).toISOString() : new Date().toISOString(),
    url: x.url || x.wapurl || ''
  })).filter(x => x.title);
}

API['/news'] = async (res, q) => {
  const tab = NEWS_FEEDS[q.get('tab')] ? q.get('tab') : 'all';
  const cfg = NEWS_FEEDS[tab];
  const kw = NEWS_KW[tab] || null;
  const src = NEWS_SRCS.includes(q.get('src')) ? q.get('src') : 'all';

  /* 东财多栏目 + 同花顺 + 新浪 并行抓取 */
  const [emLists, ths, sina] = await Promise.all([
    mapLimit(cfg.ids, 4, id => kxFeed(id).catch(() => [])),
    thsFeed().catch(() => []),
    sinaFeed().catch(() => [])
  ]);

  const raw = [];
  /* 东方财富 */
  emLists.forEach(arr => (arr || []).forEach(x => {
    const text = String(x.digest || '') + ' ' + String(x.title || '');
    if (!text.trim()) return;
    const m = String(x.digest || '').match(/^【([^】]*)】([\s\S]*)$/);
    raw.push({
      src: '东方财富',
      key: String(x.id || x.newsid || ''),
      title: m ? m[1] : String(x.title || x.digest || '').slice(0, 40),
      summary: (m ? m[2] : String(x.digest || '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120),
      time: String(x.showtime || '').replace(' ', 'T') || new Date().toISOString(),
      url: x.url_unique || x.url_w || ''
    });
  }));
  /* 同花顺 + 新浪 */
  raw.push(...ths, ...sina);

  /* 过滤 + 跨源去重：同一事件的快讯只保留一条，但把各来源都记入 sources，
     前端按渠道着色展示，来源筛选按 sources 集合匹配（而非首源） */
  const seen = {};
  const rows = [];
  raw.forEach(x => {
    const t = (x.title || '') + ' ' + (x.summary || '');
    if (!t.trim()) return;
    if (POLITICAL.test(t)) return;
    if (kw && !kw.test(t)) return;
    const dk = nz(x.title) + '|' + nz(x.summary).slice(0, 40);
    if (seen[dk]) {
      /* 同源内重复直接忽略；跨源重复则合并来源，不丢渠道 */
      if (!seen[dk].sources.includes(x.src)) seen[dk].sources.push(x.src);
      return;
    }
    const item = {
      id: x.key || dk,
      title: x.title,
      summary: x.summary.slice(0, 140),
      tag: cfg.tag,
      source: x.src,
      sources: [x.src],
      time: x.time,
      url: x.url
    };
    seen[dk] = item;
    rows.push(item);
  });

  /* 来源筛选：按 sources 集合匹配 */
  const filtered = src === 'all' ? rows : rows.filter(r => r.sources.includes(src));
  filtered.sort((a, b) => String(b.time).localeCompare(String(a.time)));
  let list;
  if (src !== 'all') {
    list = filtered.slice(0, 40);
  } else {
    /* 默认「全部来源」视图：跨源轮转，保证每个渠道都有露出，
       最后仍按时间倒序排列（东财量大但同花顺/新浪的独立快讯不会被完全挤掉） */
    const buckets = {};
    filtered.forEach(r => { (buckets[r.source] = buckets[r.source] || []).push(r); });
    const lists = Object.keys(buckets).map(k => buckets[k]);
    const out = []; let added = true;
    while (out.length < 40 && added) {
      added = false;
      for (const l of lists) { if (l.length && out.length < 40) { out.push(l.shift()); added = true; } }
    }
    out.sort((a, b) => String(b.time).localeCompare(String(a.time)));
    list = out;
  }
  ok(res, { tab, tag: cfg.tag, sources: NEWS_SRCS, src, list });
};

/* ---------- 美股 ---------- */
API['/us'] = async (res, q) => {
  const kind = q.get('kind') || 'tech';
  if (kind === 'index') {
    /* 实测东财无 100.VIX / 100.RUI，请求它们会静默丢数据，只保留已验证的三个 */
    const ids = ['100.DJIA', '100.NDX', '100.SPX'];
    const j = await getJSON(`${EM}/api/qt/ulist.np/get?secids=${ids.join(',')}&fields=f2,f3,f4,f12,f14&fltt=2&invt=2`);
    const arr = j?.data?.diff ? (Array.isArray(j.data.diff) ? j.data.diff : Object.values(j.data.diff)) : [];
    return ok(res, arr.map(x => ({
      code: String(x.f12), secid: '100.' + x.f12, name: x.f14 || String(x.f12),
      price: round(x.f2), change: round(x.f4), pct: round(x.f3), mktcap: 0
    })));
  }
  // 科技股：纳斯达克市值前列
  const arr = await clistGet('m:105', 'f20', 'f2,f3,f4,f12,f13,f14,f20', { pz: 30 });
  ok(res, arr.map(x => ({
    code: String(x.f12 || ''), secid: secidOf(x.f13, x.f12), name: x.f14 || '',
    price: round(x.f2), pct: round(x.f3), change: round(x.f4),
    mktcap: round(num(x.f20) / 1e8, 2)
  })).filter(s => s.code).slice(0, 20));
};

/* ---------- 搜索 ---------- */
API['/search'] = async (res, q) => {
  const kw = (q.get('q') || '').trim();
  if (!kw) return ok(res, []);
  const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(kw)}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=20`;
  const j = await getJSON(url);
  const arr = j?.QuotationCodeTable?.Data || [];

  /* type=14 是【全市场】模糊搜索，一次把 A股 / 港股 / 美股 / 韩股 / 债券 /
     场外基金 / 指数全塞回来。接口没有"只给某市场"的入参，只能靠
     Classify 白名单 + 代码格式双重过滤。

     旧版只留 AStock，于是站内明明有美股、港股两个模块，
     搜「NVDA」「00700」却是空的——上游其实返回了，被这里滤掉了。

     反过来，光靠 Classify 也不够：搜「00700」时上游会同时给出
       00700  Classify=HK        → 腾讯控股（要）
       000700 Classify=KRX       → 韩国 Eusu Holdings（不要）
       000700 Classify=OTCFUND   → 某货币基金（不要）
     后两个的代码同样是数字，只有格式校验能区分（港股是 5 位）。 */
  const ALLOW = {
    AStock:  { re: /^\d{6}$/, mkt: 'A股' },                        // 沪深 A 股
    HK:      { re: /^\d{5}$/, mkt: '港股' },                        // 港股
    UsStock: { re: /^[A-Za-z][A-Za-z0-9.\-]{0,7}$/, mkt: '美股' }   // 美股 / 美股 ETF
  };
  const list = arr
    .filter(x => {
      const rule = ALLOW[x.Classify];
      return rule && rule.re.test(String(x.Code || ''));
    })
    .slice(0, 12);
  if (!list.length) return ok(res, []);

  /* 接口自带 QuoteID（形如 "0.000001"）即完整 secid，无需自行拼市场码 */
  const sidOf = x => x.QuoteID || secidOf(x.MktNum, x.Code);
  const ids = list.map(sidOf).join(',');
  let priceMap = {};
  try {
    const q2 = await getJSON(`${EM}/api/qt/ulist.np/get?secids=${ids}&fields=f2,f3,f12,f13&fltt=2&invt=2`);
    const d = q2?.data?.diff ? (Array.isArray(q2.data.diff) ? q2.data.diff : Object.values(q2.data.diff)) : [];
    /* 按 secid 建索引而不是按 code：跨市场代码会撞车
       （000700 既是 A 股模塑科技，上游也会把它当韩股返回），
       按 code 建索引会让美股/港股串到 A 股的价格上 */
    d.forEach(x => { priceMap[secidOf(x.f13, x.f12)] = { price: round(x.f2), pct: round(x.f3) }; });
  } catch (e) {}

  ok(res, list.map(x => {
    const sid = x.QuoteID || secidOf(x.MktNum, x.Code);
    const p = priceMap[sid] || {};
    return {
      code: String(x.Code),
      secid: sid,
      name: x.Name,
      mkt: (ALLOW[x.Classify] || {}).mkt || '',
      price: p.price ?? 0, pct: p.pct ?? 0
    };
  }));
};

/* ---------- 个股详情快照 ----------
   push2 stock/get 的金额类字段是「放大 10^decimal 倍」的整数，
   必须按 f59（小数位）缩放后才能使用。 */
/* 个股快照：腾讯(主) → 东财(备)
   东财 push2/api/qt/stock/get 已不可用（返回空），腾讯 qt.gtimg.cn 稳定且字段更全 */
async function getText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://gu.qq.com/' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return new TextDecoder('gbk').decode(Buffer.from(await r.arrayBuffer()));
}
async function detailTX(r) {
  const txt = await getText(`https://qt.gtimg.cn/q=${txSymOf(r)}`);
  const m = txt.match(/="([\s\S]*?)"\s*;?\s*$/m);
  if (!m) throw new Error('腾讯快照解析失败');
  const a = m[1].split('~');
  if (!a[3]) throw new Error('腾讯快照无行情');
  const n = i => num(a[i]);
  return {
    code: a[2] || r.code, name: (a[1] || '').replace(/\s+/g, ''),
    secid: emSecid(r),
    price: num(a[3]), preClose: num(a[4]), open: num(a[5]),
    high: n(33), low: n(34), avg: n(51),
    change: n(31), pct: n(32), amplitude: n(43),
    volume: n(36), turnover: round(n(37) / 1e4, 2),   // 万元 → 亿元
    rate: n(38), volRatio: n(49),
    floatCap: n(44), mktcap: n(45), pb: n(46),
    limitUp: n(47), limitDown: n(48),
    pe: n(39), peStatic: n(53)
  };
}
async function detailEM(r) {
  const url = `${EM}/api/qt/stock/get?secid=${emSecid(r)}&fields=f43,f44,f45,f46,f47,f48,f50,f51,f52,f57,f58,f59,f60,f116,f117,f162,f167,f168,f169,f170,f171,f86`;
  const j = await getJSON(url);
  const d = j?.data;
  if (!d || !d.f58) throw new Error('东财未查询到该标的');
  const dec = Math.pow(10, num(d.f59));
  const p = v => (v === '-' || v === null || v === undefined) ? 0 : round(num(v) / dec, 2);
  const r100 = v => (v === '-' || v === null || v === undefined) ? 0 : round(num(v) / 100, 2);
  return {
    code: String(d.f57 || r.code), name: d.f58, secid: emSecid(r), price: p(d.f43),
    high: p(d.f44), low: p(d.f45), open: p(d.f46), preClose: p(d.f60),
    limitUp: p(d.f51), limitDown: p(d.f52),
    change: p(d.f169 === undefined ? (num(d.f43) - num(d.f60)) / 1 : d.f169),
    pct: r100(d.f170), amplitude: r100(d.f171),
    volume: num(d.f47), turnover: round(num(d.f48) / 1e8, 2),
    rate: r100(d.f168), volRatio: r100(d.f50),
    mktcap: round(num(d.f116) / 1e8, 2), floatCap: round(num(d.f117) / 1e8, 2),
    pe: r100(d.f162), pb: r100(d.f167), avg: 0, peStatic: 0
  };
}
API['/detail'] = async (res, q) => {
  const r = resolve(q);
  if (!r.code) return fail(res, '缺少 code 参数', 400);
  try {
    return ok(res, await detailTX(r));
  } catch (e1) {
    try { return ok(res, await detailEM(r)); }
    catch (e2) { return fail(res, '行情源不可用: ' + e2.message); }
  }
};

/* ---------- K 线 ----------
   period: day / week / month / 5 / 15 / 30 / 60（分钟） */
API['/kline'] = async (res, q) => {
  const r = resolve(q);
  if (!r.code) return fail(res, '缺少 code 参数', 400);
  const code = r.code;
  const period = q.get('period') || 'day';
  const limit = Math.min(parseInt(q.get('limit') || '120', 10) || 120, 500);
  /* D1：fq 透传 —— qfq(默认，看盘用) / hfq(回测与指标计算用) / '' */
  const fqRaw = (q.get('fq') || 'qfq').toLowerCase();
  const fq = fqRaw === 'hfq' ? 'hfq' : (fqRaw === 'none' || fqRaw === '0' ? '' : 'qfq');
  const FQT = { '': 0, qfq: 1, hfq: 2 }[fq];   // 东财兜底用的 fqt 映射

  const KLT = { day: 101, week: 102, month: 103, '5': 5, '15': 15, '30': 30, '60': 60 };
  const klt = KLT[period] || 101;
  const isMinute = [5, 15, 30, 60].indexOf(klt) > -1;
  const isUS = r.mkt === '105' || r.mkt === '106' || r.mkt === '107';

  /* 统一结构：{ name, code, preClose, klines:[{t,o,c,h,l,v}] } */
  const shape = (name, list) => ({
    name: name || '', code,
    preClose: list.length > 1 ? num(list[list.length - 2].c) : 0,
    klines: list
  });

  async function txBest(p) {
    const base = txSymOf(r);
    let arr = await txKline(base, p, limit, fq).catch(() => []);
    if (isUS && arr.length < 5) {
      for (const suf of US_SUFFIX) {
        const tryArr = await txKline(base + suf, p, limit, fq).catch(() => []);
        if (tryArr.length > arr.length) arr = tryArr;
        if (arr.length >= 5) break;
      }
    }
    return arr;
  }

  // 1) 腾讯：日 / 周 / 月（分钟周期不支持）
  if (!isMinute) {
    const p = { day: 'day', week: 'week', month: 'month' }[period] || 'day';
    const arr = await txBest(p);
    if (arr.length) {
      const list = arr.map(a => ({
        t: a[0], o: num(a[1]), c: num(a[2]), h: num(a[3]), l: num(a[4]), v: num(a[5])
      }));
      const nm = (await detailTX(r).catch(() => ({ name: '' }))).name;
      return ok(res, shape(nm, list));
    }
  }

  // 2) 新浪：A股全周期（分钟用 scale=5/15/30/60，日线 240）；不支持美股
  if (!isUS) {
    try {
      const scale = { day: 240, week: 1200, month: 7200, '5': 5, '15': 15, '30': 30, '60': 60 }[period] || 240;
      const sym = txSymOf(r);
      const j = await getJSON(`https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sym}&scale=${scale}&ma=no&datalen=${limit}`,
        { Referer: 'https://finance.sina.com.cn/' });
      if (Array.isArray(j) && j.length) {
        const list = j.map(x => ({
          t: x.day, o: num(x.open), c: num(x.close), h: num(x.high), l: num(x.low), v: num(x.volume)
        }));
        const nm = (await detailTX(r).catch(() => ({ name: '' }))).name;
        return ok(res, shape(nm, list));
      }
    } catch (e) { /* 落到东财 */ }
  }

  // 3) 东财兜底
  try {
    /* 东财兜底：fqt 0=不复权 1=前复权 2=后复权（与腾讯 fq 一一对应） */
    const url = `${EMH}/api/qt/stock/kline/get?secid=${emSecid(r)}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=${klt}&fqt=${FQT}&end=20500101&lmt=${limit}`;
    const j = await getJSON(url);
    const d = j?.data;
    if (d && Array.isArray(d.klines) && d.klines.length) {
      return ok(res, {
        name: d.name || '', code: String(d.code || code), preClose: num(d.preKPrice) || 0,
        klines: d.klines.map(s => {
          const a = String(s).split(',');
          return { t: a[0], o: num(a[1]), c: num(a[2]), h: num(a[3]), l: num(a[4]), v: num(a[5]) };
        })
      });
    }
  } catch (e) { /* 忽略 */ }

  ok(res, shape('', []));
};

/* ---------- 分时 ---------- */
API['/minute'] = async (res, q) => {
  const r = resolve(q);
  if (!r.code) return fail(res, '缺少 code 参数', 400);
  /* push2his 主域偶发抖动/限流，依次回退到 push2 主域、push2delay 镜像，
     任一成功即返回；全部失败也降级为空数据（不再抛 502 让前端报错） */
  const mk = (host) => `${host}/api/qt/stock/trends2/get?secid=${emSecid(r)}&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f53,f56,f57,f58&iscr=0&ndays=1`;
  let j = null;
  try {
    j = await getJSONFailover([mk(EMH), mk(EM), mk(EM2)]);
  } catch (e) { j = null; }
  const d = j?.data;
  if (!d || !Array.isArray(d.trends)) return ok(res, { name: '', code: r.code, preClose: 0, points: [] });

  ok(res, {
    name: d.name || '',
    code: String(d.code || r.code),
    preClose: num(d.preClose) || 0,
    points: d.trends.map(s => {
      const a = String(s).split(',');
      return {
        t: (a[0] || '').slice(11, 16),   // HH:MM
        p: num(a[1]),                     // 价格
        v: num(a[2]),                     // 成交量（手）
        amt: num(a[3]) || 0,              // 成交额（元）
        avg: num(a[4])                    // 均价
      };
    })
  });
};

/* ---------- 全球指数（顶部滚动条） ---------- */
const GLOBAL_IDX = [
  ['1.000001', '上证指数'], ['0.399001', '深证成指'], ['0.399006', '创业板指'],
  ['1.000300', '沪深300'], ['1.000688', '科创50'], ['0.399005', '中小100'],
  ['100.HSI', '恒生指数'], ['100.TWII', '台湾加权'], ['100.N225', '日经225'],
  ['100.KS11', '韩国综合'], ['100.SENSEX', '印度SENSEX'], ['100.STI', '新加坡海峡'],
  ['100.DJIA', '道琼斯'], ['100.NDX', '纳斯达克100'], ['100.SPX', '标普500'],
  ['100.GDAXI', '德国DAX'], ['100.FTSE', '英国富时100']
];
API['/global'] = async (res, q) => {
  const secids = GLOBAL_IDX.map(x => x[0]).join(',');
  const j = await getJSON(`${EM}/api/qt/ulist.np/get?secids=${secids}&fields=f2,f3,f4,f12,f14&fltt=2&invt=2`);
  const src = j?.data?.diff ? (Array.isArray(j.data.diff) ? j.data.diff : Object.values(j.data.diff)) : [];
  const map = {};
  src.forEach(x => { map[String(x.f12)] = x; });
  ok(res, GLOBAL_IDX.map(([sid, name]) => {
    const code = sid.slice(sid.indexOf('.') + 1);
    const x = map[code] || {};
    return { secid: sid, code, name: x.f14 || name, price: round(x.f2), pct: round(x.f3), change: round(x.f4) };
  }));
};

/* ---------- 高抛低吸信号 ----------
   口径：分时价格相对均价线的偏离率 dev=(价-均价)/均价
   阈值按个股日内波动自适应：th = max(0.4%, 1.2σ)
   偏离上穿 th 后回落至 th/2 → 高抛；下穿 -th 后回升至 -th/2 → 低吸
   记录触发时刻（极值点），并附该时刻的价格与偏离幅度
------------------------------------------------------------------- */
API['/signal'] = async (res, q) => {
  const r = resolve(q);
  if (!r.code) return fail(res, '缺少 code 参数', 400);
  const code = r.code;
  const url = `${EMH}/api/qt/stock/trends2/get?secid=${emSecid(r)}&fields1=f1,f2,f3,f4,f5,f7&fields2=f51,f53,f56,f58&iscr=0&ndays=1`;
  const j = await getJSON(url);
  const d = j?.data;
  if (!d || !Array.isArray(d.trends) || !d.trends.length) {
    return ok(res, { code, name: d?.name || '', threshold: 0, high: [], low: [], points: [] });
  }

  const pts = d.trends.map(s => {
    const a = String(s).split(',');
    return { t: (a[0] || '').slice(11, 16), p: num(a[1]), avg: num(a[3]) };
  }).filter(p => p.p > 0);

  const devs = pts.map(p => (p.avg > 0 ? (p.p - p.avg) / p.avg * 100 : 0));
  const mean = devs.reduce((a, b) => a + b, 0) / (devs.length || 1);
  const sd = Math.sqrt(devs.reduce((a, b) => a + (b - mean) ** 2, 0) / (devs.length || 1));
  const th = Math.max(0.4, sd * 1.2);

  const high = [], low = [];
  let armed = 0, ext = 0, extP = 0, extT = '';
  pts.forEach((p, i) => {
    const dv = devs[i];
    if (armed === 0 && dv >= th) { armed = 1; ext = dv; extP = p.p; extT = p.t; }
    else if (armed === 1) {
      if (dv > ext) { ext = dv; extP = p.p; extT = p.t; }
      if (dv < th * 0.5) { high.push({ t: extT, price: round(extP), dev: round(ext) }); armed = 0; }
    }
    if (armed === 0 && dv <= -th) { armed = -1; ext = dv; extP = p.p; extT = p.t; }
    else if (armed === -1) {
      if (dv < ext) { ext = dv; extP = p.p; extT = p.t; }
      if (dv > -th * 0.5) { low.push({ t: extT, price: round(extP), dev: round(ext) }); armed = 0; }
    }
  });

  ok(res, {
    code: String(d.code || code),
    name: d.name || '',
    threshold: round(th),
    high, low,
    points: pts.map((p, i) => ({ t: p.t, p: round(p.p), avg: round(p.avg), dev: round(devs[i]) }))
  });
};

/* ===================================================================
   静态文件
   =================================================================== */
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
API['/sync/pull'] = syncPull;
API['/sync/push'] = syncPush;

/* ===================================================================
   新增：对标参考站的 11 个股票页
   =================================================================== */

/* ---------- 股票排行：市场 × 维度 ----------
   市场：all 全部A股 / sh 沪A / sz 深A / cyb 创业板 / kcb 科创板 / bj 北交所
   维度：changePct 涨幅 / changePctD 跌幅 / amount 成交额 / turnover 换手
        volumeRatio 量比 / amplitude 振幅 / mainNetInflow 主力净流入 / pe 市盈率 */
const RANK_MKT = {
  all: 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23',
  sh:  'm:1+t:2,m:1+t:23',
  sz:  'm:0+t:6,m:0+t:80',
  cyb: 'm:0+t:80',
  kcb: 'm:1+t:23',
  bj:  'm:0+t:81+s:2048'
};
const RANK_DIM = {
  changePct:     { fid: 'f3',  po: 1 },
  changePctD:    { fid: 'f3',  po: 0 },
  amount:        { fid: 'f6',  po: 1 },
  turnover:      { fid: 'f8',  po: 1 },
  volumeRatio:   { fid: 'f10', po: 1 },
  amplitude:     { fid: 'f7',  po: 1 },
  mainNetInflow: { fid: 'f62', po: 1 },
  pe:            { fid: 'f9',  po: 0 }
};
API['/rank'] = async (res, q) => {
  const mkt = RANK_MKT[q.get('mkt')] ? q.get('mkt') : 'all';
  const dim = RANK_DIM[q.get('dim')] ? q.get('dim') : 'changePct';
  const { fid, po } = RANK_DIM[dim];
  const pz = Math.min(100, Math.max(10, parseInt(q.get('limit')) || 50));
  const arr = await clistGet(RANK_MKT[mkt], fid,
    'f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f20,f23,f62', { po, pz });
  ok(res, arr.map(x => ({
    code: String(x.f12 || ''),
    secid: secidOf(x.f13, x.f12),
    name: x.f14 || '',
    price: round(x.f2),
    pct: round(x.f3),
    change: round(x.f4),
    amount: round(num(x.f6) / 1e8, 4),        // 成交额（亿元）
    amplitude: round(x.f7),
    turnover: round(x.f8),                    // 换手率 %
    pe: round(x.f9),
    volumeRatio: round(x.f10),                // 量比
    pb: round(x.f23),
    mktcap: round(num(x.f20) / 1e8, 2),       // 总市值（亿元）
    mainNetInflow: round(num(x.f62) / 1e8, 4) // 主力净流入（亿元）
  })).filter(s => s.code));
};

/* ---------- 全市场统计：涨跌家数 / 成交额 / 主力净流入 / 涨幅 TOP10 ----------
   东财 clist 的 pz 硬上限是 100（传 6000 也只回 100 条），要覆盖全市场 5500+ 只
   必须翻 56 页。串行要 8.6 秒，这里用并发 6 + 60 秒缓存，首次约 1.5 秒。 */
const A_SHARE_FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';
const MST_CACHE = { t: 0, data: null };
/* 慢层（主力净流入合计）翻 56 页成本高、且变化慢，缓存放宽到 5 分钟。
   配合定时预热后，用户请求基本永远命中热缓存。 */
const MST_TTL = 300000;

/* 快层（原「快速模式」升级）：约 6 个请求，亚秒级返回除主力净流入合计外的全部指标。
   涨跌家数取指数自带统计字段 f104/f105/f106（上证 + 深证求和），
   成交额取两市 f6 之和，各维度 TOP10 用「按该字段排序的第一页」直接得到。
   只有主力净流入合计必须翻全量 —— 交给慢层 marketStatFull 后台补齐。 */
const F_TOP = 'f2,f3,f6,f12,f13,f14,f62';
async function marketStatFast() {
  const idx = await getJSON(`${EM}/api/qt/ulist.np/get` +
    `?secids=1.000001,0.399001&fields=f6,f12,f14,f104,f105,f106&fltt=2&invt=2`);
  const d = idx?.data?.diff;
  const arr = d ? (Array.isArray(d) ? d : Object.values(d)) : [];
  let up = 0, down = 0, flat = 0, amount = 0;
  arr.forEach(x => {
    up += num(x.f104); down += num(x.f105); flat += num(x.f106);
    amount += num(x.f6);
  });
  const valid = up + down + flat;
  const pctOf = n => valid ? round(n * 100 / valid, 1) : 0;

  /* 各维度 TOP10：每个维度只需 1 个「按该字段排序的第一页」请求（共 5 个，并发）。
     这是「快慢分层」的核心 —— 翻 56 页只为算主力净流入合计，
     涨跌家数 / 成交额 / 各维度 TOP10 都不需要全量。 */
  const [rUp, rDown, rAmt, rIn, rOut] = await Promise.all([
    clistPage(A_SHARE_FS, 'f3',  F_TOP, { po: 1, pz: 10, pn: 1 }).catch(() => ({ total: 0, arr: [] })),
    clistPage(A_SHARE_FS, 'f3',  F_TOP, { po: 0, pz: 10, pn: 1 }).catch(() => ({ total: 0, arr: [] })),
    clistPage(A_SHARE_FS, 'f6',  F_TOP, { po: 1, pz: 10, pn: 1 }).catch(() => ({ total: 0, arr: [] })),
    clistPage(A_SHARE_FS, 'f62', F_TOP, { po: 1, pz: 10, pn: 1 }).catch(() => ({ total: 0, arr: [] })),
    clistPage(A_SHARE_FS, 'f62', F_TOP, { po: 0, pz: 10, pn: 1 }).catch(() => ({ total: 0, arr: [] }))
  ]);

  const mk = (r) => (r.arr || []).slice(0, 10).map((x, i) => ({
    rank: i + 1, name: String(x.f14 || ''), code: String(x.f12 || ''),
    secid: secidOf(x.f13, x.f12), price: round(x.f2),
    pct: round(x.f3), amount: round(num(x.f6) / 1e8, 2), flow: round(num(x.f62) / 1e8, 2)
  }));
  const topUp = mk(rUp);
  const topDown = mk(rDown);
  const topAmt = mk(rAmt);
  const topFlowIn = mk(rIn);
  const topFlowOut = mk(rOut);
  /* 平盘抽样：涨幅升序首页里取 pct 恰为 0 的项（平盘榜本就是抽样展示） */
  const topFlat = (rDown.arr || []).filter(x => num(x.f3) === 0).slice(0, 10).map((x, i) => ({
    rank: i + 1, name: String(x.f14 || ''), code: String(x.f12 || ''),
    secid: secidOf(x.f13, x.f12), price: round(x.f2),
    pct: round(x.f3), amount: round(num(x.f6) / 1e8, 2), flow: round(num(x.f62) / 1e8, 2)
  }));

  return {
    total: rUp.total || valid,
    sample: valid,
    up, down, flat,
    upPct: pctOf(up), downPct: pctOf(down), flatPct: pctOf(flat),
    amount: round(amount / 1e12, 3),
    amountYi: round(amount / 1e8, 2),
    mainFlow: null,                 // 需全量翻页，由慢层补齐
    top10: topUp,                   // 兼容旧字段名
    topUp, topDown, topAmt, topFlowIn, topFlowOut, topFlat,
    suspend: null,                  // 指数字段无法区分停牌，置 null 表示未知
    source: 'em',                   // 数据来源：em=东方财富 / ths=同花顺
    partial: true,                  // mainFlow 尚未就绪
    updatedAt: new Date().toISOString()
  };
}

/* 精确统计（翻 ~56 页）抽成独立函数，供 SWR 后台静默刷新复用 */
async function marketStatFull() {
  const F = 'f2,f3,f6,f12,f13,f14,f62';
  const first = await clistPage(A_SHARE_FS, 'f3', F, { po: 1, pz: 100, pn: 1 });
  const total = first.total || 0;
  const pages = Math.min(60, Math.ceil(total / 100));

  const rows = first.arr.slice();
  if (pages > 1) {
    const pns = [];
    for (let p = 2; p <= pages; p++) pns.push(p);
    /* 并发从 6 降到 3：56 个请求会长时间占满全局闸门，
       降低并发可减少对前台交互请求（个股详情、板块切换）的抢占 */
    const rest = await mapLimit(pns, 3, pn =>
      clistPage(A_SHARE_FS, 'f3', F, { po: 1, pz: 100, pn }).catch(() => null));
    rest.forEach(r => { if (r && r.arr) rows.push(...r.arr); });
  }

  let up = 0, down = 0, flat = 0, amount = 0, flow = 0, valid = 0, suspend = 0;
  rows.forEach(x => {
    /* f3 为空 / '-' 通常是停牌或未报价。此前直接 return 静默跳过，
       导致东财口径（sample=5209）与同花顺（全部计入，sample=5566）的涨跌家数
       对不上、且无法解释差额。这里改为单独计数并回传，由前端明示这部分。 */
    if (x.f3 == null || x.f3 === '-') { suspend++; return; }
    const p = num(x.f3);
    valid++;
    if (p > 0) up++; else if (p < 0) down++; else flat++;
    amount += num(x.f6);
    flow += num(x.f62);
  });

  /* 慢层只回传「必须全量翻页才能得到」的字段：
     涨跌家数 / 成交额 / 各维度 TOP10 均由快层提供，路由层负责合并，
     这里不再对 5500 条数据重复排序 6 次算 TOP10（省 CPU）。 */
  return {
    mainFlow: round(flow / 1e8, 2),
    suspend,
    sample: valid,
    total,
    partial: false,
    updatedAt: new Date().toISOString()
  };
}

/* 快速模式结果缓存：原实现无缓存，前端每 20 秒刷新都会真实打上游 2 个请求 */
const MST_FAST_CACHE = { t: 0, data: null };
const MST_FAST_TTL = 15000;
let mstRefreshing = false;   // 防止并发触发多次后台全量刷新

API['/market-stat'] = async (res, q) => {
  const now = Date.now();

  /* ---- 快速模式：15 秒缓存，上游失败时用旧值兜底 ---- */
  if (q.get('mode') === 'fast') {
    if (MST_FAST_CACHE.data && now - MST_FAST_CACHE.t < MST_FAST_TTL) {
      return ok(res, MST_FAST_CACHE.data);
    }
    try {
      const d = await marketStatFast();
      MST_FAST_CACHE.data = d; MST_FAST_CACHE.t = Date.now();
      return ok(res, d);
    } catch (e) {
      if (MST_FAST_CACHE.data) return ok(res, MST_FAST_CACHE.data);
      throw e;
    }
  }

  /* ---- 完整层 = 快层（准实时）+ 慢层（缓存的主力净流入 / 停牌数）----
     慢层要翻 56 页（实测约 7 秒），绝不能让用户等：
     这里先用快层立刻响应，慢层结果由后台刷新后并入。 */
  const quick = (MST_FAST_CACHE.data && now - MST_FAST_CACHE.t < MST_FAST_TTL)
    ? MST_FAST_CACHE.data
    : await marketStatFast().catch(() => null);
  if (!quick) return fail(res, '行情源不可用，请稍后重试');

  const slow = MST_CACHE.data;
  ok(res, Object.assign({}, quick, slow || {}, {
    /* 慢层还没算出主力净流入时，前端显示「精确统计中…」 */
    partial: !(slow && slow.mainFlow != null)
  }));

  /* 后台刷新慢层，不阻塞上面的响应 */
  if (!mstRefreshing && (!slow || now - MST_CACHE.t > MST_TTL)) {
    mstRefreshing = true;
    marketStatFull()
      .then(d => { MST_CACHE.data = d; MST_CACHE.t = Date.now(); })
      .catch(() => {})
      .finally(() => { mstRefreshing = false; });
  }
};

/* ---------- 同花顺（fuyao.aicubes.cn）代理：市场统计 + 指数快照 ----------
   对标同花顺 A股市场页数据，作为「权威基准」对齐涨跌家数/成交额/主力净流入。
   未配置 FY_API_KEY 时自动降级返回 null，前端回退到东财源。 */
const FY_CACHE = { t: 0, stat: null, idx: null };
const FY_TTL = 300000;  // 实测同花顺约 20 秒/次限流，缓存放宽到 5 分钟，避免把密钥打废

/* 同花顺限流实测：约 20 秒/次，连续请求直接返回 429（request limit exceeded）。
   所有 fuyao 请求串行排队 + 最小间隔 + 429 指数退避，避免把密钥打废。 */
const FY_GAP = 20000;
let fyLast = 0;
let fyChain = Promise.resolve();
const fyDelay = ms => new Promise(r => setTimeout(r, ms));

async function fyGetRaw(fyPath) {
  const hdrs = { 'X-api-key': FY_KEY, 'User-Agent': UA };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(FY + fyPath, { signal: ctrl.signal, headers: hdrs });
    clearTimeout(timer);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (j.code === 429) { const e = new Error('fuyao 429 rate limited'); e.fy429 = true; throw e; }
    if (j.code !== 0 && j.code !== 200) throw new Error(j.message || 'fuyao error ' + j.code);
    return j.data;
  } catch (e) { clearTimeout(timer); throw e; }
}

async function fyGet(fyPath) {
  if (!FY_KEY) throw new Error('FY_API_KEY 未配置');
  const run = async () => {
    const wait = Math.max(0, fyLast + FY_GAP - Date.now());
    if (wait > 0) await fyDelay(wait);
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try {
        const d = await fyGetRaw(fyPath);
        fyLast = Date.now();
        return d;
      } catch (e) {
        lastErr = e;
        fyLast = Date.now();
        if (i < 2) await fyDelay(e.fy429 ? [20000, 40000][i] : 3000);
      }
    }
    throw lastErr;
  };
  /* 串行化：后一个请求必须等前一个走完，保证相邻间隔 >= FY_GAP */
  const p = fyChain.then(run, run);
  fyChain = p.catch(() => {});
  return p;
}

/* 市场统计：从全市场行情快照聚合涨跌家数 / 成交额
   （同花顺不提供一站式「涨跌家数汇总」接口，需从行情快照分页聚合） */
let fyStatBusy = false;

/* 全市场快照分页拉取：total≈5566 但单次 limit 上限 5000，
   只取第一页会漏掉约 566 只（≈10%），涨跌家数因此失真 —— 必须翻页取全量。
   注：原实现还多请求了一次指数快照（只用来算 amount，而 amount 最终被
   全市场快照的 sAmt 覆盖，结果根本没用上），这里已删除，省下一次请求。 */
async function fetchFuyaoStat() {
  let all = [], total = 0;
  for (let offset = 0; offset < 20000; offset += 5000) {
    const j = await fyGet(`/api/a-share/prices/snapshot?limit=5000&offset=${offset}`);
    const items = j?.item || [];
    if (j?.total) total = j.total;
    all = all.concat(items);
    if (items.length < 5000) break;   // 已取完
  }
  if (!all.length) return null;

  let up = 0, down = 0, flat = 0, amt = 0;
  all.forEach(x => {
    const p = num(x.price_change_ratio_pct);
    if (p > 0.001) up++; else if (p < -0.001) down++; else flat++;
    amt += num(x.turnover);
  });
  const valid = up + down + flat;
  const pctOf = n => valid ? round(n * 100 / valid, 1) : 0;

  return {
    source: 'ths',
    total: total || all.length,
    sample: valid,
    up, down, flat,
    upPct: pctOf(up), downPct: pctOf(down), flatPct: pctOf(flat),
    amount: round(amt / 1e12, 3),
    amountYi: round(amt / 1e8, 2),
    mainFlow: null,           /* 同花顺无全市场主力净流入汇总接口，由东财补 */
    partial: false,
    updatedAt: new Date().toISOString()
  };
}

API['/fuyao-stat'] = async (res, q) => {
  if (!FY_KEY) return ok(res, null);   /* 前端降级到东财 */
  const now = Date.now();
  if (FY_CACHE.stat && now - FY_CACHE.t < FY_TTL) return ok(res, FY_CACHE.stat);
  /* 无有效缓存：立即返回，后台异步拉取。
     同花顺限流约 20 秒/次，翻 2 页需 40+ 秒，绝不能让前端干等。 */
  if (!fyStatBusy) {
    fyStatBusy = true;
    fetchFuyaoStat()
      .then(d => { if (d) { FY_CACHE.stat = d; FY_CACHE.t = Date.now(); } })
      .catch(() => {})
      .finally(() => { fyStatBusy = false; });
  }
  return ok(res, FY_CACHE.stat || null);
};

/* 指数快照：批量取主要 A 股指数点位 */
let fyIdxBusy = false;

/* 批量快照中任一 thscode 不被支持会导致整批失败（实测 899050.TI → code 1002）。
   整批失败时二分重试并跳过失败分支，避免个别代码失效拖垮全部指数。
   递归内部走 fyGet 串行队列，不会突破 20 秒/次的限流。 */
async function fyGetIndicesSafe(codes) {
  try {
    const j = await fyGet('/api/a-share-index/prices/snapshot?thscodes=' + codes.join(','));
    return j?.item || [];
  } catch (e) {
    if (codes.length <= 1) return [];
    const mid = Math.ceil(codes.length / 2);
    const a = await fyGetIndicesSafe(codes.slice(0, mid));
    const b = await fyGetIndicesSafe(codes.slice(mid));
    return a.concat(b);
  }
}

async function fetchFuyaoIndices() {
  const items = (await fyGetIndicesSafe(FY_IDX_CODES)).map(x => ({
    /* 用 thscode 而非 ticker：ticker 是同花顺内部格式（000001.SH → "1A0001"），
       与前端代码表对不上；取 thscode 前缀得到 "000001"，与东财 code 格式一致。 */
    code: String(x.thscode || '').split('.')[0],
    name: '',   /* fuyao 快照不含名称，由前端映射 */
    price: round(x.last_price),
    pct: round(x.price_change_ratio_pct),
    change: round(x.price_change),
    amount: round(num(x.turnover) / 1e8, 2),   // 元→亿
    source: 'ths'
  })).filter(s => s.code && s.price > 0);
  return items.length ? items : null;
}

API['/fuyao-indices'] = async (res, q) => {
  if (!FY_KEY) return ok(res, null);
  const now = Date.now();
  if (FY_CACHE.idx && now - FY_CACHE.t < FY_TTL) return ok(res, FY_CACHE.idx);
  /* 无缓存：立即返回，后台异步拉取（限流约 20 秒/次，不让前端等待） */
  if (!fyIdxBusy) {
    fyIdxBusy = true;
    fetchFuyaoIndices()
      .then(d => { if (d) FY_CACHE.idx = d; })
      .catch(() => {})
      .finally(() => { fyIdxBusy = false; });
  }
  return ok(res, FY_CACHE.idx || null);
};

/* ---------- 涨跌停 / 炸板 / 连板（同花顺 fuyao 源） ----------
   文档：https://fuyao.aicubes.cn/docs/api-reference/limit-up-data/
   四个池：涨停 / 跌停 / 炸板 / 连板天梯。
   fuyao 限流约 20 秒/次，故按 kind 分别缓存（复用 FY_TTL=5 分钟），
   且限流失败时降级返回上一次的旧值，避免前端整块空白。 */
const FY_LIMIT = {
  up:     { path: '/api/a-share/special-data/limit-up-pool',    sort: 'continue_day_cnt' },
  down:   { path: '/api/a-share/special-data/limit-down-pool',  sort: 'last_limit_time' },
  break:  { path: '/api/a-share/special-data/limit-break-pool', sort: 'open_times' },
  ladder: { path: '/api/a-share/special-data/limit-up-ladder',  sort: '' }
};
const FY_LIMIT_CACHE = {};   // kind -> { t, data }

API['/fuyao-limit'] = async (res, q) => {
  const kind = q.get('kind') || 'up';
  const cfg = FY_LIMIT[kind];
  if (!cfg) return fail(res, '未知类型：' + kind, 400);
  if (!FY_KEY) return fail(res, '未配置同花顺密钥，请在 data/fuyao.json 中配置 apiKey');

  const size = Math.min(200, Math.max(1, Number(q.get('size')) || 50));
  const hit = FY_LIMIT_CACHE[kind];
  if (hit && Date.now() - hit.t < FY_TTL) return ok(res, hit.data);

  try {
    const qs = cfg.sort ? `?page=1&size=${size}&sort_field=${cfg.sort}&sort_dir=desc` : '';
    const d = await fyGet(cfg.path + qs);
    const items = Array.isArray(d && d.item) ? d.item : [];
    let list, extra;

    if (kind === 'ladder') {
      /* 连板天梯是「日期 → 6 个板位 → 股票」的矩阵。
         取最近一个交易日，按板位从高到低摊平成一维列表。 */
      const BOARDS = ['seven_over', 'six_board', 'five_board', 'four_board', 'three_board', 'two_board'];
      const latest = items[0] || null;
      list = [];
      if (latest) {
        for (const b of BOARDS) {
          for (const x of (latest.boards && latest.boards[b]) || []) {
            list.push({
              code: x.ticker || '', thscode: x.thscode || '', name: x.name || '',
              board: x.board_num == null ? null : x.board_num,
              sealNext: x.seal_nextday == null ? null : x.seal_nextday,
              signLevel: x.sign_level == null ? null : x.sign_level
            });
          }
        }
      }
      extra = { date: (latest && latest.date) || '' };
    } else {
      list = items.map(x => ({
        code: x.ticker || '', thscode: x.thscode || '', name: x.name || '',
        price: round(x.last_price),
        pct: round(x.price_change_ratio_pct),
        /* 涨停池专有 */
        limitTime: x.limit_up_time || '',
        reason: x.limit_up_reason || '',
        boardText: x.continue_day_text || '',
        boardCnt: x.continue_day_cnt == null ? null : x.continue_day_cnt,
        sealMoney: x.seal_money == null ? null : round(x.seal_money / 1e8, 2),
        maxSeal: x.max_seal_money == null ? null : round(x.max_seal_money / 1e8, 2),
        /* 跌停池专有 */
        firstTime: x.first_limit_time || '',
        lastTime: x.last_limit_time || '',
        /* 炸板池专有 */
        openTimes: x.open_times == null ? null : x.open_times,
        turnoverPct: x.turnover_ratio_pct == null ? null : round(x.turnover_ratio_pct),
        turnover: x.turnover == null ? null : round(x.turnover / 1e8, 2),
        isST: !!x.is_st,
        isNew: !!x.is_new
      }));
      extra = { total: (d && d.pagination && d.pagination.total) != null ? d.pagination.total : list.length };
    }

    const data = Object.assign({ kind: kind, list: list }, extra);
    FY_LIMIT_CACHE[kind] = { t: Date.now(), data: data };
    ok(res, data);
  } catch (e) {
    /* 限流 / 上游失败：有旧值就先用旧值，别让页面空白 */
    if (hit) return ok(res, hit.data);
    fail(res, e instanceof Error ? e.message : '同花顺数据获取失败');
  }
};

/* ---------- 板块资金：行业 / 概念 / 地域 ---------- */
const SEC_TYPE = { industry: 'm:90+t:2', concept: 'm:90+t:3', area: 'm:90+t:1' };
/* 板块资金缓存（按 type|sort 分组）：概念约 500 个板块要翻 6 页（实测 ~0.76s），
   前端每 25 秒刷新一次，无缓存时每次都会重新打上游并占用多个闸门名额。 */
const SEC_CAP_CACHE = {};
const SEC_CAP_TTL = 30000;

API['/sector-capital'] = async (res, q) => {
  const type = SEC_TYPE[q.get('type')] ? q.get('type') : 'industry';
  const sort = q.get('sort') === 'pct' ? 'f3' : 'f62';
  const ck = type + '|' + sort;
  const hit = SEC_CAP_CACHE[ck];
  if (hit && Date.now() - hit.t < SEC_CAP_TTL) return ok(res, hit.data);
  /* 资金拆解字段（已实测）：
       f62 主力净流入  f66 超大单净额 f69 超大单占比
       f72 大单净额    f75 大单占比   f78 中单净额 f81 中单占比
       f84 小单净额    f87 小单占比 */
  const F = 'f2,f3,f12,f13,f14,f62,f66,f69,f72,f75,f78,f81,f84,f87,f104,f105,f128,f136,f140,f141,f204,f205,f206';
  /* 单次 clist 硬上限 pz=100，行业约 90、概念约 380，必须翻页才能拿到
     全部板块（否则只返回「主力净流入最高」的板块，净流出的板块被截断，
     前端「主力净流出 TOP」会变成「暂无」）。按 sort 降序翻页即可同时覆盖两端。 */
  const first = await clistPage(SEC_TYPE[type], sort, F, { po: 1, pz: 100 });
  const total = first.total || first.arr.length;
  const pages = Math.min(8, Math.ceil(total / 100));   // 封顶 800，防异常
  const rows = first.arr.slice();
  if (pages > 1) {
    const rest = await mapLimit(
      Array.from({ length: pages - 1 }, (_, i) => i + 2),
      4,
      pn => clistPage(SEC_TYPE[type], sort, F, { po: 1, pz: 100, pn }).catch(() => ({ arr: [] }))
    );
    rest.forEach(r => { if (r && r.arr) rows.push(...r.arr); });
  }
  const seen = {};
  const data = rows.map(x => ({
    code: String(x.f12 || ''),
    secid: secidOf(x.f13, x.f12),
    name: x.f14 || '',
    pct: round(x.f3),
    flow: round(num(x.f62) / 1e8, 2),          // 主力净流入（亿元）
    /* 资金拆解：净额（亿元）+ 占比（%） */
    superAmt: round(num(x.f66) / 1e8, 2), superPct: round(x.f69),
    bigAmt: round(num(x.f72) / 1e8, 2), bigPct: round(x.f75),
    midAmt: round(num(x.f78) / 1e8, 2), midPct: round(x.f81),
    smallAmt: round(num(x.f84) / 1e8, 2), smallPct: round(x.f87),
    up: num(x.f104), down: num(x.f105),
    lead: x.f128 || '',                        // 领涨股
    leadCode: String(x.f140 || ''),
    leadPct: round(x.f136),
    leadSecid: secidOf(x.f141, x.f140)
  })).filter(s => s.name && !seen[s.secid] && (seen[s.secid] = 1));
  SEC_CAP_CACHE[ck] = { t: Date.now(), data };
  ok(res, data);
};

/* ---------- 美股板块行情 ---------- */
const US_GROUPS = {
  tech:    { l: '科技巨头', items: [['AAPL','苹果'],['MSFT','微软'],['NVDA','英伟达'],['GOOGL','谷歌A'],['AMZN','亚马逊'],['META','Meta'],['TSLA','特斯拉'],['NFLX','奈飞'],['ORCL','甲骨文'],['CRM','赛富时'],['ADBE','Adobe'],['CSCO','思科']] },
  chip:    { l: '半导体', items: [['NVDA','英伟达'],['AMD','AMD'],['INTC','英特尔'],['QCOM','高通'],['TXN','德州仪器'],['MU','美光'],['AMAT','应用材料'],['LRCX','拉姆研究'],['KLAC','科磊'],['ARM','ARM'],['TSM','台积电'],['ASML','阿斯麦'],['MRVL','迈威尔'],['NXPI','恩智浦']] },
  china:   { l: '中概股', items: [['BABA','阿里巴巴'],['JD','京东'],['BIDU','百度'],['PDD','拼多多'],['NIO','蔚来'],['XPEV','小鹏'],['LI','理想'],['TME','腾讯音乐'],['BILI','哔哩哔哩'],['BEKE','贝壳'],['FUTU','富途控股'],['NTES','网易'],['TCOM','携程'],['ZTO','中通快递']] },
  ev:      { l: '电动车 / 新能源', items: [['TSLA','特斯拉'],['RIVN','Rivian'],['LCID','Lucid'],['F','福特'],['GM','通用汽车'],['PLUG','普拉格能源'],['ENPH','Enphase'],['FSLR','First Solar'],['NEE','新纪元能源'],['ALB','雅保'],['CHPT','ChargePoint']] },
  retail:  { l: '消费 / 零售', items: [['KO','可口可乐'],['PEP','百事'],['MCD','麦当劳'],['SBUX','星巴克'],['WMT','沃尔玛'],['COST','好市多'],['TGT','塔吉特'],['NKE','耐克'],['PG','宝洁'],['HD','家得宝'],['LOW','劳氏'],['EBAY','eBay']] },
  finance: { l: '金融', items: [['JPM','摩根大通'],['BAC','美国银行'],['WFC','富国银行'],['GS','高盛'],['MS','摩根士丹利'],['C','花旗'],['AXP','美国运通'],['V','Visa'],['MA','万事达'],['BRK.B','伯克希尔B'],['BLK','贝莱德'],['SCHW','嘉信理财']] },
  medical: { l: '医疗健康', items: [['JNJ','强生'],['UNH','联合健康'],['LLY','礼来'],['PFE','辉瑞'],['MRK','默沙东'],['ABBV','艾伯维'],['TMO','赛默飞'],['ABT','雅培'],['DHR','丹纳赫'],['AMGN','安进'],['GILD','吉利德'],['CVS','CVS健康']] },
  energy: { l: '能源/材料/工业', items: [['XOM','埃克森美孚'],['CVX','雪佛龙'],['SLB','斯伦贝谢'],['CAT','卡特彼勒'],['GE','通用电气'],['HON','霍尼韦尔'],['UNP','联合太平洋'],['BA','波音'],['LMT','洛克希德马丁'],['RTX','雷神技术'],['DE','迪尔'],['MMM','3M']] },
  comm: { l: '通信/媒体/互联网成长股', items: [['GOOGL','谷歌A'],['META','Meta'],['NFLX','奈飞'],['DIS','迪士尼'],['TMUS','T-Mobile'],['VZ','威瑞森'],['SPOT','Spotify'],['SNAP','Snap'],['UBER','优步'],['LYFT','Lyft'],['Roku','Roku'],['PIN','Pinterest']] },
  etf: { l: 'ETF / 指数', items: [['SPY','标普500 ETF'],['QQQ','纳斯达克100 ETF'],['IWM','罗素2000 ETF'],['IWB','罗素1000 ETF'],['VTI','全市场ETF'],['GLD','黄金ETF'],['TLT','20年+国债ETF'],['HYG','高收益债ETF'],['EEM','新兴市场ETF'],['VWO','新兴市场ETF'],['IJH','中盘400 ETF'],['IJR','小盘600 ETF']] },
  consumer: { l: '消费日常', items: [['KO','可口可乐'],['PEP','百事'],['MCD','麦当劳'],['SBUX','星巴克'],['WMT','沃尔玛'],['COST','好市多'],['TGT','塔吉特'],['NKE','耐克'],['PG','宝洁'],['CL','高露洁'],['KMB','金佰利'],['EL','雅诗兰黛']] },
  industrial: { l: '工业制造', items: [['CAT','卡特彼勒'],['GE','通用电气'],['HON','霍尼韦尔'],['UNP','联合太平洋'],['UPS','联合包裹'],['FDX','联邦快递'],['RTX','雷神技术'],['LMT','洛克希德马丁'],['DE','迪尔'],['CMI','康明斯'],['ETN','伊顿'],['DOV','多佛']] },
  reit: { l: 'REITs', items: [['PLD','普洛斯达'],['AMT','美国塔楼'],['EQIX','Equinix'],['DLR','数字地产'],['VICI','维西'],['O','Realty Income'],['AVB','AvalonBay'],['SBAC','SBA Communications'],['PSA','公共存储'],['WELL','Welltower'],['EXR','Extra Space'],['MAA','MAA']] }
};
API['/us-sector'] = async (res, q) => {
  const g = q.get('g') || 'tech';
  const grp = US_GROUPS[g] || US_GROUPS.tech;
  const secids = grp.items.map(([c]) => `105.${c}`).join(',');
  /* f20 总市值 f21 流通市值 f114 市盈率(动) f115 市净率 —— 均已实测可用 */
  const j = await getJSON(`${EM}/api/qt/ulist.np/get?secids=${secids}` +
    `&fields=f2,f3,f4,f12,f13,f14,f20,f21,f114,f115&fltt=2&invt=2`);
  const arr = j?.data?.diff ? (Array.isArray(j.data.diff) ? j.data.diff : Object.values(j.data.diff)) : [];
  const map = {};
  arr.forEach(x => { map[String(x.f12)] = x; });
  ok(res, {
    group: g,
    label: grp.l,
    list: grp.items.map(([code, cn]) => {
      const x = map[code];
      return {
        code, secid: '105.' + code,
        name: (x && x.f14) ? String(x.f14) : cn,
        price: x ? round(x.f2) : null,
        pct: x ? round(x.f3) : null,
        change: x ? round(x.f4) : null,
        mktcap: x ? round(num(x.f20) / 1e8, 2) : null,   // 总市值（亿美元）
        pe: x ? round(x.f114) : null,
        pb: x ? round(x.f115) : null
      };
    })
  });
};

/* ---------- 港股行情 ----------
   踩坑记录：
     1) 港股个股用 ulist.np/get + 116.xxxxx，clist 主域被封（走 clistGet 降级）
     2) 恒生指数是 100.HSI，恒生科技是 124.HSTECH，红筹 124.HSCCI（116.HSI 返回 null）
     3) 组件名一律以接口 f14 为准 —— 之前手写名称大量张冠李戴
        （09918 是丽年国际不是京东、09896 是名创优品不是小米、09990 是祖龙娱乐不是海尔智家）
        这里的中文只作为接口缺数据时的兜底 */
const HK_GROUPS = {
  index: { l: '主要指数', secids: [
    ['100.HSI', '恒生指数'], ['124.HSTECH', '恒生科技'],
    ['100.HSCEI', '国企指数'], ['124.HSCCI', '红筹指数']
  ]},
  hsblue: { l: '恒生科技', secids: [
    ['116.09988', '阿里巴巴-W'], ['116.09888', '百度集团-SW'], ['116.09618', '京东集团-SW'],
    ['116.03690', '美团-W'], ['116.09626', '哔哩哔哩-W'], ['116.09868', '小鹏集团-W'],
    ['116.02015', '理想汽车-W'], ['116.01810', '小米集团-W'], ['116.06618', '京东健康'],
    ['116.09698', '万国数据-SW'], ['116.00981', '中芯国际'], ['116.02382', '舜宇光学科技'],
    ['116.09999', '网易'], ['116.01024', '快手-W'], ['116.00241', '阿里健康'],
    ['116.01833', '平安好医生'], ['116.03888', '金山软件'], ['116.00268', '金蝶国际'],
    ['116.01347', '华虹宏力'], ['116.00285', '比亚迪电子'], ['116.02018', '瑞声科技'],
    ['116.06060', '众安在线']
  ]},
  mainboard: { l: '主板蓝筹', secids: [
    ['116.00700', '腾讯控股'], ['116.00939', '建设银行'], ['116.01398', '工商银行'],
    ['116.03988', '中国银行'], ['116.00941', '中国移动'], ['116.02318', '中国平安'],
    ['116.02883', '中海油田服务'], ['116.06030', '中信证券'], ['116.00386', '中国石油化工股份'],
    ['116.01088', '中国神华'], ['116.02628', '中国人寿'], ['116.00002', '中电控股'],
    ['116.00003', '香港中华煤气'], ['116.00006', '电能实业'], ['116.00011', '恒生银行'],
    ['116.00012', '恒基地产'], ['116.00016', '新鸿基地产'], ['116.00019', '太古股份公司A'],
    ['116.00083', '信和置业'], ['116.00101', '恒隆地产'], ['116.00388', '香港交易所'],
    ['116.00688', '中国海外发展'], ['116.00857', '中国石油股份'], ['116.01038', '长江基建集团']
  ]},
  etf: { l: 'ETF', secids: [
    ['116.02800', '盈富基金'], ['116.03033', '南方恒生科技'], ['116.03188', '华夏沪深三百'],
    ['116.03001', 'PP中地美债'], ['116.02823', '安硕A50'], ['116.02812', '三星中国龙网'],
    ['116.07200', '南方两倍看多恒指'], ['116.07552', '南方两倍做空恒生科技'],
    ['116.03032', '恒生科技ETF'], ['116.02822', '南方A50']
  ]},
  /* 动态分组：走 clistGet（域名降级），实时取当日榜单 */
  hot:  { l: '成交额榜', fs: 'm:128+t:1,m:128+t:2,m:128+t:3,m:128+t:4', fid: 'f6', pz: 30 },
  gain: { l: '涨幅榜',   fs: 'm:128+t:1,m:128+t:2,m:128+t:3,m:128+t:4', fid: 'f3', pz: 30 },
  gem:  { l: '创业板',   fs: 'm:128+t:4', fid: 'f6', pz: 30 }
};
API['/hk-sector'] = async (res, q) => {
  const g = q.get('g') || 'index';
  const grp = HK_GROUPS[g] || HK_GROUPS.index;

  /* 动态分组：直接返回榜单，名称用接口原文 */
  if (grp.fs) {
    const arr = await clistGet(grp.fs, grp.fid, 'f2,f3,f4,f6,f12,f13,f14', { pz: grp.pz });
    return ok(res, {
      group: g, label: grp.l,
      list: arr.filter(x => x && x.f14).map(x => {
        const code = String(x.f12 || '');
        /* clist 返回的市场码是 128，但详情页走的是 116 前缀 —— 统一成 116 */
        return {
          code, secid: '116.' + code,
          name: String(x.f14), price: round(x.f2), pct: round(x.f3),
          change: round(x.f4), amount: round(num(x.f6) / 1e8, 2)
        };
      })
    });
  }

  /* 固定分组：ulist 批量查，名称以 f14 为准 */
  const secids = grp.secids.map(x => x[0]).join(',');
  const j = await getJSON(`${EM}/api/qt/ulist.np/get?secids=${secids}` +
    `&fields=f2,f3,f4,f6,f12,f13,f14&fltt=2&invt=2`);
  const d = j?.data?.diff;
  const arr = d ? (Array.isArray(d) ? d : Object.values(d)) : [];
  const map = {};
  arr.forEach(x => { if (x && x.f12 != null) map[String(x.f12)] = x; });

  ok(res, {
    group: g, label: grp.l,
    list: grp.secids.map(([sid, fallback]) => {
      const code = sid.slice(sid.indexOf('.') + 1);
      const x = map[code];
      return {
        code, secid: sid,
        name: (x && x.f14) ? String(x.f14) : fallback,
        price: x ? round(x.f2) : null,
        pct: x ? round(x.f3) : null,
        change: x ? round(x.f4) : null,
        amount: x ? round(num(x.f6) / 1e8, 2) : null
      };
    })
  });
};

/* ---------- 游资操作：游资作战室 · 龙虎榜 ----------
   数据源：
     1) RPT_DAILYBILLBOARD_DETAILSNEW  —— 个股维度（每只上榜股票的买卖总额、涨跌幅、上榜原因）
     2) RPT_OPERATEDEPT_TRADE_DETAILS  —— 营业部级明细（每个营业部在每只股票上的买/卖/净额）
   把营业部明细按「知名游资名号」聚合，得到目标站同款的：
     游资净买入/卖出 TOP10、个股净买入/卖出 TOP10、游资卡片列表、游资画像（关联营业部 + 近期交易）。 */
const LHB_DETAIL = `${EMD}/api/data/v1/get?reportName=RPT_OPERATEDEPT_TRADE_DETAILS&columns=ALL`;
const LHB_STOCK  = `${EMD}/api/data/v1/get?reportName=RPT_DAILYBILLBOARD_DETAILSNEW&columns=ALL`;

/* 知名游资名号归类规则：命中即归入该游资（按优先级从上到下匹配，命中第一条即止）。
   规则口径参考市场公认的游资席位别称，尽量覆盖目标站出现的名号。 */
function youziNameOf(dept) {
  const d = String(dept || '');
  const R = [
    [/机构专用/, '机构专用'],
    [/沪股通专用/, '沪股通专用'],
    [/深股通专用/, '深股通专用'],
    [/东北证券佛山分公司/, '佛山系'],
    [/桑田路/, '宁波桑田路'],
    [/华鑫证券.*(?:上海|深圳|北京|成都|南京|武汉|西安|合肥|广州|天津)/, '量化打板'],
    [/华鑫证券/, '量化打板'],
    [/开源证券.*西安/, '量化基金'],
    [/拉萨团结路|拉萨东环路|东财.*拉萨|东方财富.*拉萨/, '拉萨天团'],
    [/国泰海通.*上海江苏路|国泰君安.*上海江苏路|上海江苏路/, '章盟主'],
    [/国泰海通.*上海新闸路|上海新闸路/, '欢乐海岸'],
    [/中信证券.*上海溧阳路|上海溧阳路/, '炒股养家'],
    [/中国银河.*绍兴|银河.*绍兴/, '赵老哥'],
    [/国泰海通.*上海延安路|上海延安路/, '方新侠'],
    [/国泰海通.*重庆观音桥|重庆观音桥/, '作手新一'],
    [/国泰海通.*上海分公司|国泰君安.*上海分公司/, '上海超短帮'],
    [/国泰海通.*北京知春路|北京知春路/, '苏南帮'],
    [/华泰证券.*深圳益田路|深圳益田路/, '欢乐海岸'],
    [/招商证券.*深圳深南东路|深南东路/, '招商深南东'],
    [/中信证券.*北京中关村|北京中关村/, '北京中关村'],
    [/国泰海通.*温州|温州/, '温州帮'],
    [/国盛证券.*宁波桑田路/, '宁波桑田路'],
    [/东亚前海.*上海|思明南路/, '思明南路'],
    [/上塘路/, '上塘路'],
    [/成都系|国泰海通.*成都北一环路/, '成都系']
  ];
  for (const [re, name] of R) if (re.test(d)) return name;
  return null; // 未命中知名名号 → 用营业部简称兜底
}

/* 从营业部全称里提取简称（去地域+去"证券/营业部"等后缀），作为未归类席位的游资名 */
function deptShort(dept) {
  let s = String(dept || '')
    .replace(/(股份有限公司|有限责任公司|有限公司|分公司|证券营业部|营业部|证券)/g, '')
    .replace(/(中国|股份|有限|责任)/g, '');
  // 取地域关键词（省/市/区前的核心名）
  const m = s.match(/([^省市区县]{1,6}(?:路|街|大道|广场|中心)?)/);
  s = m ? m[1] : s;
  return s.trim().slice(0, 8) || String(dept).slice(0, 8);
}

API['/youzi'] = async (res, q) => {
  const date = (q.get('date') || '').trim(); // 可选指定交易日，缺省取最新
  /* 1) 先取个股汇总，确定最新交易日（龙虎榜收盘后约 18:00 发布） */
  let jStock = null;
  try {
    jStock = await getJSONFailover([
      `${LHB_STOCK}&pageNumber=1&pageSize=300&sortColumns=TRADE_DATE,BILLBOARD_NET_AMT&sortTypes=-1,-1&source=WEB&client=WEB`,
      `${LHB_STOCK.replace('datacenter-web.eastmoney.com', 'datacenter.eastmoney.com')}&pageNumber=1&pageSize=300&sortColumns=TRADE_DATE,BILLBOARD_NET_AMT&sortTypes=-1,-1&source=WEB&client=WEB`
    ]);
  } catch (e) { jStock = null; }
  let stocks = (jStock?.result?.data) || [];
  const latest = String((stocks[0] || {}).TRADE_DATE || '').slice(0, 10);
  const day = date || latest;
  stocks = stocks.filter(x => String(x.TRADE_DATE || '').slice(0, 10) === day);

  /* 2) 营业部级明细必须按 TRADE_DATE 过滤（否则接口按全历史排序，拿不到当天数据） */
  let jDept = null;
  try {
    jDept = await getJSONFailover([
      `${LHB_DETAIL}&filter=(TRADE_DATE='${day}')&pageNumber=1&pageSize=1500&sortColumns=NET_AMT&sortTypes=-1&source=WEB&client=WEB`,
      `${LHB_DETAIL.replace('datacenter-web.eastmoney.com', 'datacenter.eastmoney.com')}&filter=(TRADE_DATE='${day}')&pageNumber=1&pageSize=1500&sortColumns=NET_AMT&sortTypes=-1&source=WEB&client=WEB`
    ]);
  } catch (e) { jDept = null; }
  let depts  = (jDept?.result?.data) || [];
  if (!stocks.length && !depts.length) return ok(res, { date: day, kpi: {}, seatsRank: [], stocksRank: { buyTop: [], sellTop: [] }, hotSeats: [], detail: [] });

  const isInst = s => /机构专用/.test(s || '');

  /* ---- 个股维度 ---- */
  const MKT = { SH: '1', SZ: '0', BJ: '0' };
  const stockList = stocks.map(x => ({
    code: String(x.SECURITY_CODE || ''),
    secid: secidOf(MKT[x.MARKET], x.SECURITY_CODE),
    name: x.SECURITY_NAME_ABBR || '',
    price: round(x.CLOSE_PRICE),
    pct: round(x.CHANGE_RATE),
    net: round(num(x.BILLBOARD_NET_AMT) / 1e8, 4),
    buy: round(num(x.BILLBOARD_BUY_AMT) / 1e8, 4),
    sell: round(num(x.BILLBOARD_SELL_AMT) / 1e8, 4),
    turnover: round(num(x.TURNOVERRATE)),
    dealAmt: round(num(x.BILLBOARD_DEAL_AMT) / 1e8, 2),
    reason: x.EXPLANATION || '',
    inst: isInst(x.EXPLAIN)
  })).filter(s => s.code);

  /* ---- 营业部级明细 → 归入游资名号 ---- */
  const agg = {};
  const ensure = name => { if (!agg[name]) agg[name] = { name, depts: new Set(), rows: [], net: 0, stocks: new Set() }; return agg[name]; };
  depts.forEach(x => {
    const dept = x.OPERATEDEPT_NAME || '';
    const known = youziNameOf(dept);
    const name = known || ('@' + deptShort(dept));
    const g = ensure(name);
    g.depts.add(dept);
    const net = num(x.NET_AMT);
    g.net += net;
    if (num(x.ACT_BUY) > 0 || num(x.ACT_SELL) > 0) g.stocks.add(String(x.SECURITY_CODE || ''));
    g.rows.push({
      date: String(x.TRADE_DATE || '').slice(0, 10),
      code: String(x.SECURITY_CODE || ''),
      name: x.SECURITY_NAME_ABBR || '',
      dept,
      buy: round(num(x.ACT_BUY) / 1e8, 4),
      sell: round(num(x.ACT_SELL) / 1e8, 4),
      net: round(net / 1e8, 4)
    });
  });

  /* 游资榜单（排除纯机构专用，但保留"机构专用"作为对照项展示在净卖出榜） */
  const allSeats = Object.values(agg)
    .map(g => ({
      name: g.name.replace(/^@/, ''),
      rawName: g.name,
      isKnown: !g.name.startsWith('@'),
      net: round(g.net / 1e8, 4),
      stocks: g.stocks.size,
      depts: g.depts.size,
      initial: (g.name.startsWith('@') ? (g.name.slice(1) || '?') : g.name).slice(0, 1)
    }))
    .sort((a, b) => b.net - a.net);

  const seatsRank = allSeats.slice(0, 10);                 // 净买入 TOP10
  const seatsSellRank = allSeats.slice().reverse().slice(0, 10); // 净卖出 TOP10（负值在前）

  /* 明细区·按游资卡片（全部，含机构/股通，供搜索与画像） */
  const hotSeats = allSeats.map((s, i) => ({ ...s, rank: i + 1 }));

  /* KPI（口径贴近指标站“游资作战室”）
     机构专用 / 沪股通专用 / 深股通专用 属被动席位，不计入“游资净买”与“上榜游资” */
  const PASSIVE = /机构专用|股通专用/;
  const activeSeats = allSeats.filter(s => !(PASSIVE.test(s.name)));
  const netSum = activeSeats.reduce((a, s) => a + s.net, 0);          // 游资净买入合计（亿）
  const seatCount = allSeats.filter(s => s.isKnown && !PASSIVE.test(s.name)).length; // 上榜游资（知名）
  const dealAmt = stockList.reduce((a, s) => a + (s.dealAmt || 0), 0); // 龙虎榜成交（亿）
  const kpi = {
    netSum: round(netSum, 2),
    seatCount,
    stockCount: new Set(stockList.map(x => x.code)).size,
    dealAmt: round(dealAmt, 2),
    deptCount: new Set(depts.map(x => x.OPERATEDEPT_NAME)).size
  };

  /* 个股 TOP10 */
  const stocksRank = {
    buyTop: stockList.slice().sort((a, b) => b.net - a.net).slice(0, 10),
    sellTop: stockList.slice().sort((a, b) => a.net - b.net).slice(0, 10)
  };

  /* 全部明细（营业部级，按净额降序，供表格） */
  const detail = depts
    .map(x => ({
      date: String(x.TRADE_DATE || '').slice(0, 10),
      code: String(x.SECURITY_CODE || ''),
      name: x.SECURITY_NAME_ABBR || '',
      dept: x.OPERATEDEPT_NAME || '',
      youzi: youziNameOf(x.OPERATEDEPT_NAME) || deptShort(x.OPERATEDEPT_NAME),
      buy: round(num(x.ACT_BUY) / 1e8, 4),
      sell: round(num(x.ACT_SELL) / 1e8, 4),
      net: round(num(x.NET_AMT) / 1e8, 4)
    }))
    .sort((a, b) => b.net - a.net);

  ok(res, {
    date: day,
    latest,
    kpi,
    seatsRank,        // 游资净买入 TOP10
    seatsSellRank,    // 游资净卖出 TOP10
    stocksRank,       // 个股净买入/卖出 TOP10
    hotSeats,         // 按游资卡片列表
    detail            // 全部明细
  });
};

/* 游资画像：某游资名号下的关联营业部 + 近期交易明细 */
API['/youzi-portrait'] = async (res, q) => {
  const name = (q.get('name') || '').trim();
  if (!name) return ok(res, { depts: [], trades: [] });
  const day = (q.get('date') || '').trim();
  /* 有日期则精确过滤；无日期则拉最新一页再取最近交易日 */
  var url;
  if (day) {
    url = `${LHB_DETAIL}&filter=(TRADE_DATE='${day}')&pageNumber=1&pageSize=1500&sortColumns=NET_AMT&sortTypes=-1&source=WEB&client=WEB`;
  } else {
    url = `${LHB_DETAIL}&pageNumber=1&pageSize=1500&sortColumns=TRADE_DATE,NET_AMT&sortTypes=-1,-1&source=WEB&client=WEB`;
  }
  let j = null;
  try {
    j = await getJSONFailover([
      url,
      url.replace('datacenter-web.eastmoney.com', 'datacenter.eastmoney.com')
    ]);
  } catch (e) { j = null; }
  let depts = (j?.result?.data) || [];
  if (!depts.length) return ok(res, { name, depts: [], trades: [], note: j ? '' : '上游数据暂不可用，请稍后重试' });
  /* 无指定日期时，取接口返回的最新交易日 */
  const latest = String((depts[0] || {}).TRADE_DATE || '').slice(0, 10);
  const target = day || latest;
  depts = depts.filter(x => String(x.TRADE_DATE || '').slice(0, 10) === target);

  /* 匹配逻辑：先尝试知名游资精确匹配；未命中时回退到 deptShort 模糊匹配
     （覆盖主接口中 @未归类 游资，其名字由 deptShort 生成） */
  const matched = depts.filter(x => {
    const yn = youziNameOf(x.OPERATEDEPT_NAME);
    if (yn === name) return true;
    /* 未归类游资：name 是 deptShort 的结果（去掉了 @ 前缀），用 deptShort 再算一次比对 */
    if (!yn && deptShort(x.OPERATEDEPT_NAME) === name) return true;
    return false;
  });
  const deptSet = new Set(matched.map(x => x.OPERATEDEPT_NAME));
  const trades = matched
    .map(x => ({
      date: String(x.TRADE_DATE || '').slice(0, 10),
      code: String(x.SECURITY_CODE || ''),
      name: x.SECURITY_NAME_ABBR || '',
      dept: x.OPERATEDEPT_NAME || '',
      buy: round(num(x.ACT_BUY) / 1e8, 4),
      sell: round(num(x.ACT_SELL) / 1e8, 4),
      net: round(num(x.NET_AMT) / 1e8, 4)
    }))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

  ok(res, {
    name,
    depts: Array.from(deptSet),
    trades: trades.slice(0, 200)
  });
};

/* ---------- 暗盘监控：大宗交易（盘后大额协议转让） ---------- */
/* 大宗交易 / 暗盘监控。
   支持按交易日查询：date=YYYY-MM-DD（不传则取最近一个交易日）。
   实测东财支持 filter=(TRADE_DATE='YYYY-MM-DD') 精确过滤，据此实现历史日期回看。
   dates 返回近期可选交易日，供前端做日期选择。 */
API['/dark'] = async (res, q) => {
  const BASE = `${EMD}/api/data/v1/get?reportName=RPT_DATA_BLOCKTRADE&columns=ALL&source=WEB&client=WEB`;
  const dateQ = (q.get('date') || '').trim();

  /* 概览请求：按 日期+成交额 降序。既用于取最新交易日数据，也用于提取可选日期列表 */
  const oj = await getJSON(
    `${BASE}&pageNumber=1&pageSize=300&sortColumns=TRADE_DATE,DEAL_AMT&sortTypes=-1,-1`
  ).catch(() => null);
  const oarr = oj?.result?.data || [];

  const dates = [];
  oarr.forEach(x => {
    const d = String(x.TRADE_DATE || '').slice(0, 10);
    if (d && dates.indexOf(d) < 0) dates.push(d);
  });

  let arr = [];
  const target = dateQ || dates[0] || '';

  /* 未指定日期 → 直接复用概览里最新交易日的数据，零额外请求 */
  if (!dateQ && target) {
    arr = oarr.filter(x => String(x.TRADE_DATE || '').slice(0, 10) === target);
  }
  /* 指定了日期（或概览未覆盖）→ 用 filter 精确查询，保证拿到该日完整数据 */
  if ((dateQ || !arr.length) && target) {
    const filter = encodeURIComponent(`(TRADE_DATE='${target}')`);
    const dj = await getJSON(
      `${BASE}&pageNumber=1&pageSize=200&sortColumns=DEAL_AMT&sortTypes=-1&filter=${filter}`
    ).catch(() => null);
    const darr = dj?.result?.data || [];
    if (darr.length) arr = darr;
  }

  ok(res, {
    date: target,
    dates: dates.slice(0, 10),
    /* 不截断：合计成交额、平均溢价率等 KPI 需基于该日完整数据。
       上游 pageSize=200 已设上限，个别超量交易日按上游返回为准。 */
    list: arr.map(x => {
      const code = String(x.SECURITY_CODE || '');
      return {
        code,
        secid: secidOf(undefined, code),
        name: x.SECURITY_NAME_ABBR || '',
        price: round(x.DEAL_PRICE),
        close: round(x.CLOSE_PRICE),
        premium: round(x.PREMIUM_RATIO),        // 溢价率 %
        volume: round(num(x.DEAL_VOLUME) / 1e4, 2),  // 万股
        amount: round(num(x.DEAL_AMT) / 1e8, 4),     // 亿元
        buyer: x.BUYER_NAME || '',
        seller: x.SELLER_NAME || ''
      };
    }).filter(s => s.code)
  });
};

/* ===================================================================
   同花顺（fuyao）财务数据代理
   - 财务报表：/api/a-share/financials/{income,balance,cashflow}-statements
   - 财务指标：/api/a-share/financials/indicators（成长/盈利/偿债/营运/现金流 五类）
   注意：同花顺公开 API 无大宗交易端点（data.10jqka.com.cn/market/dzjy 未开放），
   故暗盘监控仍只用东财源。
   限流约 20 秒/次，而财报按季度才更新，这里缓存 6 小时，避免把密钥打废。
   =================================================================== */

/** 6 位 A 股代码 → 同花顺 thscode（600519.SH / 000001.SZ / 430047.BJ） */
function thscodeOf(code) {
  const c = String(code || '').trim()
  if (!c) return ''
  if (c.indexOf('.') > 0) return c.toUpperCase() // 已是 thscode
  const h = c.charAt(0)
  if (h === '6') return c + '.SH'
  if (h === '0' || h === '3') return c + '.SZ'
  if (h === '4' || h === '8') return c + '.BJ'
  return c + '.SH'
}

const FIN_ENDPOINT = {
  income: 'income-statements',
  balance: 'balance-sheets',
  cashflow: 'cash-flow-statements'
}
const FIN_CACHE = new Map()
const FIN_TTL = 6 * 3600 * 1000 // 6 小时

/** 财务报表：type=income|balance|cashflow，period=annual|quarterly */
API['/financials'] = async (res, q) => {
  const code = (q.get('code') || '').trim()
  if (!code) return fail(res, '缺少 code 参数', 400)
  const type = FIN_ENDPOINT[q.get('type')] ? q.get('type') : 'income'
  const period = q.get('period') === 'quarterly' ? 'quarterly' : 'annual'
  const limit = Math.min(20, Math.max(1, parseInt(q.get('limit')) || 4))

  const ths = thscodeOf(code)
  const ck = `${ths}|${type}|${period}|${limit}`
  const hit = FIN_CACHE.get(ck)
  if (hit && Date.now() - hit.t < FIN_TTL) {
    return ok(res, Object.assign({}, hit.data, { cached: true }))
  }
  if (!FY_KEY) return ok(res, null) // 未配置密钥 → 前端降级
  try {
    const d = await fyGet(
      `/api/a-share/financials/${FIN_ENDPOINT[type]}?thscode=${ths}&period=${period}&limit=${limit}`
    )
    const payload = {
      thscode: ths,
      code,
      period,
      type,
      list: d?.item || [],
      source: 'ths',
      cached: false
    }
    FIN_CACHE.set(ck, { t: Date.now(), data: payload })
    ok(res, payload)
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    const msg = /429|rate limit|限流/i.test(m)
      ? '同花顺接口限流（约 20 秒/次），请稍后重试'
      : '财务数据获取失败：' + m
    fail(res, msg)
  }
}

/** 财务指标：report 形如 2025-1（一季报）/ 2025-2（中报）/ 2025-3（三季报）/ 2025-4（年报） */
API['/financial-indicators'] = async (res, q) => {
  const code = (q.get('code') || '').trim()
  const report = (q.get('report') || '').trim()
  if (!code || !report) return fail(res, '缺少 code 或 report 参数', 400)

  const ths = thscodeOf(code)
  const ck = `IND|${ths}|${report}`
  const hit = FIN_CACHE.get(ck)
  if (hit && Date.now() - hit.t < FIN_TTL) {
    return ok(res, Object.assign({}, hit.data, { cached: true }))
  }
  if (!FY_KEY) return ok(res, null)
  try {
    const d = await fyGet(`/api/a-share/financials/indicators?thscode=${ths}&report=${report}`)
    const payload = {
      thscode: ths,
      code,
      report,
      abilities: d?.abilities || [],
      source: 'ths',
      cached: false
    }
    FIN_CACHE.set(ck, { t: Date.now(), data: payload })
    ok(res, payload)
  } catch (e) {
    /* 区分场景给提示：限流让用户等一下，未披露/无数据说明原因，其余透传上游信息 */
    const m = e instanceof Error ? e.message : String(e)
    const msg = /429|rate limit|限流/i.test(m)
      ? '同花顺接口限流（约 20 秒/次），请稍后重试'
      : /未披露|不存在|not found|invalid/i.test(m)
        ? `报告期 ${report} 暂无数据（可能尚未披露）`
        : '财务指标获取失败：' + m
    fail(res, msg)
  }
}

/* ---------- 对比分析：多股关键指标横向对比 ---------- */
API['/compare'] = async (res, q) => {
  const raw = (q.get('codes') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 6);
  if (!raw.length) return ok(res, []);
  /* 支持 code 或 secid 两种传法 */
  const secids = raw.map(c => (c.indexOf('.') > 0 ? c : secidOf(undefined, c)));
  const url = `${EM}/api/qt/ulist.np/get?secids=${secids.join(',')}` +
    `&fields=f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f20,f23,f62&fltt=2&invt=2`;
  const j = await getJSON(url);
  const arr = j?.data?.diff ? (Array.isArray(j.data.diff) ? j.data.diff : Object.values(j.data.diff)) : [];
  const map = {};
  arr.forEach(x => { map[String(x.f12)] = x; });

  /* 并发取 K 线，算近 5 日 / 20 日涨幅 + 均线 */
  const out = await mapLimit(secids, 4, async (sid) => {
    const code = sid.slice(sid.indexOf('.') + 1);
    const x = map[code] || {};
    let k5 = null, k20 = null, ma5 = null, ma20 = null;
    try {
      const r = { mkt: sid.slice(0, sid.indexOf('.')), sym: code, code };
      const ks = await txKline(txSymOf(r), 'day', 120);
      if (ks && ks.length >= 21) {
        const cl = closeSeries(ks);
        const last = cl[cl.length - 1];
        k5 = round((last / cl[cl.length - 6] - 1) * 100, 2);
        k20 = round((last / cl[cl.length - 21] - 1) * 100, 2);
        ma5 = round(cl.slice(-5).reduce((a, b) => a + b, 0) / 5, 2);
        ma20 = round(cl.slice(-20).reduce((a, b) => a + b, 0) / 20, 2);
      }
    } catch (e) { /* K线失败不影响主指标 */ }

    return {
      code, secid: sid, name: x.f14 || code,
      price: round(x.f2), pct: round(x.f3), change: round(x.f4),
      amount: round(num(x.f6) / 1e8, 4),
      amplitude: round(x.f7), turnover: round(x.f8),
      pe: round(x.f9), volumeRatio: round(x.f10),
      pb: round(x.f23),
      mktcap: round(num(x.f20) / 1e8, 2),
      mainNetInflow: round(num(x.f62) / 1e8, 4),
      chg5: k5, chg20: k20, ma5, ma20
    };
  });
  ok(res, out.filter(Boolean));
};

/* ---------- 预测 PP：量化选股（均线多头 + 资金流入 + 量能） ----------
   打分逻辑原样抽成 forecastList()，供 /api/forecast 与 /api/backtest（默认股票池）复用；
   内部逻辑与上游字段口径未做任何改动。 */
async function forecastList() {
  /* 第一层：东财筛出成交额活跃且上涨的票（避免全市场扫描） */
  const fs = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';
  const arr = await clistGet(fs, 'f6',
    'f2,f3,f5,f6,f7,f8,f9,f10,f12,f13,f14,f20,f23,f62', { pz: 100 });
  const cands = arr.map(x => ({
    code: String(x.f12 || ''),
    secid: secidOf(x.f13, x.f12),
    mkt: String(x.f13 || ''),
    name: x.f14 || '',
    price: round(x.f2), pct: round(x.f3),
    amount: round(num(x.f6) / 1e8, 4),
    turnover: round(x.f8), pe: round(x.f9),
    volumeRatio: round(x.f10),
    mktcap: round(num(x.f20) / 1e8, 2),
    mainNetInflow: round(num(x.f62) / 1e8, 4)
  })).filter(s => s.code && s.price > 0).slice(0, 40);

  /* 第二层：并发取日 K，判断均线多头排列 */
  const rows = await mapLimit(cands, 6, async (c) => {
    try {
      const ks = await txKline(txSymOf({ mkt: c.mkt, sym: c.code, code: c.code }), 'day', 120);
      if (!ks || ks.length < 61) return null;
      const cl = closeSeries(ks);
      const last = cl[cl.length - 1];
      const ma = n => cl.slice(-n).reduce((a, b) => a + b, 0) / n;
      const ma5 = ma(5), ma10 = ma(10), ma20 = ma(20), ma60 = ma(60);

      /* 近 20 日高低点（txKline 行序：[日期, 开, 收, 高, 低, 量]） */
      const w = ks.slice(-20);
      const hi20 = Math.max.apply(null, w.map(k => num(k[3])));
      const lo20 = Math.min.apply(null, w.map(k => num(k[4])));

      /* 多头排列：MA5 > MA10 > MA20 > MA60，且价在 MA5 上方 */
      const bull = ma5 > ma10 && ma10 > ma20 && ma20 > ma60 && last > ma5;
      /* 资金：主力净流入为正 */
      const cash = (c.mainNetInflow || 0) > 0;
      /* 量能：量比 > 1 */
      const vol = (c.volumeRatio || 0) > 1;
      /* 位置：不追高（偏离 MA20 不超过 15%） */
      const dev = (last / ma20 - 1) * 100;
      const safe = dev < 15;

      let score = 0;
      if (bull) score += 40;
      if (cash) score += 25;
      if (vol) score += 20;
      if (safe) score += 15;
      /* 资金强度加分 */
      const ratio = c.amount > 0 ? (c.mainNetInflow || 0) / c.amount * 100 : 0;
      if (ratio > 5) score += 10;
      else if (ratio > 2) score += 5;

      if (score < 50) return null;

      /* ---- 量化评分 v2：周线因子体系（移植自 quant_deliverables/features.py）----
         旧版 score 只看「均线多头+资金+量比+位置」四个布尔条件，缺少对
         「动量持续性 / 波动率 / 量能趋势 / 距前高回撤」这些横截面因子的度量。
         这里补上 8 个周线因子，方向统一为「越大越好」，MAD 去极值后等权合成。

         因子清单（与 features.compute_factors 一一对应，方向已统一）：
           mom_12_1     跳过最近 1 期的 12 期动量（规避短期反转污染）
           rev_4        4 期反转（取负，即跌多了加分）
           low_vol_12   12 期低波异象（波动越低越好，取负）
           amount_trend 近 4 期 vs 近 12 期成交额比值（量能回暖）
           trend_dev    价格相对 20 期均线偏离（趋势位置）
           trend_slope  20 期均线的 4 期斜率（趋势方向）
           pos_52       距 52 期高点回撤（越浅越好）
           low_amp_8    8 期平均振幅（取负，低振幅更稳）

         注意：这是单票时序视角的近似——真正的横截面 z-score 需要全市场面板，
         单票只能用「自身历史分位」代替截面排名，属降级近似。IC 语境下的红线
         （IC>0.03 / IR>0.5 / 正率>55%）由 wf_validate.py 离线验证，此处仅展示得分。 */
      const qf = weeklyFactors(cl, ks);   // cl 收盘价序列，ks 原始 K 线（含成交量）
      const qfScore = qf ? Math.round(qf.composite * 20 + 50) : null; // 映射到 50~90 区间展示

      /* ---- 预测结果 ---- */
      /* 目标价：20 日高点（未突破时）；已站上则按 6% 外推 */
      const target = hi20 > last ? round(hi20, 2) : round(last * 1.06, 2);
      /* 支撑位：在「低于现价」的候选（MA20 / MA60 / 20 日低点）中取最高者；
         若现价已跌破全部均线（此时 MA20 是压力位而非支撑），则退化为 20 日低点 */
      const below = [ma20, ma60, lo20].filter(v => v > 0 && v < last);
      const support = round(below.length ? Math.max.apply(null, below) : lo20, 2);
      const upside = round((target / last - 1) * 100, 2);
      const risk = round((last / support - 1) * 100, 2);   // 距支撑的下跌空间
      /* 支撑离现价不足 0.5% 时盈亏比会失真，视为无效 */
      const rr = risk >= 0.5 ? round(upside / risk, 2) : null;
      const view = score >= 85 ? '强烈看多' : score >= 70 ? '看多'
        : score >= 60 ? '偏多' : '中性';

      return Object.assign({}, c, {
        ma5: round(ma5, 2), ma10: round(ma10, 2), ma20: round(ma20, 2), ma60: round(ma60, 2),
        dev: round(dev, 2), netRatio: round(ratio, 2),
        score, bull, cash, vol, safe,
        hi20: round(hi20, 2), lo20: round(lo20, 2),
        target, support, upside, risk, rr, view,
        qfScore, qf: qf ? qf.detail : null   // 周线因子明细（8 个）
      });
    } catch (e) { return null; /* 单只失败跳过 */ }
  });
  return rows.filter(Boolean)
    .sort((a, b) => b.score - a.score || b.netRatio - a.netRatio);
}

/* ===================================================================
   周线因子计算（移植自 quant_deliverables/features.py · compute_factors）
   输入：收盘价序列 cl（数组，升序，至少 60 根）；原始 K 线 ks（用于取成交量）。
   输出：{ composite, detail } —— composite 是 8 因子等权合成（已 MAD 标准化），
         detail 是每个因子的原始值 + 方向说明，供前端 tooltip 展示。

   设计原则（features.py 原文）：
     1. 全部「越大越好」方向，便于等权合成，不必逐因子记符号
     2. 只用 t 时刻及之前数据，因子在 t 收盘后算、交易在 t+1 发生
     3. 样本量小，因子控制在 8 个以内，30 个弱因子只会放大过拟合
   =================================================================== */
function weeklyFactors(cl, ks) {
  if (!cl || cl.length < 60) return null;
  const n = cl.length;
  const last = cl[n - 1];
  const slice = (from) => cl.slice(from < 0 ? n + from : from);
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const std = (arr) => {
    const m = mean(arr);
    return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, arr.length - 1));
  };
  const rets = [];
  for (let i = 1; i < n; i++) rets.push(cl[i] / cl[i - 1] - 1);

  /* ---- 8 个因子（原始值，方向各异）---- */
  const mom_12_1 = last / cl[n - 13] - 1;                    // 12 期动量（跳最近 1 期）
  const rev_4 = -(last / cl[n - 5] - 1);                     // 4 期反转（取负）
  const low_vol_12 = -std(rets.slice(-12));                  // 低波异象（取负）
  /* 量能趋势：近 4 日均成交额 / 近 12 日均成交额。腾讯 K 线行序 [日期,开,收,高,低,量]，
     无成交额字段时用 收盘价×成交量 近似（amount ≈ close × volume）。 */
  const amtSeries = (ks && ks.length) ? ks.map(k => num(k[2]) * num(k[5])) : cl;
  const av4 = mean(amtSeries.slice(-4)), av12 = mean(amtSeries.slice(-12));
  const amount_trend = av12 ? av4 / av12 : 1;
  const ma20v = mean(slice(-20));
  const trend_dev = last / ma20v - 1;                        // 趋势位置
  const ma20_4ago = mean(cl.slice(n - 24, n - 4));
  const trend_slope = ma20v / ma20_4ago - 1;                 // 均线斜率
  const hi52 = Math.max.apply(null, slice(-52));
  const pos_52 = last / hi52 - 1;                            // 距 52 期高点回撤
  const amps = [];
  for (let i = Math.max(1, n - 8); i < n; i++) amps.push(cl[i] / cl[i - 1] - 1);
  const low_amp_8 = -mean(amps);                             // 低振幅（取负）

  const raw = { mom_12_1, rev_4, low_vol_12, amount_trend, trend_dev, trend_slope, pos_52, low_amp_8 };

  /* ---- 标准化（features.winsorize_and_zscore 的降级版）----
     真正的量化需要「全市场横截面」做 z-score——今天全市场几千只票的因子值
     排名的相对位置才是信号。单票只有时序，没有横截面可比，硬算 MAD 会量纲错乱
     （因子是百分比、却拿收盘价当中位数）。

     所以这里改用「经验阈值线性映射」：每个因子按 A 股历史经验设定一个合理上下界，
     超出截尾，再线性压到 [-2, 2]。这是单票视角下的降级近似，仅供展示参考；
     严格的样本外有效性由 wf_validate.py 在全市场面板上验证。 */
  const clampZ = (v, lo, hi) => {
    if (v == null || v !== v) return 0;
    const c = Math.max(lo, Math.min(hi, v));
    return ((c - (lo + hi) / 2) / ((hi - lo) / 2)) || 0;   // 压到 [-2, 2]
  };
  // 阈值依据 features.py 因子定义 + A 股周线经验分布（动量/偏离类 ±20% 已极端，
  // 波动率/振幅类年化 20~60%，量能比 0.5~2 为常态，距高回撤 0~-30%）
  const zMom = clampZ(mom_12_1 * 100, -20, 20);
  const zRev = clampZ(rev_4 * 100, -15, 15);
  const zLv = clampZ(low_vol_12 * 100, -3, 3);       // 周波动率 std，3% 已很高
  const zAt = clampZ(amount_trend, 0.4, 2.5);
  const zTd = clampZ(trend_dev * 100, -15, 15);
  const zTs = clampZ(trend_slope * 100, -8, 8);
  const zP = clampZ(pos_52 * 100, -30, 5);           // 创新高时 pos_52=0，深跌 -30%
  const zLa = clampZ(low_amp_8 * 100, -3, 3);
  const composite = (zMom + zRev + zLv + zAt + zTd + zTs + zP + zLa) / 8;

  return {
    composite,
    detail: {
      mom_12_1: round(mom_12_1 * 100, 2), rev_4: round(rev_4 * 100, 2),
      low_vol_12: round(low_vol_12 * 100, 2), amount_trend: round(amount_trend, 2),
      trend_dev: round(trend_dev * 100, 2), trend_slope: round(trend_slope * 100, 2),
      pos_52: round(pos_52 * 100, 2), low_amp_8: round(low_amp_8 * 100, 2),
      composite: round(composite, 2)
    }
  };
}
API['/forecast'] = async (res) => {
  ok(res, { date: todayDash(), list: (await forecastList()).slice(0, 20) });
};

/* ===================================================================
   A1 历史回测系统（REQUIREMENTS A1 · 最高优先级）

   ---------- 数据可得性限制（务必先读，不得虚构数据源）----------
   1. 历史某日的全市场快照（当日成交额榜、当日主力净流入 f62）不可得，
      东财 clist 只返回实时数据 → 资金维度（forecast 的 cash / 25 分，
      以及资金强度加分）在回测中记为「不可用」，不参与打分。
   2. 因此回测只覆盖 K 线可推导的三维：
        bull 均线多头 40 分（MA5>MA10>MA20>MA60 且 收盘>MA5）
        vol  量比近似 20 分（当日量 / 前 5 日均量 > 1）
        safe 位置安全 15 分（偏离 MA20 < 15%）
      满分 75 分。命中规则沿用线上口径：kScore >= minScore（默认 50）。
      注意 50 分这一门槛本身蕴含 bull 必为真（非 bull 时上限 20+15=35），
      与线上「score>=50 入选」在 K 线维度上完全等价。
      资金维度由 A2 事后追踪补齐（追踪落盘时资金数据是真实的）。
   3. 所有价格一律用**后复权 hfq**（见 D1）。原因：前复权历史价在每次
      除权后整体平移，用它回测会产生「当时并不存在」的假买卖点。

   ---------- 实测记录（上游 hfq 口径，勿删）----------
   - 腾讯 qfq 与东财 fqt=1 数值完全一致（600519：1473.53 / 1467.54 / 1545.68 / 1506.51）
   - 但 hfq 序列跨源、乃至与同源 qfq 都**不对齐**：
       腾讯内部 hfq 与 qfq 的日收益近似成常数倍（≈1.245），
       qfq/hfq 比值逐日变化（500 个交易日里变 497 次），不是除权阶跃；
       腾讯 hfq 与东财 fqt=2 的 5 日区间收益也不同
       （600519 2024-11-08→2024-11-15：TX hfq −2.79% / EM hfq −4.90% / qfq −3.38%）
     → 结论：本环境上游的「后复权」是各源各自生成的序列，互相不可对齐。
       回测内部自洽（买卖价取自同一条 hfq 序列），
       但**不能**用东财 App 的后复权 K 线做跨源逐笔核对，
       验收改用「同一条上游序列手工复算」的方式（见 A1 验收说明）。
   =================================================================== */
const BT_WARMUP = 60;        // 指标预热：MA60 所需的最小历史
const BT_MAX_CODES = 30;
const BT_MAX_DAYS = 500;
const BT_HOLDS = [1, 5, 10, 20];
const BT_BENCH_SEC = '1.000300';   // 沪深300
const BT_BENCH_SYM = 'sh000300';
const BT_BENCH_NAME = '沪深300';

/* 结果缓存：TTL 10 分钟，key = sha1(codes 排序 + days + hold + minScore) */
const BT_CACHE = new Map();
const BT_TTL = 10 * 60 * 1000;
const BT_CACHE_MAX = 64;
/* K 线缓存（L1）：切 hold 时不重打上游，这是「切换 <3s / 命中 <100ms」的关键 */
const KL_CACHE = new Map();
const KL_TTL = 30 * 60 * 1000;
const KL_CACHE_MAX = 320;
/* 同 key 并发合并：避免同一批请求重复打上游 */
const KL_INFLIGHT = new Map();

function cacheKeyOf(o) {
  return 'bt:' + createHash('sha1')
    .update([o.codes.join(','), o.days, o.hold, o.minScore].join('|')).digest('hex').slice(0, 16);
}
function cachePut(map, max, key, val) {
  if (map.size >= max) map.delete(map.keys().next().value);   // 简易 FIFO 淘汰
  map.set(key, val);
}

/* 取后复权日 K（带 L1 缓存 + 并发合并） */
function klineCached(sym, bars, fq) {
  const key = (fq || 'hfq') + ':' + sym + ':' + bars;
  const hit = KL_CACHE.get(key);
  if (hit && Date.now() - hit.t < KL_TTL) return Promise.resolve(hit.arr);
  const flying = KL_INFLIGHT.get(key);
  if (flying) return flying;
  const p = txKlineBatched(sym, 'day', bars, fq || 'hfq')
    .then(arr => {
      cachePut(KL_CACHE, KL_CACHE_MAX, key, { t: Date.now(), arr });
      KL_INFLIGHT.delete(key);
      return arr;
    })
    .catch(e => { KL_INFLIGHT.delete(key); throw e; });
  KL_INFLIGHT.set(key, p);
  return p;
}

/* ---- 统计工具（口径见 REQUIREMENTS §4）---- */
function meanAt(arr, endIdx, n) {          // arr[endIdx-n+1 .. endIdx] 均值
  let s = 0;
  for (let k = endIdx - n + 1; k <= endIdx; k++) s += num(arr[k]);
  return s / n;
}
function medianOf(a) {
  const b = a.slice().sort((x, y) => x - y);
  const n = b.length;
  if (!n) return 0;
  return n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2;
}
/* 最大回撤：max(1 − nav_t / max_{s≤t} nav_s) */
function maxDrawdown(nav) {
  if (!nav.length) return 0;
  let peak = nav[0], mdd = 0;
  for (let i = 0; i < nav.length; i++) {
    if (nav[i] > peak) peak = nav[i];
    const d = peak > 0 ? 1 - nav[i] / peak : 0;
    if (d > mdd) mdd = d;
  }
  return mdd;
}

/* 扫描单只股票的信号：只用 t 日及之前的数据，避免未来函数 */
function scanSignals(ks, hold, windowDays, minScore) {
  const N = ks.length;
  if (N < BT_WARMUP + hold + 2) return [];
  const cl = ks.map(k => num(k[2]));
  const vl = ks.map(k => num(k[5]));
  const lastBuy = N - 1 - hold;
  const firstBuy = Math.max(BT_WARMUP, lastBuy - (windowDays - 1));
  const out = [];
  for (let i = firstBuy; i <= lastBuy; i++) {
    const ma5 = meanAt(cl, i, 5), ma10 = meanAt(cl, i, 10),
      ma20 = meanAt(cl, i, 20), ma60 = meanAt(cl, i, 60);
    if (!(ma20 > 0) || !(ma60 > 0)) continue;
    const bull = ma5 > ma10 && ma10 > ma20 && ma20 > ma60 && cl[i] > ma5;
    const avgVol5 = meanAt(vl, i - 1, 5);            // 前 5 日均量（不含当日）
    const vol = avgVol5 > 0 && vl[i] / avgVol5 > 1;  // 量比近似（K 线可推导）
    const dev = (cl[i] / ma20 - 1) * 100;
    const safe = dev < 15;
    const kScore = (bull ? 40 : 0) + (vol ? 20 : 0) + (safe ? 15 : 0);
    if (kScore < minScore) continue;
    const j = i + hold;
    if (!cl[i] || !cl[j]) continue;
    out.push({
      i, date: String(ks[i][0]), buy: cl[i],
      j, sellDate: String(ks[j][0]), sell: cl[j],
      ret: cl[j] / cl[i] - 1,
      bull, vol, safe, kScore
    });
  }
  return out;
}

/* 按信号等权逐日组合构建净值曲线
   - 每笔信号在 (t, t+hold] 区间内持有；当日组合收益 = 所有持仓当日收益的等权均值
   - 无持仓的交易日按空仓处理（收益 0），曲线在整段窗口上连续
   - 基准按同一条日期轴，用沪深300 的日收益同步推进 */
function buildNav(sigList, benchRows) {
  const axisSet = new Set();
  sigList.forEach(s => s.signals.forEach(x => { axisSet.add(x.date); axisSet.add(x.sellDate); }));
  (benchRows || []).forEach(r => axisSet.add(String(r[0])));
  const axis = Array.from(axisSet).sort();
  if (!axis.length) return { dates: [], portfolio: [], benchmark: [] };
  const idx = {}; axis.forEach((d, i) => { idx[d] = i; });
  const bmMap = {};
  (benchRows || []).forEach(r => { bmMap[String(r[0])] = num(r[2]); });

  const buckets = new Array(axis.length);
  sigList.forEach(s => {
    const cl = s.cl;
    s.signals.forEach(x => {
      for (let k = x.i + 1; k <= x.j; k++) {
        const d = String(s.dates[k]);
        const p = idx[d];
        if (p === undefined) continue;
        const prev = num(cl[k - 1]);
        if (!(prev > 0)) continue;
        (buckets[p] || (buckets[p] = [])).push(num(cl[k]) / prev - 1);
      }
    });
  });

  /* 把日期轴裁剪到「有持仓」的区间：
     基准序列比信号窗口多出 hold+预热 根，不裁剪的话基准曲线会提前起跑，
     两条净值线起点不同就无法比较。裁剪后两条曲线都从 1 开始。 */
  let lo = -1, hi = -1;
  for (let t = 0; t < axis.length; t++) {
    if (buckets[t] && buckets[t].length) { if (lo < 0) lo = t; hi = t; }
  }
  if (lo < 0) return { dates: [], portfolio: [], benchmark: [] };
  /* lo 是「第一个产生收益的交易日」（= 首个买入日的次日）。
     净值轴必须再往前取一天（首个买入日），否则 lo 这一天的收益会在下面的
     循环里被跳过（循环从 t=1 开始取 buckets[t+lo]）。 */
  const dates = axis.slice(Math.max(0, lo - 1), hi + 1);
  const off = axis.length - (hi + 1) >= 0 ? (lo - Math.max(0, lo - 1)) : 0;

  const navP = new Array(dates.length);
  const navB = new Array(dates.length);
  let p = 1, b = 1;
  navP[0] = 1; navB[0] = 1;
  let lastBm = bmMap[dates[0]];
  for (let t = 1; t < dates.length; t++) {
    const bt = buckets[t + lo - off];
    if (bt && bt.length) {
      let s = 0; bt.forEach(v => { s += v; });
      p *= (1 + s / bt.length);
    }
    const cv = bmMap[dates[t]];
    if (cv !== undefined) {
      if (lastBm > 0) b *= cv / lastBm;
      lastBm = cv;
    }
    navP[t] = p; navB[t] = b;
  }
  return { dates, portfolio: navP, benchmark: navB };
}

/* 收益分布直方图（单位 %） */
function buildHist(rets, bins) {
  const n = bins || 12;
  if (!rets.length) return [];
  const pcts = rets.map(r => r * 100);
  let mn = Math.min.apply(null, pcts), mx = Math.max.apply(null, pcts);
  if (mx - mn < 1e-9) { mn -= 0.5; mx += 0.5; }
  const w = (mx - mn) / n;
  const out = [];
  for (let k = 0; k < n; k++) out.push({ from: mn + k * w, to: mn + (k + 1) * w, count: 0 });
  pcts.forEach(v => {
    let k = Math.floor((v - mn) / w);
    if (k < 0) k = 0; if (k >= n) k = n - 1;
    out[k].count++;
  });
  return out.map(x => ({ from: round(x.from, 2), to: round(x.to, 2), count: x.count }));
}

/* ---------------- /api/backtest ---------------- */
API['/backtest'] = async (res, q) => {
  const t0 = Date.now();
  const days = Math.max(20, Math.min(parseInt(q.get('days') || '250', 10) || 250, BT_MAX_DAYS));
  const holdRaw = parseInt(q.get('hold') || '5', 10) || 5;
  const hold = BT_HOLDS.indexOf(holdRaw) > -1 ? holdRaw : 5;
  const minScore = Math.max(0, Math.min(parseInt(q.get('minScore') || '50', 10) || 50, 75));

  /* 1) 股票池：显式 codes 优先；否则取当前 forecast 推荐列表（上限 30） */
  let codes = (q.get('codes') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!codes.length) {
    codes = (await forecastList()).slice(0, BT_MAX_CODES).map(x => x.code);
  }
  codes = Array.from(new Set(codes)).slice(0, BT_MAX_CODES);
  if (!codes.length) return fail(res, '无可回测的股票池', 400);

  /* 2) 缓存（key = codes 排序 hash + days + hold + minScore） */
  const ckey = cacheKeyOf({ codes: codes.slice().sort(), days, hold, minScore });
  const hit = BT_CACHE.get(ckey);
  if (hit && Date.now() - hit.t < BT_TTL) {
    return ok(res, Object.assign({}, hit.data, {
      meta: Object.assign({}, hit.data.meta, { cached: true, costMs: Date.now() - t0 })
    }));
  }

  /* 3) 拉取后复权日 K
     预热 60 根 + 最长持有期 20 根 + 窗口 days 根。
     注意：bar 数固定按「最长持有期」取，与本次 hold 无关 ——
     这样切换 hold 重跑时能命中 L1 K 线缓存，不必重新打上游。
     scanSignals 内部按 hold 反推起止索引，评估点恒为 days 个。 */
  const need = days + BT_HOLDS[BT_HOLDS.length - 1] + BT_WARMUP;
  const items = codes.map(c => {
    const i = c.indexOf('.');
    const code = i > 0 ? c.slice(i + 1) : c;
    const mkt = i > 0 ? c.slice(0, i) : (/^(6|9|5|11)/.test(code) ? '1' : '0');
    return { code, mkt, sym: txSymOf({ mkt, sym: code, code }) };
  });

  const [series, benchRows] = await Promise.all([
    mapLimit(items, 4, async (it) => {
      const ks = await klineCached(it.sym, need, 'hfq');
      if (!ks || ks.length < BT_WARMUP + hold + 2) return null;
      return {
        code: it.code, sym: it.sym,
        dates: ks.map(k => String(k[0])),
        cl: ks.map(k => num(k[2])),
        signals: scanSignals(ks, hold, days, minScore)
      };
    }),
    klineCached(BT_BENCH_SYM, need, 'hfq').catch(() => [])
  ]);

  /* 4) 名称（1 次批量快照请求，同样走闸门）
        只重试 1 次：名称是锦上添花，不能让它拖慢回测主流程
        （实测东财 push2 在部分网络下会持续 socket closed，重试 4 次要 4.6s） */
  const nameMap = {};
  try {
    const j = await getJSON(`${EM}/api/qt/ulist.np/get?secids=${items.map(it => it.mkt + '.' + it.code).join(',')}` +
      `&fields=f12,f14&fltt=2&invt=2`, {}, 1);
    const arr = j?.data?.diff ? (Array.isArray(j.data.diff) ? j.data.diff : Object.values(j.data.diff)) : [];
    arr.forEach(x => { nameMap[String(x.f12)] = x.f14 || ''; });
  } catch (e) { /* 名称失败不影响指标，回落为代码 */ }

  const valid = series.filter(Boolean);
  const skipped = items.filter(it => !series.find(s => s && s.code === it.code)).map(it => it.code);
  if (!valid.length) return fail(res, 'K 线数据不可用（' + items.length + ' 只全部拉取失败，上游可能限流）', 502);

  /* 5) 逐信号对齐基准，计算同期基准收益 */
  const benchDates = (benchRows || []).map(r => String(r[0])).sort();
  const benchCl = {};
  (benchRows || []).forEach(r => { benchCl[String(r[0])] = num(r[2]); });
  /* 取 date 当日基准收盘；缺失则向前找最近交易日 */
  function benchAt(date) {
    if (benchCl[date] !== undefined) return benchCl[date];
    let lo = 0, hi = benchDates.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (benchDates[mid] <= date) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best >= 0 ? benchCl[benchDates[best]] : 0;
  }

  const all = [];
  const perStock = valid.map(s => {
    let sum = 0;
    s.signals.forEach(x => {
      const b0 = benchAt(x.date), b1 = benchAt(x.sellDate);
      x.benchRet = (b0 > 0 && b1 > 0) ? b1 / b0 - 1 : null;
      sum += x.ret;
      all.push(Object.assign({ code: s.code, name: nameMap[s.code] || s.code }, x));
    });
    return {
      code: s.code, name: nameMap[s.code] || s.code,
      count: s.signals.length,
      avgReturn: s.signals.length ? round(sum / s.signals.length * 100, 3) : null
    };
  });

  const rets = all.map(x => x.ret);
  const wins = rets.filter(r => r > 0).length;
  const avgReturn = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const medianReturn = medianOf(rets);
  const benchRets = all.map(x => x.benchRet).filter(v => v != null);
  const benchAvg = benchRets.length ? benchRets.reduce((a, b) => a + b, 0) / benchRets.length : 0;

  /* 6) 净值曲线（等权逐日组合）与最大回撤 */
  const nav = buildNav(valid, benchRows);
  const portMdd = maxDrawdown(nav.portfolio);
  const benchMdd = maxDrawdown(nav.benchmark);
  const n0 = nav.benchmark.length ? nav.benchmark[nav.benchmark.length - 1] : 1;

  const dates = all.map(x => x.date).sort();

  const data = {
    meta: {
      codes, days, hold, minScore,
      benchmark: { secid: BT_BENCH_SEC, code: '000300', name: BT_BENCH_NAME },
      window: { start: dates[0] || '', end: dates[dates.length - 1] || '' },
      warmup: BT_WARMUP,
      barsNeeded: need,
      skipped: skipped,            // K 线拉取失败的股票（上游限流时会非空）
      cashUnknown: true,
      dimensions: { bull: 40, vol: 20, safe: 15, cash: '不可用（历史全市场资金快照不可得）' },
      note: '资金维度(cash/25分)历史不可得，回测仅覆盖 K 线可推导的 bull/vol/safe 三维（满分 75）；' +
        '命中阈值沿用线上 score>=50，且 50 分门槛蕴含 bull 必为真。价格一律用后复权(hfq)。',
      cached: false, costMs: Date.now() - t0
    },
    signals: {
      count: all.length,
      stockCount: valid.length,
      perStock
    },
    winRate: round(all.length ? wins / all.length * 100 : 0, 2),
    avgReturn: round(avgReturn * 100, 3),
    medianReturn: round(medianReturn * 100, 3),
    excess: round((avgReturn - benchAvg) * 100, 3),
    maxDrawdown: round(portMdd * 100, 2),
    benchmark: {
      code: '000300', name: BT_BENCH_NAME,
      avgReturn: round(benchAvg * 100, 3),
      periodReturn: round((n0 - 1) * 100, 3),
      maxDrawdown: round(benchMdd * 100, 2),
      samples: benchRets.length
    },
    nav: {
      dates: nav.dates,
      portfolio: nav.portfolio.map(v => round(v, 4)),
      benchmark: nav.benchmark.map(v => round(v, 4))
    },
    hist: buildHist(rets, 14),
    /* 明细最多返回 200 条，供前端抽样核对 */
    sample: all.sort((a, b) => (a.date < b.date ? -1 : 1)).slice(0, 200).map(x => ({
      code: x.code, name: x.name, date: x.date, buy: round(x.buy, 3),
      sellDate: x.sellDate, sell: round(x.sell, 3),
      ret: round(x.ret * 100, 3), benchRet: x.benchRet == null ? null : round(x.benchRet * 100, 3),
      bull: x.bull, vol: x.vol, safe: x.safe, kScore: x.kScore
    }))
  };

  cachePut(BT_CACHE, BT_CACHE_MAX, ckey, { t: Date.now(), data });
  ok(res, data);
};

/* ===================================================================
   邮件通知
   配置落盘 data/mail.json；按 intervalMin 巡检规则，命中即发信。
   规则：自选异动 / 指数异动 / 价格突破（一次性）/ 收盘日报
   冷却：同类事件默认 60 分钟，避免盘中反复轰炸
   =================================================================== */
const MAIL_FILE = path.join(ROOT, 'data', 'mail.json');
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (e) { nodemailer = null; }

const MAIL_COOLDOWN = 60 * 60 * 1000;          // 事件类冷却：60 分钟
const MAIL_IDX = [['1.000001', '上证指数'], ['0.399001', '深证成指'], ['0.399006', '创业板指']];

function mailDefault() {
  return {
    to: '', enabled: false, intervalMin: 15,
    rules: { watchPct: 0, idxPct: 0, daily: false, alerts: [] },
    smtp: { host: '', port: 465, secure: true, user: '', pass: '', from: '' },
    watchlist: [],      // 前端保存设置时附带上传（自选股本就存在浏览器本地）
    sent: {},           // 冷却记录：key -> ms
    lastCheckAt: ''
  };
}
let MAIL = mailDefault();

async function mailLoad() {
  try {
    const j = JSON.parse(await fsp.readFile(MAIL_FILE, 'utf8'));
    const d = mailDefault();
    MAIL = Object.assign(d, j, {
      rules: Object.assign(d.rules, j.rules || {}),
      smtp: Object.assign(d.smtp, j.smtp || {}),
      sent: j.sent && typeof j.sent === 'object' ? j.sent : {}
    });
  } catch (e) { MAIL = mailDefault(); }
  return MAIL;
}
async function mailSave() {
  await fsp.mkdir(path.dirname(MAIL_FILE), { recursive: true });
  await fsp.writeFile(MAIL_FILE, JSON.stringify(MAIL, null, 2), 'utf8');
}

/* 只保留白名单字段并限长；口令留空表示「不修改」 */
function mailClean(b) {
  const cur = MAIL;
  const num01 = (v, d) => { const n = Number(v); return isNaN(n) ? d : Math.min(100, Math.max(0, n)); };
  const alerts = (Array.isArray(b.rules && b.rules.alerts) ? b.rules.alerts : [])
    .slice(0, 30)
    .map(a => {
      const price = Number(a && a.price);
      const code = String((a && a.code) || '').trim().slice(0, 16);
      if (!code || isNaN(price) || price <= 0) return null;
      return {
        code,
        name: String((a && a.name) || code).trim().slice(0, 40),
        dir: a && a.dir === 'down' ? 'down' : 'up',
        price: round(price, 3)
      };
    }).filter(Boolean);
  return {
    to: String(b.to || '').trim().slice(0, 120),
    enabled: !!b.enabled,
    intervalMin: [5, 15, 30, 60].indexOf(Number(b.intervalMin)) > -1 ? Number(b.intervalMin) : 15,
    rules: {
      watchPct: num01(b.rules && b.rules.watchPct, 0),
      idxPct: num01(b.rules && b.rules.idxPct, 0),
      daily: !!(b.rules && b.rules.daily),
      alerts
    },
    smtp: {
      host: String((b.smtp && b.smtp.host) || '').trim().slice(0, 120),
      port: Math.min(65535, Math.max(1, parseInt(b.smtp && b.smtp.port, 10) || 465)),
      secure: !!(b.smtp && b.smtp.secure),
      user: String((b.smtp && b.smtp.user) || '').trim().slice(0, 160),
      /* 留空 = 沿用已保存的口令（前端不回填明文，避免误以为被清空） */
      pass: b.smtp && b.smtp.pass ? String(b.smtp.pass).slice(0, 256) : cur.smtp.pass,
      from: String((b.smtp && b.smtp.from) || '').trim().slice(0, 160)
    },
    watchlist: (Array.isArray(b.watchlist) ? b.watchlist : []).slice(0, 200).map(w => ({
      code: String((w && w.code) || '').trim().slice(0, 16),
      name: String((w && w.name) || '').trim().slice(0, 40),
      secid: /^[0-9]{1,3}\.[A-Za-z0-9]{1,12}$/.test(String((w && w.secid) || '')) ? String(w.secid) : ''
    })).filter(w => w.code),
    sent: cur.sent,
    lastCheckAt: cur.lastCheckAt
  };
}

/* ---------- 发信 ---------- */
function mailTransport() {
  if (!nodemailer) throw new Error('服务端缺少 nodemailer，请在项目目录执行 npm i nodemailer');
  const s = MAIL.smtp;
  if (!s.host || !s.user || !s.pass) throw new Error('SMTP 未配置完整（服务器 / 账号 / 授权码）');
  return nodemailer.createTransport({
    host: s.host,
    port: s.port || 465,
    secure: !!s.secure,
    auth: { user: s.user, pass: s.pass },
    connectionTimeout: 12000,
    greetingTimeout: 12000,
    socketTimeout: 20000
  });
}
async function mailSend(subject, html) {
  if (!MAIL.to) throw new Error('未设置接收邮箱');
  const s = MAIL.smtp;
  await mailTransport().sendMail({
    from: s.from || s.user,
    to: MAIL.to,
    subject,
    html
  });
}
function pctCls(v) { return v > 0 ? 'up' : (v < 0 ? 'down' : 'flat'); }
function pctTxt(v) { return v == null ? '--' : (v > 0 ? '+' : '') + round(v, 2) + '%'; }
function mailShell(title, body) {
  return '<div style="max-width:620px;margin:0 auto;font:14px/1.7 -apple-system,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;' +
    'color:#1f2329;background:#fff;border:1px solid #e6e8ec;border-radius:14px;overflow:hidden">' +
    '<div style="padding:14px 18px;background:linear-gradient(135deg,#4f46e5,#0ea5e9);color:#fff;font-size:16px;font-weight:700">' +
    '行情通 · ' + title + '</div>' +
    '<div style="padding:16px 18px">' + body + '</div>' +
    '<div style="padding:10px 18px 14px;color:#8a8f99;font-size:12px;border-top:1px solid #eef1f5">' +
    '本邮件由行情通自动发送 · ' + new Date().toLocaleString('zh-CN') + ' · 仅供学习研究，不构成投资建议</div>' +
    '</div>';
}
function mailTable(rows) {
  const th = 'padding:8px 10px;text-align:center;font-size:12px;color:#2a2f3a;background:#eef1fb;';
  const td = 'padding:8px 10px;text-align:center;font-size:13px;border-top:1px solid #eef1f5;';
  const col = v => (v > 0 ? 'color:#f5483b;font-weight:600' : (v < 0 ? 'color:#16a34a;font-weight:600' : 'color:#8a8f99'));
  return '<table style="width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums">' +
    '<thead><tr><th style="' + th + '">名称</th><th style="' + th + '">现价</th><th style="' + th + '">涨跌幅</th></tr></thead>' +
    '<tbody>' + rows.map(r =>
      '<tr><td style="' + td + '">' + r.name + '<span style="color:#b4b9c4;font-size:12px"> ' + r.code + '</span></td>' +
      '<td style="' + td + ';font-family:Consolas,monospace">' + (r.price == null ? '--' : round(r.price, 2)) + '</td>' +
      '<td style="' + td + ';' + col(r.pct) + ';font-family:Consolas,monospace">' + pctTxt(r.pct) + '</td></tr>'
    ).join('') + '</tbody></table>';
}
function mailList(items) {
  return '<ul style="margin:0;padding-left:20px">' + items.map(t => '<li style="margin:5px 0">' + t + '</li>').join('') + '</ul>';
}

/* ---------- 行情抓取（复用东方财富批量快照） ---------- */
async function fetchQuotes(codes) {
  const list = (codes || []).filter(Boolean).slice(0, 60);
  if (!list.length) return [];
  const ids = list.map(c => secidOf(undefined, c)).join(',');
  const j = await getJSON(`${EM}/api/qt/ulist.np/get?secids=${ids}&fields=f2,f3,f4,f12,f13,f14&fltt=2&invt=2`);
  const arr = j && j.data && j.data.diff ? (Array.isArray(j.data.diff) ? j.data.diff : Object.values(j.data.diff)) : [];
  return arr.map(x => ({
    code: String(x.f12 || ''), name: x.f14 || '',
    price: round(x.f2), pct: round(x.f3), change: round(x.f4)
  })).filter(x => x.code);
}
async function fetchIndices(secids) {
  const j = await getJSON(`${EM}/api/qt/ulist.np/get?secids=${secids.join(',')}&fields=f2,f3,f4,f12,f14&fltt=2&invt=2`);
  const arr = j && j.data && j.data.diff ? (Array.isArray(j.data.diff) ? j.data.diff : Object.values(j.data.diff)) : [];
  const map = {};
  arr.forEach(x => { map[String(x.f12)] = x; });
  return secids.map(sid => {
    const code = sid.slice(sid.indexOf('.') + 1);
    const x = map[code];
    if (!x) return null;
    return { secid: sid, code, name: x.f14 || '', price: round(x.f2), pct: round(x.f3) };
  }).filter(Boolean);
}

/* ---------- 规则巡检 ----------
   force=true 时忽略冷却（供「立即巡检」按钮使用） */
async function mailCheck(force) {
  const out = { sent: 0, hits: [] };
  if (!MAIL.enabled || !MAIL.to) return Object.assign(out, { skipped: '未启用或未填接收邮箱' });
  const r = MAIL.rules || {};
  const now = Date.now();
  const hits = [];

  /* 1. 自选异动 */
  const wl = (MAIL.watchlist || []).slice(0, 60);
  if (r.watchPct > 0 && wl.length) {
    const qs = await fetchQuotes(wl.map(x => x.code));
    qs.forEach(q => {
      if (q.pct == null || Math.abs(q.pct) < r.watchPct) return;
      const key = 'watch:' + q.code;
      if (!force && now - (MAIL.sent[key] || 0) < MAIL_COOLDOWN) return;
      MAIL.sent[key] = now;
      hits.push('<b>' + q.name + '</b>（' + q.code + '）现价 <b>' + round(q.price, 2) +
        '</b>，涨跌 <b style="color:' + (q.pct > 0 ? '#f5483b' : '#16a34a') + '">' + pctTxt(q.pct) + '</b>');
    });
  }

  /* 2. 指数异动 */
  if (r.idxPct > 0) {
    const idx = await fetchIndices(MAIL_IDX.map(x => x[0]));
    idx.forEach(x => {
      if (x.pct == null || Math.abs(x.pct) < r.idxPct) return;
      const key = 'idx:' + x.code;
      if (!force && now - (MAIL.sent[key] || 0) < MAIL_COOLDOWN) return;
      MAIL.sent[key] = now;
      hits.push('<b>' + x.name + '</b> 现价 <b>' + round(x.price, 2) +
        '</b>，涨跌 <b style="color:' + (x.pct > 0 ? '#f5483b' : '#16a34a') + '">' + pctTxt(x.pct) + '</b>');
    });
  }

  /* 3. 价格提醒（一次性，触发即从列表移除） */
  const alerts = (r.alerts || []).slice();
  if (alerts.length) {
    const qs = await fetchQuotes(alerts.map(a => a.code));
    const map = {};
    qs.forEach(q => { map[String(q.code)] = q; });
    const keep = [];
    alerts.forEach(a => {
      const q = map[String(a.code)];
      if (!q || q.price == null) { keep.push(a); return; }
      const hit = a.dir === 'down' ? q.price <= a.price : q.price >= a.price;
      if (hit) {
        hits.push('<b>' + (a.name || q.name) + '</b>（' + a.code + '）' +
          (a.dir === 'down' ? '跌破' : '突破') + ' <b>' + round(a.price, 2) +
          '</b>，现价 <b>' + round(q.price, 2) + '</b>（' + pctTxt(q.pct) + '）');
      } else keep.push(a);
    });
    r.alerts = keep;
  }

  /* 4. 收盘日报（每交易日 15:30 后，一天一封） */
  const dayKey = 'daily:' + todayDash();
  if (r.daily && !MAIL.sent[dayKey]) {
    const d = new Date();
    const wd = d.getDay();
    const hhmm = d.getHours() * 60 + d.getMinutes();
    if (wd >= 1 && wd <= 5 && (hhmm >= 930 || force)) {
      MAIL.sent[dayKey] = now;
      const idx = await fetchIndices(MAIL_IDX.map(x => x[0]));
      const qs = await fetchQuotes(wl.map(x => x.code));
      let body = '';
      if (idx.length) body += '<div style="margin-bottom:14px"><div style="font-weight:700;margin-bottom:8px">大盘指数</div>' + mailTable(idx) + '</div>';
      if (qs.length) body += '<div><div style="font-weight:700;margin-bottom:8px">自选股（' + qs.length + ' 只）</div>' + mailTable(qs) + '</div>';
      if (!body) body = '<div style="color:#8a8f99">暂无可汇总的数据</div>';
      await mailSend('自选日报 ' + todayDash(), mailShell('自选日报 ' + todayDash(), body));
      out.sent++;
    }
  }

  if (hits.length) {
    await mailSend('行情提醒 · ' + hits.length + ' 条命中',
      mailShell('行情提醒', mailList(hits) + '<div style="margin-top:12px;color:#8a8f99;font-size:12px">同类事件 60 分钟内只提醒一次</div>'));
    out.sent++;
  }

  out.hits = hits.map(h => h.replace(/<[^>]+>/g, ''));
  /* 清掉 7 天前的冷却记录，避免 sent 无限膨胀 */
  const cutoff = now - 7 * 86400000;
  Object.keys(MAIL.sent).forEach(k => { if (MAIL.sent[k] < cutoff) delete MAIL.sent[k]; });
  MAIL.lastCheckAt = new Date().toLocaleString('zh-CN');
  await mailSave();
  return out;
}

API['/mail/config'] = async (res, q, req) => {
  if (req.method === 'POST') {
    const b = await readBody(req, res);
    MAIL = Object.assign(MAIL, mailClean(b));
    await mailSave();
    return ok(res, { saved: true, lastCheckAt: MAIL.lastCheckAt, relay: !!nodemailer });
  }
  /* GET：不下发口令明文，只告诉前端「有没有」 */
  ok(res, {
    to: MAIL.to, enabled: MAIL.enabled, intervalMin: MAIL.intervalMin,
    rules: {
      watchPct: MAIL.rules.watchPct, idxPct: MAIL.rules.idxPct,
      daily: MAIL.rules.daily, alerts: MAIL.rules.alerts
    },
    smtp: {
      host: MAIL.smtp.host, port: MAIL.smtp.port, secure: MAIL.smtp.secure,
      user: MAIL.smtp.user, from: MAIL.smtp.from, hasPass: !!MAIL.smtp.pass
    },
    watchCount: (MAIL.watchlist || []).length,
    lastCheckAt: MAIL.lastCheckAt,
    relay: !!nodemailer
  });
};
API['/mail/test'] = async (res, q, req) => {
  await readBody(req, res);
  if (!MAIL.to) return fail(res, '请先填写接收邮箱', 400);
  const idx = await fetchIndices(MAIL_IDX.map(x => x[0])).catch(() => []);
  const body = '<div style="margin-bottom:12px">这是一封来自「行情通」的测试邮件。SMTP 配置正常，你将会收到下面的提醒。</div>' +
    (idx.length ? mailTable(idx) : '<div style="color:#8a8f99">（指数快照获取失败，不影响发信功能）</div>');
  await mailSend('测试邮件 · 行情通', mailShell('测试邮件', body));
  MAIL.lastCheckAt = new Date().toLocaleString('zh-CN');
  await mailSave();
  ok(res, { sent: true, to: MAIL.to });
};
API['/mail/check'] = async (res, q, req) => {
  await readBody(req, res);
  const r = await mailCheck(true);
  ok(res, r);
};

function serveStatic(req, res, pathname) {
  let fp = path.join(ROOT, pathname === '/' ? 'index.html' : decodeURIComponent(pathname));
  // 防目录穿越
  if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }

  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) {
      // SPA 回退
      fp = path.join(ROOT, 'index.html');
    }
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': (ext === '.html' || ext === '.js' || ext === '.css') ? 'no-cache' : 'public, max-age=300'
    });
    fs.createReadStream(fp).pipe(res);
  });
}

/* ===================================================================
   服务器
   =================================================================== */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = u.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  if (pathname.startsWith('/api/')) {
    const key = pathname.slice('/api'.length);   // 去掉 /api 前缀
    const h = API[key];
    if (!h) return fail(res, '未知接口: ' + pathname, 404);
    if (req.method === 'POST' && !POST_OK[key]) {
      return fail(res, '该接口不支持 POST', 405);
    }
    try {
      await h(res, u.searchParams, req);   // 第三个参数给需要用请求体的接口
    } catch (e) {
      console.error('[API]', pathname, e.message);
      fail(res, e.message || '上游数据获取失败');
    }
    return;
  }

  serveStatic(req, res, pathname);
});

fs.mkdirSync(SYNC_DIR, { recursive: true });

/* 邮件巡检调度：每 60 秒看一次是否到了 intervalMin 的间隔。
   首次启动先给足一个间隔，避免刚起来就发一封 */
let mailLastRun = Date.now();
setInterval(async () => {
  if (!MAIL.enabled || !MAIL.to) return;
  const gap = (MAIL.intervalMin || 15) * 60000;
  if (Date.now() - mailLastRun < gap) return;
  mailLastRun = Date.now();
  try {
    const r = await mailCheck(false);
    if (r.sent) console.log('[邮件] 巡检命中，已发送 ' + r.sent + ' 封');
  } catch (e) {
    console.error('[邮件] 巡检失败:', e.message);
  }
}, 60000);

mailLoad().then(() => {
  console.log('[邮件] 配置已加载：' + (MAIL.enabled ? '已启用 → ' + MAIL.to : '未启用') +
    '，发信组件 ' + (nodemailer ? '就绪' : '缺失（npm i nodemailer）'));
});

server.listen(PORT, () => {
  console.log('\n  ┌──────────────────────────────────────────┐');
  console.log('  │   行情通 · 股市数据终端                  │');
  console.log('  ├──────────────────────────────────────────┤');
  console.log(`  │   本地访问:  http://localhost:${PORT}         │`);
  console.log('  │   停止服务:  Ctrl + C                     │');
  console.log('  └──────────────────────────────────────────┘\n');
});

process.on('uncaughtException', e => console.error('[ERR]', e.message));
process.on('unhandledRejection', e => console.error('[REJ]', e && e.message));

/* ===================================================================
   定时预热：让重接口的缓存永不过期，彻底消除冷启动
   慢层（翻 56 页约 7 秒）与概念板块（翻 6 页约 1 秒）冷启动成本明显。
   服务就绪后定时请求自身接口刷新缓存，用户请求时永远命中热缓存。
   注意：预热同样走全局闸门（并发 6 / 间隔 110ms），间隔不宜过密，
   以免抢占前台交互请求；实测每轮约占 10% 闸门吞吐，影响可忽略。
   =================================================================== */
const WARM_INTERVAL = 20000;
async function warmUpOnce() {
  const selfFetch = (p) =>
    fetch(`http://127.0.0.1:${PORT}${p}`).then((r) => r.json()).catch(() => null);
  await selfFetch('/api/market-stat?mode=fast');                    // 快层（15s TTL）
  await selfFetch('/api/sector-capital?type=industry&sort=flow');   // 行业（30s TTL）
  await selfFetch('/api/sector-capital?type=concept&sort=flow');    // 概念（30s TTL）
  await selfFetch('/api/market-stat');                              // 慢层由路由按 TTL 判断是否刷新
}
function startWarmUp() {
  warmUpOnce();
  setInterval(warmUpOnce, WARM_INTERVAL);
}
/* 延迟 5 秒启动，避开服务启动阶段 */
setTimeout(startWarmUp, 5000);
