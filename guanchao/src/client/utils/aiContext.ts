import { reactive } from 'vue'

/* 全局 AI 上下文总线：
   各页面把自己的数据摘要写入当前「活跃页」上下文（kind + ctx），
   全局 AiPanel（挂在 App.vue）读取后作为解读依据。
   这样 AI 面板只需在 App 层挂载一次，即可在所有界面复用，
   并始终基于用户当前所在页面的数据。 */
const state = reactive<{
  kind: string
  ctx: string
}>({
  kind: 'overview',
  ctx: ''
})

/** 页面调用：注册当前页的 AI 上下文（kind + 数据摘要 ctx） */
export function setAiContext(kind: string, ctx: string) {
  state.kind = kind
  state.ctx = ctx
}

/** AiPanel 读取当前页上下文 */
export function getAiContext() {
  return { kind: state.kind, ctx: state.ctx }
}

export const aiContext = state
