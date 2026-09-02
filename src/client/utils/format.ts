/* 数值 / 涨跌格式化（与旧版 app.js 的 fx / pc / yi / cl / sg 保持一致） */

export const fx = (v: unknown, d = 2): string => {
  const n = Number(v)
  return Number.isFinite(n) ? n.toFixed(d) : '--'
}

export const pc = (v: unknown, d = 2): string => {
  const n = Number(v)
  if (!Number.isFinite(n)) return '--'
  return (n >= 0 ? '+' : '') + n.toFixed(d) + '%'
}

/** 亿元 */
export const yi = (v: unknown, d = 2): string => {
  const n = Number(v)
  if (!Number.isFinite(n)) return '--'
  return (n >= 0 ? '+' : '') + n.toFixed(d) + '亿'
}

/** 涨跌色 class：>0 up / <0 down / 0 或无效 muted */
export const cl = (v: unknown): string => {
  const n = Number(v)
  if (!Number.isFinite(n) || n === 0) return 'muted'
  return n > 0 ? 'up' : 'down'
}

/** 正负号 */
export const sg = (v: unknown): string => (Number(v) >= 0 ? '+' : '')

/** 数据来源中文名 */
export const srcLabel = (s?: string): string =>
  s === 'ths' ? '同花顺' : s === 'em' ? '东方财富' : ''
