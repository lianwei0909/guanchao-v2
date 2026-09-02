import type { PaperItem } from '@/types/market'

/* 模拟持仓本地存储（对应旧版 js/api.js 的 paper / paperAdd / paperDel）。
   key 与旧版一致（hqt.paper.v1），旧版建的仓在 Vue 版里依然可见。 */
const PK = 'hqt.paper.v1'

export function paper(): PaperItem[] {
  try {
    const arr = JSON.parse(localStorage.getItem(PK) || '[]') as unknown
    return Array.isArray(arr)
      ? arr.filter((x): x is PaperItem => !!x && typeof (x as PaperItem).code === 'string')
      : []
  } catch {
    return []
  }
}

function paperSave(list: PaperItem[]): PaperItem[] {
  try {
    localStorage.setItem(PK, JSON.stringify(list))
  } catch {
    /* 隐私模式 / 配额满：忽略 */
  }
  return list
}

/** 已持仓则加仓，按加权平均更新成本 */
export function paperAdd(p: Omit<PaperItem, 'ts'>): PaperItem[] {
  const list = paper()
  const hit = list.find((x) => x.code === p.code)
  if (hit) {
    const tot = hit.shares + p.shares
    hit.cost = tot > 0 ? (hit.cost * hit.shares + p.cost * p.shares) / tot : p.cost
    hit.shares = tot
    hit.ts = Date.now()
    return paperSave(list)
  }
  list.push({ ...p, ts: Date.now() })
  return paperSave(list)
}

export function paperDel(code: string): PaperItem[] {
  return paperSave(paper().filter((x) => x.code !== code))
}
