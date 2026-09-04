import { describe, it, expect } from 'vitest'
import { reportError, stats } from '../server/lib/monitor.js'

/* 错误监控：把「服务有没有在报错、报什么错」变得可观测。
   这里锁死指纹归并语义 —— 上游抖动时同一个错误可能每秒来一次，
   若不归并，落盘文件会瞬间膨胀。 */

describe('错误监控', () => {
  it('相同指纹归并计数：总数增加但种类数不变', () => {
    const before = stats()
    const path = '/api/test-dup'
    reportError(new Error('same-error-marker'), { path })
    reportError(new Error('same-error-marker'), { path })

    const after = stats()
    expect(after.total).toBe(before.total + 2)
    expect(after.kinds).toBe(before.kinds + 1)   // 只新增了一种
  })

  it('不同指纹分别成类', () => {
    const before = stats()
    reportError(new Error('err-a-marker'), { path: '/api/x' })
    reportError(new Error('err-b-marker'), { path: '/api/x' })
    expect(stats().kinds).toBe(before.kinds + 2)
  })

  it('相同消息但不同路径视为不同指纹', () => {
    const before = stats()
    reportError(new Error('shared-marker'), { path: '/api/p1' })
    reportError(new Error('shared-marker'), { path: '/api/p2' })
    expect(stats().kinds).toBe(before.kinds + 2)
  })

  it('last 记录最近一次错误的路径与消息', () => {
    reportError(new Error('last-one-marker'), { path: '/api/last' })
    const s = stats()
    expect(s.last).toBeTruthy()
    expect(s.last.msg).toBe('last-one-marker')
    expect(s.last.path).toBe('/api/last')
    expect(typeof s.last.count).toBe('number')
  })

  it('非 Error 入参也能安全记录', () => {
    expect(() => reportError('plain string error', { path: '/api/str' })).not.toThrow()
    expect(stats().last.msg).toBe('plain string error')
  })
})
