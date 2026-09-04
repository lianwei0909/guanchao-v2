import type { KlineItem, MinutePoint } from '@/types/market'
import { buildKlineIndicators } from './indicator'

/* Canvas 图表绘制。
   改版要点（依据 design/DEV-SPEC.md 第 5 章）：
   - K 线：主图（蜡烛 + MA5/10/20/60）+ 成交量副图（VOL MA5/10）+ MACD(12,26,9) 副图
   - 分时：主图（价格线 + 均价线）+ 成交量副图，左轴涨跌幅 / 右轴价格 双轴
   - 指标全部前端计算，后端数据源不提供
   - 高清屏按 devicePixelRatio 放大位图，颜色从 CSS 变量读取以跟随主题 */

const cssv = (name: string): string => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name)
  return v ? v.trim() : ''
}
const CN_UP = '#f5483b'
const CN_DOWN = '#16a34a'

const isDark = (): boolean =>
  document.documentElement.getAttribute('data-theme') === 'dark'

/** 图表内数字字体：与 --font-mono（Lora/Georgia）保持一致 */
const numFont = (size: number, weight: number | string = 400): string => {
  const fam = cssv('--font-mono') || 'Georgia, serif'
  return `${weight} ${size}px ${fam}`
}

/** 图表线色，随主题切换 */
export const CHART_COLORS = {
  ma5: () => cssv('--up') || '#d97757',
  ma10: () => (isDark() ? '#d9a44a' : '#c9942a'),
  ma20: () => cssv('--accent') || '#6a9bcc',
  ma60: () => cssv('--down') || '#788c5d',
  avg: () => (isDark() ? '#d9a44a' : '#c9942a'),
  axis: () => (isDark() ? '#7d786d' : '#b0aea5'),
  cursor: () => (isDark() ? '#8a8f99' : '#8a8880')
}

/** 图表内边距。r=60 给右侧价格轴留出呼吸（原 52 偏挤） */
const PAD = { l: 8, r: 60, t: 10, b: 24 }

function thColors() {
  return {
    up: cssv('--up') || CN_UP,
    down: cssv('--down') || CN_DOWN,
    text: cssv('--text') || '#1f2329',
    muted: cssv('--muted') || '#8a8f99',
    faint: cssv('--text-faint') || '#aab0bb',
    border: cssv('--border2') || '#eef1f5',
    card: cssv('--surface') || '#ffffff'
  }
}

/** HTML 转义（tip 内容由接口数据拼出，必须转义） */
const esc = (s: unknown): string =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  )

/** 处理高清屏：按 devicePixelRatio 放大位图，避免图表模糊 */
function setupCanvas(cv: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1
  const w = cv.clientWidth || cv.parentElement?.clientWidth || 600
  const h = cv.clientHeight || 260
  cv.width = Math.round(w * dpr)
  cv.height = Math.round(h * dpr)
  const g = cv.getContext('2d')!
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, w, h)
  return { g, w, h }
}

function empty(g: CanvasRenderingContext2D, w: number, h: number, txt: string, col: string) {
  g.fillStyle = col
  g.font = numFont(13)
  g.textAlign = 'center'
  g.fillText(txt, w / 2, h / 2)
}

/** 图表布局信息，供悬停时把鼠标位置换算成数据点索引 */
export interface ChartLayout {
  n: number
  X: (i: number) => number
  Y: (v: number) => number
}

/** 十字光标 + 高亮点 */
function drawCursor(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  col: string,
  dotCol: string
) {
  g.save()
  g.strokeStyle = col
  g.lineWidth = 1
  g.setLineDash([3, 3])
  g.beginPath()
  g.moveTo(x, y0)
  g.lineTo(x, y1)
  g.stroke()
  g.beginPath()
  g.moveTo(x0, y)
  g.lineTo(x1, y)
  g.stroke()
  g.setLineDash([])
  g.beginPath()
  g.arc(x, y, 3.6, 0, Math.PI * 2)
  g.fillStyle = dotCol
  g.fill()
  g.lineWidth = 2
  g.strokeStyle = col
  g.stroke()
  g.restore()
}

