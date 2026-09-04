import { describe, it, expect } from 'vitest'
import { createCache } from '../server/lib/cache.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* 统一缓存是这次性能优化的核心：热点接口靠它做请求合并，
   一旦回归（比如合并在某次改动后失效）会直接导致上游被打爆，
   所以这里把几条关键语义都锁死。 */
describe('统一缓存', () => {
  it('命中未过期数据时不重复生产', async () => {
    const c = createCache({ name: 't-hit', ttl: 5000 })
    await c.wrap('k', async () => 'v1')
    const r = await c.wrap('k', async () => 'v2')
    expect(r.data).toBe('v1')
    expect(r.cached).toBe(true)
  })

  it('过期后重新生产', async () => {
    const c = createCache({ name: 't-expire', ttl: 20 })
    expect((await c.wrap('k', async () => 'a')).data).toBe('a')
    await sleep(40)
    expect((await c.wrap('k', async () => 'b')).data).toBe('b')
  })

  it('并发相同 key 只生产一次（请求合并）', async () => {
    let calls = 0
    const c = createCache({ name: 't-coalesce', ttl: 5000 })
    const producer = async () => {
      calls++
      await sleep(30)
      return 'x'
    }
    const rs = await Promise.all(Array.from({ length: 5 }, () => c.wrap('k', producer)))
    expect(calls).toBe(1)
    expect(rs.every((r) => r.data === 'x')).toBe(true)
    expect(c.stats().coalesced).toBe(4)
  })

  it('生产失败不留下 in-flight 占位，后续请求可重试', async () => {
    const c = createCache({ name: 't-inflight', ttl: 5000 })
    await expect(c.wrap('k', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(c.stats().inflight).toBe(0)
    expect((await c.wrap('k', async () => 'ok')).data).toBe('ok')
  })

  it('LRU：超过上限淘汰最久未用的', () => {
    const c = createCache({ name: 't-lru', ttl: 10000, max: 2 })
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)
    expect(c.get('a')).toBeNull()
    expect(c.get('b')).toBe(2)
    expect(c.get('c')).toBe(3)
  })

  it('LRU：读取会刷新使用顺序', () => {
    const c = createCache({ name: 'lru-touch', ttl: 10000, max: 2 })
    c.set('a', 1)
    c.set('b', 2)
    c.get('a') // a 变成最近使用
    c.set('c', 3)
    expect(c.get('b')).toBeNull()
    expect(c.get('a')).toBe(1)
  })

  it('上游失败且开启 stale 时降级返回过期数据', async () => {
    const c = createCache({ name: 't-stale', ttl: 20, staleTtl: 5000 })
    await c.wrap('k', async () => 'old')
    await sleep(40)
    const r = await c.wrap('k', async () => { throw new Error('boom') }, { stale: true })
    expect(r.data).toBe('old')
    expect(r.stale).toBe(true)
  })

  it('上游失败且未开启 stale 时抛出错误', async () => {
    const c = createCache({ name: 't-nostale', ttl: 20 })
    await expect(c.wrap('k', async () => { throw new Error('boom') })).rejects.toThrow('boom')
  })

  it('force 可跳过缓存强制刷新', async () => {
    const c = createCache({ name: 't-force', ttl: 5000 })
    await c.wrap('k', async () => 'v1')
    const r = await c.wrap('k', async () => 'v2', { force: true })
    expect(r.data).toBe('v2')
    expect(r.cached).toBe(false)
  })
})
