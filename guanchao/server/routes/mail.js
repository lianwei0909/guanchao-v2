/* 由 server.js 机械拆分而来，行为未改动。 */
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { EM, ROOT } = require('../config.js');
const { round, todayDash } = require('../lib/format.js');
const { getJSON } = require('../lib/http.js');
const { fail, ok, readBody } = require('../lib/respond.js');
const { secidOf } = require('../lib/secid.js');
const { log } = require('../lib/logger.js');
const H = {};

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

H['/mail/config'] = async (res, q, req) => {
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
H['/mail/test'] = async (res, q, req) => {
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
H['/mail/check'] = async (res, q, req) => {
  await readBody(req, res);
  const r = await mailCheck(true);
  ok(res, r);
};


let mailLastRun = Date.now();
/* 邮件巡检调度：每 60 秒看一次是否到了 intervalMin 的间隔。
   首次启动先给足一个间隔，避免刚起来就发一封。
   由 index.js 显式启动 —— 模块加载期的定时器会挂住事件循环，
   导致进程无法退出，且让「加载模块」产生隐式副作用。 */
function startMailSchedule() {
  const tick = setInterval(async () => {
    if (!MAIL.enabled || !MAIL.to) return;
    const gap = (MAIL.intervalMin || 15) * 60000;
    if (Date.now() - mailLastRun < gap) return;
    mailLastRun = Date.now();
    try {
      const r = await mailCheck(false);
      if (r.sent) log.info('mail patrol sent', { count: r.sent });
    } catch (e) {
      log.error('mail patrol failed', { err: e.message });
    }
  }, 60000);
  if (tick.unref) tick.unref();
  return () => clearInterval(tick);
}

Object.assign(H, { MAIL, MAIL_COOLDOWN, MAIL_FILE, MAIL_IDX, fetchIndices, fetchQuotes, mailCheck, mailClean, mailDefault, mailList, mailLoad, mailSave, mailSend, mailShell, mailTable, mailTransport, nodemailer, pctCls, pctTxt, startMailSchedule });
module.exports = H;