/** 画折线：遇 null 断开（指标预热期不画，避免贴地假线） */
function drawSeries(
  g: CanvasRenderingContext2D,
  vals: (number | null)[],
  color: string,
  X: (i: number) => number,
  Y: (v: number) => number
) {
  g.strokeStyle = color
  g.lineWidth = 1
  g.beginPath()
  let started = false
  vals.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) {
      started = false
      return
    }
    const x = X(i)
    const y = Y(v)
    if (started) g.lineTo(x, y)
    else {
      g.moveTo(x, y)
      started = true
    }
  })
  g.stroke()
}

/** 横向网格线（主图内 k 等分） */
function drawGrid(
  g: CanvasRenderingContext2D,
  x0: number,
  x1: number,
  top: number,
  height: number,
  n: number,
  col: string
) {
  g.strokeStyle = col
  g.globalAlpha = 0.55
  g.lineWidth = 1
  for (let k = 1; k < n; k++) {
    const yy = top + (height * k) / n
    g.beginPath()
    g.moveTo(x0, yy)
    g.lineTo(x1, yy)
    g.stroke()
  }
  g.globalAlpha = 1
}

/**
 * 分时图：价格线 + 均价线 + 成交量柱 + 昨收基准线 + 双轴（左涨跌幅 / 右价格）。
 * hoverIdx >= 0 时画十字光标。
 * 分时无 MACD 副图，因此主图占比高于 K 线、画布更矮，下方不留白。
 */
