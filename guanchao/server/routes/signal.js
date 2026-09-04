/* 由 server.js 机械拆分而来，行为未改动。 */
const { EMH } = require('../config.js');
const { num, round } = require('../lib/format.js');
const { getJSON } = require('../lib/http.js');
const { fail, ok } = require('../lib/respond.js');
const { emSecid, resolve } = require('../lib/secid.js');
const H = {};

H['/signal'] = async (res, q) => {
  const r = resolve(q);
  if (!r.code) return fail(res, '缺少 code 参数', 400);
  const code = r.code;
  const url = `${EMH}/api/qt/stock/trends2/get?secid=${emSecid(r)}&fields1=f1,f2,f3,f4,f5,f7&fields2=f51,f53,f56,f58&iscr=0&ndays=1`;
  const j = await getJSON(url);
  const d = j?.data;
  if (!d || !Array.isArray(d.trends) || !d.trends.length) {
    return ok(res, { code, name: d?.name || '', threshold: 0, high: [], low: [], state: 'none', curDev: 0, activeSince: '', points: [] });
  }

  const pts = d.trends.map(s => {
    const a = String(s).split(',');
    return { t: (a[0] || '').slice(11, 16), p: num(a[1]), avg: num(a[3]), vol: num(a[2]) };
  }).filter(p => p.p > 0);

  const devs = pts.map(p => (p.avg > 0 ? (p.p - p.avg) / p.avg * 100 : 0));
  const mean = devs.reduce((a, b) => a + b, 0) / (devs.length || 1);
  const sd = Math.sqrt(devs.reduce((a, b) => a + (b - mean) ** 2, 0) / (devs.length || 1));
  /* 阈值夹紧到 [0.35, 3]%：sd*1.2 在极端行情会被拉到很大，导致漏检；
     下限略降到 0.35，让活跃股的轻微异动也能被捕捉 */
  const th = Math.max(0.35, Math.min(3, sd * 1.2));

  /* 成交量滚动均值（窗口 20 根），用于「放量确认」：
     单根成交量相对近期均量越高，说明该异动有真实资金推动、可信度越高 */
  const W = 20;
  const volMa = pts.map((p, i) => {
    const s = Math.max(0, i - W + 1);
    let sum = 0;
    for (let k = s; k <= i; k++) sum += pts[k].vol;
    const n = i - s + 1;
    return n > 0 ? sum / n : 0;
  });
  const volRatio = pts.map((p, i) => (volMa[i] > 0 ? p.vol / volMa[i] : 0));

  /* 段式识别：连续 |dev| >= th 视为一段，段内极值即一个异动点。
     修复原版的 bug：
       - 末尾 armed≠0 时直接丢弃（应该也记录）
       - 拉升/砸盘两个 if-else 不互斥，方向反转时旧 armed 状态不会结束
       - 阈值不夹紧，极端行情会漏检
     优化：段极值附「放量确认」标记 strong（极值根量比 >= 1.5 视为有效突破）；
           输出实时段状态 state / curDev / activeSince 供前端即时提醒。 */
  const high = []
  const low = []
  let cur = null
  let state = 'none'
  let curDev = 0
  let activeSince = ''
  const pushCur = () => {
    if (!cur) return;
    const vr = volRatio[cur.idx] || 0;
    const mark = { t: cur.maxT, price: round(cur.maxP), dev: round(cur.maxDev), volRatio: round(vr, 2), strong: vr >= 1.5 };
    (cur.type > 0 ? high : low).push(mark);
  };
  for (let i = 0; i < pts.length; i++) {
    const dv = devs[i]
    const absDv = Math.abs(dv)
    const overHalf = absDv >= th * 0.5
    if (cur) {
      if (!overHalf) {
        /* 跌破半阈值 → 结束当前段 */
        pushCur();
        cur = null;
      } else if (Math.sign(dv) !== Math.sign(cur.type) && absDv >= 0.3) {
        /* 方向反转 → 立即结束旧段，开始新方向段 */
        pushCur();
        cur = { type: dv > 0 ? 1 : -1, maxDev: dv, maxP: pts[i].p, maxT: pts[i].t, idx: i };
      } else {
        /* 同方向或小回踩 → 更新极值 */
        if ((cur.type > 0 && dv > cur.maxDev) || (cur.type < 0 && dv < cur.maxDev)) {
          cur.maxDev = dv;
          cur.maxP = pts[i].p;
          cur.maxT = pts[i].t;
          cur.idx = i;
        }
      }
    } else if (absDv >= th) {
      /* 进入新段（去抖：单点跳变不立即开启，先看下一根是否延续） */
      const next = devs[i + 1]
      if (next !== undefined && Math.sign(next) === Math.sign(dv) && Math.abs(next) >= th * 0.6) {
        cur = { type: dv > 0 ? 1 : -1, maxDev: dv, maxP: pts[i].p, maxT: pts[i].t, idx: i };
      }
    }
  }
  /* 末尾段未退出也要记录 */
  pushCur();
  /* 实时段状态：当前仍在持续中的方向 + 当前偏离（带符号） */
  if (cur) {
    state = cur.type > 0 ? 'up' : 'down';
    curDev = cur.maxDev;
    activeSince = cur.maxT;
  } else if (pts.length) {
    curDev = devs[devs.length - 1];
  }

  ok(res, {
    code: String(d.code || code),
    name: d.name || '',
    threshold: round(th),
    high, low,
    state,
    curDev: round(curDev),
    activeSince,
    points: pts.map((p, i) => ({ t: p.t, p: round(p.p), avg: round(p.avg), dev: round(devs[i]) }))
  });
};

/* ===================================================================
   静态文件
   =================================================================== */

module.exports = H;
