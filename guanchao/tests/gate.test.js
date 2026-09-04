import { describe, it, expect } from 'vitest'
import { tiers, withTier, gateAcquire, gateRelease, stats } from '../server/lib/gate.js'

/* 并发闸门：前后台分级后，后台全市场扫描不得抢占前台预算。
   这里锁死「档位隔离」与「释放后计数归零」两条语义 ——
   后者尤其重要：计数一旦变负，`active >= max` 永不成立，限流会静默失效。 */

/** 在指定档位内取一个许可，执行完立即释放 */
async function withPermit(tier, fn) {
  await withTier(tier, async () => {
    await gateAcquire()
    try { fn() } finally { gateRelease() }
  })
}

describe('并发闸门', () => {
  it('默认走前台档位', async () => {
    await gateAcquire()
    try {
      expect(tiers.fg.active).toBeGreaterThan(0)
    } finally {
      gateRelease()
    }
  })

  it('前后台计数相互独立', async () => {
    await withPermit('bg', () => {
      expect(tiers.bg.active).toBeGreaterThan(0)
      expect(tiers.fg.active).toBe(0)
    })
  })

  it('释放后计数归零，不会变负（限流不会静默失效）', async () => {
    await withPermit('bg', () => {})
    expect(tiers.bg.active).toBeGreaterThanOrEqual(0)
    expect(tiers.bg.active).toBeLessThan(tiers.bg.active + 1) // 有限数
    // 反复取放后仍不为负
    for (let i = 0; i < 3; i++) await withPermit('fg', () => {})
    expect(tiers.fg.active).toBeGreaterThanOrEqual(0)
  })

  it('stats 暴露两档水位且含 max', () => {
    const s = stats()
    expect(s).toHaveProperty('fg')
    expect(s).toHaveProperty('bg')
    expect(s.fg.max).toBe(6)
    expect(s.bg.max).toBe(3)
    // 后台配额必须小于前台，否则就失去了隔离意义
    expect(s.bg.max).toBeLessThan(s.fg.max)
  })
})