export function drawMinute(
  cv: HTMLCanvasElement,
  pts: MinutePoint[],
  preClose: number,
  hoverIdx = -1
): ChartLayout | null {
  const { g, w, h } = setupCanvas(cv)
  const col = thColors()
  if (!pts || !pts.length) {
    empty(g, w, h, '暂无分时数据', col.muted)
    return null
  }

  const inner = h - PAD.t - PAD.b
  const mainH = Math.round(inner * 0.79)
  const gapH = Math.round(inner * 0.03)
  const volH = Math.round(inner * 0.18)
  const volTop = PAD.t + mainH + gapH
  const plotW = w - PAD.l - PAD.r
  const right = w - PAD.r

  const prices = pts.map((p) => p.p)
  const avgs = pts.map((p) => p.avg).filter((x) => x > 0)
  const all = prices.concat(avgs)
  if (preClose > 0) all.push(preClose)
  const mx = Math.max(...all)
  const mn = Math.min(...all)
  const dev = Math.max(Math.abs(mx - preClose), Math.abs(preClose - mn), 0.01)
  const hi = preClose + dev
  const lo = preClose - dev
  const maxV = Math.max(...pts.map((p) => p.v || 0)) || 1

  const X = (i: number) => PAD.l + (i / Math.max(1, pts.length - 1)) * plotW
  const Y = (v: number) => PAD.t + ((hi - v) / (hi - lo)) * mainH
  const VY = (v: number) => volTop + volH - (v / maxV) * volH
  const pctOf = (p: number) => (preClose > 0 ? ((p - preClose) / preClose) * 100 : 0)
  const lastP = prices[prices.length - 1]
  const main = lastP >= preClose ? col.up : col.down

  /* 网格 + 昨收基准线 */
  drawGrid(g, PAD.l, right, PAD.t, mainH, 4, col.border)
  if (preClose > 0) {
    g.strokeStyle = col.faint
    g.setLineDash([4, 3])
    g.lineWidth = 1
    g.beginPath()
    g.moveTo(PAD.l, Y(preClose))
    g.lineTo(right, Y(preClose))
    g.stroke()
    g.setLineDash([])
  }

  /* 成交量（悬停的那一根加亮） */
  const bw = Math.max(1, (plotW / pts.length) * 0.7)
  pts.forEach((p, i) => {
    const prev = i === 0 ? preClose : pts[i - 1].p
    g.fillStyle = p.p >= prev ? col.up : col.down
    g.globalAlpha = i === hoverIdx ? 0.95 : 0.5
    const y = VY(p.v || 0)
    g.fillRect(X(i) - bw / 2, y, bw, volTop + volH - y)
  })
  g.globalAlpha = 1
  g.strokeStyle = col.border
  g.lineWidth = 1
  g.beginPath()
  g.moveTo(PAD.l, volTop)
  g.lineTo(right, volTop)
  g.stroke()

  /* 价格线 + 渐变填充 */
  g.beginPath()
  pts.forEach((p, i) => (i === 0 ? g.moveTo(X(i), Y(p.p)) : g.lineTo(X(i), Y(p.p))))
  g.strokeStyle = main
  g.lineWidth = 1.6
  g.stroke()
  g.lineTo(X(pts.length - 1), PAD.t + mainH)
  g.lineTo(X(0), PAD.t + mainH)
  g.closePath()
  const grad = g.createLinearGradient(0, PAD.t, 0, PAD.t + mainH)
  grad.addColorStop(0, main + '33')
  grad.addColorStop(1, main + '00')
  g.fillStyle = grad
  g.fill()

  /* 均价线 */
  drawSeries(
    g,
    pts.map((p) => (p.avg > 0 ? p.avg : null)),
    CHART_COLORS.avg(),
    X,
    Y
  )

  /* 悬停十字光标 */
  if (hoverIdx >= 0 && hoverIdx < pts.length) {
    drawCursor(
      g,
      X(hoverIdx),
      Y(pts[hoverIdx].p),
      PAD.l,
      right,
      PAD.t,
      volTop + volH,
      CHART_COLORS.cursor(),
      main
    )
  }

  /* 左轴涨跌幅（5 档）/ 右轴价格（5 档） */
  g.font = numFont(9.5)
  const devPct = pctOf(hi)
  for (let k = 0; k < 5; k++) {
    const yy = PAD.t + (mainH * k) / 4
    const pct = devPct - (devPct * 2 * k) / 4
    g.fillStyle = pct > 0 ? col.up : pct < 0 ? col.down : col.muted
    g.textAlign = 'left'
    g.fillText(`${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`, PAD.l + 2, Math.min(PAD.t + mainH, yy + 3))
    g.fillStyle = col.muted
    g.textAlign = 'left'
    g.fillText((hi - ((hi - lo) * k) / 4).toFixed(2), right + 6, Math.min(PAD.t + mainH, yy + 3))
  }

  /* 现价标签（右轴色块反白） */
  const yLast = Math.max(PAD.t + 8, Math.min(PAD.t + mainH - 8, Y(lastP)))
  g.fillStyle = main
  g.fillRect(right + 4, yLast - 8, PAD.r - 8, 16)
  g.fillStyle = '#fff'
  g.font = numFont(9.5, 600)
  g.textAlign = 'left'
  g.fillText(lastP.toFixed(2), right + 7, yLast + 3.5)

  /* 底部时间轴：紧贴量图，下方不留白。
     首/尾标签改用左右对齐贴边，避免居中时左半（或右半）被画布裁掉 */
  g.fillStyle = CHART_COLORS.axis()
  g.font = numFont(12, 600)
  const tN = pts.length
  const tStops = [0, Math.floor(tN * 0.25), Math.floor(tN * 0.5), Math.floor(tN * 0.75), tN - 1]
  const yBottom = volTop + volH
  tStops.forEach((i) => {
    if (i < 0 || i >= tN) return
    const x = X(i)
    g.strokeStyle = col.faint
    g.beginPath()
    g.moveTo(x, yBottom)
    g.lineTo(x, yBottom + 3)
    g.stroke()
    const isFirst = i === 0
    const isLast = i === tN - 1
    g.textAlign = isFirst ? 'left' : isLast ? 'right' : 'center'
    const tx = isFirst ? PAD.l : isLast ? right : x
    g.fillText(pts[i].t, tx, h - 8)
  })

  return { n: pts.length, X, Y }
}

