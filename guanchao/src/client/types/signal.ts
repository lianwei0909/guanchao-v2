import type { MinutePoint, SignalResp } from './market'

/**
 * 盘中监控的单个卡片状态。
 * 由 Signal.vue 持有并持久化（localStorage），SignalCard.vue 只负责渲染与交互，
 * 这样父组件的数据刷新逻辑与卡片的展示逻辑互不干扰。
 */
export interface SignalCardState {
  code: string
  name: string
  sig: SignalResp | null
  loading: boolean
  error: string
  pts: MinutePoint[]
  preClose: number
  /** 分时点位表默认展示 7 行（≈35px × 7 ≈ 245px） */
  showAllPoints: boolean
  /** 是否已在自选股里 —— 卡片右侧「加自选」按钮的状态 */
  watched: boolean
  /** 已见过的异动事件 key（用于「新异动才提醒」，避免刷新重复弹窗） */
  seen: Set<string>
}
