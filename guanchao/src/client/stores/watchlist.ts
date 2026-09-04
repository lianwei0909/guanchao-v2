import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type { WatchItem } from '@/types/market'
import { loadArray, saveJson } from './persist'

/* 自选股（P2-4：由 utils/watchlist.ts 的模块级 ref 收敛为 Pinia store）。
   key 与旧版保持一致（hqt.watchlist.v1），旧版加的自选在 Vue 版里依然可见。
   收敛后增删即时同步到所有页面（自选股页、个股详情弹窗、盘中监控）。 */
const WK = 'hqt.watchlist.v1'
const isItem = (x: unknown): x is WatchItem => !!x && typeof (x as WatchItem).code === 'string'

export const useWatchlistStore = defineStore('watchlist', () => {
  const items = ref<WatchItem[]>(loadArray<WatchItem>(WK, isItem))
  watch(items, (list) => saveJson(WK, list), { deep: true })

  /** 已存在则忽略（按代码去重） */
  function add(item: WatchItem): void {
    if (!items.value.some((x) => x.code === item.code)) items.value.push(item)
  }
  function remove(code: string): void {
    items.value = items.value.filter((x) => x.code !== code)
  }
  function has(code: string): boolean {
    return items.value.some((x) => x.code === code)
  }

  return { items, add, remove, has }
})
