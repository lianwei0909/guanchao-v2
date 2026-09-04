import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { loadStr, saveStr } from './persist'

/* 深浅色主题（P2-4：由 App.vue 内的局部 ref + 直接读写 localStorage 收敛为
   Pinia store）。收敛后其它页面/组件也能读取或切换主题，无需层层传参。 */
const KEY = 'theme'

export const useThemeStore = defineStore('theme', () => {
  const isDark = ref(false)

  function apply(v: boolean): void {
    document.documentElement.setAttribute('data-theme', v ? 'dark' : 'light')
  }

  function toggle(): void {
    isDark.value = !isDark.value
  }

  /** 挂载时调用：读取本地偏好，无则跟随系统偏好 */
  function init(): void {
    const saved = loadStr(KEY)
    if (saved === 'dark') isDark.value = true
    else if (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches) isDark.value = true
    apply(isDark.value)
  }

  watch(isDark, (v) => {
    apply(v)
    saveStr(KEY, v ? 'dark' : 'light')
  })

  return { isDark, toggle, init }
})
