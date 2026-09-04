import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { loadArray, loadStr, saveJson, saveStr } from './persist'

/* 盘中监控（P2-4：由 utils/signal-list.ts + Signal.vue 内的 localStorage
   开关收敛为 Pinia store）。key 与旧版一致（hqt.signal.v1）。 */
export interface SignalItem {
  code: string
  name: string
}

const SK = 'hqt.signal.v1'
/* 沿用原 Signal.vue 的开关 key 与裸字符串取值，避免用户已保存的设置丢失 */
const ALERT_K = 'hqt.sigAlert'
const ALERT_MUTE_K = 'hqt.sigAlertMute'
const isItem = (x: unknown): x is SignalItem => !!x && typeof (x as SignalItem).code === 'string'

export const useSignalStore = defineStore('signal', () => {
  const items = ref<SignalItem[]>(loadArray<SignalItem>(SK, isItem))
  watch(items, (list) => saveJson(SK, list), { deep: true })

  /* 语音播报开关与静音：原先由 Signal.vue 直接读写 localStorage，
     与监控列表割裂，收进同一 store 便于统一持久化 */
  const alertEnabled = ref(loadStr(ALERT_K) === '1')
  const alertMuted = ref(loadStr(ALERT_MUTE_K) === '1')
  watch(alertEnabled, (v) => saveStr(ALERT_K, v ? '1' : '0'))
  watch(alertMuted, (v) => saveStr(ALERT_MUTE_K, v ? '1' : '0'))

  /** 同一只股票去重 */
  function add(item: SignalItem): void {
    if (!items.value.some((x) => x.code === item.code)) items.value.push(item)
  }
  function remove(code: string): void {
    items.value = items.value.filter((x) => x.code !== code)
  }
  function clear(): void {
    items.value = []
  }
  function setAlert(v: boolean): void {
    alertEnabled.value = v
  }
  function setMuted(v: boolean): void {
    alertMuted.value = v
  }

  return { items, alertEnabled, alertMuted, add, remove, clear, setAlert, setMuted }
})
