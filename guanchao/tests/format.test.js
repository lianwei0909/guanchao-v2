import { describe, it, expect } from 'vitest'
import { num, round, feeOf, roundTripCostPct, FEE } from '../server/lib/format.js'

/* 金额/费率是「算错就亏钱」的逻辑，且前端另有一份镜像常量，
   这里把后端口径锁死，避免改动时悄悄跑偏。 */
describe('数值格式化', () => {
  it('num 把非法值统一归零', () => {
    expect(num('12.5')).toBe(12.5)
    expect(num(0)).toBe(0)
    expect(num('-')).toBe(0) // 东财缺失字段一律返回 '-'
    expect(num(null)).toBe(0)
    expect(num(undefined)).toBe(0)
    expect(num('abc')).toBe(0)
    expect(num(Infinity)).toBe(0)
  })

  it('round 按位四舍五入', () => {
    expect(round(1.239)).toBe(1.24)
    expect(round(1.239, 1)).toBe(1.2)
    expect(round('-')).toBe(0)
  })
})

describe('交易成本', () => {
  it('买入：佣金触底 5 元 + 过户费，无印花税', () => {
    const f = feeOf(10000, 'buy')
    expect(f.commission).toBe(5) // 10000*0.00025=2.5 < 下限 5
    expect(f.stamp).toBe(0)
    expect(round(f.total, 2)).toBe(5.1)
  })

  it('卖出：额外收印花税', () => {
    const f = feeOf(10000, 'sell')
    expect(f.commission).toBe(5)
    expect(round(f.stamp, 2)).toBe(5) // 10000 * 0.0005
    expect(round(f.total, 2)).toBe(10.1)
  })

  it('大额不再触底，按费率计算', () => {
    const f = feeOf(1000000, 'buy')
    expect(round(f.commission, 2)).toBe(250) // 1000000 * 0.00025
  })

  it('双边成本：万元级约 0.152%', () => {
    expect(round(roundTripCostPct(10000) * 100, 3)).toBe(0.152)
  })

  it('金额为 0 时不产生成本', () => {
    expect(roundTripCostPct(0)).toBe(0)
  })

  it('费率常量口径未被改动', () => {
    expect(FEE.commission).toBe(0.00025)
    expect(FEE.commissionMin).toBe(5)
    expect(FEE.stampTax).toBe(0.0005)
    expect(FEE.transfer).toBe(0.00001)
  })
})
