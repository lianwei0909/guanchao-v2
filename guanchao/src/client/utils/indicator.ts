/* 技术指标计算。
   后端数据源不提供任何指标（腾讯 fqkline 仅返回 开/收/高/低/量），
   全部在前端由 K 线序列本地计算。/api/kline 默认返回 120 根，
   足够覆盖 MA60 与 MACD 预热（EMA26 + DEA9 约需 35 根）。

   约定：预热期返回 null，绘制时必须「断开不画」，
   不能用 0 顶替 —— 否则图左端会出现一条贴地的假直线。 */

/** 简单移动平均。前 n-1 项为 null */
export function ma(vals: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(vals.length).fill(null)
  if (n <= 0 || vals.length < n) return out
  let sum = 0
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i]
    if (i >= n) sum -= vals[i - n]
    if (i >= n - 1) out[i] = sum / n
  }
  return out
}

/** 指数移动平均。首项取序列首个值 */
export function ema(vals: number[], n: number): number[] {
  const out: number[] = []
  if (!vals.length || n <= 0) return out
  const k = 2 / (n + 1)
  let prev = vals[0]
  for (let i = 0; i < vals.length; i++) {
    prev = i === 0 ? vals[0] : (vals[i] - prev) * k + prev
    out.push(prev)
  }
  return out
}

export interface MacdResult {
  dif: number[]
  dea: number[]
  /** A 股惯例：bar = (DIF - DEA) * 2 */
  bar: number[]
}

/** MACD(12,26,9) */
export function macd(closes: number[], fast = 12, slow = 26, signal = 9): MacdResult {
  if (closes.length < 2) {
    return { dif: closes.slice(), dea: closes.slice(), bar: closes.map(() => 0) }
  }
  const ef = ema(closes, fast)
  const es = ema(closes, slow)
  const dif = closes.map((_, i) => ef[i] - es[i])
  const dea = ema(dif, signal)
  const bar = dif.map((d, i) => (d - dea[i]) * 2)
  return { dif, dea, bar }
}

/** 一次性算出 K 线图需要的全部指标，避免 hover 时重复计算 */
export interface KlineIndicators {
  ma5: (number | null)[]
  ma10: (number | null)[]
  ma20: (number | null)[]
  ma60: (number | null)[]
  volMa5: (number | null)[]
  volMa10: (number | null)[]
  macd: MacdResult
}

export function buildKlineIndicators(
  closes: number[],
  volumes: number[]
): KlineIndicators {
  return {
    ma5: ma(closes, 5),
    ma10: ma(closes, 10),
    ma20: ma(closes, 20),
    ma60: ma(closes, 60),
    volMa5: ma(volumes, 5),
    volMa10: ma(volumes, 10),
    macd: macd(closes)
  }
}
