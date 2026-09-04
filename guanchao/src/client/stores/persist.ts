/* store 持久化辅助：localStorage 读写统一收敛在此。
   原先 watchlist / paper / signal 三处各自实现了一遍「读 JSON → 过滤 →
   写回」的样板（含 try/catch 兜底），重复且容易漏掉异常分支。
   隐私模式 / 配额满时静默降级，不影响页面使用。 */

/** 读取 JSON 数组并按类型守卫过滤脏数据（历史数据可能混入非预期结构） */
export function loadArray<T>(key: string, guard: (x: unknown) => x is T): T[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const arr = JSON.parse(raw) as unknown
    return Array.isArray(arr) ? arr.filter(guard) : []
  } catch {
    return []
  }
}

/** 写入 JSON；localStorage 不可用（隐私模式/配额满）时忽略 */
export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 忽略：数据仅在内存中的 store 生效，页面仍可正常使用 */
  }
}

/** 读取裸字符串（布尔开关等） */
export function loadStr(key: string): string {
  try {
    return localStorage.getItem(key) || ''
  } catch {
    return ''
  }
}

/** 写入裸字符串。注意：开关类旧值是 '1'/'0' 这样的裸字符串，
    用 saveJson 会写成带引号的 '"1"'，导致读回判断失效 */
export function saveStr(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 忽略 */
  }
}