/** K 线日期归一化：兼容腾讯 20260902 / 新浪 2026-09-02 / 东财 2026/09/02 三种格式 */
function kDate(t: unknown): [string, string, string] {
  const s = String(t || '').trim()
  let m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/)
  if (m) return [m[1], m[2].padStart(2, '0'), m[3].padStart(2, '0')]
  m = s.match(/^(\d{4})(\d{2})(\d{2})/)
  if (m) return [m[1], m[2], m[3]]
  return [s, '', '']
}

/**
 * 轴刻度日期（同花顺口径，跨周期不歧义）：
 * 日K 09/02；周K 26/07（120 周跨约 2.3 年，MM/DD 会出现跨年重名）；
 * 月K 2026/07（月K 的「日」恒为月末，显示出来没有信息量）。
 */
function axisDate(t: unknown, period: 'day' | 'week' | 'month'): string {
  const [y, mo, d] = kDate(t)
  if (!mo) return String(t || '')
  if (period === 'month') return `${y}/${mo}`
  if (period === 'week') return `${y.slice(2)}/${mo}`
  return `${mo}/${d}`
}

/**
 * K 线图：主图（蜡烛 + MA5/10/20/60）+ 成交量副图（VOL MA5/10）+ MACD(12,26,9) 副图。
 * hoverIdx >= 0 时画十字光标。
 * 注意：数据源无成交额字段，浮层不应出现成交额（分时有点级 amt，才可以有）。
 */
