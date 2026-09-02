/* ===================================================================
   行情通 · 应用层
   路由 / 11 个股票页 / 图表 / 弹窗
   =================================================================== */
(function () {
  'use strict';

  /* =================================================================
     基础工具
     ================================================================= */
  function $(s, c) { return (c || document).querySelector(s); }
  function $$(s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }
  function fx(v, d) { return (v == null || isNaN(v)) ? '--' : Number(v).toFixed(d == null ? 2 : d); }
  function sg(v) { return v > 0 ? '+' : ''; }
  function cl(v) { return v > 0 ? 'up' : (v < 0 ? 'down' : 'flat'); }
  function pc(v) { return (v == null || isNaN(v)) ? '--' : sg(v) + fx(v, 2) + '%'; }
  /* 亿元智能单位 */
  function yi(v) {
    if (v == null || isNaN(v)) return '--';
    var a = Math.abs(v);
    if (a >= 10000) return fx(v / 10000, 2) + '万亿';
    if (a >= 1) return fx(v, 2) + '亿';
    return fx(v * 10000, 0) + '万';
  }
  function cssv(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function getCSSVar(n, fb) { var v = cssv('--' + n); return v || fb; }
  function rgba(hex, a) {
    hex = String(hex || '').replace('#', '');
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    var r = parseInt(hex.slice(0,2),16), g = parseInt(hex.slice(2,4),16), b = parseInt(hex.slice(4,6),16);
    if (isNaN(r)) r = 128; if (isNaN(g)) g = 128; if (isNaN(b)) b = 128;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + (a == null ? 1 : a) + ')';
  }
  function roundRect(ctx, x, y, w, h, r) {
    if (w < 0) { x += w; w = -w; } if (h < 0) { y += h; h = -h; }
    r = Math.min(r || 0, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  var toastTimer = null;
  function toast(m) {
    var t = $('#toast'); if (!t) return;
    t.textContent = m; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 1900);
  }
  function showErr(m) { var b = $('#errBanner'); if (b) { $('#errText').textContent = m; b.style.display = 'flex'; } }
  function hideErr() { var b = $('#errBanner'); if (b) b.style.display = 'none'; }

  /* 分段控件 */
  function segHTML(id, items, sel) {
    return '<div class="seg" id="' + id + '">' + items.map(function (it) {
      return '<button data-v="' + esc(it[0]) + '" class="' + (String(it[0]) === String(sel) ? 'on' : '') + '">' + esc(it[1]) + '</button>';
    }).join('') + '</div>';
  }
  function bindSeg(id, cb) {
    var box = $('#' + id); if (!box) return;
    box.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-v]'); if (!b) return;
      $$('button', box).forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      cb(b.dataset.v);
    });
  }
  /* 页面头部 */
  function pgHead(icon, title, sub, right) {
    return '<div class="pg-head"><div class="pg-l"><div class="pg-ic">' + icon + '</div>' +
      '<div><h1>' + esc(title) + '</h1><p class="pg-sub">' + esc(sub) + '</p></div></div>' +
      '<div class="pg-r">' + (right || '') + '</div></div>';
  }

  /* 页头「立即刷新」按钮：固定 id=rfBtn，由 bindRefresh 绑定 */
  function rfHTML() {
    return '<button class="btn sm ghost rf-btn" id="rfBtn" title="立即刷新">' +
      '<span class="rf-ic">⟳</span>刷新</button>';
  }
  function bindRefresh(fn) {
    var b = $('#rfBtn'); if (!b) return;
    b.onclick = function () {
      b.classList.add('busy');
      try { fn(); } catch (e) { showErr('刷新失败：' + e.message); }
      setTimeout(function () { b.classList.remove('busy'); }, 800);
      toast('已刷新');
    };
  }

  /* =================================================================
     Canvas 图表
     ================================================================= */
  function setupCanvas(cv) {
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth || cv.parentNode.clientWidth || 600;
    var h = cv.clientHeight || 260;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    var g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    return { g: g, w: w, h: h };
  }
  var CN_UP = '#f5483b', CN_DOWN = '#16a34a';
  function thColors() {
    var up = cssv('--up') || CN_UP, down = cssv('--down') || CN_DOWN;
    return {
      up: up, down: down,
      text: cssv('--text') || '#1f2329',
      muted: cssv('--muted') || '#8a8f99',
      faint: cssv('--text-faint') || '#aab0bb',
      border: cssv('--border2') || '#eef1f5',
      card: cssv('--surface') || '#ffffff'
    };
  }

  /* 图表悬浮：十字光标 + 数据浮层
     cfg = { n: 数据点数, X(i): 横坐标, paint(idx): 重绘(idx<0 表示无), tip(i): [[标签, 值, 颜色class], ...] } */
  function bindChartHover(cv, cfg) {
    var box = cv.parentNode; if (!box) return;
    if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
    var tip = box.querySelector('.cv-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'cv-tip';
      box.appendChild(tip);
    }
    tip.style.display = 'none';
    cv._hk = cfg;
    cv.style.cursor = 'crosshair';

    function px(e) { return (e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX); }
    function py(e) { return (e.touches && e.touches[0] ? e.touches[0].clientY : e.clientY); }

    function hide() {
      tip.style.display = 'none';
      if (cv._hk) cv._hk.paint(-1);
    }
    function move(e) {
      var k = cv._hk; if (!k || !k.n) return;
      var r = cv.getBoundingClientRect();
      var x = px(e) - r.left;
      var best = 0, bd = Infinity;
      for (var i = 0; i < k.n; i++) {
        var d = Math.abs(k.X(i) - x);
        if (d < bd) { bd = d; best = i; }
      }
      k.paint(best);
      var rows = k.tip(best) || [];
      tip.innerHTML = rows.map(function (rw) {
        return '<div class="cv-tip-r"><span>' + esc(rw[0]) + '</span>' +
          '<b' + (rw[2] ? ' class="' + rw[2] + '"' : '') + '>' + esc(rw[1]) + '</b></div>';
      }).join('');
      tip.style.display = 'block';
      var tw = tip.offsetWidth, th = tip.offsetHeight;
      var cx = k.X(best);
      var left = cx + 14;
      if (left + tw > r.width - 4) left = cx - tw - 14;
      if (left < 4) left = 4;
      var top = py(e) - r.top - th - 14;
      if (top < 4) top = py(e) - r.top + 18;
      if (top + th > r.height - 2) top = Math.max(4, r.height - th - 2);
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    }
    cv.onmousemove = move;
    cv.onmouseleave = hide;
    cv.ontouchstart = move;
    cv.ontouchmove = function (e) { move(e); if (e.cancelable) e.preventDefault(); };
    cv.ontouchend = hide;
  }
  /* 在图上画十字光标与高亮点 */
  function drawCursor(g, x, y, x0, x1, y0, y1, col, dotCol) {
    g.save();
    g.strokeStyle = col; g.lineWidth = 1; g.setLineDash([4, 3]);
    g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y1); g.stroke();
    g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
    g.setLineDash([]);
    g.beginPath(); g.arc(x, y, 3.6, 0, Math.PI * 2);
    g.fillStyle = dotCol; g.fill();
    g.lineWidth = 2; g.strokeStyle = col; g.stroke();
    g.restore();
  }

  /* 分时图：价格线 + 均价线 + 成交量柱 */
  function drawMinute(cv, pts, preClose) {
    var c = setupCanvas(cv), g = c.g, W = c.w, H = c.h, col = thColors();
    if (!pts || !pts.length) { g.fillStyle = col.muted; g.font = '13px sans-serif'; g.textAlign = 'center'; g.fillText('暂无分时数据', W / 2, H / 2); cv._hk = null; return; }
    var pad = { l: 8, r: 52, t: 12, b: 34 };
    var chH = Math.round((H - pad.t - pad.b) * 0.74);
    var volH = H - pad.t - pad.b - chH;
    var prices = pts.map(function (p) { return p.p; });
    var avgs = pts.map(function (p) { return p.avg; }).filter(function (x) { return x > 0; });
    var all = prices.concat(avgs); if (preClose > 0) all.push(preClose);
    var mx = Math.max.apply(null, all), mn = Math.min.apply(null, all);
    var dev = Math.max(Math.abs(mx - preClose), Math.abs(preClose - mn), 0.01);
    var hi = preClose + dev, lo = preClose - dev;
    var maxV = Math.max.apply(null, pts.map(function (p) { return p.v || 0; })) || 1;
    var X = function (i) { return pad.l + i / Math.max(1, pts.length - 1) * (W - pad.l - pad.r); };
    var Y = function (v) { return pad.t + (hi - v) / (hi - lo) * chH; };
    var YV = function (v) { return pad.t + chH + volH - v / maxV * volH; };

    function paint(hIdx) {
    g.clearRect(0, 0, W, H);

    // 网格 + 中轴
    g.strokeStyle = col.border; g.lineWidth = 1;
    g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(pad.l, Y(preClose)); g.lineTo(W - pad.r, Y(preClose)); g.stroke();
    g.setLineDash([]);
    // 右侧刻度
    g.fillStyle = col.muted; g.font = '11px sans-serif'; g.textAlign = 'left';
    g.fillText(fx(hi, 2), W - pad.r + 6, pad.t + 4);
    g.fillText(fx(preClose, 2), W - pad.r + 6, Y(preClose) + 4);
    g.fillText(fx(lo, 2), W - pad.r + 6, pad.t + chH);
    g.fillStyle = preClose > 0 && prices[prices.length - 1] < preClose ? col.down : col.up;
    g.fillText(pc((prices[prices.length - 1] / preClose - 1) * 100), W - pad.r + 6, Y(preClose) + 18);

    // 量柱
    for (var i = 0; i < pts.length; i++) {
      var up = i === 0 ? pts[i].p >= preClose : pts[i].p >= pts[i - 1].p;
      g.fillStyle = up ? 'rgba(245,72,59,.35)' : 'rgba(22,163,74,.35)';
      g.fillRect(X(i) - 0.8, YV(pts[i].v || 0), 1.6, pad.t + chH + volH - YV(pts[i].v || 0));
    }
    // 价格线
    var last = prices[prices.length - 1];
    var lineCol = last >= preClose ? col.up : col.down;
    g.beginPath();
    for (var j = 0; j < pts.length; j++) { j ? g.lineTo(X(j), Y(pts[j].p)) : g.moveTo(X(j), Y(pts[j].p)); }
    g.strokeStyle = lineCol; g.lineWidth = 1.6; g.stroke();
    g.lineTo(X(pts.length - 1), pad.t + chH); g.lineTo(X(0), pad.t + chH); g.closePath();
    var grd = g.createLinearGradient(0, pad.t, 0, pad.t + chH);
    grd.addColorStop(0, last >= preClose ? 'rgba(245,72,59,.18)' : 'rgba(22,163,74,.18)');
    grd.addColorStop(1, 'rgba(245,72,59,0)');
    g.fillStyle = grd; g.fill();
    // 均价线
    if (avgs.length) {
      g.beginPath();
      var started = false;
      for (var k = 0; k < pts.length; k++) {
        if (!(pts[k].avg > 0)) continue;
        started ? g.lineTo(X(k), Y(pts[k].avg)) : g.moveTo(X(k), Y(pts[k].avg));
        started = true;
      }
      g.strokeStyle = '#f59e0b'; g.lineWidth = 1.2; g.stroke();
    }
    // 时间轴
    g.fillStyle = col.muted; g.font = '11px sans-serif'; g.textAlign = 'center';
    var t0 = pts[0].t || '', t1 = pts[pts.length - 1].t || '';
    g.fillText(String(t0).slice(0, 5), pad.l + 14, H - 10);
    g.fillText(String(t1).slice(0, 5), W - pad.r - 14, H - 10);

    if (hIdx >= 0 && hIdx < pts.length) {
      drawCursor(g, X(hIdx), Y(pts[hIdx].p), pad.l, W - pad.r, pad.t, pad.t + chH + volH,
        col.muted, pts[hIdx].p >= preClose ? col.up : col.down);
    }
    }

    paint(-1);
    bindChartHover(cv, {
      n: pts.length, X: X, paint: paint,
      tip: function (i) {
        var p = pts[i];
        var d = preClose > 0 ? (p.p / preClose - 1) * 100 : 0;
        return [
          ['时间', p.t || '--'],
          ['价格', fx(p.p, 2), d >= 0 ? 'up' : 'down'],
          ['涨跌幅', pc(d), d >= 0 ? 'up' : 'down'],
          ['均价', p.avg > 0 ? fx(p.avg, 2) : '--'],
          ['成交额', p.amt > 0 ? yi(p.amt / 1e8) : (p.v > 0 ? Math.round(p.v) + ' 手' : '--')]
        ];
      }
    });
  }

  /* K 线：蜡烛 + MA5/MA10/MA20 */
  function drawKline(cv, ks) {
    var c = setupCanvas(cv), g = c.g, W = c.w, H = c.h, col = thColors();
    if (!ks || !ks.length) { g.fillStyle = col.muted; g.font = '13px sans-serif'; g.textAlign = 'center'; g.fillText('暂无K线数据', W / 2, H / 2); cv._hk = null; return; }
    var pad = { l: 8, r: 8, t: 12, b: 22 };
    var hs = ks.map(function (k) { return k.h; }), ls = ks.map(function (k) { return k.l; });
    var hi = Math.max.apply(null, hs), lo = Math.min.apply(null, ls);
    var pad2 = (hi - lo) * 0.06 || 0.1; hi += pad2; lo -= pad2;
    var n = ks.length;
    var bw = (W - pad.l - pad.r) / n;
    var X = function (i) { return pad.l + (i + 0.5) * bw; };
    var Y = function (v) { return pad.t + (hi - v) / (hi - lo) * (H - pad.t - pad.b); };

    function paint(hIdx) {
    g.clearRect(0, 0, W, H);

    // 网格
    g.strokeStyle = col.border; g.lineWidth = 1; g.setLineDash([2, 4]);
    for (var r = 0; r <= 3; r++) {
      var y = pad.t + r / 3 * (H - pad.t - pad.b);
      g.beginPath(); g.moveTo(pad.l, y); g.lineTo(W - pad.r, y); g.stroke();
    }
    g.setLineDash([]);

    // 蜡烛
    var cw = Math.max(1, Math.min(bw * 0.62, 12));
    for (var i = 0; i < n; i++) {
      var k = ks[i], up = k.c >= k.o;
      g.strokeStyle = up ? col.up : col.down; g.fillStyle = up ? col.up : col.down; g.lineWidth = 1;
      g.beginPath(); g.moveTo(X(i), Y(k.h)); g.lineTo(X(i), Y(k.l)); g.stroke();
      var y1 = Y(Math.max(k.o, k.c)), y2 = Y(Math.min(k.o, k.c));
      g.fillRect(X(i) - cw / 2, y1, cw, Math.max(1, y2 - y1));
    }
    // 均线
    function ma(p) {
      g.beginPath(); var st = false;
      for (var i = p - 1; i < n; i++) {
        var s = 0; for (var j = 0; j < p; j++) s += ks[i - j].c;
        var v = s / p;
        st ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)); st = true;
      }
      g.lineWidth = 1.2; g.stroke();
    }
    g.strokeStyle = '#f59e0b'; ma(5);
    g.strokeStyle = '#0ea5e9'; ma(10);
    g.strokeStyle = '#a855f7'; ma(20);

    // 日期
    g.fillStyle = col.muted; g.font = '11px sans-serif'; g.textAlign = 'center';
    if (ks[0].t) g.fillText(String(ks[0].t).slice(0, 10), pad.l + 26, H - 6);
    if (ks[n - 1].t) g.fillText(String(ks[n - 1].t).slice(0, 10), W - pad.r - 26, H - 6);

    if (hIdx >= 0 && hIdx < n) {
      drawCursor(g, X(hIdx), Y(ks[hIdx].c), pad.l, W - pad.r, pad.t, H - pad.b,
        col.muted, ks[hIdx].c >= ks[hIdx].o ? col.up : col.down);
    }
    }

    paint(-1);
    bindChartHover(cv, {
      n: n, X: X, paint: paint,
      tip: function (i) {
        var k = ks[i];
        var base = i > 0 ? ks[i - 1].c : k.o;
        var d = base > 0 ? (k.c / base - 1) * 100 : 0;
        return [
          ['日期', k.t || '--'],
          ['开盘', fx(k.o, 2)],
          ['收盘', fx(k.c, 2), k.c >= k.o ? 'up' : 'down'],
          ['最高', fx(k.h, 2), 'up'],
          ['最低', fx(k.l, 2), 'down'],
          ['涨跌幅', pc(d), d >= 0 ? 'up' : 'down'],
          ['成交量', k.v > 0 ? Math.round(k.v) + ' 手' : '--']
        ];
      }
    });
  }

  /* 信号图：价格 + 均价 + 高低点标记 */
  function drawSignal(cv, pts, highs, lows) {
    var c = setupCanvas(cv), g = c.g, W = c.w, H = c.h, col = thColors();
    if (!pts || !pts.length) { g.fillStyle = col.muted; g.font = '13px sans-serif'; g.textAlign = 'center'; g.fillText('暂无分时数据', W / 2, H / 2); return; }
    var pad = { l: 34, r: 34, t: 14, b: 22 };
    var ps = pts.map(function (p) { return p.p; });
    var av = pts.map(function (p) { return p.avg; }).filter(function (x) { return x > 0; });
    var hi = Math.max.apply(null, ps.concat(av)), lo = Math.min.apply(null, ps.concat(av));
    var p2 = (hi - lo) * 0.12 || 0.1; hi += p2; lo -= p2;
    var X = function (i) { return pad.l + i / Math.max(1, pts.length - 1) * (W - pad.l - pad.r); };
    var Y = function (v) { return pad.t + (hi - v) / (hi - lo) * (H - pad.t - pad.b); };

    g.strokeStyle = col.border; g.setLineDash([2, 4]);
    g.beginPath(); g.moveTo(pad.l, Y(pts[0].avg || ps[0])); g.lineTo(W - pad.r, Y(pts[0].avg || ps[0])); g.stroke();
    g.setLineDash([]);

    g.beginPath();
    for (var i = 0; i < pts.length; i++) i ? g.lineTo(X(i), Y(pts[i].p)) : g.moveTo(X(i), Y(pts[i].p));
    g.strokeStyle = col.up; g.lineWidth = 1.5; g.stroke();

    g.beginPath(); var st = false;
    for (var k = 0; k < pts.length; k++) { if (!(pts[k].avg > 0)) continue; st ? g.lineTo(X(k), Y(pts[k].avg)) : g.moveTo(X(k), Y(pts[k].avg)); st = true; }
    g.strokeStyle = '#f59e0b'; g.lineWidth = 1.2; g.stroke();

    function mark(list, color, label) {
      (list || []).forEach(function (s) {
        var idx = -1;
        for (var i = 0; i < pts.length; i++) { if (pts[i].t === s.t) { idx = i; break; } }
        if (idx < 0) return;
        var x = X(idx), y = Y(s.p);
        g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2);
        g.fillStyle = color; g.fill();
        g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke();
        g.fillStyle = color; g.font = 'bold 10px sans-serif'; g.textAlign = 'center';
        g.fillText(label, x, y - 10);
      });
    }
    mark(highs, col.up, '抛');
    mark(lows, col.down, '吸');

    g.fillStyle = col.muted; g.font = '11px sans-serif'; g.textAlign = 'right';
    g.fillText(fx(hi, 2), pad.l - 6, pad.t + 4);
    g.fillText(fx(lo, 2), pad.l - 6, H - pad.b);
  }

  /* 横向条形图（对比分析 / 资金流概览） */
  function drawBars(cv, items, opt) {
    opt = opt || {};
    var c = setupCanvas(cv), g = c.g, W = c.w, H = c.h, col = thColors();
    if (!items.length) { g.fillStyle = col.muted; g.font = '13px sans-serif'; g.textAlign = 'center'; g.fillText('暂无数据', W / 2, H / 2); return; }
    var pad = { l: 78, r: 66, t: 12, b: 12 };
    var rh = Math.min(38, (H - pad.t - pad.b) / items.length);
    var maxAbs = Math.max.apply(null, items.map(function (x) { return Math.abs(x.v); })) || 1;
    if (opt.bidirectional) {
      var mid = pad.l + (W - pad.l - pad.r) / 2;
      g.strokeStyle = col.border; g.beginPath(); g.moveTo(mid, pad.t); g.lineTo(mid, H - pad.b); g.stroke();
      items.forEach(function (it, i) {
        var y = pad.t + i * rh + rh / 2;
        var w = Math.abs(it.v) / maxAbs * ((W - pad.l - pad.r) / 2 - 4);
        g.fillStyle = it.v >= 0 ? col.up : col.down;
        g.fillRect(it.v >= 0 ? mid : mid - w, y - rh * 0.28, w, rh * 0.56);
        g.fillStyle = col.text; g.font = '12px sans-serif'; g.textAlign = 'right';
        g.fillText(it.name, pad.l - 8, y + 4);
        g.fillStyle = it.v >= 0 ? col.up : col.down; g.textAlign = 'left';
        g.fillText(opt.fmt ? opt.fmt(it.v) : fx(it.v, 2), W - pad.r + 8, y + 4);
      });
    } else {
      items.forEach(function (it, i) {
        var y = pad.t + i * rh + rh / 2;
        var w = Math.abs(it.v) / maxAbs * (W - pad.l - pad.r);
        g.fillStyle = col.border;
        g.fillRect(pad.l, y - rh * 0.24, W - pad.l - pad.r, rh * 0.48);
        g.fillStyle = it.color || (it.v >= 0 ? col.up : col.down);
        g.fillRect(pad.l, y - rh * 0.24, w, rh * 0.48);
        g.fillStyle = col.text; g.font = '12px sans-serif'; g.textAlign = 'right';
        g.fillText(it.name, pad.l - 8, y + 4);
        g.fillStyle = col.muted; g.textAlign = 'left';
        g.fillText(opt.fmt ? opt.fmt(it.v) : fx(it.v, 2), pad.l + w + 8, y + 4);
      });
    }
  }

  /* =================================================================
     页面状态
     ================================================================= */
  var TIMERS = [];
  function clearTimers() { TIMERS.forEach(clearInterval); TIMERS = []; }
  function every(ms, fn) { var t = setInterval(fn, ms); TIMERS.push(t); return t; }

  var view = function () { return $('#stockView'); };
  function mount(html) {
    var v = view(); if (!v) return;
    clearTimers();
    v.innerHTML = html;
    v.classList.remove('view-anim');
    void v.offsetWidth;
    v.classList.add('view-anim');
    window.scrollTo(0, 0);
  }

  /* =================================================================
     顶部指数滚动播放条（全局，与路由无关）
     ================================================================= */
  var idxCache = [];
  var ashareIdxCache = [];   /* A股行情页指数板专用缓存（已过滤港股/全球） */

  /* =================================================================
     全局数据缓存（跨页面共享，避免 A股行情 / 全景盘面 各自重复请求）
     指数 + 市场统计 两页共用同一份，切换路由时直接复用。
     TTL：指数 20s / 市场统计 30s（同花顺）/ 90s（东财精确）
     ================================================================= */
  var GC = {
    indices: null, indicesTs: 0, indicesTTL: 20000,
    mstat: null,   mstatTs: 0,    mstatTTL: 30000,
    sector: null,  sectorTs: 0,   sectorTTL: 25000,
    fuyaoReady: false
  };
  function gcStale(key) { return !GC[key] || (Date.now() - GC[key + 'Ts'] > GC[key + 'TTL']); }
  function gcSet(key, val) { GC[key] = val; GC[key + 'Ts'] = Date.now(); }
  function itItemHTML(x) {
    return '<span class="it-item">' +
      '<span class="it-n">' + esc(x.name) + '</span>' +
      '<span class="it-p">' + fx(x.price) + '</span>' +
      '<span class="it-c ' + cl(x.pct) + '">' + pc(x.pct) + '</span>' +
      '</span>';
  }
  /* 已在播放时只改数值，不重建 DOM，避免滚动动画每次刷新都跳回原点 */
  function itUpdate(el, x) {
    if (!el) return;
    var n = el.querySelector('.it-n'), p = el.querySelector('.it-p'), c = el.querySelector('.it-c');
    if (n) n.textContent = x.name;
    if (p) p.textContent = fx(x.price);
    if (c) { c.textContent = pc(x.pct); c.className = 'it-c ' + cl(x.pct); }
  }
  function loadTicker() {
    var tr = $('#itTrack'); if (!tr) return;
    API.indices().then(function (rows) {
      if (!rows || !rows.length) return;
      idxCache = rows;
      var n = rows.length;
      if (tr.dataset.built === '1' && tr.children.length === n * 2) {
        for (var i = 0; i < n; i++) { itUpdate(tr.children[i], rows[i]); itUpdate(tr.children[n + i], rows[i]); }
        return;
      }
      var one = rows.map(itItemHTML).join('');
      tr.innerHTML = one + one;           // 复制一份，配合 translateX(-50%) 实现无缝循环
      tr.dataset.built = '1';
      /* 按内容宽度换算时长，保持约 55px/s 的匀速 */
      var w = tr.scrollWidth / 2 || n * 220;
      tr.style.setProperty('--it-dur', Math.max(24, Math.round(w / 55)) + 's');
    }).catch(function () {
      if (tr.dataset.built !== '1') tr.innerHTML = '<span class="it-loading">指数加载失败</span>';
    });
  }

  /* 指数看板（股票排行页顶部）—— 使用全局缓存，与全景盘面共享 */
  function idxCardHTML(x) {
    return '<div class="idx-card" data-code="' + esc(x.code) + '" data-secid="' + esc(x.secid) + '" data-name="' + esc(x.name) + '">' +
      '<div class="idx-card-n">' + esc(x.name) + '</div>' +
      '<div class="idx-card-p ' + cl(x.pct) + '">' + fx(x.price) + '</div>' +
      '<div class="idx-card-c ' + cl(x.pct) + '">' + (x.change == null ? '--' : sg(x.change) + fx(x.change)) +
      '&nbsp;&nbsp;' + pc(x.pct) + '</div>' +
      '<div class="idx-card-x">额 ' + (x.amount == null ? '--' : fx(x.amount, 0) + '亿') + '</div>' +
      '</div>';
  }
  function loadIdxBoard() {
    var box = $('#idxBoard'); if (!box) return;
    /* 优先用全局缓存（全景盘面可能已加载过） */
    if (!gcStale('indices') && GC.indices) {
      ashareIdxCache = GC.indices;
      box.innerHTML = ashareIdxCache.map(idxCardHTML).join('');
      return;
    }
    if (ashareIdxCache.length) { box.innerHTML = ashareIdxCache.map(idxCardHTML).join(''); return; }
    box.innerHTML = '<div class="empty" style="grid-column:1/-1">指数加载中…</div>';
    /* A股行情页只展示 A股指数（scope=ashare 由后端过滤掉港股/全球） */
    API.indices({ scope: 'ashare' }).then(function (rows) {
      if (!rows || !rows.length) return;
      ashareIdxCache = rows;
      gcSet('indices', rows);   // 写入全局缓存，供全景盘面复用
      if ($('#idxBoard')) $('#idxBoard').innerHTML = rows.map(idxCardHTML).join('');
    }).catch(function () {
      if ($('#idxBoard')) $('#idxBoard').innerHTML = '<div class="empty" style="grid-column:1/-1">指数加载失败</div>';
    });
  }
  function bindIdxBoard() {
    var box = $('#idxBoard'); if (!box) return;
    box.addEventListener('click', function (e) {
      var c = e.target.closest('.idx-card'); if (!c) return;
      openDetail(c.dataset.code, c.dataset.name, c.dataset.secid);
    });
  }

  /* =================================================================
     1. 自选股
     ================================================================= */
  var wlQuotes = [];
  function renderWatchlist() {
    mount(
      pgHead('⭐', '自选股', '搜索代码或名称添加，每个账户独立保存；点击卡片查看详情，行情每 10 秒自动刷新',
        '<button class="btn sm ghost" id="wlSync">☁️ 云同步</button>' + rfHTML()) +
      '<div class="pg-tools">' +
      '<div class="wl-search"><input id="wlSearch" class="wl-input" placeholder="搜索股票：代码 / 名称，如 600519 或 茅台" autocomplete="off" />' +
      '<div id="wlSuggest" class="wl-suggest" style="display:none"></div></div>' +
      '</div>' +
      '<div id="wlCards" class="wl-cards"><div class="empty" style="grid-column:1/-1">加载中…</div></div>'
    );
    bindSearch();
    $('#wlSync').onclick = openSync;
    bindRefresh(refreshWatchQuotes);
    loadWatchlist();
    every(10000, function () {
      if (location.hash === '#/stock-watchlist') refreshWatchQuotes();
    });
  }
  function wlCardHtml(x) {
    var up = x.pct > 0, dn = x.pct < 0;
    return '<div class="wl-card ' + (up ? 'up' : (dn ? 'down' : '')) + '" data-code="' + esc(x.code) + '" data-secid="' + esc(x.secid || '') + '" data-name="' + esc(x.name) + '">' +
      '<button class="wl-del" data-del="' + esc(x.code) + '" title="删除">×</button>' +
      '<div class="wl-card-name">' + esc(x.name) + '</div>' +
      '<div class="wl-card-code">' + esc(x.code) + '</div>' +
      '<div class="wl-card-price">' + fx(x.price) + '</div>' +
      '<div class="wl-card-chg ' + cl(x.pct) + '">' + pc(x.pct) + '</div>' +
      '<div class="wl-card-meta">高 ' + fx(x.high) + ' · 低 ' + fx(x.low) + '</div>' +
      '</div>';
  }
  function loadWatchlist() {
    var box = $('#wlCards'); if (!box) return;
    var list = API.watchlist();
    if (!list.length) {
      box.innerHTML = '<div class="empty" style="grid-column:1/-1">还没有自选股，搜索代码或名称添加吧～</div>';
      return;
    }
    box.innerHTML = list.map(function (x) {
      return wlCardHtml({ code: x.code, name: x.name, secid: x.secid, price: null, pct: null, high: null, low: null });
    }).join('');
    refreshWatchQuotes();
  }
  function refreshWatchQuotes() {
    var box = $('#wlCards'); if (!box) return;
    var list = API.watchlist();
    if (!list.length) return;
    API.quotes(list.map(function (x) { return x.code; })).then(function (rows) {
      wlQuotes = rows;
      var map = {};
      rows.forEach(function (r) { map[r.code] = r; });
      $$('.wl-card', box).forEach(function (card) {
        var code = card.dataset.code, q = map[code];
        if (!q) return;
        card.classList.toggle('up', q.pct > 0);
        card.classList.toggle('down', q.pct < 0);
        var pe = $('.wl-card-price', card), ce = $('.wl-card-chg', card), me = $('.wl-card-meta', card);
        if (pe) pe.textContent = fx(q.price);
        if (ce) { ce.textContent = pc(q.pct); ce.className = 'wl-card-chg ' + cl(q.pct); }
        if (me) me.textContent = '高 ' + fx(q.high) + ' · 低 ' + fx(q.low);
      });
      hideErr();
    }).catch(function (e) { showErr('自选股行情刷新失败：' + e.message); });
  }

  /* =================================================================
     2. 股票排行
     ================================================================= */
  var RK_MKT = [['all', '全部A股'], ['sh', '沪A'], ['sz', '深A'], ['cyb', '创业板'], ['kcb', '科创板'], ['bj', '北交所']];
  var RK_DIM = [['changePct', '涨幅榜'], ['changePctD', '跌幅榜'], ['amount', '成交额榜'], ['turnover', '换手率榜'],
  ['volumeRatio', '量比榜'], ['amplitude', '振幅榜'], ['mainNetInflow', '主力净流入榜'], ['pe', '市盈率榜']];
  var rkState = { mkt: 'all', dim: 'changePct' };

  function renderRank() {
    mount(
      pgHead('🏆', '股票排行', '全市场行情排行 · 数据每 15 秒自动更新，点击行查看个股详情', rfHTML()) +
      '<div class="pg-tools"><span class="lbl">市场</span>' + segHTML('rkMkt', RK_MKT, rkState.mkt) +
      '<span class="lbl" style="margin-left:8px">维度</span>' + segHTML('rkDim', RK_DIM, rkState.dim) + '</div>' +
      '<div id="rkStat"><div class="kpi-row">' + msSkeleton() + '</div></div>' +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
      '<th>#</th><th>代码 / 名称</th><th>现价</th><th>涨跌幅</th><th>涨跌额</th><th>成交额</th>' +
      '<th>振幅</th><th>换手</th><th>量比</th><th>市盈率</th><th>主力净流入</th><th>总市值</th>' +
      '</tr></thead><tbody id="rkBody"><tr><td colspan="12"><div class="empty">加载中…</div></td></tr></tbody></table></div>'
    );
    bindSeg('rkMkt', function (v) { rkState.mkt = v; loadRank(); });
    bindSeg('rkDim', function (v) { rkState.dim = v; loadRank(); });
    bindRefresh(function () { GC.mstatTs = 0; loadRank(true); loadMarketStat(); });
    loadRank();
    loadMarketStat();
    every(15000, function () { if (location.hash === '#/stock-rank') loadRank(true); });
    every(120000, function () { if (location.hash === '#/stock-rank') loadMarketStat(); });
  }

  /* ---------- 全市场统计卡（对标参考站：涨跌家数 / 成交额 / 主力净流入）---------- */
  function msSkeleton() {
    var one = function (l) { return '<div class="kpi"><div class="kpi-l">' + l + '</div><div class="kpi-v muted" style="font-size:15px">…</div></div>'; };
    return one('股票总数') + one('上涨家数') + one('下跌家数') + one('停牌/无数据') + one('两市成交额') + one('主力净流入合计');
  }
  function msHTML(d) {
    var flowTxt = d.mainFlow == null ? '统计中…' : (d.mainFlow >= 0 ? '+' : '') + fx(d.mainFlow, 2) + '亿';
    var flowCls = d.mainFlow == null ? 'muted' : cl(d.mainFlow);
    var kpi = function (l, v, c, s) {
      return '<div class="kpi"><div class="kpi-l">' + esc(l) + '</div>' +
        '<div class="kpi-v ' + (c || '') + '">' + v + '</div>' +
        (s ? '<div class="kpi-s">' + esc(s) + '</div>' : '') + '</div>';
    };
    /* 停牌 / 无报价：此前被静默跳过，导致东财口径与同花顺对不上且差额无法解释，这里明示 */
    var susTxt = (d.suspend == null) ? '—' : String(d.suspend);
    var srcName = d.source === 'ths' ? '同花顺' : (d.source === 'em' ? '东方财富' : '');
    var html = '<div class="kpi-row">' +
      kpi('股票总数', esc(String(d.total)) + '<span style="font-size:13px"> 只</span>', '', '有效样本 ' + d.sample) +
      kpi('上涨家数', '<span class="up">' + d.up + '</span>', '', '占比 ' + d.upPct + '%') +
      kpi('下跌家数', '<span class="down">' + d.down + '</span>', '', '占比 ' + d.downPct + '%') +
      kpi('停牌/无数据', '<span class="muted">' + esc(susTxt) + '</span>', '',
        (d.suspend == null) ? '快速模式不统计' : '未计入涨跌家数') +
      kpi('两市成交额', fx(d.amount, 3) + '<span style="font-size:13px"> 万亿</span>', '', fx(d.amountYi, 0) + ' 亿元') +
      kpi('主力净流入合计', '<span class="' + flowCls + '">' + esc(flowTxt) + '</span>', '',
        d.partial ? '精确统计中…' : '样本 ' + d.sample + ' 只') +
      '</div>';
    if (srcName) {
      html += '<div style="margin-top:6px;font-size:12px;color:var(--muted)">数据来源：<b>' +
        esc(srcName) + '</b>（已与另一数据源交叉核对）</div>';
    }
    return html;
  }
  /* 同花顺优先 → 东财降级：先尝试 fuyao（权威基准），失败则用东财
     全局缓存命中时直接复用，两页共享同一份数据 */
  function loadMarketStat() {
    var box = $('#rkStat'); if (!box) return;
    /* 全局缓存命中且未过期 → 直接渲染 */
    if (!gcStale('mstat') && GC.mstat) { box.innerHTML = msHTML(GC.mstat); return; }

    /* 先试同花顺（单次请求约 300ms），再补东财精确全量 */
    API.fuyaoStat().then(function (fyData) {
      if (fyData) {
        GC.fuyaoReady = true;
        gcSet('mstat', fyData); GC.mstatTTL = 30000;
        if ($('#rkStat') === box) box.innerHTML = msHTML(fyData);
        /* 同花顺无主力净流入汇总，异步补东财的 mainFlow */
        return API.marketStat().then(function (emData) {
          if (emData && !emData.partial && $('#rkStat') === box) {
            var merged = Object.assign({}, fyData, { mainFlow: emData.mainFlow, partial: false });
            gcSet('mstat', merged); box.innerHTML = msHTML(merged);
          }
        }).catch(function () {});
      }
      throw new Error('fuyao_unavailable');
    }).catch(function () {
      /* 同花顺不可用或未配置 → 纯东财路径 */
      return API.marketStat('fast').then(function (d) {
        if ($('#rkStat') !== box) return;
        box.innerHTML = msHTML(d);
        gcSet('mstat', d); GC.mstatTTL = 90000;
        return API.marketStat();
      }).then(function (d) {
        if (!d || $('#rkStat') !== box) return;
        if (!d.partial) { gcSet('mstat', d); box.innerHTML = msHTML(d); }
      });
    }).catch(function () {});
  }
  function loadRank(silent) {
    var body = $('#rkBody'); if (!body) return;
    if (!silent) body.innerHTML = '<tr><td colspan="12"><div class="empty">加载中…</div></td></tr>';
    API.rank(rkState.mkt, rkState.dim, 50).then(function (rows) {
      if (!rows.length) { body.innerHTML = '<tr><td colspan="12"><div class="empty">暂无数据</div></td></tr>'; return; }
      body.innerHTML = rows.map(function (s, i) {
        return '<tr data-code="' + esc(s.code) + '" data-secid="' + esc(s.secid) + '" data-name="' + esc(s.name) + '">' +
          '<td data-label="#" class="muted">' + (i + 1) + '</td>' +
          '<td data-label="代码/名称"><span class="c-name">' + esc(s.name) + '</span><span class="c-code">' + esc(s.code) + '</span></td>' +
          '<td data-label="现价">' + fx(s.price) + '</td>' +
          '<td data-label="涨跌幅" class="' + cl(s.pct) + '">' + pc(s.pct) + '</td>' +
          '<td data-label="涨跌额" class="' + cl(s.change) + '">' + (s.change == null ? '--' : sg(s.change) + fx(s.change)) + '</td>' +
          '<td data-label="成交额">' + yi(s.amount) + '</td>' +
          '<td data-label="振幅">' + fx(s.amplitude) + '%</td>' +
          '<td data-label="换手">' + fx(s.turnover) + '%</td>' +
          '<td data-label="量比">' + fx(s.volumeRatio) + '</td>' +
          '<td data-label="市盈率">' + fx(s.pe) + '</td>' +
          '<td data-label="主力净流入" class="' + cl(s.mainNetInflow) + '">' + yi(s.mainNetInflow) + '</td>' +
          '<td data-label="总市值">' + yi(s.mktcap) + '</td>' +
          '</tr>';
      }).join('');
      bindRowClick('#rkBody');
      hideErr();
    }).catch(function (e) {
      if (!silent) body.innerHTML = '<tr><td colspan="12"><div class="empty">加载失败：' + esc(e.message) + '</div></td></tr>';
      else showErr('排行刷新失败：' + e.message);
    });
  }

  /* =================================================================
     4. 对比分析
     ================================================================= */
  var cmpCodes = [];   /* 默认不预填股票代码，进入对比页后由用户自行输入 */
  var CMP_ROWS = [
    ['现价', function (x) { return fx(x.price); }, function (x) { return cl(x.pct); }],
    ['涨跌幅', function (x) { return pc(x.pct); }, function (x) { return cl(x.pct); }],
    ['5日涨幅', function (x) { return pc(x.chg5); }, function (x) { return cl(x.chg5); }],
    ['20日涨幅', function (x) { return pc(x.chg20); }, function (x) { return cl(x.chg20); }],
    ['MA20', function (x) { return fx(x.ma20); }, null],
    ['市盈率', function (x) { return fx(x.pe); }, null],
    ['市净率', function (x) { return fx(x.pb); }, null],
    ['换手率', function (x) { return fx(x.turnover) + '%'; }, null],
    ['量比', function (x) { return fx(x.volumeRatio); }, null],
    ['成交额', function (x) { return yi(x.amount); }, null],
    ['主力净流入', function (x) { return yi(x.mainNetInflow); }, function (x) { return cl(x.mainNetInflow); }],
    ['总市值', function (x) { return yi(x.mktcap); }, null]
  ];
  function renderCompare() {
    mount(
      pgHead('📊', '对比分析', '最多 6 只股票横向对比 · 输入代码后用逗号分隔，回车或点「对比」刷新') +
      '<div class="pg-tools">' +
      '<input id="cmpInput" class="wl-input" style="max-width:420px" value="' + esc(cmpCodes.join(',')) + '" placeholder="股票代码，逗号分隔，如 600519,000858,300750" />' +
      '<button class="btn sm" id="cmpGo">对比</button>' +
      '<span class="lbl" style="margin-left:auto">涨跌幅 / 5日 / 20日 强度条</span>' +
      '</div>' +
      '<div id="cmpBox"><div class="empty">加载中…</div></div>'
    );
    $('#cmpGo').onclick = function () {
      var raw = $('#cmpInput').value.split(/[,，\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (!raw.length) return toast('请输入至少 1 只股票代码');
      if (raw.length > 6) { raw = raw.slice(0, 6); toast('最多对比 6 只，已截断'); }
      cmpCodes = raw; loadCompare();
    };
    $('#cmpInput').onkeydown = function (e) { if (e.key === 'Enter') $('#cmpGo').click(); };
    loadCompare();
  }
  function loadCompare() {
    var box = $('#cmpBox'); if (!box) return;
    box.innerHTML = '<div class="empty">加载中…</div>';
    API.compare(cmpCodes).then(function (rows) {
      if (!rows.length) { box.innerHTML = '<div class="empty">暂无数据</div>'; return; }
      var head = '<tr><th>指标</th>' + rows.map(function (r) {
        return '<th>' + esc(r.name) + '<span class="c-code">' + esc(r.code) + '</span></th>';
      }).join('') + '</tr>';
      var body = CMP_ROWS.map(function (rw) {
        return '<tr><td data-label="指标"><b>' + rw[0] + '</b></td>' +
          rows.map(function (r) {
            var c = rw[2] ? rw[2](r) : '';
            return '<td data-label="' + esc(r.name) + '" class="' + c + '">' + rw[1](r) + '</td>';
          }).join('') + '</tr>';
      }).join('');
      box.innerHTML =
        '<div class="tbl-wrap" style="margin-bottom:12px"><table class="tbl"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>' +
        '<div class="panel"><div class="section-title" style="font-size:15px;margin-bottom:8px">阶段涨幅对比（%）</div>' +
        '<div class="chart-box" style="height:260px"><canvas id="cmpChart"></canvas></div></div>';
      var items = [];
      rows.forEach(function (r) {
        items.push({ name: r.name + ' 今日', v: r.pct || 0 });
      });
      rows.forEach(function (r) { items.push({ name: r.name + ' 5日', v: r.chg5 || 0 }); });
      rows.forEach(function (r) { items.push({ name: r.name + ' 20日', v: r.chg20 || 0 }); });
      drawBars($('#cmpChart'), items, { bidirectional: true, fmt: function (v) { return fx(v, 2) + '%'; } });
      hideErr();
    }).catch(function (e) {
      box.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>';
    });
  }

  /* KPI 卡片（val 支持 raw HTML：传第4参数 sub 时 val 不转义） */
  function kpiBox(label, val, cls, sub, key) {
    /* val 在传入 cls 或 sub 时视为「已格式化的可信 HTML」（如带 <span class="up"> 的金额），
       此时不再 esc，否则 <span> 会被当纯文本显示（如「主力净流入合计」）；
       仅当纯文本数值（无 cls 也无 sub）时才 esc 防注入。 */
    var raw = (cls != null && cls !== '') || (sub != null);
    return '<div class="kpi' + (key ? ' kpi-click' : '') + '"' + (key ? ' data-sent="' + esc(key) + '"' : '') + '><div class="kpi-l">' + esc(label) + '</div><div class="kpi-v ' + (cls || '') + '">' + (raw ? val : esc(val)) + '</div>' +
      (sub ? '<div class="kpi-s">' + esc(sub) + '</div>' : '') + '</div>';
  }
  /* 事件委托：tbody 上只挂 1 个监听器。
     原实现逐行绑定 onclick，约 470 个板块 = 470 个监听器 + 470 次 DOM 查询，
     是「板块数据返回后浏览器卡死」的主因之一。 */
  function bindSectorRows() {
    var body = $('#ovSecBody'); if (!body) return;
    body.onclick = function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('#ovSecMore')) { renderOvSecRows(ovSecAll.length); return; }
      var tr = t.closest('tr[data-secid]');
      if (!tr) return;
      if (tr.dataset.code) openDetail(tr.dataset.code, tr.dataset.name);
      else toast('该板块暂无可跳转的领涨股');
    };
  }

  /* =================================================================
     5. 暗盘监控（大宗交易 · A股）
        对标 yysd.fun「暗盘监控」版式：顶部概览 KPI + 筛选分栏
        （全部 / 溢价 / 折价 / 平价）+ 可排序主表，行点击走本站 openDetail 弹窗。
        不使用右侧展示图。
     ================================================================= */
  var dkState = { sort: 'amount', filter: 'all' };
  function renderDark() {
    mount(
      pgHead('🌑', '暗盘监控', 'A股大宗交易盘后协议转让 · 折溢价分布、买卖席位、成交明细，反映机构与大资金动向', rfHTML()) +
      '<div class="pg-tools">' +
        '<span class="lbl">筛选</span>' + segHTML('dkFilter', [
          ['all', '全部'], ['prem', '溢价'], ['disc', '折价'], ['flat', '平价']
        ], dkState.filter) +
        '<span class="lbl" style="margin-left:12px">排序</span>' + segHTML('dkSort', [
          ['amount', '成交额'], ['premium', '溢价率'], ['volume', '成交量']
        ], dkState.sort) +
      '</div>' +
      '<div class="kpi-row" id="dkKpi"></div>' +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
      '<th>#</th><th>代码 / 名称</th><th>成交价</th><th>收盘价</th><th>溢价率</th><th>成交量</th><th>成交额</th><th>买方席位</th><th>卖方席位</th>' +
      '</tr></thead><tbody id="dkBody"><tr><td colspan="9"><div class="empty">加载中…</div></td></tr></tbody></table></div>' +
      '<div class="panel" style="margin:12px 0"><div class="section-title ov-st" style="margin:0 0 8px;text-align:left">📐 折溢价分布</div><div id="dkDist"><div class="empty">加载中…</div></div></div>' +
      '<div class="panel" style="margin:12px 0"><div class="section-title ov-st" style="margin:0 0 8px;text-align:left">🏢 机构席位统计（买方 TOP / 卖方 TOP）</div><div id="dkSeat"><div class="empty">加载中…</div></div></div>'
    );
    bindSeg('dkFilter', function (v) { dkState.filter = v; loadDark(); });
    bindSeg('dkSort', function (v) { dkState.sort = v; loadDark(); });
    bindRefresh(function () { loadDark(true); });
    loadDark();
    every(30000, function () { if (location.hash === '#/stock-dark') loadDark(true); });
  }
  function loadDark() {
    var body = $('#dkBody'); if (!body) return;
    API.dark().then(function (d) {
      var rows = d.list || [];
      /* ---- KPI 概览（始终基于全量，保持监控视角稳定） ---- */
      var kpi = $('#dkKpi');
      if (kpi) {
        var tot = rows.reduce(function (a, b) { return a + (b.amount || 0); }, 0);
        var premN = rows.filter(function (x) { return x.premium > 0; }).length;
        var discN = rows.filter(function (x) { return x.premium < 0; }).length;
        var eqN = rows.length - premN - discN;
        var avgPrem = rows.length ? rows.reduce(function (a, b) { return a + b.premium; }, 0) / rows.length : 0;
        var maxP = rows.length ? Math.max.apply(null, rows.map(function (x) { return x.premium; })) : 0;
        var minP = rows.length ? Math.min.apply(null, rows.map(function (x) { return x.premium; })) : 0;
        kpi.innerHTML =
          kpiBox('交易日', d.date || '--') +
          kpiBox('成交笔数', rows.length + ' 笔', '', '溢价' + premN + ' / 平价' + eqN + ' / 折价' + discN) +
          kpiBox('合计成交额', yi(tot)) +
          kpiBox('最高溢价', pc(maxP), 'up') +
          kpiBox('最大折价', pc(minP), 'down') +
          kpiBox('平均溢价率', pc(avgPrem), cl(avgPrem));
      }
      renderDarkDist(rows);
      renderDarkSeat(rows);

      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="9"><div class="empty">暂无数据</div></td></tr>';
        return;
      }

      /* ---- 筛选分栏 ---- */
      var view = rows.filter(function (x) {
        if (dkState.filter === 'prem') return x.premium > 0;
        if (dkState.filter === 'disc') return x.premium < 0;
        if (dkState.filter === 'flat') return x.premium === 0;
        return true;
      });

      if (!view.length) {
        body.innerHTML = '<tr><td colspan="9"><div class="empty">当前筛选条件下暂无数据</div></td></tr>';
        bindRowClick('#dkBody');
        hideErr();
        return;
      }

      /* ---- 排序 ---- */
      var sorted = view.slice().sort(function (a, b) {
        if (dkState.sort === 'amount') return (b.amount || 0) - (a.amount || 0);
        if (dkState.sort === 'premium') return b.premium - a.premium;
        return (b.volume || 0) - (a.volume || 0);
      });

      body.innerHTML = sorted.map(function (s, i) {
        return '<tr data-code="' + esc(s.code) + '" data-secid="' + esc(s.secid) + '" data-name="' + esc(s.name) + '">' +
          '<td data-label="#" class="muted">' + (i + 1) + '</td>' +
          '<td data-label="代码/名称"><span class="c-name">' + esc(s.name) + '</span><span class="c-code">' + esc(s.code) + '</span></td>' +
          '<td data-label="成交价">' + fx(s.price) + '</td>' +
          '<td data-label="收盘价" class="muted">' + fx(s.close) + '</td>' +
          '<td data-label="溢价率" class="' + cl(s.premium) + '">' + pc(s.premium) + '</td>' +
          '<td data-label="成交量">' + fx(s.volume, 2) + '万股</td>' +
          '<td data-label="成交额">' + yi(s.amount) + '</td>' +
          '<td data-label="买方席位" style="max-width:200px;overflow:hidden;text-overflow:ellipsis" title="' + esc(s.buyer || '') + '">' + esc(s.buyer || '--') + '</td>' +
          '<td data-label="卖方席位" style="max-width:200px;overflow:hidden;text-overflow:ellipsis" title="' + esc(s.seller || '') + '">' + esc(s.seller || '--') + '</td>' +
          '</tr>';
      }).join('');

      bindRowClick('#dkBody');
      hideErr();
    }).catch(function (e) {
      body.innerHTML = '<tr><td colspan="9"><div class="empty">加载失败：' + esc(e.message) + '</div></td></tr>';
    });
  }
  /* 折溢价分布（全量统计，不随筛选变化） */
  function renderDarkDist(rows) {
    var dist = $('#dkDist'); if (!dist) return;
    if (!rows.length) { dist.innerHTML = '<div class="empty">暂无数据</div>'; return; }
    var prem = rows.filter(function (x) { return x.premium > 0; }).length;
    var disc = rows.filter(function (x) { return x.premium < 0; }).length;
    var eq = rows.length - prem - disc;
    var avg = rows.reduce(function (a, b) { return a + b.premium; }, 0) / rows.length;
    var mx = Math.max(prem, disc, eq, 1);
    dist.innerHTML =
      '<div class="ov-breadth" style="margin-bottom:8px">' +
        '<div class="ov-b-up" style="width:' + (prem / mx * 100) + '%"></div>' +
        '<div class="ov-b-flat" style="width:' + (eq / mx * 100) + '%"></div>' +
        '<div class="ov-b-down" style="width:' + (disc / mx * 100) + '%"></div>' +
      '</div>' +
      '<div class="kpi-row" style="margin-bottom:0">' +
        kpiBox('溢价成交', prem + ' 笔', 'up') +
        kpiBox('平价', eq + ' 笔', 'flat') +
        kpiBox('折价成交', disc + ' 笔', 'down') +
        kpiBox('平均溢价率', pc(avg), cl(avg)) +
      '</div>';
  }
  /* 机构席位统计（全量统计，不随筛选变化） */
  function renderDarkSeat(rows) {
    var seat = $('#dkSeat'); if (!seat) return;
    if (!rows.length) { seat.innerHTML = '<div class="empty">暂无数据</div>'; return; }
    var buyMap = {}, sellMap = {};
    rows.forEach(function (r) {
      if (r.buyer) { buyMap[r.buyer] = (buyMap[r.buyer] || 0) + (r.amount || 0); }
      if (r.seller) { sellMap[r.seller] = (sellMap[r.seller] || 0) + (r.amount || 0); }
    });
    var buyTop = Object.keys(buyMap).sort(function (a, b) { return buyMap[b] - buyMap[a]; }).slice(0, 6);
    var sellTop = Object.keys(sellMap).sort(function (a, b) { return sellMap[b] - sellMap[a]; }).slice(0, 6);
    var maxBuy = buyTop.length ? buyMap[buyTop[0]] : 1;
    var maxSell = sellTop.length ? sellMap[sellTop[0]] : 1;
    seat.innerHTML = '<div class="yz-rank-grid">' +
      '<div class="yz-rank"><div class="yz-rank-h">买方席位 TOP（按成交额）</div><div class="yz-rank-list">' +
        (buyTop.length ? buyTop.map(function (n) {
          return '<div class="rb"><span class="rb-name">' + esc(n) + '</span>' +
            '<span class="rb-track"><span class="rb-fill up" style="width:' + Math.round(buyMap[n] / maxBuy * 100) + '%"></span></span>' +
            '<span class="rb-val up">' + yi(buyMap[n]) + '</span></div>';
        }).join('') : '<div class="empty">暂无</div>') +
      '</div></div>' +
      '<div class="yz-rank"><div class="yz-rank-h">卖方席位 TOP（按成交额）</div><div class="yz-rank-list">' +
        (sellTop.length ? sellTop.map(function (n) {
          return '<div class="rb"><span class="rb-name">' + esc(n) + '</span>' +
            '<span class="rb-track"><span class="rb-fill down" style="width:' + Math.round(sellMap[n] / maxSell * 100) + '%"></span></span>' +
            '<span class="rb-val down">' + yi(sellMap[n]) + '</span></div>';
        }).join('') : '<div class="empty">暂无</div>') +
      '</div></div></div>';
  }

  /* =================================================================
     5.5 全景盘面（今日盘面 + 板块资金 融合页 · A股）
          对标基基窝（yysd.fun）「大盘指数 / 板块机会 / 市场情绪」的呈现，
          结合行情通真实的 A股 涨跌家数、大盘指数、板块主力资金流。
     ================================================================= */
  var ovTab = 'all';
  function renderOverview() {
    mount(
      pgHead('🌐', '全景盘面', 'A股今日盘面 × 板块资金：市场情绪、大盘指数、主力资金流向与板块热度机会', rfHTML()) +
      '<div class="pg-tools"><span class="lbl">视图</span>' + segHTML('ovTab', [['all', '综合'], ['index', '大盘指数'], ['sector', '板块资金']], ovTab) + '</div>' +
      '<div id="ovIndexWrap">' +
        '<div class="section-title ov-st">🧭 市场情绪</div>' +
        '<div class="panel ov-sent" id="ovSent"><div class="empty">加载中…</div></div>' +
        '<div class="section-title ov-st">📊 今日盘面 · 大盘指数</div>' +
        '<div class="idx-board" id="ovIdx"><div class="empty" style="grid-column:1/-1">加载中…</div></div>' +
      '</div>' +
      '<div id="ovSectorWrap" style="margin-top:4px">' +
        '<div class="section-title ov-st">💰 板块资金流向 · 主力净流入 TOP / BOTTOM</div>' +
        '<div class="yz-rank-grid" id="ovSecRank"></div>' +
        '<div class="panel" style="margin:12px 0"><div class="section-title ov-st" style="margin:0 0 8px;text-align:left">🔬 资金拆解（行业 + 概念 全板块合计）</div><div id="ovBreak"><div class="empty">加载中…</div></div></div>' +
        '<div class="section-title ov-st">🔥 板块机会 · 涨跌幅 / 热度</div>' +
        '<div class="ov-heat" id="ovHeat"><div class="empty">加载中…</div></div>' +
        '<div class="tbl-wrap" style="margin-top:12px"><table class="tbl"><thead><tr>' +
          '<th>#</th><th>板块</th><th>涨跌幅</th><th>主力净流入</th><th>上涨</th><th>下跌</th><th>领涨股</th>' +
          '</tr></thead><tbody id="ovSecBody"><tr><td colspan="7"><div class="empty">加载中…</div></td></tr></tbody></table></div>' +
      '</div>'
    );
    bindSeg('ovTab', function (v) {
      ovTab = v;
      var iw = $('#ovIndexWrap'), sw = $('#ovSectorWrap');
      if (iw) iw.style.display = (v === 'sector') ? 'none' : '';
      if (sw) sw.style.display = (v === 'index') ? 'none' : '';
    });
    bindRefresh(function () { GC.indicesTs = 0; GC.mstatTs = 0; loadOverview(true); });
    loadOverview();
    every(20000, function () { if (location.hash === '#/stock-overview') loadOverview(true); });
  }
  var lastSent = null;   // 最近一次市场情绪数据，供 KPI 点击弹窗复用
  function loadOverview() {
    var sent = $('#ovSent');

    /* ---- 市场情绪：同花顺优先 → 全局缓存 → 东财降级 ---- */
    if (!gcStale('mstat') && GC.mstat && sent) {
      lastSent = GC.mstat;
      sent.innerHTML = ovSentHTML(GC.mstat);
      bindSentKpis();
    } else {
      API.fuyaoStat().then(function (fyData) {
        if (fyData) {
          GC.fuyaoReady = true;
          gcSet('mstat', fyData); GC.mstatTTL = 30000;
          lastSent = fyData;
          if (sent) sent.innerHTML = ovSentHTML(fyData);
          bindSentKpis();
          /* 补东财主力净流入 */
          return API.marketStat().then(function (emData) {
            if (emData && !emData.partial) {
              var merged = Object.assign({}, fyData, { mainFlow: emData.mainFlow, partial: false });
              gcSet('mstat', merged); lastSent = merged;
              if (sent) sent.innerHTML = ovSentHTML(merged); bindSentKpis();
            }
          }).catch(function () {});
        }
        throw new Error('fuyao_unavailable');
      }).catch(function () {
        return API.marketStat('fast').then(function (d) {
          lastSent = d;
          if (sent) sent.innerHTML = ovSentHTML(d);
          bindSentKpis();
          gcSet('mstat', d); GC.mstatTTL = 90000;
          return API.marketStat();
        }).then(function (d) {
          if (d && !d.partial) { gcSet('mstat', d); lastSent = d; if (sent) sent.innerHTML = ovSentHTML(d); bindSentKpis(); }
        });
      }).catch(function () {});
    }

    /* ---- 大盘指数：全局缓存优先 ---- */
    if (!gcStale('indices') && GC.indices) {
      var ib = $('#ovIdx');
      if (ib) ib.innerHTML = GC.indices.map(function (x) {
        return '<div class="idx-card ' + cl(x.pct) + '">' +
          '<div class="idx-card-n">' + esc(x.name) + '</div>' +
          '<div class="idx-card-p">' + fx(x.price) + '</div>' +
          '<div class="idx-card-c ' + cl(x.pct) + '">' + pc(x.pct) + '</div>' +
          '<div class="idx-card-x"><span class="idx-amt">' + sg(x.change) + fx(x.change) + '</span> · <span class="idx-amt">额' + fx(x.amount, 0) + '亿</span></div>' +
          '</div>';
      }).join('');
    } else {
      API.indices({ scope: 'ashare' }).then(function (arr) {
        var box = $('#ovIdx'); if (!box) return;
        if (!arr.length) { box.innerHTML = '<div class="empty" style="grid-column:1/-1">暂无数据</div>'; return; }
        gcSet('indices', arr); ashareIdxCache = arr;   // 写入全局缓存，供 A股行情页复用
        box.innerHTML = arr.map(function (x) {
          return '<div class="idx-card ' + cl(x.pct) + '">' +
            '<div class="idx-card-n">' + esc(x.name) + '</div>' +
            '<div class="idx-card-p">' + fx(x.price) + '</div>' +
            '<div class="idx-card-c ' + cl(x.pct) + '">' + pc(x.pct) + '</div>' +
            '<div class="idx-card-x"><span class="idx-amt">' + sg(x.change) + fx(x.change) + '</span> · <span class="idx-amt">额' + fx(x.amount, 0) + '亿</span></div>' +
            '</div>';
        }).join('');
      }).catch(function () { var b = $('#ovIdx'); if (b) b.innerHTML = '<div class="empty" style="grid-column:1/-1">加载失败</div>'; });
    }

    /* ---- 板块资金：全局缓存优先（行业+概念合并缓存 25s）---- */
    function renderSectorData(all) {
      ovSecRank(all);
      var bd = $('#ovBreak'); if (bd) bd.innerHTML = breakdownHTML(all);
      ovHeat(all);
      ovSecTable(all);
      hideErr();
    }
    if (!gcStale('sector') && GC.sector) {
      renderSectorData(GC.sector);
    } else {
      /* 先显示骨架占位，数据到了再填充 */
      var sk = $('#ovSecRank'); if (sk) sk.innerHTML = '<div class="empty" style="grid-column:1/-1">板块数据加载中…</div>';
      Promise.all([
        API.sectorCapital('industry', 'flow'),
        API.sectorCapital('concept', 'flow')
      ]).then(function (res) {
        var ind = res[0] || [], con = res[1] || [];
        var all = ind.concat(con);
        gcSet('sector', all);   // 写入全局缓存
        renderSectorData(all);
      }).catch(function (e) { showErr('板块资金加载失败：' + e.message); });
    }
  }
  /* 🔬 资金拆解：主力 / 超大单 / 大单 / 中单 / 小单 的净额与占比
     占比按成交额加权不现实（接口没给板块成交额），这里展示净额合计 + 各档占比的算术均值 */
  function breakdownHTML(rows) {
    var keys = [
      ['主力净流入', 'flow', null],
      ['超大单', 'superAmt', 'superPct'],
      ['大单', 'bigAmt', 'bigPct'],
      ['中单', 'midAmt', 'midPct'],
      ['小单', 'smallAmt', 'smallPct']
    ];
    var sum = function (k) {
      return rows.reduce(function (a, b) { return a + (typeof b[k] === 'number' ? b[k] : 0); }, 0);
    };
    var avg = function (k) {
      var arr = rows.filter(function (b) { return typeof b[k] === 'number' && isFinite(b[k]); });
      return arr.length ? arr.reduce(function (a, b) { return a + b[k]; }, 0) / arr.length : null;
    };
    var main = sum('flow');
    var cells = keys.map(function (k) {
      var amt = sum(k[1]);
      var pct = k[2] ? avg(k[2]) : null;
      var isMain = k[2] === null;
      return '<div class="kpi"' + (isMain ? ' style="border-color:var(--up)"' : '') + '>' +
        '<div class="kpi-l">' + k[0] + '</div>' +
        '<div class="kpi-v ' + cl(amt) + '">' + yi(amt) + '</div>' +
        '<div class="kpi-s">' + (pct == null ? '占主力 ' + (main ? Math.round(amt / main * 100) : 0) + '%' : '均占比 ' + fx(pct) + '%') + '</div>' +
        '</div>';
    }).join('');
    return '<div class="kpi-row" style="margin-bottom:0">' + cells + '</div>';
  }
  function ovSentHTML(d) {
    if (!d) return '<div class="empty">暂无数据</div>';
    var upR = d.upPct == null ? 0 : d.upPct;
    var mood = upR >= 55 ? ['偏热', 'up'] : (upR <= 45 ? ['偏冷', 'down'] : ['中性', 'flat']);
    var ratio = (d.down > 0) ? (d.up / d.down) : (d.up > 0 ? 99 : 0);
    var tot = d.total || 1;
    var upW = Math.round(d.up / tot * 100), dnW = Math.round(d.down / tot * 100), flW = Math.round(d.flat / tot * 100);
    var flowCls = d.mainFlow == null ? 'muted' : cl(d.mainFlow);
    var flowTxt = d.mainFlow == null ? '统计中…' : (sg(d.mainFlow) + fx(d.mainFlow, 2) + '亿');
    return '<div class="ov-sent-head">' +
        '<div class="ov-mood ' + mood[1] + '">' + mood[0] + '</div>' +
        '<div class="ov-mood-sub">上涨占比 <b>' + upR + '%</b> · 涨跌比 <b class="' + (ratio >= 1 ? 'up' : 'down') + '">' + fx(ratio, 2) + '</b>' +
          (d.source ? ' · 来源 <b>' + (d.source === 'ths' ? '同花顺' : '东方财富') + '</b>' : '') + '</div>' +
      '</div>' +
      '<div class="ov-breadth">' +
        '<div class="ov-b-up" style="width:' + upW + '%"></div>' +
        '<div class="ov-b-flat" style="width:' + flW + '%"></div>' +
        '<div class="ov-b-down" style="width:' + dnW + '%"></div>' +
      '</div>' +
      '<div class="kpi-row" style="margin-top:12px">' +
        kpiBox('上涨', '<span class="up">' + d.up + '</span>', 'up', '占 ' + upR + '%', 'up') +
        kpiBox('下跌', '<span class="down">' + d.down + '</span>', 'down', '占 ' + (d.downPct || 0) + '%', 'down') +
        kpiBox('平盘', d.flat, 'flat', null, 'flat') +
        kpiBox('两市成交额', fx(d.amount, 3) + '<span style="font-size:13px"> 万亿</span>', '', fx(d.amountYi, 0) + ' 亿', 'amount') +
        kpiBox('主力净流入合计', '<span class="' + flowCls + '">' + flowTxt + '</span>', flowCls, null, 'flow') +
      '</div>';
  }
  /* 市场情绪 KPI 点击 → 弹窗展示具体数据 */
  function bindSentKpis() {
    $$('.kpi[data-sent]', $('#ovSent')).forEach(function (el) {
      el.onclick = function () { openSentModal(el.dataset.sent); };
    });
  }
  /* 各 KPI 对应的个股榜单 key → { title, list, cols } */
  function openSentModal(kind) {
    var d = lastSent; if (!d) { toast('数据加载中…'); return; }
    var MAP = {
      up:     { t: '涨幅 TOP 10',   list: d.topUp || d.top10,       c: [['排名'],['名称'],['代码'],['现价'],['涨幅']] },
      down:   { t: '跌幅 TOP 10',   list: d.topDown,                c: [['排名'],['名称'],['代码'],['现价'],['跌幅']] },
      flat:   { t: '平盘个股（抽样）', list: d.topFlat,             c: [['排名'],['名称'],['代码'],['现价'],['涨跌']] },
      amount: { t: '成交额 TOP 10', list: d.topAmt,                c: [['排名'],['名称'],['代码'],['现价'],['成交额(亿)']] },
      flow:   { t: '主力净流入 TOP 10', list: d.topFlowIn,         c: [['排名'],['名称'],['代码'],['现价'],['主力净流入(亿)']] }
    };
    var m = MAP[kind] || MAP.up;
    var arr = m.list || [];
    var rowsHtml;
    if (!arr.length) {
      rowsHtml = '<tr><td colspan="5"><div class="empty">暂无数据（需重启服务端后刷新）</div></td></tr>';
    } else {
      rowsHtml = arr.map(function (x) {
        var valCol;
        if (kind === 'up')   valCol = '<td class="' + cl(x.pct) + '">' + pc(x.pct) + '</td>';
        else if (kind === 'down') valCol = '<td class="' + cl(-x.pct) + '">' + pc(x.pct) + '</td>';
        else if (kind === 'flat') valCol = '<td class="flat">' + pc(x.pct) + '</td>';
        else if (kind === 'amount') valCol = '<td>' + fx(x.amount, 2) + '</td>';
        else valCol = '<td class="' + cl(x.flow) + '">' + yi(x.flow) + '</td>';
        return '<tr data-code="' + esc(x.code) + '" data-name="' + esc(x.name) + '" data-secid="' + esc(x.secid) + '">' +
          '<td class="muted">' + x.rank + '</td><td>' + esc(x.name) + '</td><td>' + esc(x.code) + '</td>' +
          '<td>' + fx(x.price) + '</td>' + valCol + '</tr>';
      }).join('');
    }
    /* 主力净流入额外追加流出榜 */
    var extraHtml = '';
    if (kind === 'flow' && (d.topFlowOut || []).length) {
      var outRows = d.topFlowOut.map(function (x) {
        return '<tr data-code="' + esc(x.code) + '" data-name="' + esc(x.name) + '" data-secid="' + esc(x.secid) + '">' +
          '<td class="muted">' + x.rank + '</td><td>' + esc(x.name) + '</td><td>' + esc(x.code) + '</td>' +
          '<td>' + fx(x.price) + '</td><td class="' + cl(x.flow) + '">' + yi(x.flow) + '</td></tr>';
      }).join('');
      extraHtml = '<div class="yz-sec" style="margin-top:16px"><span class="yz-bar">▍</span>主力净流出 TOP 10</div>' +
        '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>排名</th><th>名称</th><th>代码</th><th>现价</th><th>主力净流出(亿)</th></tr></thead><tbody>' +
        outRows + '</tbody></table></div>';
    }
    var label = { up:'上涨', down:'下跌', flat:'平盘', amount:'两市成交额', flow:'主力净流入合计' }[kind] || '市场情绪';
    var ov = $('#ovSentModal');
    if (!ov) { ov = document.createElement('div'); ov.id = 'ovSentModal'; ov.className = 'modal-mask'; document.body.appendChild(ov); }
    ov.innerHTML = '<div class="modal"><div class="modal-h"><span>' + label + ' · ' + m.t + '</span>' +
      '<button class="modal-x" onclick="OV_closeSent()">×</button></div>' +
      '<div class="yz-sec"><span class="yz-bar">▍</span>' + m.t + '（点击查看个股详情）</div>' +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
      m.c.map(function (h) { return '<th>' + h[0] + '</th>'; }).join('') +
      '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>' + extraHtml + '</div>';
    ov.classList.add('show'); raiseModal(ov);
    ov.onclick = function (e) { if (e.target === ov) OV_closeSent(); };
    bindRowClick('#ovSentModal');
  }
  window.OV_closeSent = function () { var ov = $('#ovSentModal'); if (ov) ov.classList.remove('show'); };
  function ovSecRank(all) {
    var box = $('#ovSecRank'); if (!box) return;
    if (!all.length) { box.innerHTML = '<div class="empty">暂无数据</div>'; return; }
    var inflow = all.filter(function (x) { return x.flow > 0; }).sort(function (a, b) { return b.flow - a.flow; }).slice(0, 8);
    var outflow = all.filter(function (x) { return x.flow < 0; }).sort(function (a, b) { return a.flow - b.flow; }).slice(0, 8);
    box.innerHTML = rankBlockHTML('主力净流入 TOP', 'ovIn') + rankBlockHTML('主力净流出 TOP', 'ovOut');
    renderFlowList($('#ovIn'), inflow, 'in');
    renderFlowList($('#ovOut'), outflow, 'out');
  }
  function renderFlowList(box, arr, dir) {
    if (!box) return;
    if (!arr.length) { box.innerHTML = '<div class="empty">暂无</div>'; return; }
    var max = Math.max.apply(null, arr.map(function (x) { return Math.abs(x.flow); })) || 1;
    box.innerHTML = arr.map(function (x) {
      var w = Math.max(4, Math.round(Math.abs(x.flow) / max * 100));
      return '<div class="fb"><span class="fb-label">' + esc(x.name) + '</span>' +
        '<span class="fb-track"><span class="fb-fill ' + dir + '" style="width:' + w + '%"></span></span>' +
        '<span class="fb-val ' + cl(x.flow) + '">' + yi(x.flow) + '</span></div>';
    }).join('');
  }
  function ovHeat(all) {
    var box = $('#ovHeat'); if (!box) return;
    var arr = all.slice().sort(function (a, b) { return b.pct - a.pct; }).slice(0, 24);
    if (!arr.length) { box.innerHTML = '<div class="empty">暂无数据</div>'; return; }
    var upN = all.filter(function (x) { return x.pct > 0; }).length;
    var dnN = all.filter(function (x) { return x.pct < 0; }).length;
    box.innerHTML = '<div class="ov-heat-sum">上涨板块 <b class="up">' + upN + '</b> · 下跌板块 <b class="down">' + dnN + '</b> · 最强 <b>' + esc(arr[0].name) + ' ' + pc(arr[0].pct) + '</b></div>' +
      arr.map(function (x) {
        return '<div class="ov-hc ' + cl(x.pct) + '">' +
          '<div class="ov-hc-n">' + esc(x.name) + '</div>' +
          '<div class="ov-hc-p ' + cl(x.pct) + '">' + pc(x.pct) + '</div>' +
          '<div class="ov-hc-m">主力 ' + yi(x.flow) + ' · 涨' + x.up + '/跌' + x.down + '</div>' +
          '</div>';
      }).join('');
  }
  /* 板块表格：默认只渲染 TOP 60，其余点「展开」按需渲染。
     全量约 470 个板块（行业~90 + 概念~380）× 7 列 ≈ 3300 个 <td>，
     一次性同步 innerHTML 会长时间阻塞主线程 —— 这是首屏卡顿的最大来源。 */
  var OV_SEC_LIMIT = 60;
  var ovSecAll = [];
  function ovSecTable(all) {
    ovSecAll = all.slice().sort(function (a, b) { return b.flow - a.flow; });
    renderOvSecRows(OV_SEC_LIMIT);
    bindSectorRows();
  }
  function renderOvSecRows(limit) {
    var body = $('#ovSecBody'); if (!body) return;
    var rows = limit >= ovSecAll.length ? ovSecAll : ovSecAll.slice(0, limit);
    var html = rows.map(function (s, i) {
      return '<tr data-secid="' + esc(s.secid) + '" data-code="' + esc(s.leadCode) + '" data-name="' + esc(s.name) + '">' +
        '<td class="muted">' + (i + 1) + '</td>' +
        '<td><span class="c-name">' + esc(s.name) + '</span></td>' +
        '<td class="' + cl(s.pct) + '">' + pc(s.pct) + '</td>' +
        '<td class="' + cl(s.flow) + '">' + yi(s.flow) + '</td>' +
        '<td class="up">' + s.up + '</td>' +
        '<td class="down">' + s.down + '</td>' +
        '<td>' + esc(s.lead || '--') + ' <span class="' + cl(s.leadPct) + '">' + pc(s.leadPct) + '</span></td>' +
        '</tr>';
    }).join('');
    if (ovSecAll.length > rows.length) {
      html += '<tr id="ovSecMore"><td colspan="7" style="text-align:center">' +
        '<button class="btn ghost sm" type="button">展开剩余 ' + (ovSecAll.length - rows.length) +
        ' 个板块（共 ' + ovSecAll.length + '）</button></td></tr>';
    }
    body.innerHTML = html;
  }

  /* =================================================================
     6. 游资操作（龙虎榜）
     ================================================================= */
  /* =================================================================
     6. 游资作战室 · 龙虎榜（对标 yysd.fun/#/stock-youzi）
     ================================================================= */
  var yzDate = '';
  var yzView = 'seat';   // seat=按游资 / stock=按个股 / all=全部明细
  var yzSearch = '';
  var yzCache = null;

  function rankBlockHTML(title, id, hint) {
    return '<div class="yz-rank"><div class="yz-rank-h">' + esc(title) +
      (hint ? '<span class="yz-rank-hint">' + esc(hint) + '</span>' : '') + '</div>' +
      '<div class="yz-rank-list" id="' + id + '"></div></div>';
  }

  function renderYouzi() {
    mount(
      pgHead('🐉', '游资作战室 · 龙虎榜', '龙虎榜每日上榜营业部与个股的买卖净额，按知名游资聚合', rfHTML()) +
      '<div class="yz-toolbar">' +
        '<label class="yz-date">交易日 <input type="date" id="yzDate" class="yz-date-in"></label>' +
      '</div>' +
      '<div class="kpi-row" id="yzKpi"></div>' +
      '<div class="yz-rank-grid">' +
        rankBlockHTML('游资净买入 TOP 10', 'yzBuy') +
        rankBlockHTML('游资净卖出 TOP 10', 'yzSell') +
        rankBlockHTML('个股净买入 TOP 10', 'yzStockBuy') +
        rankBlockHTML('个股净卖出 TOP 10', 'yzStockSell') +
      '</div>' +
      '<div class="yz-detail">' +
        '<div class="yz-detail-head">' +
          segHTML('yzView', [['seat', '按游资'], ['stock', '按个股'], ['all', '全部明细']], yzView) +
          '<input type="search" id="yzSearch" class="yz-search" placeholder="搜索游资数据（名称 / 代码 / 营业部）">' +
        '</div>' +
        '<div id="yzCards" class="yz-cards"></div>' +
      '</div>'
    );
    var di = $('#yzDate');
    if (di) {
      di.value = yzDate || '';
      di.addEventListener('change', function () { yzDate = di.value; yzCache = null; loadYouzi(true); });
    }
    bindSeg('yzView', function (v) { yzView = v; renderDetail(); });
    var sb = $('#yzSearch');
    if (sb) sb.addEventListener('input', function () { yzSearch = sb.value.trim(); renderDetail(); });
    bindRefresh(function () { yzCache = null; loadYouzi(true); });
    loadYouzi();
    every(30000, function () { if (location.hash === '#/stock-youzi') loadYouzi(true); });
  }

  function loadYouzi(force) {
    var draw = function (d) {
      yzCache = d;
      if (!yzDate && d.date) { yzDate = d.date; var di = $('#yzDate'); if (di) di.value = yzDate; }
      var k = d.kpi || {};
      $('#yzKpi').innerHTML = [
        kpiBox('当日净买入合计', yi(k.netSum), k.netSum >= 0 ? 'up' : 'down'),
        kpiBox('上榜游资', (k.seatCount || 0) + ' 家'),
        kpiBox('上榜个股', (k.stockCount || 0) + ' 只'),
        kpiBox('龙虎榜成交', yi(k.dealAmt)),
        kpiBox('活跃营业部', (k.deptCount || 0) + ' 家')
      ].join('');
      drawRankList($('#yzBuy'), d.seatsRank, 'seat');
      drawRankList($('#yzSell'), d.seatsSellRank, 'seat');
      drawRankList($('#yzStockBuy'), d.stocksRank.buyTop, 'stock');
      drawRankList($('#yzStockSell'), d.stocksRank.sellTop, 'stock');
      renderDetail();
      hideErr();
    };
    if (yzCache && !force) return draw(yzCache);
    API.youzi(yzDate).then(draw).catch(function (e) {
      $('#yzKpi').innerHTML = '';
      showErr('游资数据加载失败：' + e.message);
    });
  }

  /* 渲染单个 TOP 排行（按钮列表，点击游资→画像 / 个股→详情） */
  function drawRankList(box, arr, kind) {
    if (!box) return;
    if (!arr || !arr.length) { box.innerHTML = '<div class="empty">暂无数据</div>'; return; }
    box.innerHTML = arr.map(function (s, i) {
      var net = s.net;
      var sub = kind === 'seat'
        ? ('涉及个股 ' + s.stocks + ' · 席位 ' + s.depts)
        : (s.code + ' ' + pc(s.pct));
      var init = s.initial || (s.name || '?').slice(0, 1);
      var crown = i === 0 ? '<span class="yz-crown">👑</span>' : '<span class="yz-rk-no">' + (i + 1) + '</span>';
      var attr = kind === 'seat'
        ? 'data-seat="' + esc(s.name) + '"'
        : 'data-code="' + esc(s.code) + '" data-name="' + esc(s.name) + '"';
      return '<button class="yz-rank-item" ' + attr + '>' +
        crown +
        '<span class="yz-avatar">' + esc(init) + '</span>' +
        '<span class="yz-rk-name"><span class="yz-rk-nm">' + esc(s.name) + '</span>  <span class="yz-rk-amt ' + cl(net) + '">' + sg(net) + yi(net) + '</span>  <span class="yz-rk-sub">' + esc(sub) + '</span></span>' +
        '</button>';
    }).join('');
    $$('.yz-rank-item', box).forEach(function (el) {
      el.onclick = function () {
        if (el.dataset.seat) openYouziPortrait(el.dataset.seat);
        else if (el.dataset.code) openDetail(el.dataset.code, el.dataset.name);
      };
    });
  }

  /* 明细区：按游资 / 按个股 / 全部明细，含搜索 */
  function renderDetail() {
    var box = $('#yzCards'); if (!box || !yzCache) return;
    var d = yzCache;
    var q = yzSearch.toLowerCase();

    if (yzView === 'seat') {
      var list = d.hotSeats || [];
      if (q) list = list.filter(function (s) { return (s.name || '').toLowerCase().indexOf(q) >= 0; });
      box.className = 'yz-cards';
      if (!list.length) { box.innerHTML = '<div class="empty">无匹配游资</div>'; return; }
      box.innerHTML = list.map(function (s) {
        var net = s.net;
        var init = s.initial || (s.name || '?').slice(0, 1);
        return '<button class="yz-seat-card" data-seat="' + esc(s.name) + '">' +
          '<span class="yz-avatar">' + esc(init) + '</span>' +
          '<span class="yz-sc-name">' + esc(s.name) + (s.isKnown ? '' : '<span class="yz-sc-tag">营业部</span>') + '  <span class="yz-sc-amt ' + cl(net) + '">' + sg(net) + yi(net) + '</span></span>' +
          '<span class="yz-sc-sub">涉及个股 ' + s.stocks + ' · 席位 ' + s.depts + '</span>' +
          '</button>';
      }).join('');
      $$('.yz-seat-card', box).forEach(function (el) {
        el.onclick = function () { openYouziPortrait(el.dataset.seat); };
      });

    } else if (yzView === 'stock') {
      var map = {};
      (d.detail || []).forEach(function (r) {
        if (!map[r.code]) map[r.code] = { code: r.code, name: r.name, net: 0, depts: {} };
        map[r.code].net += r.net; map[r.code].depts[r.dept] = 1;
      });
      var arr = Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return b.net - a.net; });
      if (q) arr = arr.filter(function (s) { return (s.name || '').toLowerCase().indexOf(q) >= 0 || (s.code || '').indexOf(q) >= 0; });
      box.className = 'yz-cards yz-cards-stock';
      if (!arr.length) { box.innerHTML = '<div class="empty">无匹配个股</div>'; return; }
      box.innerHTML = arr.map(function (s) {
        return '<button class="yz-seat-card" data-code="' + esc(s.code) + '" data-name="' + esc(s.name) + '">' +
          '<span class="yz-avatar">' + esc((s.name || '?').slice(0, 1)) + '</span>' +
          '<span class="yz-sc-name">' + esc(s.name) + '  <span class="yz-sc-amt ' + cl(s.net) + '">' + sg(s.net) + yi(s.net) + '</span></span>' +
          '<span class="yz-sc-sub">' + esc(s.code) + ' · 席位 ' + Object.keys(s.depts).length + '</span>' +
          '</button>';
      }).join('');
      $$('.yz-seat-card', box).forEach(function (el) {
        el.onclick = function () { if (el.dataset.code) openDetail(el.dataset.code, el.dataset.name); };
      });

    } else {
      var rows = d.detail || [];
      if (q) rows = rows.filter(function (r) {
        return (r.name || '').toLowerCase().indexOf(q) >= 0 || (r.code || '').indexOf(q) >= 0 ||
          (r.dept || '').toLowerCase().indexOf(q) >= 0 || (r.youzi || '').toLowerCase().indexOf(q) >= 0;
      });
      box.className = 'tbl-wrap';
      if (!rows.length) { box.innerHTML = '<div class="empty">无匹配记录</div>'; return; }
      box.innerHTML = '<table class="tbl"><thead><tr>' +
        '<th>日期</th><th>代码</th><th>名称</th><th>营业部</th><th>游资</th><th>买入</th><th>卖出</th><th>净额</th>' +
        '</tr></thead><tbody>' + rows.map(function (r) {
          return '<tr data-code="' + esc(r.code) + '" data-name="' + esc(r.name) + '">' +
            '<td>' + esc(r.date) + '</td><td>' + esc(r.code) + '</td><td>' + esc(r.name) + '</td>' +
            '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis" title="' + esc(r.dept) + '">' + esc(r.dept) + '</td>' +
            '<td>' + esc(r.youzi) + '</td>' +
            '<td class="up">' + yi(r.buy) + '</td><td class="down">' + yi(r.sell) + '</td>' +
            '<td class="' + cl(r.net) + '">' + sg(r.net) + yi(r.net) + '</td>' +
            '</tr>';
        }).join('') + '</tbody></table>';
      bindRowClick('#yzCards');
    }
  }

  /* 弹窗层级管理：后打开的弹窗始终在最上层，前一个弹窗保持显示不被盖掉
     （解决「游资画像里点个股 → 打开详情弹窗时画像被遮罩盖住」的问题） */
  var modalZ = 50;
  function raiseModal(el) { var m = typeof el === 'string' ? $(el) : el; if (m) m.style.zIndex = ++modalZ; }
  /* 游资画像弹窗：关联营业部 + 近期交易明细 */
  function openYouziPortrait(name) {
    var ov = $('#yzPortrait');
    if (!ov) {
      ov = document.createElement('div'); ov.id = 'yzPortrait'; ov.className = 'modal-mask';
      document.body.appendChild(ov);
    }
    ov.innerHTML = '<div class="modal yz-portrait">' +
      '<div class="modal-h"><span id="yzPortraitTitle"></span><button class="modal-x" onclick="YZ_closePortrait()">×</button></div>' +
      '<div class="yz-portrait-body" id="yzPortraitBody"><div class="empty">加载游资画像…</div></div></div>';
    ov.classList.add('show');
    raiseModal(ov);
    ov.onclick = function (e) { if (e.target === ov) YZ_closePortrait(); };
    API.youziPortrait(name, yzDate).then(function (r) {
      var dd = r || {};
      var t = $('#yzPortraitTitle'); if (t) t.textContent = name + ' · 游资画像';
      var depts = (dd.depts || []).map(function (x) { return '<span class="yz-tag">' + esc(x) + '</span>'; }).join('');
      var trades = dd.trades || [];
      var rows = trades.map(function (t2) {
        return '<tr data-code="' + esc(t2.code) + '" data-name="' + esc(t2.name) + '">' +
          '<td>' + esc(t2.date) + '</td><td>' + esc(t2.code) + '</td><td>' + esc(t2.name) + '</td>' +
          '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis" title="' + esc(t2.dept) + '">' + esc(t2.dept) + '</td>' +
          '<td class="up">' + yi(t2.buy) + '</td><td class="down">' + yi(t2.sell) + '</td>' +
          '<td class="' + cl(t2.net) + '">' + sg(t2.net) + yi(t2.net) + '</td>' +
          '</tr>';
      }).join('');
      var body = $('#yzPortraitBody');
      var noteHtml = dd.note ? '<div class="yz-note">⚠️ ' + esc(dd.note) + '</div>' : '';
      if (body) body.innerHTML =
        noteHtml +
        '<div class="yz-sec"><span class="yz-bar">▍</span>关联营业部</div>' +
        '<div class="yz-tags">' + (depts || '<span class="muted">—</span>') + '</div>' +
        '<div class="yz-sec"><span class="yz-bar">▍</span>近期交易（' + trades.length + ' 条）</div>' +
        '<div class="tbl-wrap yz-trades"><table class="tbl"><thead><tr>' +
        '<th>日期</th><th>代码</th><th>名称</th><th>营业部</th><th>买入</th><th>卖出</th><th>净额</th>' +
        '</tr></thead><tbody>' + (rows || '<tr><td colspan="7"><div class="empty">暂无</div></td></tr>') + '</tbody></table></div>';
      bindRowClick('#yzPortraitBody');
    }).catch(function (e) {
      var body = $('#yzPortraitBody');
      if (body) body.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>';
    });
  }
  window.YZ_closePortrait = function () { var ov = $('#yzPortrait'); if (ov) ov.classList.remove('show'); };

  /* =================================================================
     7. 股票资讯（拆分 A股 / 港股 / 美股 / 异动 四标签）
     ================================================================= */
  var NW_TABS = [['all', '全部'], ['a', 'A股'], ['hk', '港股'], ['us', '美股'], ['alert', '异动']];
  var NW_SRCS = [['all', '全部来源'], ['东方财富', '东方财富'], ['同花顺', '同花顺'], ['新浪财经', '新浪']];
  var nwTab = 'all';
  var nwSrc = 'all';
  function renderNews() {
    mount(
      pgHead('📰', '股票快讯 · 多渠道', '东方财富 · 同花顺 · 新浪 三源聚合，实时滚动更新', rfHTML()) +
      '<div class="pg-tools">' + segHTML('nwTab', NW_TABS, nwTab) + '</div>' +
      '<div class="pg-tools">' + segHTML('nwSrc', NW_SRCS, nwSrc) + '</div>' +
      '<div id="nwBox"><div class="empty">加载中…</div></div>'
    );
    bindSeg('nwTab', function (v) { nwTab = v; loadNews(true); });
    bindSeg('nwSrc', function (v) { nwSrc = v; loadNews(true); });
    bindRefresh(function () { loadNews(true); });
    loadNews();
    every(60000, function () { if (location.hash === '#/stock-news') loadNews(true); });
  }
  /* 快讯时间：ISO 串 → 绝对时间 + 相对时间 */
  function nwTime(iso) {
    var full = String(iso || '').replace('T', ' ');
    if (!iso) return { abs: '--', rel: '', full: '' };
    var d = new Date(String(iso).replace(/-/g, '/').replace('T', ' '));
    if (isNaN(d.getTime())) return { abs: '--', rel: '', full: full };
    var now = new Date(), pad = function (v) { return ('0' + v).slice(-2); };
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    var d0 = d.toDateString(), n0 = now.toDateString();
    var y = new Date(now.getTime() - 86400000).toDateString();
    var abs = d0 === n0 ? hm
      : d0 === y ? '昨天 ' + hm
        : pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + hm;
    var m = Math.floor((now - d) / 60000);
    var rel = m < 1 ? '刚刚'
      : m < 60 ? m + ' 分钟前'
        : m < 1440 ? Math.floor(m / 60) + ' 小时前'
          : Math.floor(m / 1440) + ' 天前';
    return { abs: abs, rel: rel, full: full };
  }
  function srcKey(s) { return s === '同花顺' ? 'ths' : s === '新浪财经' ? 'sina' : 'em'; }
  function loadNews(silent) {
    var box = $('#nwBox'); if (!box) return;
    /* 分类 + 来源过滤均由服务端完成（多渠道并行抓取后统一过滤），前端只负责渲染 */
    API.news(nwTab, nwSrc).then(function (d) {
      var rows = d && d.list ? d.list : [];
      if (!rows.length) {
        var scope = (nwSrc === 'all' ? '全部来源' : nwSrc) + ' · ' + (nwTab === 'all' ? '全部' : nwTab);
        box.innerHTML = '<div class="empty">当前筛选（' + esc(scope) + '）下暂无快讯</div>';
        return;
      }
      /* 港股 / 美股分类天然稀疏，数量过少时给出说明，避免误以为数据没加载 */
      var note = (rows.length < 6 && (nwTab === 'hk' || nwTab === 'us'))
        ? '<div class="empty" style="padding:8px 12px;font-size:12.5px">该分类快讯本身较少（已聚合 东方财富 / 同花顺 / 新浪 三源），以上为当前全部命中</div>'
        : '';
      box.innerHTML = note + rows.map(function (n) {
        var t = nwTime(n.time);
        return '<a class="nw-item" href="' + esc(n.url || '#') + '" target="_blank" rel="noopener" ' +
          'title="' + esc(t.full) + '">' +
          '<div class="nw-meta">' +
          '<span class="nw-time">' + esc(t.abs) + '</span>' +
          '<span class="nw-rel">' + esc(t.rel) + '</span>' +
          (n.tag ? '<span class="nw-tag">' + esc(n.tag) + '</span>' : '') +
          (n.sources && n.sources.length ? n.sources : [n.source || '']).map(function (s) {
            return s ? '<span class="nw-src s-' + srcKey(s) + '">' + esc(s) + '</span>' : '';
          }).join('') +
          '</div>' +
          '<span class="nw-title">' + esc(n.title || '') + '</span>' +
          (n.summary ? '<div class="nw-sum">' + esc(n.summary) + '</div>' : '') +
          '</a>';
      }).join('');
      box.style.background = 'var(--card)';
      box.style.border = '1px solid var(--border)';
      box.style.borderRadius = '14px';
      box.style.overflow = 'hidden';
      hideErr();
    }).catch(function (e) {
      box.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>';
    });
  }

  /* =================================================================
     8. 美股行情
     ================================================================= */
  var US_TABS = [['tech', '科技巨头'], ['chip', '半导体'], ['china', '中概股'], ['ev', '电动车'],
    ['retail', '消费零售'], ['finance', '金融'], ['medical', '医疗健康'],
    ['energy', '能源材料工业'], ['comm', '通信媒体互联网'], ['etf', 'ETF/指数'],
    ['consumer', '消费日常'], ['industrial', '工业制造'], ['reit', 'REITs']];
  var usGroup = 'tech';
  function renderUS() {
    mount(
      pgHead('🇺🇸', '美股实时行情', '按板块查看美股实时行情，点击卡片查看个股详情', rfHTML()) +
      '<div class="pg-tools">' + segHTML('usTab', US_TABS, usGroup) + '</div>' +
      '<div id="usCards" class="wl-cards"><div class="empty" style="grid-column:1/-1">加载中…</div></div>'
    );
    bindSeg('usTab', function (v) { usGroup = v; loadUS(); });
    bindRefresh(loadUS);
    loadUS();
    every(20000, function () { if (location.hash === '#/stock-us') loadUS(); });
  }
  function loadUS() {
    var box = $('#usCards'); if (!box) return;
    API.usSector(usGroup).then(function (d) {
      var rows = (d.list || []).filter(function (x) { return x.price != null; });
      if (!rows.length) { box.innerHTML = '<div class="empty" style="grid-column:1/-1">暂无数据</div>'; return; }
      box.innerHTML = rows.map(function (x) {
        /* 市值 / 市盈率 / 市净率（对标参考站卡片信息量） */
        var meta = [];
        if (x.mktcap != null) meta.push('市值 ' + yi(x.mktcap));
        if (x.pe != null && x.pe > 0) meta.push('PE ' + fx(x.pe));
        if (x.pb != null && x.pb > 0) meta.push('PB ' + fx(x.pb));
        return '<div class="wl-card ' + cl(x.pct) + '" data-code="' + esc(x.code) + '" data-secid="' + esc(x.secid) + '" data-name="' + esc(x.name) + '">' +
          '<div class="wl-card-name">' + esc(x.name) + '</div>' +
          '<div class="wl-card-code">' + esc(x.code) + '</div>' +
          '<div class="wl-card-price">' + fx(x.price) + '</div>' +
          '<div class="wl-card-chg ' + cl(x.pct) + '">' + pc(x.pct) + '</div>' +
          (meta.length ? '<div class="wl-card-meta">' + esc(meta.join(' · ')) + '</div>' : '') +
          '</div>';
      }).join('');
      hideErr();
    }).catch(function (e) {
      box.innerHTML = '<div class="empty" style="grid-column:1/-1">加载失败：' + esc(e.message) + '</div>';
    });
  }

  /* =================================================================
     9. 预测 PP（量化选股）
     tab：今日推荐（原逻辑） / 回测验证（A1）
     ================================================================= */
  /* A1：回测页签 */
  var FC_TABS = [['pick', '今日推荐'], ['bt', '回测验证']];
  var BT_HOLD_TABS = [['1', 'T+1'], ['5', 'T+5'], ['10', 'T+10'], ['20', 'T+20']];
  var BT_DAY_TABS = [['120', '近半年'], ['250', '近一年'], ['500', '近两年']];
  var fcTab = 'pick';
  var btState = { days: '250', hold: '5', pool: '' };
  var fcCodes = [];   /* 当前推荐列表代码，作为回测默认股票池 */

  function renderForecast() {
    mount(
      pgHead('📈', '预测 PP · 每日收盘荐股',
        '按「主力净流入甜区 + 量能放大 + 均线结构 + 位置安全」四维打分，全市场扫描筛出资金关注且尚未过热的票') +
      '<div class="pg-tools"><span class="lbl">视图</span>' + segHTML('fcTab', FC_TABS, fcTab) + '</div>' +
      '<div id="fcBox"><div class="empty">正在全市场扫描，请稍候…</div></div>'
    );
    bindSeg('fcTab', function (v) { fcTab = v; renderFcBody(); });
    renderFcBody();
  }
  function renderFcBody() {
    var box = $('#fcBox'); if (!box) return;
    if (fcTab === 'bt') renderBacktest();
    else loadForecast();
  }
  function loadForecast() {
    var box = $('#fcBox'); if (!box) return;
    API.forecast().then(function (d) {
      var rows = d.list || [];
      fcCodes = rows.map(function (r) { return r.code; });   /* 供回测页签作默认股票池 */
      if (!rows.length) {
        box.innerHTML = '<div class="empty">今日暂无符合条件的标的（四维打分需 ≥50 分）</div>';
        return;
      }
      box.innerHTML =
        '<div class="pg-tools"><span class="lbl">交易日</span><b>' + esc(d.date) + '</b>' +
        '<span class="lbl" style="margin-left:12px">命中</span><b>' + rows.length + '</b> 只' +
        '<span class="lbl" style="margin-left:auto">图例：多=均线多头 资=主力净流入 量=量比&gt;1 位=偏离MA20&lt;15%</span></div>' +
        fcSummary(rows) +
        '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
        '<th>#</th><th>代码 / 名称</th><th>现价</th><th>涨跌幅</th><th>评分</th><th>量化</th><th>四维</th>' +
        '<th>预测</th><th>目标价</th><th>上涨空间</th><th>支撑位</th><th>盈亏比</th>' +
        '<th>主力净流入</th><th>净占比</th><th>成交额</th><th>量比</th>' +
        '</tr></thead><tbody id="fcBody">' + fcRows(rows) + '</tbody></table></div>';
      bindRowClick('#fcBody');
      hideErr();
    }).catch(function (e) {
      box.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>';
    });
  }
  /* 预测结果汇总：把「预测结论」量化成一眼可读的指标 */
  function fcSummary(rows) {
    var n = rows.length || 1;
    var sum = function (f) { return rows.reduce(function (a, r) { return a + (f(r) || 0); }, 0); };
    var bullN = rows.filter(function (r) { return r.view === '强烈看多' || r.view === '看多'; }).length;
    var strongN = rows.filter(function (r) { return r.view === '强烈看多'; }).length;
    var avgScore = Math.round(sum(function (r) { return r.score; }) / n);
    var avgUp = sum(function (r) { return r.upside; }) / n;
    var rrArr = rows.filter(function (r) { return r.rr != null; });
    var avgRR = rrArr.length ? sum(function (r) { return r.rr; }) / rrArr.length : null;
    return '<div class="kpi-row">' +
      kpiBox('命中标的', rows.length + ' 只', '') +
      kpiBox('看多 / 强烈看多', bullN + ' / ' + strongN, 'up') +
      kpiBox('平均评分', avgScore + ' 分', '') +
      kpiBox('平均上涨空间', pc(avgUp), 'up') +
      kpiBox('平均盈亏比', avgRR == null ? '--' : fx(avgRR, 2), '') +
      '</div>';
  }
  var VIEW_CLS = { '强烈看多': 'vw-strong', '看多': 'vw-up', '偏多': 'vw-mid', '中性': 'vw-flat' };
  function viewBadge(v) {
    return '<span class="vw ' + (VIEW_CLS[v] || 'vw-flat') + '">' + esc(v || '--') + '</span>';
  }
  function fcRows(rows) {
    return rows.map(function (s, i) {
      var flag = function (on, t) { return '<span style="display:inline-block;width:20px;height:20px;line-height:20px;text-align:center;border-radius:5px;font-size:11px;margin-right:3px;background:' + (on ? 'rgba(245,72,59,.15);color:var(--up)' : 'var(--bg-chip);color:var(--text-faint)') + '">' + t + '</span>'; };
      var tipTxt = 'MA5 ' + fx(s.ma5) + ' / MA10 ' + fx(s.ma10) + ' / MA20 ' + fx(s.ma20) + ' / MA60 ' + fx(s.ma60) +
        '\n20日高点 ' + fx(s.hi20) + ' / 20日低点 ' + fx(s.lo20) +
        '\n偏离MA20 ' + fx(s.dev, 2) + '%　评分 ' + s.score +
        (s.qfScore != null ? '\n量化评分(周线8因子) ' + s.qfScore : '') +
        (s.qf ? '\n因子: 动量' + s.qf.mom_12_1 + '% 反转' + s.qf.rev_4 + '% 低波' + s.qf.low_vol_12 + '%' +
               '\n　　　量能比' + s.qf.amount_trend + ' 偏离' + s.qf.trend_dev + '% 斜率' + s.qf.trend_slope + '%' +
               '\n　　　距高' + s.qf.pos_52 + '% 低振' + s.qf.low_amp_8 + '%' : '');
      return '<tr data-code="' + esc(s.code) + '" data-secid="' + esc(s.secid) + '" data-name="' + esc(s.name) + '" title="' + esc(tipTxt) + '">' +
        '<td data-label="#" class="muted">' + (i + 1) + '</td>' +
        '<td data-label="代码/名称"><span class="c-name">' + esc(s.name) + '</span><span class="c-code">' + esc(s.code) + '</span></td>' +
        '<td data-label="现价">' + fx(s.price) + '</td>' +
        '<td data-label="涨跌幅" class="' + cl(s.pct) + '">' + pc(s.pct) + '</td>' +
        '<td data-label="评分"><b style="color:var(--primary)">' + s.score + '</b></td>' +
        '<td data-label="量化" title="周线8因子等权合成（动量/反转/低波/量能/趋势位置/趋势斜率/距高回撤/低振幅），MAD标准化。离线 walk-forward 验证见 wf_validate.py">' +
          (s.qfScore != null ? '<b style="color:' + (s.qfScore >= 70 ? 'var(--up)' : s.qfScore >= 55 ? 'var(--primary)' : 'var(--muted)') + '">' + s.qfScore + '</b>' : '<span class="muted">--</span>') + '</td>' +
        '<td data-label="四维">' + flag(s.bull, '多') + flag(s.cash, '资') + flag(s.vol, '量') + flag(s.safe, '位') + '</td>' +
        '<td data-label="预测">' + viewBadge(s.view) + '</td>' +
        '<td data-label="目标价"><b>' + fx(s.target) + '</b></td>' +
        '<td data-label="上涨空间" class="up">' + (s.upside == null ? '--' : pc(s.upside)) + '</td>' +
        '<td data-label="支撑位">' + fx(s.support) + '</td>' +
        '<td data-label="盈亏比">' + (s.rr == null ? '--' : fx(s.rr, 2)) + '</td>' +
        '<td data-label="主力净流入" class="' + cl(s.mainNetInflow) + '">' + yi(s.mainNetInflow) + '</td>' +
        '<td data-label="净占比" class="' + cl(s.netRatio) + '">' + fx(s.netRatio, 2) + '%</td>' +
        '<td data-label="成交额">' + yi(s.amount) + '</td>' +
        '<td data-label="量比">' + fx(s.volumeRatio) + '</td>' +
        '</tr>';
    }).join('');
  }

  /* =================================================================
     9b. 回测验证（A1）
     指标口径见 REQUIREMENTS §4；资金维度历史不可得，已在服务端注明
     ================================================================= */
  function renderBacktest() {
    var box = $('#fcBox'); if (!box) return;
    box.innerHTML =
      '<div class="pg-tools">' +
      '<span class="lbl">窗口</span>' + segHTML('btDays', BT_DAY_TABS, btState.days) +
      '<span class="lbl" style="margin-left:12px">持有期</span>' + segHTML('btHold', BT_HOLD_TABS, btState.hold) +
      '<input id="btPoolInput" class="wl-input" style="max-width:230px" placeholder="股票代码，逗号分隔（留空=当前推荐）" ' +
      'value="' + esc(btState.pool) + '" />' +
      '<button class="btn sm" id="btRun">回测</button>' +
      '<span class="lbl" style="margin-left:auto">股票池</span><span id="btPool" class="muted">--</span>' +
      '</div>' +
      '<div id="btBox"><div class="empty"><span class="spinner"></span> 正在回测，首次需拉取历史 K 线…</div></div>';
    bindSeg('btDays', function (v) { btState.days = v; loadBacktest(); });
    bindSeg('btHold', function (v) { btState.hold = v; loadBacktest(); });
    $('#btRun').onclick = function () { btState.pool = $('#btPoolInput').value.trim(); loadBacktest(); };
    loadBacktest();
  }
  function loadBacktest() {
    var box = $('#btBox'); if (!box) return;
    box.innerHTML = '<div class="empty"><span class="spinner"></span> 正在回测…</div>';
    /* 股票池优先级：手动输入 > 当前推荐列表 > 留空（后端自动取推荐列表） */
    var manual = (btState.pool || '').split(/[,，\s]+/).filter(Boolean);
    var codes = manual.length ? manual : fcCodes.slice(0, 30);
    var t0 = Date.now();
    API.backtest(codes, btState.days, btState.hold).then(function (d) {
      var pool = $('#btPool');
      if (pool) pool.textContent = d.meta.codes.length + ' 只' +
        (manual.length ? '（手动）' : (fcCodes.length ? '（当前推荐）' : '（后端自动取自推荐列表）')) +
        ' · 窗口 ' + d.meta.window.start + ' ~ ' + d.meta.window.end;
      var cost = Date.now() - t0;
      box.innerHTML =
        btKpi(d, cost) +
        '<div class="bt-charts">' +
        '<div class="bt-card"><div class="bt-title">信号收益分布（区间收益 %）</div>' +
        '<div class="chart-box" style="height:230px"><canvas id="btHist"></canvas></div></div>' +
        '<div class="bt-card"><div class="bt-title">等权组合净值 vs 沪深300</div>' +
        '<div class="chart-box" style="height:230px"><canvas id="btNav"></canvas></div></div>' +
        '</div>' +
        btStockTable(d) +
        '<div class="bt-note">' + esc(d.meta.note) +
        '<br><span class="muted">基准 ' + esc(d.meta.benchmark.name) + '（' + esc(d.meta.benchmark.secid) +
        '）· 预热 ' + d.meta.warmup + ' 根 · 本次耗时 ' + cost + 'ms' +
        (d.meta.cached ? '（命中 10 分钟结果缓存）' : '') + '</span></div>';
      drawBtHist($('#btHist'), d.hist);
      drawBtNav($('#btNav'), d.nav);
      hideErr();
    }).catch(function (e) {
      box.innerHTML = '<div class="empty">回测失败：' + esc(e.message) + '</div>';
    });
  }
  function btKpi(d, cost) {
    var exc = d.excess;
    return '<div class="kpi-row">' +
      kpiBox('信号总数', d.signals.count + ' 个', '') +
      kpiBox('覆盖股票', d.signals.stockCount + ' 只', '') +
      kpiBox('胜率', fx(d.winRate, 2) + '%', d.winRate >= 50 ? 'up' : 'down') +
      kpiBox('平均收益', pc(d.avgReturn), cl(d.avgReturn)) +
      kpiBox('收益中位数', pc(d.medianReturn), cl(d.medianReturn)) +
      kpiBox('超额收益', pc(exc) + ' vs 沪深300', cl(exc)) +
      kpiBox('组合最大回撤', '-' + fx(d.maxDrawdown, 2) + '%', 'down') +
      kpiBox('基准同期', pc(d.benchmark.avgReturn) + '（回撤 -' + fx(d.benchmark.maxDrawdown, 2) + '%）', cl(d.benchmark.avgReturn)) +
      '</div>';
  }
  function btStockTable(d) {
    var rows = d.signals.perStock || [];
    if (!rows.length) return '';
    return '<div class="tbl-wrap" style="margin-top:12px"><table class="tbl"><thead><tr>' +
      '<th>代码 / 名称</th><th>信号数</th><th>平均区间收益</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr>' +
          '<td data-label="代码/名称"><span class="c-name">' + esc(r.name) + '</span>' +
          '<span class="c-code">' + esc(r.code) + '</span></td>' +
          '<td data-label="信号数">' + r.count + '</td>' +
          '<td data-label="平均区间收益" class="' + cl(r.avgReturn) + '">' + pc(r.avgReturn) + '</td>' +
          '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  /* 收益分布直方图 */
  function drawBtHist(cv, hist) {
    if (!cv) return;
    var c = setupCanvas(cv), g = c.g, W = c.w, H = c.h, col = thColors();
    if (!hist || !hist.length) {
      g.fillStyle = col.muted; g.font = '13px sans-serif'; g.textAlign = 'center';
      g.fillText('暂无信号', W / 2, H / 2); return;
    }
    var pad = { l: 34, r: 10, t: 12, b: 30 };
    var maxN = 0;
    hist.forEach(function (b) { if (b.count > maxN) maxN = b.count; });
    maxN = maxN || 1;
    var bw = (W - pad.l - pad.r) / hist.length;
    /* 网格 */
    g.strokeStyle = col.border; g.lineWidth = 1;
    for (var k = 0; k <= 4; k++) {
      var y = pad.t + (H - pad.t - pad.b) * k / 4;
      g.beginPath(); g.moveTo(pad.l, y); g.lineTo(W - pad.r, y); g.stroke();
    }
    /* 零轴 */
    var zeroX = null;
    for (var i = 0; i < hist.length; i++) {
      if (hist[i].from <= 0 && hist[i].to >= 0) { zeroX = pad.l + (0 - hist[i].from) / (hist[i].to - hist[i].from) * bw + i * bw; }
    }
    hist.forEach(function (b, i) {
      var h = (H - pad.t - pad.b) * b.count / maxN;
      var x = pad.l + i * bw;
      var mid = (b.from + b.to) / 2;
      g.fillStyle = mid >= 0 ? rgba(col.up, 0.72) : rgba(col.down, 0.72);
      g.fillRect(x + 1, pad.t + (H - pad.t - pad.b) - h, Math.max(1, bw - 2), h);
      if (b.count > 0) {
        g.fillStyle = col.text; g.font = '10px sans-serif'; g.textAlign = 'center';
        g.fillText(String(b.count), x + bw / 2, pad.t + (H - pad.t - pad.b) - h - 3);
      }
    });
    if (zeroX != null) {
      g.strokeStyle = col.faint; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(zeroX, pad.t); g.lineTo(zeroX, H - pad.b); g.stroke();
      g.setLineDash([]);
    }
    /* 横轴刻度 */
    g.fillStyle = col.muted; g.font = '10px sans-serif'; g.textAlign = 'center';
    g.fillText(fx(hist[0].from, 1) + '%', pad.l + 12, H - 12);
    g.fillText(fx(hist[hist.length - 1].to, 1) + '%', W - pad.r - 14, H - 12);
    if (zeroX != null) { g.fillStyle = col.faint; g.fillText('0', zeroX, H - 12); }
    g.fillStyle = col.muted; g.textAlign = 'left';
    g.fillText(String(maxN), 4, pad.t + 8);
  }

  /* 组合净值 vs 基准净值 */
  function drawBtNav(cv, nav) {
    if (!cv) return;
    var c = setupCanvas(cv), g = c.g, W = c.w, H = c.h, col = thColors();
    var dates = nav.dates || [], P = nav.portfolio || [], B = nav.benchmark || [];
    if (dates.length < 2) {
      g.fillStyle = col.muted; g.font = '13px sans-serif'; g.textAlign = 'center';
      g.fillText('暂无净值数据', W / 2, H / 2); return;
    }
    var pad = { l: 42, r: 46, t: 12, b: 26 };
    var all = P.concat(B);
    var mx = Math.max.apply(null, all), mn = Math.min.apply(null, all);
    if (mx - mn < 1e-6) { mx += 0.01; mn -= 0.01; }
    var gapY = (mx - mn) * 0.08; mn -= gapY; mx += gapY;
    var X = function (i) { return pad.l + i / (dates.length - 1) * (W - pad.l - pad.r); };
    var Y = function (v) { return pad.t + (mx - v) / (mx - mn) * (H - pad.t - pad.b); };
    function line(arr, color, w) {
      g.beginPath();
      for (var i = 0; i < arr.length; i++) { i ? g.lineTo(X(i), Y(arr[i])) : g.moveTo(X(i), Y(arr[i])); }
      g.strokeStyle = color; g.lineWidth = w || 1.6; g.stroke();
    }
    function paint(hIdx) {
      g.clearRect(0, 0, W, H);
      /* 网格 */
      g.strokeStyle = col.border; g.lineWidth = 1;
      for (var k = 0; k <= 4; k++) {
        var y = pad.t + (H - pad.t - pad.b) * k / 4;
        g.beginPath(); g.moveTo(pad.l, y); g.lineTo(W - pad.r, y); g.stroke();
      }
      /* 净值 1.0 基准线 */
      g.strokeStyle = col.faint; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(pad.l, Y(1)); g.lineTo(W - pad.r, Y(1)); g.stroke();
      g.setLineDash([]);

      line(B, '#f59e0b', 1.4);
      line(P, col.up, 1.8);

      /* 右侧刻度 */
      g.fillStyle = col.muted; g.font = '10px sans-serif'; g.textAlign = 'left';
      g.fillText(fx(mx, 2), W - pad.r + 6, pad.t + 4);
      g.fillText(fx(mn, 2), W - pad.r + 6, H - pad.b);
      g.fillStyle = col.faint; g.fillText('1.00', W - pad.r + 6, Y(1) + 3);
      /* 时间轴 */
      g.fillStyle = col.muted; g.textAlign = 'center';
      g.fillText(String(dates[0]).slice(0, 7), pad.l + 22, H - 8);
      g.fillText(String(dates[dates.length - 1]).slice(0, 7), W - pad.r - 22, H - 8);
      /* 图例 */
      g.textAlign = 'left'; g.font = '11px sans-serif';
      g.fillStyle = col.up; g.fillRect(pad.l, pad.t + 2, 14, 3);
      g.fillStyle = col.text; g.fillText('等权组合', pad.l + 19, pad.t + 7);
      g.fillStyle = '#f59e0b'; g.fillRect(pad.l + 74, pad.t + 2, 14, 3);
      g.fillStyle = col.text; g.fillText('沪深300', pad.l + 93, pad.t + 7);
      /* 终值标注 */
      g.fillStyle = col.text; g.font = '11px sans-serif'; g.textAlign = 'right';
      g.fillText('终值 组合 ' + fx(P[P.length - 1], 3) + ' / 基准 ' + fx(B[B.length - 1], 3), W - pad.r - 4, pad.t + 7);

      if (hIdx >= 0 && hIdx < dates.length) {
        drawCursor(g, X(hIdx), Y(P[hIdx]), pad.l, W - pad.r, pad.t, H - pad.b, col.muted, col.up);
        g.beginPath(); g.arc(X(hIdx), Y(B[hIdx]), 2.6, 0, Math.PI * 2);
        g.fillStyle = '#f59e0b'; g.fill();
      }
    }
    paint(-1);
    bindChartHover(cv, {
      n: dates.length, X: X, paint: paint,
      tip: function (i) {
        return [
          ['日期', dates[i]],
          ['组合净值', fx(P[i], 4), P[i] >= 1 ? 'up' : 'down'],
          ['沪深300', fx(B[i], 4), B[i] >= 1 ? 'up' : 'down'],
          ['超额', pc((P[i] / (B[i] || 1) - 1) * 100), cl(P[i] - B[i])]
        ];
      }
    });
  }

  /* =================================================================
     10. 模拟持仓
     ================================================================= */
  function renderPaper() {
    mount(
      pgHead('💼', '模拟持仓', '本地记录买入成本与数量，实时按现价计算浮动盈亏 · 数据保存在浏览器，不上传', rfHTML()) +
      '<div class="kpi-row" id="ppKpi"></div>' +
      '<div class="pg-tools">' +
      '<span class="lbl">建仓</span>' +
      '<input id="ppCode" class="wl-input" style="max-width:190px" placeholder="输入代码，如 600519 / 00700 / NVDA" />' +
      '<span id="ppHint" style="font-size:12px;color:var(--muted)">名称自动带出 · 成本价取当前价 · 数量默认 100 股</span>' +
      '<button class="btn sm" id="ppAdd">＋ 建仓</button>' +
      '</div>' +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
      '<th>代码 / 名称</th><th>成本价</th><th>现价</th><th>涨跌幅</th><th>数量</th><th>市值</th><th>浮动盈亏</th><th>收益率</th><th>操作</th>' +
      '</tr></thead><tbody id="ppBody"></tbody></table></div>'
    );
    var ppInput = $('#ppCode');
    if (ppInput) {
      /* 回车直接建仓，省一次鼠标点击 */
      ppInput.onkeydown = function (e) { if (e.key === 'Enter') doPaperAdd(); };
    }
    $('#ppAdd').onclick = doPaperAdd;
    bindRefresh(loadPaperQuotes);
    loadPaper();
    every(10000, function () { if (location.hash === '#/stock-paper-portfolio') loadPaperQuotes(); });
  }
  /* 建仓：只填代码，名称 / 成本价 / 数量都由系统补齐。
     代码允许 A股(6位)、港股(5位)、美股(字母)，与 /api/search 的白名单一致。 */
  function doPaperAdd() {
    var inp = $('#ppCode');
    var hint = $('#ppHint');
    var code = (inp && inp.value || '').trim();
    if (!code) return toast('请输入股票代码');
    if (!/^(\d{6}|\d{5}|[A-Za-z][A-Za-z0-9.\-]{0,7})$/.test(code)) {
      return toast('代码格式不对：A股6位 / 港股5位 / 美股字母');
    }
    if (hint) hint.textContent = '正在查询 ' + code + ' …';
    API.search(code).then(function (list) {
      /* search 可能返回多个市场同名代码，优先取与输入完全一致的那条 */
      var hit = null;
      for (var i = 0; i < list.length; i++) {
        if (list[i].code === code) { hit = list[i]; break; }
      }
      hit = hit || list[0];
      if (!hit) { if (hint) hint.textContent = '没查到这只股票，请确认代码'; return toast('未找到：' + code); }
      var cost = hit.price > 0 ? hit.price : null;
      if (cost == null) { if (hint) hint.textContent = '取不到现价，请稍后再试'; return toast('取不到现价，暂不能建仓'); }
      API.paperAdd({
        code: hit.code,
        name: hit.name || hit.code,
        secid: hit.secid || '',
        shares: 100,          // 数量默认 100 股
        cost: cost            // 成本价自动填当前价
      });
      if (inp) inp.value = '';
      if (hint) hint.textContent = '已建仓 ' + hit.name + ' 成本 ' + fx(cost) + ' × 100 股';
      toast('已建仓：' + hit.name + ' ' + fx(cost) + ' × 100');
      loadPaper();
    }).catch(function (e) {
      if (hint) hint.textContent = '查询失败：' + e.message;
      toast('查询失败：' + e.message);
    });
  }
  var ppRows = [];
  function loadPaper() {
    var body = $('#ppBody'); if (!body) return;
    ppRows = API.paper();
    if (!ppRows.length) {
      body.innerHTML = '<tr><td colspan="9"><div class="empty">还没有持仓，在上方输入代码 / 成本 / 数量后点「建仓」</div></td></tr>';
      var k = $('#ppKpi'); if (k) k.innerHTML = '';
      return;
    }
    body.innerHTML = ppRows.map(function (p) {
      return '<tr data-code="' + esc(p.code) + '" data-secid="' + esc(p.secid || '') + '" data-name="' + esc(p.name) + '">' +
        '<td data-label="代码/名称"><span class="c-name">' + esc(p.name) + '</span><span class="c-code">' + esc(p.code) + '</span></td>' +
        '<td data-label="成本价">' + fx(p.cost) + '</td>' +
        '<td data-label="现价" class="q-price">--</td>' +
        '<td data-label="涨跌幅" class="q-pct">--</td>' +
        '<td data-label="数量">' + p.shares + '</td>' +
        '<td data-label="市值" class="q-mv">--</td>' +
        '<td data-label="浮动盈亏" class="q-pl">--</td>' +
        '<td data-label="收益率" class="q-rate">--</td>' +
        '<td data-label="操作"><button class="btn sm ghost" data-ppdel="' + esc(p.code) + '">删除</button></td>' +
        '</tr>';
    }).join('');
    $$('[data-ppdel]').forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        API.paperDel(b.dataset.ppdel);
        toast('已删除');
        loadPaper();
      };
    });
    /* 整行可点开详情弹窗。之前只给删除按钮绑了事件，行本身点不动——
       表格里每行都塞了 data-code/data-name/data-secid 却没人用。
       注意删除按钮已 stopPropagation，不会误触发详情。 */
    $$('#ppBody tr[data-code]').forEach(function (tr) {
      tr.style.cursor = 'pointer';
      tr.onclick = function () {
        openDetail(tr.dataset.code, tr.dataset.name, tr.dataset.secid);
      };
    });
    loadPaperQuotes();
  }
  function loadPaperQuotes() {
    var body = $('#ppBody'); if (!body || !ppRows.length) return;
    API.quotes(ppRows.map(function (p) { return p.code; })).then(function (qs) {
      var map = {}; qs.forEach(function (q) { map[q.code] = q; });
      var totMv = 0, totCost = 0;
      ppRows.forEach(function (p) {
        var q = map[p.code]; if (!q) return;
        var mv = q.price * p.shares, cost = p.cost * p.shares;
        var pl = mv - cost, rate = cost > 0 ? pl / cost * 100 : 0;
        totMv += mv; totCost += cost;
        var tr = $('tr[data-code="' + p.code + '"]', body); if (!tr) return;
        $('.q-price', tr).textContent = fx(q.price);
        var pe = $('.q-pct', tr); pe.textContent = pc(q.pct); pe.className = 'q-pct ' + cl(q.pct);
        $('.q-mv', tr).textContent = fx(mv, 2);
        var le = $('.q-pl', tr); le.textContent = sg(pl) + fx(pl, 2); le.className = 'q-pl ' + cl(pl);
        var re = $('.q-rate', tr); re.textContent = pc(rate); re.className = 'q-rate ' + cl(rate);
      });
      var k = $('#ppKpi');
      if (k) {
        var pl = totMv - totCost, rate = totCost > 0 ? pl / totCost * 100 : 0;
        k.innerHTML =
          kpiBox('持仓市值', fx(totMv, 2), cl(pl)) +
          kpiBox('总成本', fx(totCost, 2)) +
          kpiBox('浮动盈亏', sg(pl) + fx(pl, 2), cl(pl)) +
          kpiBox('总收益率', pc(rate), cl(rate)) +
          kpiBox('持仓只数', ppRows.length + ' 只');
      }
      hideErr();
    }).catch(function (e) { showErr('持仓行情刷新失败：' + e.message); });
  }

  /* =================================================================
     11. 盘中信号监控
     ================================================================= */
  var SIG_TABS = [['high', '高抛信号'], ['low', '低吸信号'], ['all', '全部']];
  var sigTab = 'all';
  function renderSignalMonitor() {
    mount(
      pgHead('📡', '盘中信号监控', '对自选股逐只检测「高抛 / 低吸」时点 · 基于分时价对均价的偏离度，阈值自适应，每 30 秒刷新', rfHTML()) +
      '<div class="pg-tools"><span class="lbl">类型</span>' + segHTML('sigTab', SIG_TABS, sigTab) + '</div>' +
      '<div class="kpi-row" id="sigKpi"></div>' +
      '<div id="sigList"><div class="empty">加载中…</div></div>'
    );
    bindSeg('sigTab', function (v) { sigTab = v; loadSignals(); });
    bindRefresh(loadSignals);
    loadSignals();
    every(30000, function () { if (location.hash === '#/stock-signal-monitor') loadSignals(); });
  }
  var sigData = [];
  /* 服务端 /signal 返回 {t, price, dev}，统一归一为 {t, p, dev} 供渲染与绘图使用 */
  function sigNorm(list) {
    return (list || []).map(function (x) {
      return { t: x.t, p: (x.p != null ? x.p : x.price), dev: x.dev };
    });
  }

  function loadSignals() {
    var box = $('#sigList'); if (!box) return;
    var list = API.watchlist();
    if (!list.length) {
      box.innerHTML = '<div class="empty">自选股为空 —— 请先在「自选股」页添加要监控的股票</div>';
      var k = $('#sigKpi'); if (k) k.innerHTML = '';
      return;
    }
    box.innerHTML = '<div class="empty"><span class="spinner"></span> 正在检测 ' + list.length + ' 只自选股…</div>';
    API.mapLimit(list, 3, function (it) {
      return API.signal(it.code, it.secid).then(function (d) {
        return { code: it.code, name: it.name, secid: it.secid, th: d.threshold, high: sigNorm(d.high), low: sigNorm(d.low) };
      }).catch(function () { return null; });
    }).then(function (rows) {
      sigData = rows.filter(Boolean);
      var k = $('#sigKpi');
      var nh = sigData.reduce(function (a, b) { return a + b.high.length; }, 0);
      var nl = sigData.reduce(function (a, b) { return a + b.low.length; }, 0);
      if (k) {
        k.innerHTML =
          kpiBox('监控只数', sigData.length + ' 只') +
          kpiBox('高抛信号', nh + ' 个', 'up') +
          kpiBox('低吸信号', nl + ' 个', 'down') +
          kpiBox('信号合计', (nh + nl) + ' 个');
      }
      var items = [];
      sigData.forEach(function (d) {
        if (sigTab === 'all' || sigTab === 'high') d.high.forEach(function (s) { items.push({ code: d.code, name: d.name, secid: d.secid, type: 'high', t: s.t, p: s.p, dev: s.dev }); });
        if (sigTab === 'all' || sigTab === 'low') d.low.forEach(function (s) { items.push({ code: d.code, name: d.name, secid: d.secid, type: 'low', t: s.t, p: s.p, dev: s.dev }); });
      });
      items.sort(function (a, b) { return a.t < b.t ? 1 : -1; });
      if (!items.length) {
        box.innerHTML = '<div class="empty">当前无信号 —— 信号基于分时价对均价的偏离，需盘中且波动足够大才会触发</div>';
        return;
      }
      box.innerHTML = items.map(function (s) {
        return '<div class="quick" data-code="' + esc(s.code) + '" data-secid="' + esc(s.secid) + '" data-name="' + esc(s.name) + '" style="margin-bottom:8px">' +
          '<div class="ic" style="background:' + (s.type === 'high' ? 'linear-gradient(135deg,#f5483b,#fb923c)' : 'linear-gradient(135deg,#16a34a,#2dd4a7)') + '">' +
          (s.type === 'high' ? '↑' : '↓') + '</div>' +
          '<div style="flex:1;min-width:0">' +
          '<div style="font-weight:600">' + esc(s.name) + ' <span class="c-code" style="display:inline">' + esc(s.code) + '</span></div>' +
          '<div class="muted" style="font-size:12.5px;margin-top:2px">' +
          '<b class="' + (s.type === 'high' ? 'up' : 'down') + '">' + (s.type === 'high' ? '高抛' : '低吸') + '</b> · ' +
          esc(s.t) + ' · 价 ' + fx(s.p) + ' · 偏离均价 ' + pc(s.dev) + '</div>' +
          '</div>' +
          '<button class="btn sm ghost" data-sigview="' + esc(s.code) + '" data-sigsec="' + esc(s.secid) + '" data-signame="' + esc(s.name) + '">看图</button>' +
          '</div>';
      }).join('');
      $$('[data-sigview]').forEach(function (b) {
        b.onclick = function (e) { e.stopPropagation(); openSignal(b.dataset.sigview, b.dataset.signame, b.dataset.sigsec); };
      });
      bindRowClick('#sigList', '.quick');
      hideErr();
    });
  }

  /* =================================================================
     个股详情弹窗
     ================================================================= */
  var detailCode = '', detailSecid = '', detailPeriod = 'minute';
  function openDetail(code, name, secid) {
    if (!code) return;
    detailCode = code; detailSecid = secid || ''; detailPeriod = 'minute';
    $('#dName').textContent = name || '--';
    $('#dCode').textContent = code;
    $('#dPrice').textContent = '--'; $('#dChg').textContent = '--'; $('#dPct').textContent = '--';
    $('#dKv').innerHTML = '';
    $$('#dSeg button').forEach(function (b) { b.classList.toggle('on', b.dataset.p === 'minute'); });
    $('#dFav').textContent = API.inWatch(code) ? '移出股票池' : '加入股票池';
    var m = $('#detailModal'); m.classList.add('show'); m.setAttribute('aria-hidden', 'false'); raiseModal(m);
    loadDetail(); loadDetailChart();
  }
  /* 统一的弹窗关闭：先清掉模态内的焦点再设 aria-hidden=true。
   否则浏览器会报「Blocked aria-hidden on an element because its
   descendant retained focus」，同时把焦点困在不可达的节点上。
   这条是 W3C WAI-ARIA 1.2 的硬性要求（aria-hidden=的 不能含 focused 后代） */
  function hideModal(m) {
    if (!m) return;
    if (m.contains(document.activeElement)) document.activeElement.blur();
    m.classList.remove('show'); m.setAttribute('aria-hidden', 'true');
  }
  function closeDetail() {
    hideModal($('#detailModal'));
  }
  function loadDetail() {
    var code = detailCode; if (!code) return;
    API.detail(code, detailSecid).then(function (d) {
      if (code !== detailCode) return;
      /* 用后端回传的 secid 回写，保证切周期时不丢市场信息 */
      if (d.secid) detailSecid = d.secid;
      $('#dName').textContent = d.name || '--';
      $('#dPrice').textContent = fx(d.price);
      $('#dPrice').className = cl(d.pct);
      var ce = $('#dChg'); ce.textContent = (d.change == null ? '--' : sg(d.change) + fx(d.change)); ce.className = cl(d.change);
      var pe = $('#dPct'); pe.textContent = pc(d.pct); pe.className = cl(d.pct);
      var kv = [
        ['今开', fx(d.open)], ['昨收', fx(d.preClose)], ['最高', fx(d.high)], ['最低', fx(d.low)],
        ['均价', fx(d.avg)], ['振幅', d.amplitude == null ? '--' : fx(d.amplitude) + '%'],
        ['成交量', d.volume == null ? '--' : (d.volume / 1e4).toFixed(2) + '万手'],
        ['成交额', yi(d.turnover)], ['换手率', d.rate == null ? '--' : fx(d.rate) + '%'],
        ['量比', fx(d.volRatio)], ['市盈率(动)', fx(d.pe)], ['市净率', fx(d.pb)],
        ['总市值', yi(d.mktcap)], ['流通市值', yi(d.floatCap)],
        ['涨停价', fx(d.limitUp)], ['跌停价', fx(d.limitDown)]
      ];
      $('#dKv').innerHTML = kv.map(function (x) {
        return '<div class="kv"><div class="kv-l">' + x[0] + '</div><div class="kv-v">' + x[1] + '</div></div>';
      }).join('');
      hideErr();
    }).catch(function (e) { showErr('详情加载失败：' + e.message); });
  }
  function loadDetailChart() {
    var cv = $('#dChart'); if (!cv) return;
    if (detailPeriod === 'minute') {
      API.minute(detailCode, detailSecid).then(function (d) {
        drawMinute(cv, d.points || [], d.preClose);
      }).catch(function () { drawMinute(cv, [], 0); });
    } else {
      API.kline(detailCode, detailPeriod, 120, detailSecid).then(function (d) {
        drawKline(cv, d.klines || []);
      }).catch(function () { drawKline(cv, []); });
    }
  }

  /* =================================================================
     信号弹窗
     ================================================================= */
  function openSignal(code, name, secid) {
    $('#sName').textContent = (name || '--') + ' (' + (code || '--') + ')';
    $('#sTh').textContent = '--'; $('#sHigh').textContent = '0'; $('#sLow').textContent = '0';
    $('#sTimes').textContent = '';
    var m = $('#signalModal'); m.classList.add('show'); m.setAttribute('aria-hidden', 'false');
    API.signal(code, secid).then(function (d) {
      /* 服务端字段为 {t, price, dev}，绘图/展示统一用 p */
      var hi = sigNorm(d.high), lo = sigNorm(d.low);
      $('#sTh').textContent = fx(d.threshold) + '%';
      $('#sHigh').textContent = hi.length;
      $('#sLow').textContent = lo.length;
      drawSignal($('#sChart'), d.points || [], hi, lo);
      var all = hi.map(function (x) { return { t: x.t, p: x.p, k: '高抛' }; })
        .concat(lo.map(function (x) { return { t: x.t, p: x.p, k: '低吸' }; }))
        .sort(function (a, b) { return a.t < b.t ? -1 : 1; });
      $('#sTimes').innerHTML = all.length
        ? all.map(function (x) { return '<span style="display:inline-block;margin:0 10px 4px 0"><b class="' + (x.k === '高抛' ? 'up' : 'down') + '">' + x.k + '</b> ' + esc(x.t) + ' @ ' + fx(x.p) + '</span>'; }).join('')
        : '今日暂无信号';
    }).catch(function (e) { $('#sTimes').textContent = '加载失败：' + e.message; });
  }
  function closeSignal() { hideModal($('#signalModal')); }

  /* =================================================================
     邮件通知弹窗
     ================================================================= */
  var ML_PRESETS = {
    qq: { host: 'smtp.qq.com', port: 465, secure: true },
    '163': { host: 'smtp.163.com', port: 465, secure: true },
    gmail: { host: 'smtp.gmail.com', port: 465, secure: true },
    outlook: { host: 'smtp.office365.com', port: 587, secure: false },
    exmail: { host: 'smtp.exmail.qq.com', port: 465, secure: true }
  };
  function mlMsg(text, cls) {
    var m = $('#mlMsg'); if (!m) return;
    m.innerHTML = text || '';
    m.className = 'ml-msg' + (cls ? ' ' + cls : '');
  }
  /* 一条价格提醒：代码 + 方向 + 目标价（+ 自动补全的名称） */
  function mlAlertRow(a) {
    return '<div class="ml-alert" data-row>' +
      '<input class="wl-input ml-code" value="' + esc(a.code || '') + '" placeholder="代码" autocomplete="off" />' +
      '<span class="ml-name">' + esc(a.name || '') + '</span>' +
      '<select class="wl-input ml-dir">' +
      '<option value="up"' + (a.dir === 'down' ? '' : ' selected') + '>突破</option>' +
      '<option value="down"' + (a.dir === 'down' ? ' selected' : '') + '>跌破</option>' +
      '</select>' +
      '<input class="wl-input ml-px" type="number" step="0.01" min="0" value="' + esc(a.price == null ? '' : a.price) + '" placeholder="目标价" />' +
      '<button class="ml-del" title="删除" data-mldel>×</button>' +
      '</div>';
  }
  function mlAlertsHTML(list) {
    if (!list || !list.length) return '<div class="ml-empty">暂无价格提醒</div>';
    return list.map(mlAlertRow).join('');
  }
  /* 代码填完自动补全名称；逐行直接绑定，不依赖事件冒泡 */
  function mlAutoName(row) {
    var inp = row.querySelector('.ml-code'); if (!inp || inp._bound) return;
    inp._bound = 1;
    function run() {
      var code = (inp.value || '').trim(); if (!code) return;
      API.search(code).then(function (list) {
        var hit = null;
        for (var i = 0; i < list.length; i++) if (String(list[i].code) === code) { hit = list[i]; break; }
        if (!hit && list.length) hit = list[0];
        if (hit) row.querySelector('.ml-name').textContent = hit.name || '';
      }).catch(function () {});
    }
    inp.addEventListener('change', run);
    inp.addEventListener('blur', run);
  }
  function mlBindAlerts() {
    $$('#mlAlerts [data-row]').forEach(mlAutoName);
  }
  function mlReadAlerts() {
    return $$('#mlAlerts [data-row]').map(function (r) {
      var code = (r.querySelector('.ml-code').value || '').trim();
      var px = parseFloat(r.querySelector('.ml-px').value);
      if (!code || isNaN(px)) return null;
      return {
        code: code,
        name: r.querySelector('.ml-name').textContent.trim(),
        dir: r.querySelector('.ml-dir').value,
        price: px
      };
    }).filter(Boolean);
  }
  function mlReadForm() {
    var port = parseInt($('#mlPort').value, 10);
    return {
      to: ($('#mlTo').value || '').trim(),
      enabled: !!$('#mlEnabled').checked,
      intervalMin: parseInt($('#mlInterval').value, 10) || 15,
      /* 自选股存在浏览器本地，服务端看不到，所以每次保存都顺带上传一份 */
      watchlist: API.watchlist().map(function (w) {
        return { code: w.code, name: w.name, secid: w.secid };
      }),
      rules: {
        watchPct: parseFloat($('#mlWatchPct').value) || 0,
        idxPct: parseFloat($('#mlIdxPct').value) || 0,
        daily: !!$('#mlDaily').checked,
        alerts: mlReadAlerts()
      },
      smtp: {
        host: ($('#mlHost').value || '').trim(),
        port: isNaN(port) ? 465 : port,
        secure: !!$('#mlSecure').checked,
        user: ($('#mlUser').value || '').trim(),
        pass: $('#mlPass').value,
        from: ($('#mlFrom').value || '').trim()
      }
    };
  }
  function mlFillForm(c) {
    c = c || {};
    var r = c.rules || {}, s = c.smtp || {};
    $('#mlTo').value = c.to || '';
    $('#mlEnabled').checked = !!c.enabled;
    $('#mlInterval').value = String(c.intervalMin || 15);
    $('#mlWatchPct').value = r.watchPct == null ? '' : r.watchPct;
    $('#mlIdxPct').value = r.idxPct == null ? '' : r.idxPct;
    $('#mlDaily').checked = !!r.daily;
    $('#mlAlerts').innerHTML = mlAlertsHTML(r.alerts);
    mlBindAlerts();
    $('#mlHost').value = s.host || '';
    $('#mlPort').value = s.port || 465;
    $('#mlSecure').checked = !!s.secure;
    $('#mlUser').value = s.user || '';
    /* 服务端不回传口令明文，只回填占位，避免误以为「已保存」 */
    $('#mlPass').value = '';
    $('#mlPass').placeholder = s.hasPass ? '已保存（留空表示不修改）' : 'SMTP 授权码 / 应用专用密码';
    $('#mlFrom').value = s.from || '';
  }
  function openMail() {
    mlMsg('读取配置中…');
    var m = $('#mailModal'); m.classList.add('show'); m.setAttribute('aria-hidden', 'false');
    API.mailGet().then(function (c) { mlFillForm(c); mlMsg(''); }).catch(function (e) {
      mlFillForm({});
      mlMsg('配置读取失败：' + esc(e.message), 'err');
    });
  }
  function closeMail() { var m = $('#mailModal'); if (m) hideModal(m); }
  function bindMail() {
    if (!$('#mailModal')) return;
    $('#mlPreset').onchange = function () {
      var p = ML_PRESETS[this.value]; if (!p) return;
      $('#mlHost').value = p.host; $('#mlPort').value = p.port; $('#mlSecure').checked = p.secure;
      if (!$('#mlUser').value) mlMsg('提示：账号与授权码仍需手动填写', '');
    };
    $('#mlAddAlert').onclick = function () {
      var box = $('#mlAlerts');
      var e = box.querySelector('.ml-empty'); if (e) e.remove();
      box.insertAdjacentHTML('beforeend', mlAlertRow({ dir: 'up' }));
      mlAutoName(box.lastElementChild);
    };
    $('#mlAlerts').addEventListener('click', function (e) {
      var d = e.target.closest('[data-mldel]'); if (!d) return;
      d.closest('[data-row]').remove();
      if (!$('#mlAlerts').querySelector('[data-row]')) $('#mlAlerts').innerHTML = '<div class="ml-empty">暂无价格提醒</div>';
    });
    $('#mlSave').onclick = function () {
      var cfg = mlReadForm();
      if (!cfg.to) { mlMsg('请填写接收邮箱', 'err'); return; }
      if (!cfg.smtp.host || !cfg.smtp.user) { mlMsg('请填写 SMTP 服务器与账号', 'err'); return; }
      mlMsg('保存中…');
      API.mailSave(cfg).then(function (d) {
        mlMsg('已保存。' + (d && d.lastCheckAt ? '上次巡检：' + d.lastCheckAt : '等待首次巡检'), 'ok');
        toast('邮件设置已保存');
      }).catch(function (e) { mlMsg('保存失败：' + esc(e.message), 'err'); });
    };
    $('#mlTest').onclick = function () {
      var cfg = mlReadForm();
      if (!cfg.to) { mlMsg('请先填写接收邮箱', 'err'); return; }
      mlMsg('发送中…');
      /* 测试邮件用的是「当前表单值」，因此先落盘再发，保证发出的是刚填的配置 */
      API.mailSave(cfg).then(function () { return API.mailTest(); }).then(function (d) {
        mlMsg('测试邮件已发出，请查收 ' + esc(cfg.to) + '（含垃圾箱）', 'ok');
      }).catch(function (e) { mlMsg('发送失败：' + esc(e.message), 'err'); });
    };
    $('#mlCheck').onclick = function () {
      mlMsg('巡检中…');
      API.mailSave(mlReadForm()).then(function () { return API.mailCheck(); }).then(function (d) {
        var n = (d && d.sent) || 0;
        var hits = (d && d.hits) || [];
        mlMsg('巡检完成，命中 ' + hits.length + ' 条，发出 ' + n + ' 封。' +
          (hits.length ? '<br>' + hits.map(esc).join('<br>') : ''), hits.length ? 'ok' : '');
      }).catch(function (e) { mlMsg('巡检失败：' + esc(e.message), 'err'); });
    };
  }

  /* =================================================================
     云同步弹窗
     ================================================================= */
  function openSync() {
    var c = API.syncCred();
    $('#syncUser').value = c.user || '';
    $('#syncPass').value = '';
    $('#syncMsg').textContent = '';
    var m = $('#syncModal'); m.classList.add('show'); m.setAttribute('aria-hidden', 'false');
  }
  function closeSync() { hideModal($('#syncModal')); }

  /* =================================================================
     搜索
     ================================================================= */
  function bindSearch() {
    var input = $('#wlSearch'), sug = $('#wlSuggest');
    if (!input || !sug) return;
    var deb = null;
    input.addEventListener('input', function () {
      var kw = input.value.trim();
      clearTimeout(deb);
      if (!kw) { sug.style.display = 'none'; sug.innerHTML = ''; return; }
      deb = setTimeout(function () {
        API.search(kw).then(function (list) {
          if (!list.length) { sug.style.display = 'none'; return; }
          sug.innerHTML = list.map(function (x, i) {
            /* 第三个格子右对齐（margin-left:auto），只能放一个 .wl-sug-type，
               放两个会把剩余空间对半劈开。所以价格和市场标签拼成一个字符串。
               价格取不到时至少能看到是港股还是美股，否则会被误认成 A 股 */
            var t = x.price ? (fx(x.price) + ' ' + pc(x.pct)) : '';
            if (x.mkt) t += (t ? ' · ' : '') + x.mkt;
            return '<div class="wl-sug" data-i="' + i + '">' +
              '<span class="wl-sug-name">' + esc(x.name) + '</span>' +
              '<span class="wl-sug-code">' + esc(x.code) + '</span>' +
              '<span class="wl-sug-type">' + esc(t) + '</span></div>';
          }).join('');
          sug.style.display = 'block';
          $$('.wl-sug', sug).forEach(function (node) {
            node.addEventListener('mousedown', function (e) {
              e.preventDefault();
              var it = list[+node.dataset.i];
              if (API.addWatch(it.code, it.name, it.secid)) toast('已加入自选：' + it.name);
              else toast('已在自选股中');
              input.value = ''; sug.style.display = 'none'; sug.innerHTML = '';
              loadWatchlist();
            });
          });
        }).catch(function () { sug.style.display = 'none'; });
      }, 260);
    });
    document.addEventListener('mousedown', function (e) {
      if (sug && !sug.contains(e.target) && e.target !== input) sug.style.display = 'none';
    });
  }

  /* =================================================================
     行点击 → 详情
     ================================================================= */
  function bindRowClick(rootSel, itemSel) {
    var root = $(rootSel || '#stockView'); if (!root) return;
    $$((itemSel || 'tr[data-code]'), root).forEach(function (el) {
      el.onclick = function (e) {
        if (e.target.closest('button')) return;
        if (el.dataset.code) openDetail(el.dataset.code, el.dataset.name, el.dataset.secid);
      };
    });
  }

  /* =================================================================
     13. 大盘云图 —— 直接嵌入 52etf.site
     实测该站响应头里没有 X-Frame-Options、也没有 CSP 的 frame-ancestors，
     允许被 iframe 嵌入，所以不再自己画 canvas treemap。

     之前那套自绘实现（squarify / marimekko + 东财 clist+ulist 两步取数）
     已整体删除，原因：
       - 板块层在宽画布上会把色块压成横条，改了三种布局才勉强能看
       - 数据源残缺：东财 clist 从本机只返回 "-"，个股层常年空白
     交给源站后数据、交互、配色都由对方维护，本侧只留全屏容器 + 三个入口。
     ================================================================= */
  var TM_SITE = 'https://52etf.site/';
  function renderTreemap() {
    mount(
      '<div class="tm-embed">' +
        '<div class="tm-embed-bar">' +
          '<span class="tm-embed-title">🗺️ 大盘云图</span>' +
          '<span class="tm-embed-note">数据源 52etf.site · 面积=流通市值 颜色=涨跌幅</span>' +
          '<span class="tm-embed-actions">' +
            '<button class="btn sm ghost" id="tmOpen" title="在新窗口打开源站">↗ 新窗口</button>' +
            '<button class="btn sm ghost" id="tmReload" title="重新加载">⟳</button>' +
            '<button class="btn sm ghost" id="tmExit" title="退出，回到常规界面">✕</button>' +
          '</span>' +
        '</div>' +
        '<iframe id="tmFrame" class="tm-embed-frame" src="' + TM_SITE + '" ' +
          'referrerpolicy="no-referrer" loading="eager" ' +
          'allow="fullscreen; clipboard-write"></iframe>' +
      '</div>'
    );
    $('#tmOpen').onclick = function () { window.open(TM_SITE, '_blank', 'noopener'); };
    /* iframe 没有暴露 reload 之外的刷新手段，直接重设 src 即可 */
    $('#tmReload').onclick = function () { var f = $('#tmFrame'); if (f) f.src = TM_SITE; };
    $('#tmExit').onclick = function () { location.hash = '#/stock-watchlist'; };
  }
  /* =================================================================
     14. 港股行情
     ================================================================= */
  var HK_TABS = [['index', '主要指数'], ['mainboard', '主板蓝筹'], ['hsblue', '恒生科技'],
    ['hot', '成交额榜'], ['gain', '涨幅榜'], ['gem', '创业板'], ['etf', 'ETF']];
  var hkGroup = 'index';
  function renderHK() {
    mount(
      pgHead('🇭🇰', '港股实时行情', '恒生指数 / 恒生科技 / 港股通等，点击卡片查看详情', rfHTML()) +
      '<div class="pg-tools">' + segHTML('hkTab', HK_TABS, hkGroup) + '</div>' +
      '<div id="hkCards" class="wl-cards"><div class="empty" style="grid-column:1/-1">加载中…</div></div>'
    );
    bindSeg('hkTab', function (v) { hkGroup = v; loadHK(); });
    bindRefresh(loadHK);
    loadHK();
    every(20000, function () { if (location.hash === '#/stock-hk') loadHK(); });
  }
  function loadHK() {
    var box = $('#hkCards'); if (!box) return;
    API.hkSector(hkGroup).then(function (d) {
      var rows = (d.list || []).filter(function (x) { return x.price != null; });
      if (!rows.length) { box.innerHTML = '<div class="empty" style="grid-column:1/-1">暂无数据</div>'; return; }
      box.innerHTML = rows.map(function (x) {
        /* 注意：cl() 返回的是 up/down/flat，拼接时务必留空格，否则会拼成 wl-cardup */
        return '<div class="wl-card ' + cl(x.pct) + '" data-code="' + esc(x.code) + '" data-name="' + esc(x.name) + '" data-secid="' + esc(x.secid) + '">' +
          '<div class="wl-cn">' + esc(x.name) + '</div>' +
          '<div class="wl-cp ' + cl(x.pct) + '">' + fx(x.price) + '</div>' +
          '<div class="wl-cc ' + cl(x.pct) + '">' + (x.change == null ? '--' : sg(x.change) + fx(x.change)) +
            '&nbsp;' + pc(x.pct) + '</div>' +
          (x.amount != null ? '<div class="wl-cx">额 ' + fx(x.amount, 0) + '亿</div>' : '') +
          '</div>';
      }).join('');
      /* 绑定点击弹窗 */
      $$('.wl-card[data-secid]', box).forEach(function (el) {
        el.onclick = function () { openDetail(el.dataset.code, el.dataset.name, el.dataset.secid); };
      });
      hideErr();
    }).catch(function (e) {
      showErr('港股加载失败：' + e.message);
    });
  }

  /* =================================================================
     路由
     ================================================================= */
  var ROUTES = {
    'stock-treemap': { fn: renderTreemap, t: '大盘云图' },
    'stock-watchlist': { fn: renderWatchlist, t: '自选股' },
    'stock-rank': { fn: renderRank, t: 'A股行情' },
    'stock-dark': { fn: renderDark, t: '暗盘监控' },
    'stock-overview': { fn: renderOverview, t: '全景盘面' },
    'stock-youzi': { fn: renderYouzi, t: '游资操作' },
    'stock-us': { fn: renderUS, t: '美股行情' },
    'stock-hk': { fn: renderHK, t: '港股行情' },
    'stock-azt-compare': { fn: renderCompare, t: '对比分析' },
    'stock-forecast': { fn: renderForecast, t: '预测PP' },
    'stock-paper-portfolio': { fn: renderPaper, t: '模拟持仓' },
    'stock-signal-monitor': { fn: renderSignalMonitor, t: '盘中监控' },
    'stock-news': { fn: renderNews, t: '股票资讯' }
  };
  var curRoute = '';
  function route() {
    var h = (location.hash || '').replace(/^#\/?/, '') || 'stock-watchlist';
    var r = ROUTES[h] || ROUTES['stock-watchlist'];
    if (h === curRoute) return;
    curRoute = h;
    hideErr();
    $$('.nav-item').forEach(function (b) { b.classList.toggle('active', b.dataset.route === h); });
    document.title = r.t + ' · 行情通';
    $('#sidebar').classList.remove('open');
    try { r.fn(); } catch (e) {
      showErr('页面渲染失败：' + e.message);
      view().innerHTML = '<div class="empty">页面渲染失败：' + esc(e.message) + '</div>';
    }
  }

  /* =================================================================
     主题 / 顶栏 / 事件
     ================================================================= */
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('hqt.theme', t); } catch (e) {}
    var dark = t === 'dark';
    var ic = $('#sideThemeIcon'), lb = $('#sideThemeLabel');
    if (ic) ic.textContent = dark ? '☀️' : '🌙';
    if (lb) lb.textContent = dark ? '切换浅色' : '切换深色';
    /* 重绘当前图表以套用新配色 */
    if ($('#detailModal').classList.contains('show')) loadDetailChart();
    if ($('#signalModal').classList.contains('show')) {
      var b = $('[data-sigview]');
      if (b) openSignal(b.dataset.sigview, b.dataset.signame, b.dataset.sigsec);
    }
  }

  function tickClock() {
    var el = $('#topClock'); if (!el) return;
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    el.textContent = p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    // 交易时段 9:30-11:30 / 13:00-15:00（周一至周五）
    var day = d.getDay(), m = d.getHours() * 60 + d.getMinutes();
    var open = day >= 1 && day <= 5 && ((m >= 570 && m <= 690) || (m >= 780 && m <= 900));
    var st = $('#mktStatusText');
    if (st) st.textContent = (day === 0 || day === 6) ? '休市' : (open ? '盘中' : (m < 570 ? '未开盘' : (m > 900 ? '已收盘' : '午间休市')));
    var dot = $('.live');
    if (dot) dot.style.background = open ? '#22c55e' : '#f59e0b';
  }

  function boot() {
    // 主题
    var th = 'light';
    try { th = localStorage.getItem('hqt.theme') || 'light'; } catch (e) {}
    applyTheme(th);

    // 导航
    $$('.nav-item').forEach(function (b) {
      b.onclick = function () { location.hash = '#/' + b.dataset.route; };
    });
    $('#sideThemeBtn').onclick = function () {
      applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    };
    $('#sideMailBtn').onclick = openMail;
    $('#sideHelpBtn').onclick = function () {
      toast('自选股：搜索添加 · 排行：市场×维度 · 板块资金：行业/概念/地域 · 点击任意行看详情');
    };
    $('#hamburger').onclick = function () { $('#sidebar').classList.toggle('open'); };
    $('#retryBtn').onclick = function () { hideErr(); curRoute = ''; route(); };

    // 详情弹窗
    $('#dSeg').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-p]'); if (!b) return;
      $$('#dSeg button').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      detailPeriod = b.dataset.p;
      loadDetailChart();
    });
    $('#dFav').onclick = function () {
      var nm = $('#dName').textContent;
      if (API.inWatch(detailCode)) {
        API.removeWatch(detailCode); toast('已移出股票池：' + nm); $('#dFav').textContent = '加入股票池';
      } else {
        API.addWatch(detailCode, nm, detailSecid); toast('已加入股票池：' + nm); $('#dFav').textContent = '移出股票池';
      }
    };
    $('#dSignal').onclick = function () { openSignal(detailCode, $('#dName').textContent, detailSecid); };

    // 云同步
    $('#syncPullBtn').onclick = function () {
      var u = $('#syncUser').value.trim(), p = $('#syncPass').value;
      var msg = $('#syncMsg');
      if (!u || !p) { msg.textContent = '请填写昵称和口令'; return; }
      msg.textContent = '拉取中…';
      API.syncRawPull(u, p).then(function (j) {
        if (!j.ok) { msg.textContent = '拉取失败：' + (j.msg || '未知错误'); return; }
        API.saveWatchlist(j.data.watchlist || []);
        API.saveSyncUser(u, true);
        msg.textContent = '已拉取 ' + (j.data.count || 0) + ' 只，更新于 ' + new Date(j.data.updatedAt).toLocaleString();
        loadWatchlist();
        toast('同步成功');
      }).catch(function (e) { msg.textContent = '网络错误：' + e.message; });
    };
    $('#syncPushBtn').onclick = function () {
      var u = $('#syncUser').value.trim(), p = $('#syncPass').value;
      var msg = $('#syncMsg');
      if (!u || !p) { msg.textContent = '请填写昵称和口令'; return; }
      msg.textContent = '上传中…';
      API.syncPush(u, p, API.watchlist()).then(function (d) {
        API.saveSyncUser(u, true);
        msg.textContent = '已上传 ' + d.count + ' 只';
        toast('上传成功');
      }).catch(function (e) { msg.textContent = '上传失败：' + e.message; });
    };

    // 全局点击：自选股删除 / 卡片 / 关闭弹窗
    document.addEventListener('click', function (e) {
      var del = e.target.closest('[data-del]');
      if (del) {
        e.stopPropagation();
        API.removeWatch(del.dataset.del);
        toast('已移出自选');
        loadWatchlist();
        return;
      }
      var card = e.target.closest('.wl-card[data-code]');
      if (card && !(e.target.closest('[data-sigview]'))) {
        openDetail(card.dataset.code, card.dataset.name, card.dataset.secid);
        return;
      }
      if (e.target.closest('[data-close]')) { closeDetail(); closeSignal(); closeSync(); closeMail(); }
      // 点击遮罩关闭
      ['#detailModal', '#signalModal', '#syncModal', '#mailModal'].forEach(function (id) {
        var m = $(id);
        if (m && e.target === m) { closeDetail(); closeSignal(); closeSync(); closeMail(); }
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeDetail(); closeSignal(); closeSync(); closeMail(); $('#sidebar').classList.remove('open'); }
    });
    window.addEventListener('resize', function () {
      if ($('#detailModal').classList.contains('show')) loadDetailChart();
      if (curRoute === 'stock-youzi' && yzCache) loadYouzi();
      if (curRoute === 'stock-overview') loadOverview(true);
    });

    window.addEventListener('hashchange', route);
    setInterval(tickClock, 1000); tickClock();

    // 顶部指数滚动条：全局常驻，不走 TIMERS（路由切换会清空 TIMERS）
    bindMail();
    loadTicker();
    setInterval(loadTicker, 30000);

    route();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
