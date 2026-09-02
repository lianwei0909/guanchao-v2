import type { WatchItem } from '@/types/market'

/* 自选股本localStorage 封装（对应旧版 js/api.js 的 watchlist / addWatch / removeWatch）。
   key 与旧版保持一致（hqt.watchlist.v1），这样旧版加的自选在 Vue 版里依然可见。 */
const WK = 'hqt.watchlist.v1'

export function watchlist(): WatchItem[] {
  try {
    const raw = localStorage.getItem(WK)
    if (!raw) return []
    const arr = JSON.parse(raw) as unknown
    return Array.isArray(arr)
      ? arr.filter((x): x is WatchItem => !!x && typeof (x as WatchItem).code === 'string')
      : []
  } catch {
    return []
  }
}

function save(list: WatchItem[]) {
  try {
    localStorage.setItem(WK, JSON.stringify(list))
  } catch {
    /* 隐私模式 / 配额满：忽略，不影响页面使用 */
  }
}

export function addWatch(item: WatchItem): WatchItem[] {
  const list = watchlist()
  if (list.some((x) => x.code === item.code)) return list
  list.push(item)
  save(list)
  return list
}

export function removeWatch(code: string): WatchItem[] {
  const list = watchlist().filter((x) => x.code !== code)
  save(list)
  return list
}

export function inWatch(code: string): boolean {
  return watchlist().some((x) => x.code === code)
}