export function drawKline(
  cv: HTMLCanvasElement,
  ks: KlineItem[],
  hoverIdx = -1,
  period: 'day' | 'week' | 'month' = 'day'
): ChartLayout | null {
  const { g, w, h } = setupCanvas(cv)
  const col = thColors()
  if (!ks || !ks.length) {
    empty(g, w, h, '暂无K线数据', col.muted)
    return null
  }

  const inner = h - PAD.t - PAD.b
  const mainH = Math.round(inner * 0.6)
  const gapH = Math.round(inner * 0.03)
  const volH = Math.round(inner * 0.155)
  const macdH = Math.round(inner * 0.155)
  const volTop = PAD.t + mainH + gapH
  const macdTop = volTop + volH + gapH
  const macdBottom = macdTop + macdH
  const plotW = w - PAD.l - PAD.r
  const right = w - PAD.r

  const closes = ks.map((k) => k.c)
  const vols = ks.map((k) => k.v || 0)
  const ind = buildKlineIndicators(closes, vols)

  /* 价格区间：蜡烛 + 全部可见 MA 都纳入，避免 MA 线被裁掉 */
  let H = Math.max(...ks.map((k) => k.h))
  let L = Math.min(...ks.map((k) => k.l))
  for (const arr of [ind.ma5, ind.ma10, ind.ma20, ind.ma60]) {
    for (const v of arr) {
      if (v == null) continue
      if (v > H) H = v
      if (v < L) L = v
    }
  }
  const p2 = (H - L) * 0.06 || 0.1
  H += p2
  L -= p2

  const n = ks.length
  const bw = plotW / n
  const cw = Math.max(1, bw * 0.62)
  const X = (i: number) => PAD.l + (i + 0.5) * bw
  const Y = (v: number) => PAD.t + ((H - v) / (H - L)) * mainH

  /* 主图网格 + 蜡烛 */
  drawGrid(g, PAD.l, right, PAD.t, mainH, 4, col.border)
  ks.forEach((k, i) => {
    const c = k.c >= k.o ? col.up : col.down
    g.strokeStyle = c
    g.fillStyle = c
    g.lineWidth = 1
    g.beginPath()
    g.moveTo(X(i), Y(k.h))
    g.lineTo(X(i), Y(k.l))
    g.stroke()
    const y = Y(Math.max(k.o, k.c))
    const hh = Math.max(1, Math.abs(Y(k.o) - Y(k.c)))
    g.fillRect(X(i) - cw / 2, y, cw, hh)
  })

  /* MA 线 */
  drawSeries(g, ind.ma5, CHART_COLORS.ma5(), X, Y)
  drawSeries(g, ind.ma10, CHART_COLORS.ma10(), X, Y)
  drawSeries(g, ind.ma20, CHART_COLORS.ma20(), X, Y)
  drawSeries(g, ind.ma60, CHART_COLORS.ma60(), X, Y)

  /* ---- 成交量副图 ---- */
  const maxV = Math.max(...vols) || 1
  const VY = (v: number) => volTop + volH - (v / maxV) * volH
  g.strokeStyle = col.border
  g.lineWidth = 1
  g.beginPath()
  g.moveTo(PAD.l, volTop)
  g.lineTo(right, volTop)
  g.stroke()
  ks.forEach((k, i) => {
    const prev = i === 0 ? k.o : ks[i - 1].c
    g.fillStyle = k.c >= prev ? col.up : col.down
    g.globalAlpha = i === hoverIdx ? 0.95 : 0.5
    const y = VY(k.v || 0)
    g.fillRect(X(i) - cw / 2, y, cw, volTop + volH - y)
  })
  g.globalAlpha = 1
  drawSeries(g, ind.volMa5, CHART_COLORS.ma20(), X, VY)
  drawSeries(g, ind.volMa10, CHART_COLORS.ma10(), X, VY)
  g.fillStyle = col.faint
  g.font = numFont(9.5)
  g.textAlign = 'left'
  g.fillText('VOL', PAD.l + 2, volTop + 11)

  /* ---- MACD(12,26,9) 副图 ---- */
  const { dif, dea, bar } = ind.macd
  const mAbs = Math.max(...bar.map((b) => Math.abs(b)), 0.001)
  const MY = (v: number) => macdTop + macdH / 2 - (v / mAbs) * (macdH / 2 - 3)
  g.strokeStyle = col.border
  g.beginPath()
  g.moveTo(PAD.l, macdTop)
  g.lineTo(right, macdTop)
  g.stroke()
  g.setLineDash([2, 3])
  g.beginPath()
  g.moveTo(PAD.l, MY(0))
  g.lineTo(right, MY(0))
  g.stroke()
  g.setLineDash([])
  bar.forEach((b, i) => {
    const y0 = MY(0)
    const y1 = MY(b)
    g.fillStyle = b >= 0 ? col.up : col.down
    g.globalAlpha = i === hoverIdx ? 0.95 : 0.5
    g.fillRect(X(i) - cw / 2, Math.min(y0, y1), cw, Math.max(1, Math.abs(y1 - y0)))
  })
  g.globalAlpha = 1
  drawSeries(g, dif, CHART_COLORS.ma5(), X, MY)
  drawSeries(g, dea, CHART_COLORS.ma10(), X, MY)
  g.fillStyle = col.faint
  g.font = numFont(9.5)
  g.textAlign = 'left'
  g.fillText('MACD(12,26,9)', PAD.l + 2, macdTop + 11)

  /* 右侧价格轴：5 档 */
  g.fillStyle = col.muted
  g.font = numFont(9.5)
  g.textAlign = 'left'
  for (let k = 0; k < 5; k++) {
    const v = H - ((H - L) * k) / 4
    const yy = PAD.t + (mainH * k) / 4
    g.fillText(v.toFixed(2), right + 6, Math.min(PAD.t + mainH, yy + 3))
  }

  /* 悬停十字光标：竖线贯穿三个区 */
  if (hoverIdx >= 0 && hoverIdx < n) {
    drawCursor(
      g,
      X(hoverIdx),
      Y(ks[hoverIdx].c),
      PAD.l,
      right,
      PAD.t,
      macdBottom,
      CHART_COLORS.cursor(),
      col.text
    )
  }

  /* 底部日期轴：首/尾标签左右对齐贴边，避免居中时被画布裁掉半截 */
  g.fillStyle = CHART_COLORS.axis()
  g.font = numFont(12, 600)
  const kStops = [0, Math.floor(n * 0.25), Math.floor(n * 0.5), Math.floor(n * 0.75), n - 1]
  kStops.forEach((i) => {
    if (i < 0 || i >= n) return
    const x = X(i)
    g.strokeStyle = col.faint
    g.beginPath()
    g.moveTo(x, macdBottom)
    g.lineTo(x, macdBottom + 3)
    g.stroke()
    /* 按周期格式化：日K MM/DD / 周K YY/MM / 月K YYYY/MM（同花顺口径） */
    const isFirst = i === 0
    const isLast = i === n - 1
    g.textAlign = isFirst ? 'left' : isLast ? 'right' : 'center'
    const tx = isFirst ? PAD.l : isLast ? right : x
    g.fillText(axisDate(ks[i].t, period), tx, h - 8)
  })

  return { n: ks.length, X, Y }
}

