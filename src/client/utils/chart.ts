import type { KlineItem, MinutePoint } from '@/types/market'

/* Canvas 图表绘制。
   从旧版 js/app.js 的 drawMinute / drawKline / bindChartHover 移植并 TypeScript 化，
   保留原有视觉风格（涨红跌绿、分时带成交量与均价线、K线为蜡烛图、悬停十字光标 + 数据浮层）。 */

const cssv = (name: string): string => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name)
  return v ? v.trim() : ''
}
const CN_UP = '#f5483b'
const CN_DOWN = '#16a34a'

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
  g.font = '13px sans-serif'
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
  g.setLineDash([4, 3])
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

/** 分时图：价格线 + 均价线 + 成交量柱 + 昨收基准线。hoverIdx >= 0 时画十字光标 */
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

  const pad = { l: 8, r: 52, t: 12, b: 20 }
  const chH = Math.round((h - pad.t - pad.b) * 0.74)
  const volH = h - pad.t - pad.b - chH

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

  const X = (i: number) => pad.l + (i / Math.max(1, pts.length - 1)) * (w - pad.l - pad.r)
  const Y = (v: number) => pad.t + ((hi - v) / (hi - lo)) * chH
  const VY = (v: number) => pad.t + chH + volH - (v / maxV) * volH
  const lastP = prices[prices.length - 1]
  const main = lastP >= preClose ? col.up : col.down

  /* 昨收基准线 */
  if (preClose > 0) {
    g.strokeStyle = col.border
    g.setLineDash([3, 3])
    g.lineWidth = 1
    g.beginPath()
    g.moveTo(pad.l, Y(preClose))
    g.lineTo(w - pad.r, Y(preClose))
    g.stroke()
    g.setLineDash([])
  }

  /* 成交量（悬停的那一根加亮） */
  const bw = Math.max(1, ((w - pad.l - pad.r) / pts.length) * 0.7)
  pts.forEach((p, i) => {
    const prev = i === 0 ? preClose : pts[i - 1].p
    g.fillStyle = p.p >= prev ? col.up : col.down
    g.globalAlpha = i === hoverIdx ? 0.95 : 0.45
    const y = VY(p.v || 0)
    g.fillRect(X(i) - bw / 2, y, bw, pad.t + chH + volH - y)
  })
  g.globalAlpha = 1

  /* 价格线 + 渐变填充 */
  g.beginPath()
  pts.forEach((p, i) => (i === 0 ? g.moveTo(X(i), Y(p.p)) : g.lineTo(X(i), Y(p.p))))
  g.strokeStyle = main
  g.lineWidth = 1.6
  g.stroke()
  g.lineTo(X(pts.length - 1), pad.t + chH)
  g.lineTo(X(0), pad.t + chH)
  g.closePath()
  const grad = g.createLinearGradient(0, pad.t, 0, pad.t + chH)
  grad.addColorStop(0, main + '33')
  grad.addColorStop(1, main + '00')
  g.fillStyle = grad
  g.fill()

  /* 均价线 */
  g.beginPath()
  let started = false
  pts.forEach((p, i) => {
    if (p.avg > 0) {
      if (started) g.lineTo(X(i), Y(p.avg))
      else {
        g.moveTo(X(i), Y(p.avg))
        started = true
      }
    }
  })
  g.strokeStyle = '#f0a020'
  g.lineWidth = 1
  g.stroke()

  /* 悬停十字光标 */
  if (hoverIdx >= 0 && hoverIdx < pts.length) {
    drawCursor(
      g,
      X(hoverIdx),
      Y(pts[hoverIdx].p),
      pad.l,
      w - pad.r,
      pad.t,
      pad.t + chH + volH,
      col.faint,
      main
    )
  }

  /* 右侧价格刻度 */
  g.fillStyle = col.muted
  g.font = '11px sans-serif'
  g.textAlign = 'left'
  g.fillText(hi.toFixed(2), w - pad.r + 4, pad.t + 10)
  g.fillText(lo.toFixed(2), w - pad.r + 4, pad.t + chH - 2)
  if (preClose > 0) g.fillText(preClose.toFixed(2), w - pad.r + 4, Y(preClose) + 3)

  return { n: pts.length, X, Y }
}

/** K 线图：蜡烛图（涨红跌绿）+ 坐标轴。hoverIdx >= 0 时画十字光标 */
export function drawKline(cv: HTMLCanvasElement, ks: KlineItem[], hoverIdx = -1): ChartLayout | null {
  const { g, w, h } = setupCanvas(cv)
  const col = thColors()
  if (!ks || !ks.length) {
    empty(g, w, h, '暂无K线数据', col.muted)
    return null
  }

  const pad = { l: 8, r: 52, t: 12, b: 22 }
  const hs = ks.map((k) => k.h)
  const ls = ks.map((k) => k.l)
  const p2 = (Math.max(...hs) - Math.min(...ls)) * 0.06 || 0.1
  const H = Math.max(...hs) + p2
  const L = Math.min(...ls) - p2
  const n = ks.length
  const bw = (w - pad.l - pad.r) / n
  const X = (i: number) => pad.l + (i + 0.5) * bw
  const Y = (v: number) => pad.t + ((H - v) / (H - L)) * (h - pad.t - pad.b)

  /* 坐标轴 */
  g.strokeStyle = col.border
  g.lineWidth = 1
  g.beginPath()
  g.moveTo(pad.l, pad.t)
  g.lineTo(pad.l, h - pad.b)
  g.lineTo(w - pad.r, h - pad.b)
  g.stroke()

  /* 蜡烛 */
  const cw = Math.max(1, bw * 0.62)
  ks.forEach((k, i) => {
    const c = k.c >= k.o ? col.up : col.down
    g.strokeStyle = c
    g.fillStyle = c
    g.beginPath()
    g.moveTo(X(i), Y(k.h))
    g.lineTo(X(i), Y(k.l))
    g.stroke()
    const y = Y(Math.max(k.o, k.c))
    const hh = Math.max(1, Math.abs(Y(k.o) - Y(k.c)))
    g.fillRect(X(i) - cw / 2, y, cw, hh)
  })

  /* 悬停十字光标 */
  if (hoverIdx >= 0 && hoverIdx < ks.length) {
    const k = ks[hoverIdx]
    drawCursor(g, X(hoverIdx), Y(k.c), pad.l, w - pad.r, pad.t, h - pad.b, col.faint, col.text)
  }

  /* 右侧价格刻度 */
  g.fillStyle = col.muted
  g.font = '11px sans-serif'
  g.textAlign = 'left'
  g.fillText(H.toFixed(2), w - pad.r + 4, pad.t + 10)
  g.fillText(L.toFixed(2), w - pad.r + 4, h - pad.b - 2)

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
