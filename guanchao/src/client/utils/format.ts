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

/** 成交量（手）：5.42e5 → "54.2万手" */
export const fmtVol = (v: unknown): string => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return '--'
  if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿手'
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万手'
  return String(Math.round(n))
}

/** 成交额（元）：2.286e9 → "22.86亿" */
export const fmtAmt = (v: unknown): string => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return '--'
  if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿'
  if (n >= 1e4) return (n / 1e4).toFixed(2) + '万'
  return n.toFixed(0)
}

/** 按代码判别所属市场（自选股等列表在名字后括号标注用）。
   代码格式：纯字母=美股 / 5 位=港股 / 6 位=A股（再细分沪市·深市·创业板·科创板·北交所） */
export function marketLabel(code: string): string {
  const c = (code || '').trim()
  if (!c) return ''
  if (/^[A-Za-z][A-Za-z0-9.\-]*$/.test(c)) return '美股'
  if (/^\d{5}$/.test(c)) return '港股'
  if (/^\d{6}$/.test(c)) {
    if (c.startsWith('688')) return '科创板'
    if (c.startsWith('60')) return '沪市'
    if (c.startsWith('30') || c.startsWith('301')) return '创业板'
    if (c.startsWith('8') || c.startsWith('4') || c.startsWith('92')) return '北交所'
    if (c.startsWith('00') || c.startsWith('001') || c.startsWith('002') || c.startsWith('003')) return '深市'
    return '沪市' // 9xxxxx 等归沪
  }
  return ''
}

/** 快讯时间统一格式化（资讯页与个股弹窗共用）：
   abs —— 紧凑显示（今天 HH:mm / 昨天 HH:mm / MM-DD HH:mm）
   rel —— 相对显示（刚刚 / N 分钟前 / N 小时前 / N 天前）
   full —— 原始字符串，给 title 用。

   三源返回的时间格式不统一：
   有的带时区（2026-09-02T08:03:59.000Z），有的不带（2026-09-02 16:50:12）。
   一律 replace 成斜杠会把带 Z 的串解析错，这里优先用原生 ISO 解析，失败再兜底。 */
function parseTime(iso: string): Date | null {
  const d1 = new Date(iso)
  if (!isNaN(d1.getTime())) return d1
  const d2 = new Date(String(iso).replace(/-/g, '/').replace('T', ' '))
  return isNaN(d2.getTime()) ? null : d2
}
export function newsTime(iso?: string): { abs: string; rel: string; full: string } {
  const full = String(iso || '').replace('T', ' ')
  if (!iso) return { abs: '--', rel: '', full }
  const d = parseTime(iso)
  if (!d) return { abs: '--', rel: '', full }
  const now = new Date()
  const pad = (v: number) => ('0' + v).slice(-2)
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes())
  const d0 = d.toDateString()
  const n0 = now.toDateString()
  const y = new Date(now.getTime() - 86400000).toDateString()
  const abs =
    d0 === n0
      ? hm
      : d0 === y
        ? '昨天 ' + hm
        : pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + hm
  const m = Math.floor((now.getTime() - d.getTime()) / 60000)
  const rel =
    m < 1
      ? '刚刚'
      : m < 60
        ? m + ' 分钟前'
        : m < 1440
          ? Math.floor(m / 60) + ' 小时前'
          : Math.floor(m / 1440) + ' 天前'
  return { abs, rel, full }
}

/** 把任意时间串解析为时间戳（解析失败返回 0），资讯页排序用 */
export function toTs(iso?: string): number {
  if (!iso) return 0
  const d = parseTime(iso)
  return d ? d.getTime() : 0
}