/* ===================================================================
   图表悬停：十字光标 + 数据浮层（对应旧版 bindChartHover）
   paint(idx) 只做重绘，不重新请求数据，因此悬停是零网络开销。
   =================================================================== */
export interface HoverCfg {
  n: number
  X: (i: number) => number
  /** idx < 0 表示取消高亮 */
  paint: (idx: number) => void
  /** 返回 [[标签, 值, 颜色class?], ...] */
  tip: (idx: number) => [string, string, string?][]
}

export function bindChartHover(cv: HTMLCanvasElement, cfg: HoverCfg) {
  const box = cv.parentElement
  if (!box) return
  if (getComputedStyle(box).position === 'static') box.style.position = 'relative'

  let tip = box.querySelector('.cv-tip') as HTMLElement | null
  if (!tip) {
    tip = document.createElement('div')
    tip.className = 'cv-tip'
    box.appendChild(tip)
  }
  tip.style.display = 'none'
  cv.style.cursor = 'crosshair'

  const hide = () => {
    if (tip) tip.style.display = 'none'
    cfg.paint(-1)
  }

  const move = (clientX: number, clientY: number) => {
    if (!cfg.n) return
    const r = cv.getBoundingClientRect()
    const x = clientX - r.left
    let best = 0
    let bd = Infinity
    for (let i = 0; i < cfg.n; i++) {
      const d = Math.abs(cfg.X(i) - x)
      if (d < bd) {
        bd = d
        best = i
      }
    }
    cfg.paint(best)

    const rows = cfg.tip(best) || []
    tip!.innerHTML = rows
      .map(
        (rw) =>
          `<div class="cv-tip-r"><span>${esc(rw[0])}</span>` +
          `<b${rw[2] ? ` class="${esc(rw[2])}"` : ''}>${esc(rw[1])}</b></div>`
      )
      .join('')
    tip!.style.display = 'block'

    /* 浮层定位：默认跟随光标上方，越界则翻转，避免被裁切 */
    const tw = tip!.offsetWidth
    const th = tip!.offsetHeight
    const cx = cfg.X(best)
    let left = cx + 14
    if (left + tw > r.width - 4) left = cx - tw - 14
    if (left < 4) left = 4
    let top = clientY - r.top - th - 14
    if (top < 4) top = clientY - r.top + 18
    if (top + th > r.height - 2) top = Math.max(4, r.height - th - 2)
    tip!.style.left = left + 'px'
    tip!.style.top = top + 'px'
  }

  cv.onmousemove = (e) => move(e.clientX, e.clientY)
  cv.onmouseleave = hide
  cv.ontouchstart = (e) => move(e.touches[0].clientX, e.touches[0].clientY)
  cv.ontouchmove = (e) => {
    move(e.touches[0].clientX, e.touches[0].clientY)
    if (e.cancelable) e.preventDefault()
  }
  cv.ontouchend = hide
}
