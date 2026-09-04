import { describe, it, expect } from 'vitest'
import {
  FORECAST_HORIZONS,
  crossSection,
  rawFactors,
  scoreRow
} from '../server/routes/forecast.js'

/* ---------- 预测选股：核心逻辑回归测试 ----------
   这份测试的直接由来是 P0-1 缺陷：评分闭包里引用了外层并不存在的
   last / ma5 / ma10 / ma20 / ma60 / dev，导致 /api/forecast 每次调用都抛
   ReferenceError、100% 失败；又因错误被 try/catch 转成 502 文案而长期未被发现。

   为此把评分逻辑抽成了纯函数 scoreRow（见 server/routes/forecast.js），
   这里直接用合成数据调用它 —— 不需要网络、不需要 mock，
   一旦再出现同类自由变量，测试会立刻以 ReferenceError 失败。 */

/** 合成一只「技术面数据齐备」的候选（对应 forecastList 第二层的产出） */
function makeItem(over = {}) {
  return {
    hasKs: true,
    last: 10,
    ma5: 9.8, ma10: 9.5, ma20: 9.0, ma60: 8.5,
    hi20: 10.5, lo20: 8.0,
    dev: 11.1,          // (last/ma20 - 1) * 100
    bull: true, safe: true, cash: true, vol: true,
    c: {
      code: '600000', secid: '1.600000', mkt: '1', name: '测试标的',
      price: 10, pct: 1.5,
      amount: 5,                 // 成交额（亿）
      turnover: 1.2, pe: 20, peTtm: 18, pb: 2,
      volumeRatio: 1.5, mktcap: 100,
      mainNetInflow: 0.2         // 主力净流入（亿）→ 净流入占比 4%
    },
    raw: {
      mom_12_1: 0.12, rev_4: 0.03, low_vol_12: -0.02, amount_trend: 1.1,
      trend_dev: 0.11, trend_slope: 0.04, pos_52: -0.05, low_amp_8: 0.01
    },
    ...over
  }
}

describe('评分纯函数 scoreRow', () => {
  it('产出有限且合法的评分（P0-1 回归防线）', () => {
    const row = scoreRow(makeItem(), FORECAST_HORIZONS.mid, null)
    expect(row).not.toBeNull()
    // 修复前：这里会抛 ReferenceError: last is not defined
    expect(Number.isFinite(row.score)).toBe(true)
    expect(row.score).toBeGreaterThanOrEqual(0)
    expect(row.score).toBeLessThanOrEqual(100)
  })

  it('派生字段全部为有限数（不会出现 undefined / NaN）', () => {
    const row = scoreRow(makeItem(), FORECAST_HORIZONS.mid, { composite: 0.5 })
    for (const k of [
      'score', 'ma5', 'ma10', 'ma20', 'ma60', 'dev', 'netRatio',
      'target', 'support', 'upside', 'risk', 'hi20', 'lo20'
    ]) {
      expect(Number.isFinite(row[k]), `${k} 应为有限数，实际 ${row[k]}`).toBe(true)
    }
    expect(typeof row.view).toBe('string')
    expect(row.view.length).toBeGreaterThan(0)
  })

  it('未达门槛时返回 null', () => {
    // 均线空头 + 资金流出 + 缩量 → 综合分应低于 mid 的门槛 50
    const weak = makeItem({
      last: 10, ma5: 10.2, ma10: 10.4, ma20: 10.6, ma60: 10.8,
      dev: -5.66, bull: false, cash: false, vol: false,
      c: { ...makeItem().c, volumeRatio: 0.8, mainNetInflow: -0.2 }
    })
    expect(scoreRow(weak, FORECAST_HORIZONS.mid, null)).toBeNull()
  })

  it('四个周期配置都能产出合法结果', () => {
    for (const [h, cfg] of Object.entries(FORECAST_HORIZONS)) {
      const row = scoreRow(makeItem(), cfg, null)
      expect(row, h).not.toBeNull()
      expect(Number.isFinite(row.score), h).toBe(true)
      expect(row.score, h).toBeLessThanOrEqual(100)
    }
  })

  it('评分单调：均线多头越强分越高', () => {
    const weak = scoreRow(makeItem({ ma5: 10.1, ma10: 10.15, ma20: 10.2, ma60: 10.25 }), FORECAST_HORIZONS.mid, null)
    const strong = scoreRow(makeItem({ ma5: 9.5, ma10: 9.0, ma20: 8.5, ma60: 8.0 }), FORECAST_HORIZONS.mid, null)
    expect(strong.score).toBeGreaterThan(weak.score)
  })

  it('资金强度加分：净流入占比越高分越高，且上限 10 分', () => {
    const base = makeItem()
    const low = scoreRow({ ...base, c: { ...base.c, mainNetInflow: 0.05 } }, FORECAST_HORIZONS.mid, null)
    const high = scoreRow({ ...base, c: { ...base.c, mainNetInflow: 1 } }, FORECAST_HORIZONS.mid, null)
    expect(high.score).toBeGreaterThan(low.score)
    // 占比 100% 时加分被夹到 10 分，不会溢出
    const extreme = scoreRow({ ...base, c: { ...base.c, mainNetInflow: 50 } }, FORECAST_HORIZONS.mid, null)
    expect(extreme.score).toBeLessThanOrEqual(100)
  })

  it('技术位自洽：目标价 >= 现价，支撑 <= 现价，风险为正', () => {
    const row = scoreRow(makeItem(), FORECAST_HORIZONS.mid, null)
    expect(row.target).toBeGreaterThanOrEqual(row.price)
    expect(row.support).toBeLessThanOrEqual(row.price)
    expect(row.risk).toBeGreaterThanOrEqual(0)
  })

  it('有因子时回传 qf，无因子时为 null', () => {
    const withRaw = scoreRow(makeItem(), FORECAST_HORIZONS.mid, { composite: 0.5 })
    expect(withRaw.qf).toBeTruthy()
    expect(withRaw.qfScore).not.toBeNull()

    const noRaw = scoreRow(makeItem({ raw: null }), FORECAST_HORIZONS.mid, null)
    expect(noRaw.qf).toBeNull()
    expect(noRaw.qfScore).toBeNull()
  })
})

