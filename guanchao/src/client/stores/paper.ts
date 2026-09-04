import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type { PaperItem } from '@/types/market'
import { loadArray, saveJson } from './persist'

/* 模拟持仓（P2-4：由 utils/paper.ts 收敛为 Pinia store）。
   key 与旧版一致（hqt.paper.v1），旧版建的仓在 Vue 版里依然可见。
   原实现每次 paper() 都重读 localStorage 且非响应式，各页面需自行
   维护副本；收敛后增删即时反映到模拟持仓页与预测页。 */
const PK = 'hqt.paper.v1'
const isItem = (x: unknown): x is PaperItem => !!x && typeof (x as PaperItem).code === 'string'

export const usePaperStore = defineStore('paper', () => {
  const items = ref<PaperItem[]>(loadArray<PaperItem>(PK, isItem))
  watch(items, (list) => saveJson(PK, list), { deep: true })

  /** 建仓；已持仓则加仓，按加权平均更新成本 */
  function add(p: Omit<PaperItem, 'ts'>): void {
    const list = items.value
    const hit = list.find((x) => x.code === p.code)
    if (hit) {
      const tot = hit.shares + p.shares
      hit.cost = tot > 0 ? (hit.cost * hit.shares + p.cost * p.shares) / tot : p.cost
      hit.shares = tot
      hit.ts = Date.now()
      return
    }
    list.push({ ...p, ts: Date.now() })
  }

  function remove(code: string): void {
    items.value = items.value.filter((x) => x.code !== code)
  }

  return { items, add, remove }
})
