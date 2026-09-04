/* 统一缓存：TTL + LRU + in-flight 合并 + stale 兜底
   背景：原先有 12 处各自手写的 Map/对象缓存，TTL 与淘汰语义不一致，
   且只有 K 线做了请求合并 —— 热点接口在缓存失效瞬间会并发击穿到上游，
   叠加东财 IP 级限流极易雪崩。这里统一为一份实现。 */
const registry = new Map();

class Cache {
  /**
   * @param {object} o
   * @param {string} o.name      缓存名（用于 /health 观测）
   * @param {number} o.ttl       有效期 ms
   * @param {number} o.max       LRU 上限条数
   * @param {number} o.staleTtl  过期后仍可兜底返回的时长 ms，0 表示不兜底
   */
  constructor({ name = 'anon', ttl = 60 * 1000, max = 200, staleTtl = 0 } = {}) {
    this.name = name;
    this.ttl = ttl;
    this.max = max;
    this.staleTtl = staleTtl;
    this.map = new Map();      // key -> { t, v }
    this.inflight = new Map(); // key -> Promise
    this.hits = 0;
    this.misses = 0;
    this.coalesced = 0;
    registry.set(name, this);
  }

  /* 命中未过期数据；顺手做 LRU 提频 */
  get(key) {
    const e = this.map.get(key);
    if (!e) return null;
    if (Date.now() - e.t > (e.ttl ?? this.ttl)) return null;
    this.map.delete(key);
    this.map.set(key, e);
    return e.v;
  }

  /* 忽略 TTL 读取（含刚过期的数据），用于 stale 兜底 */
  peek(key) {
    const e = this.map.get(key);
    if (!e) return null;
    const age = Date.now() - e.t;
    if (age > (e.ttl ?? this.ttl) + this.staleTtl) return null;
    return { v: e.v, age };
  }

  /**
   * @param {any} v
   * @param {number|((v:any)=>number)} [ttl] 可传数字，也可传函数按值决定 TTL。
   *   例：K 线空结果只缓存 30 秒（防穿透），有数据则缓存 5 分钟。
   */
  set(key, v, ttl) {
    const eff = typeof ttl === 'function' ? ttl(v) : (ttl == null ? this.ttl : ttl);
    this.map.delete(key);
    this.map.set(key, { t: Date.now(), v, ttl: eff });
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    return v;
  }

  invalidate(key) {
    if (key === undefined) this.map.clear();
    else this.map.delete(key);
  }

  /**
   * 读取-穿透主入口。
   * @param {string}   key
   * @param {Function} producer 未命中时的数据生产函数
   * @param {object}   opts  { ttl, stale, force }
   * @returns {Promise<{data:any, cached:boolean, stale?:boolean, coalesced?:boolean, age?:number}>}
   */
  async wrap(key, producer, { ttl, stale = this.staleTtl > 0, force = false } = {}) {
    if (!force) {
      const hit = this.get(key);
      if (hit !== null && hit !== undefined) {
        this.hits++;
        return { data: hit, cached: true };
      }
    }

    /* 已有同名请求在飞：复用同一个 Promise，避免并发击穿 */
    const running = this.inflight.get(key);
    if (running) {
      this.coalesced++;
      return { data: await running, cached: true, coalesced: true };
    }

    this.misses++;
    const p = (async () => {
      try {
        return this.set(key, await producer(), ttl);
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);

    try {
      return { data: await p, cached: false };
    } catch (e) {
      /* 上游失败时降级到过期数据，好过直接把错误抛给用户 */
      if (stale) {
        const s = this.peek(key);
        if (s) return { data: s.v, cached: true, stale: true, age: s.age };
      }
      throw e;
    }
  }

  stats() {
    return {
      name: this.name,
      size: this.map.size,
      hits: this.hits,
      misses: this.misses,
      coalesced: this.coalesced,
      inflight: this.inflight.size
    };
  }
}

function createCache(opts) {
  return new Cache(opts);
}

function stats() {
  return [...registry.values()].map((c) => c.stats());
}

module.exports = { Cache, createCache, stats };