describe('因子纯函数', () => {
  /** 合成 K 线：行序与腾讯一致 [日期, 开, 收, 高, 低, 量]，收盘在索引 2 */
  function makeKline(n = 120, base = 10) {
    const out = []
    for (let i = 0; i < n; i++) {
      const close = base + i * 0.05 + Math.sin(i / 5) * 0.2
      out.push([`2026-01-${String((i % 28) + 1).padStart(2, '0')}`, close, close, close + 0.1, close - 0.1, 1000 + i])
    }
    return out
  }

  it('样本不足 60 根时返回 null', () => {
    const ks = makeKline(30)
    expect(rawFactors(ks.map((k) => Number(k[2])), ks)).toBeNull()
  })

  it('样本充足时 8 个因子均为有限数', () => {
    const ks = makeKline(120)
    const f = rawFactors(ks.map((k) => Number(k[2])), ks)
    expect(f).not.toBeNull()
    expect(Object.keys(f)).toHaveLength(8)
    for (const v of Object.values(f)) expect(Number.isFinite(v)).toBe(true)
  })

  it('横截面用 MAD 抗极值：单个极端样本不会污染其余合成分', () => {
    const base = Array.from({ length: 9 }, () => ({
      mom_12_1: 0.1, rev_4: 0.1, low_vol_12: 0.1, amount_trend: 1,
      trend_dev: 0.1, trend_slope: 0.1, pos_52: -0.1, low_amp_8: 0.1
    }))
    const normal = crossSection(base)
    const poisoned = crossSection([
      ...base,
      { mom_12_1: 99, rev_4: 99, low_vol_12: 99, amount_trend: 99, trend_dev: 99, trend_slope: 99, pos_52: 99, low_amp_8: 99 }
    ])
    for (let i = 0; i < base.length; i++) {
      expect(Math.abs(poisoned[i].composite - normal[i].composite)).toBeLessThan(1)
    }
    // 极端样本自身被截尾在 ±3 内
    expect(Math.abs(poisoned[9].composite)).toBeLessThanOrEqual(3)
  })
})
