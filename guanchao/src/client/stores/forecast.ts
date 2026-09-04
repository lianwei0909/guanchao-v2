import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { MlRow } from '@/types/market'

/* 预测 PP 的 ML 训练状态（跨路由持久化）。
   打开预测 PP 默认短线，随后在后台「按周期顺序」把全部周期（超短→短→中→长）
   各训练一遍：优先训练首个进入的周期（当前页）；中途切换页面/周期不中断当前训练，
   训完提示该周期完成，再按固定顺序补训尚未完成的周期、跳过已完成的。
   只有点「⚡ 重新综合预测」才清掉全部重训。状态收进 store，组件卸载再挂载不丢。 */
export interface MlFailItem {
  code: string
  name: string
  reason: string
}

export const useForecastStore = defineStore('forecast', () => {
  /** 当前持股周期（切换页面后保持） */
  const horizon = ref<string>('short')

  /** 各周期 ML 结果：period -> code -> MlRow（不同周期训练口径不同，分开存） */
  const mlByPeriod = ref<Record<string, Record<string, MlRow>>>({})
  const mlMappedByPeriod = ref<Record<string, number>>({})
  const mlElapsedByPeriod = ref<Record<string, number>>({})
  const mlFailByPeriod = ref<Record<string, MlFailItem[]>>({})
  const mlErrorByPeriod = ref<Record<string, string>>({})
  const mlEtaByPeriod = ref<Record<string, number>>({})

  /** 训练队列/进度（全局，跨周期扫描用） */
  const mlLoading = ref(false) // 整轮扫描是否在进行
  const mlCurrentPeriod = ref('') // 当前正在训的周期（进度提示用）
  const mlDone = ref(0) // 当前周期已完成数量
  const mlCount = ref(0) // 当前周期总数

  /** 当前周期（horizon）的派生结果 —— 模板/计算函数沿用 ms.mlMap 等旧名，无需改动 */
  const mlMap = computed(() => mlByPeriod.value[horizon.value] ?? {})
  const mlMapped = computed(() => mlMappedByPeriod.value[horizon.value] ?? 0)
  const mlElapsed = computed(() => mlElapsedByPeriod.value[horizon.value] ?? 0)
  const mlFailList = computed(() => mlFailByPeriod.value[horizon.value] ?? [])
  const mlError = computed(() => mlErrorByPeriod.value[horizon.value] ?? '')
  const mlEta = computed(() => mlEtaByPeriod.value[horizon.value] ?? 0)
  const mlOn = computed(() => {
    const m = mlByPeriod.value[horizon.value]
    return !!m && Object.keys(m).length > 0
  })

  /** 某周期是否已训好（用于扫描跳过） */
  function trainedFor(h: string) {
    const m = mlByPeriod.value[h]
    return !!m && Object.keys(m).length > 0
  }

  /** 清空全部训练结果（重新预测时调用） */
  function reset() {
    mlByPeriod.value = {}
    mlMappedByPeriod.value = {}
    mlElapsedByPeriod.value = {}
    mlFailByPeriod.value = {}
    mlErrorByPeriod.value = {}
    mlEtaByPeriod.value = {}
    mlLoading.value = false
    mlCurrentPeriod.value = ''
    mlDone.value = 0
    mlCount.value = 0
  }

  /** 写入某周期训练结果 */
  function commitPeriod(h: string, m: Record<string, MlRow>, fails: MlFailItem[], elapsed: number, etaTotal: number) {
    mlByPeriod.value[h] = m
    mlMappedByPeriod.value[h] = Object.keys(m).length
    mlElapsedByPeriod.value[h] = Math.round(elapsed * 10) / 10
    mlEtaByPeriod.value[h] = Math.round(etaTotal)
    mlFailByPeriod.value[h] = fails
    mlErrorByPeriod.value[h] = ''
  }
  /** 某周期整批异常（无标的/服务离线） */
  function setPeriodError(h: string, msg: string) {
    mlErrorByPeriod.value[h] = msg
  }

  return {
    horizon,
    mlByPeriod,
    mlMappedByPeriod,
    mlElapsedByPeriod,
    mlFailByPeriod,
    mlErrorByPeriod,
    mlEtaByPeriod,
    mlLoading,
    mlCurrentPeriod,
    mlDone,
    mlCount,
    mlMap,
    mlMapped,
    mlElapsed,
    mlFailList,
    mlError,
    mlEta,
    mlOn,
    trainedFor,
    reset,
    commitPeriod,
    setPeriodError
  }
})
