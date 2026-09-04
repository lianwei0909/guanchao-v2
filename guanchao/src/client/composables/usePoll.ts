/* 统一轮询：把散落在各页面的 setInterval 收敛到一处。
   原先 11 个页面各自手写「onMounted 起定时器 + onUnmounted 清理」，
   逻辑重复且每一处都可能漏写清理；更重要的是它们在页面被切到后台后
   仍然继续打服务端 —— 用户开着十几个标签页时，这些请求是纯浪费，
   还会把服务端并发闸门占满（表现为「服务莫名变卡」）。

   统一后具备：
     - 卸载自动清理（不可能漏）
     - 页面隐藏（切标签页 / 最小化）自动跳过，回到前台立即补一次
     - 可选 shouldRun：盘外等业务条件不满足时暂停，条件恢复自动继续 */
import { onMounted, onUnmounted, ref } from 'vue'

export function usePoll(
  fn: () => void | Promise<void>,
  intervalMs: number,
  opts: { shouldRun?: () => boolean; immediate?: boolean } = {}
) {
  const { shouldRun, immediate = true } = opts
  const timer = ref<number>()
  /** 因业务条件（如盘外）而暂停时为 true，供页面展示「已暂停」提示 */
  const paused = ref(false)

  async function tick() {
    /* 后台标签页：不打服务端 */
    if (typeof document !== 'undefined' && document.hidden) return
    if (shouldRun && !shouldRun()) {
      paused.value = true
      return
    }
    paused.value = false
    await fn()
  }

  function onVisibility() {
    if (!document.hidden) tick()
  }

  onMounted(() => {
    document.addEventListener('visibilitychange', onVisibility)
    if (immediate) tick()
    timer.value = window.setInterval(tick, intervalMs)
  })

  onUnmounted(() => {
    if (timer.value) clearInterval(timer.value)
    document.removeEventListener('visibilitychange', onVisibility)
  })

  return { paused, tick }
}
