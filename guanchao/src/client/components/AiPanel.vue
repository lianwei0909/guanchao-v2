<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { api } from '@/api'
import { readSSE } from '@/utils/ai'
import { aiContext } from '@/utils/aiContext'

/* 全局 AI 解读助手（挂在 App.vue，所有界面可见）：
   - 默认收起为可自由拖动的 🤖 悬浮图标，位置记忆到 localStorage；
   - 点击图标 → 图标消失，原地展开一个社交软件风格的对话窗；
     关闭后图标重新出现。
   - 自动把当前页面注册的数据摘要（aiContext）作为上下文，
     SSE 流式多轮对话；未配置大模型时提示。 */

const LS_KEY = 'ai-panel-pos'

/* ---------------- 拖动状态与逻辑 ---------------- */
const pos = ref<{ x: number; y: number } | null>(null)
const dragging = ref(false)
const moved = ref(false)
let dragOffX = 0
let dragOffY = 0
const DRAG_THRESHOLD = 5 // 移动超过该像素才视为拖拽，否则算点击

function loadPos() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      const p = JSON.parse(raw)
      if (p && typeof p.x === 'number' && typeof p.y === 'number') return p
    }
  } catch { /* ignore */ }
  // 默认：右下角
  return { x: window.innerWidth - 70, y: window.innerHeight * 0.72 }
}
function savePos() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(pos.value)) } catch { /* ignore */ }
}
// 根据当前形态（收起图标 / 展开聊天窗）取容器实际宽高，用于夹紧视口
function rigSize() {
  if (open.value) {
    const w = Math.min(360, (window.innerWidth * 82) / 100 - 24)
    const h = Math.min(560, (window.innerHeight * 78) / 100 - 24)
    return { w, h }
  }
  return { w: 48, h: 48 }
}
function clampPos(x: number, y: number) {
  const { w, h } = rigSize()
  return {
    x: Math.max(8, Math.min(window.innerWidth - w - 8, x)),
    y: Math.max(8, Math.min(window.innerHeight - h - 8, y))
  }
}
function onPointerDown(e: PointerEvent) {
  // 仅主键拖动
  if (e.button !== 0) return
  dragging.value = true
  moved.value = false
  dragOffX = e.clientX - pos.value!.x
  dragOffY = e.clientY - pos.value!.y
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}
function onPointerMove(e: PointerEvent) {
  if (!dragging.value) return
  const nx = e.clientX - dragOffX
  const ny = e.clientY - dragOffY
  if (!moved.value && Math.abs(nx - pos.value!.x) + Math.abs(ny - pos.value!.y) < DRAG_THRESHOLD) return
  moved.value = true
  pos.value = clampPos(nx, ny)
}
function onPointerUp(e: PointerEvent) {
  dragging.value = false
  try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* ignore */ }
  if (moved.value) savePos()
}
function onResize() {
  // 视口变化时夹紧位置，避免跑出屏幕
  if (pos.value) pos.value = clampPos(pos.value.x, pos.value.y)
}
onMounted(() => {
  pos.value = loadPos()
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => window.removeEventListener('resize', onResize))

/* 整体容器定位：跟随图标位置（图标与弹窗一起移动） */
const rigStyle = computed(() => {
  if (!pos.value) return {}
  return { left: pos.value.x + 'px', top: pos.value.y + 'px' }
})

/* ---------------- 弹窗开关 ---------------- */
const open = ref(false)
function toggle() {
  if (moved.value) return // 拖动结束不弹开
  open.value = !open.value
}
function close() {
  open.value = false
}

/* ---------------- 对话状态（社交软件式消息流） ---------------- */
/** 单条消息：role=user|assistant，含流式中的临时内容 */
interface ChatMsg { role: 'user' | 'assistant'; content: string }
const messages = ref<ChatMsg[]>([])
const ask = ref('')
const streaming = ref(false)
const configured = ref<boolean | null>(null)
const err = ref('')
/** 多轮对话历史（不含当前正在流式的这条） */
const history = ref<{ role: string; content: string }[]>([])
let controller: AbortController | null = null

/* 当前页上下文（响应式读取） */
const pageCtx = computed(() => aiContext.ctx || '（当前页暂无数据）')
const pageKind = computed(() => aiContext.kind || 'overview')

/* 打开弹窗时若尚无对话，自动发起首轮「当前页解读」 */
watch(open, (v) => {
  if (v && !messages.value.length && !streaming.value) startFirst()
})

async function startFirst() {
  streaming.value = true
  err.value = ''
  const cur: ChatMsg = { role: 'assistant', content: '' }
  messages.value.push(cur)
  controller = new AbortController()
  try {
    const res = await api.aiRaw({
      kind: pageKind.value,
      ask: '请对以上数据进行解读、总结与风险提示',
      ctx: pageCtx.value,
      history: []
    })
    await readSSE(res, {
      signal: controller.signal,
      onDelta: (t) => { cur.content += t; configured.value = true },
      /* 正常收流：说明大模型确实配置可用（未配置时服务端会直接发 error） */
      onDone: () => { configured.value = true },
      onError: (m) => { err.value = m; if (m.includes('未配置')) configured.value = false }
    })
  } catch (e) {
    err.value = e instanceof Error ? e.message : '请求失败'
  } finally {
    streaming.value = false
    controller = null
    if (!cur.content) messages.value.pop()
  }
}

/* ---------------- AI 请求（用户追问） ---------------- */
async function send() {
  const userAsk = ask.value.trim()
  if (!userAsk || streaming.value) return
  ask.value = ''
  err.value = ''

  messages.value.push({ role: 'user', content: userAsk })
  const cur: ChatMsg = { role: 'assistant', content: '' }
  messages.value.push(cur)

  streaming.value = true
  controller = new AbortController()
  const hist = history.value.slice()
  try {
    const res = await api.aiRaw({
      kind: pageKind.value,
      ask: userAsk,
      ctx: pageCtx.value,
      history: hist
    })
    await readSSE(res, {
      signal: controller.signal,
      onDelta: (t) => { cur.content += t; configured.value = true },
      /* 正常收流：说明大模型确实配置可用（未配置时服务端会直接发 error） */
      onDone: () => { configured.value = true },
      onError: (m) => { err.value = m; if (m.includes('未配置')) configured.value = false }
    })
  } catch (e) {
    err.value = e instanceof Error ? e.message : '请求失败'
  } finally {
    streaming.value = false
    controller = null
    if (!cur.content) {
      // 移除空的 assistant 占位
      const last = messages.value[messages.value.length - 1]
      if (last && last.role === 'assistant' && !last.content) messages.value.pop()
    }
  }
  // 沉淀进多轮历史
  if (messages.value.length >= 2) {
    const u = messages.value.find((m) => m.role === 'user' && m.content === userAsk)
    const a = messages.value[messages.value.length - 1]
    if (u && a?.content) {
      history.value = [...history.value, { role: 'user', content: u.content }, { role: 'assistant', content: a.content }]
    }
  }
}
function stop() { controller?.abort(); streaming.value = false }

/* 消息流容器引用 + 自动滚到底部 */
const msgBox = ref<HTMLElement | null>(null)
function scrollBottom() {
  const el = msgBox.value
  if (el) el.scrollTop = el.scrollHeight
}
watch(() => messages.value.length, () => scrollBottom())
watch(streaming, () => scrollBottom())
</script>

<template>
  <!-- 悬浮容器：整体跟随 pos 定位。展开时放大以容纳聊天窗，收起时为图标尺寸 -->
  <div class="ai-rig" :class="{ expanded: open }" :style="rigStyle">
    <!-- 对话弹窗（社交软件风格，原地展开，图标消失） -->
    <div v-if="open" class="ai-chat">
      <!-- 顶部标题栏（可拖动移动弹窗） -->
      <header
        class="chat-hd"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      >
        <img src="/icons/guanchao-logo.png" alt="" class="chat-logo" />
        <span class="chat-title">guanchao</span>
        <span class="chat-sub">在线</span>
        <button class="chat-stop" @pointerdown.stop @click="stop" title="停止生成">■</button>
        <button class="chat-close" @pointerdown.stop @click="close" title="关闭">✕</button>
      </header>

      <!-- 消息流 -->
      <div ref="msgBox" class="chat-body">
        <div v-if="configured === false && !messages.length" class="chat-hint">
          未配置大模型：请在 <code>data/llm.json</code> 或环境变量
          <code>LLM_API_KEY / LLM_BASE_URL / LLM_MODEL</code> 中配置后刷新。
        </div>
        <div v-else-if="!messages.length && !streaming" class="chat-empty">
          我已就绪，可基于当前页面数据为你解读、总结与风险提示。
        </div>

        <div
          v-for="(m, i) in messages"
          :key="i"
          class="msg-row"
          :class="m.role === 'user' ? 'is-user' : 'is-ai'"
        >
          <span class="msg-av">{{ m.role === 'user' ? '我' : 'AI' }}</span>
          <div class="msg-bub" :class="m.role === 'user' ? 'bub-user' : 'bub-ai'">
            {{ m.content || '思考中…' }}
          </div>
        </div>
        <div v-if="err" class="chat-err">{{ err }}</div>
      </div>

      <!-- 底部输入栏 -->
      <footer class="chat-foot">
        <input
          v-model="ask"
          class="chat-in"
          type="text"
          placeholder="输入消息…"
          :disabled="streaming"
          @keyup.enter="send"
        />
        <button v-if="!streaming" class="chat-send" @click="send">➤</button>
        <button v-else class="chat-send stop" @click="stop">■</button>
      </footer>
    </div>

    <!-- 悬浮触发按钮（收起时可见、可拖动；展开后隐藏） -->
    <button
      v-if="!open"
      class="ai-trigger"
      :class="{ dragging: dragging }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @click.capture="toggle"
      title="AI 解读（可拖动）"
    >
      <img src="/icons/guanchao-logo.png" alt="AI" class="trigger-img" />
    </button>
  </div>
</template>

<style scoped>
/* ============================================================
   AI 悬浮助手 —— 社交软件风格对话窗
   图标使用网页 logo；展开后图标消失，原地弹出聊天窗。
   配色沿用站点变量：橙 #d97757 / 米白 #faf9f5 / 墨黑 #141413 / 描边 #e8e6dc
   ============================================================ */

/* ---------- 悬浮整体容器（fixed 定位）---------- */
.ai-rig {
  position: fixed;
  z-index: 910;
  width: 48px;
  height: 48px;
  pointer-events: none;
}
/* 展开时容器撑满聊天窗尺寸，原点仍锚定在图标处（左下区域） */
.ai-rig.expanded {
  width: min(360px, calc(82vw - 24px));
  height: min(560px, calc(78vh - 24px));
}

/* ---------- 悬浮触发按钮（logo 图标，可拖动）---------- */
.ai-trigger {
  position: absolute;
  left: 0;
  top: 0;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: none;
  background: #ffffff;
  padding: 4px;
  cursor: grab;
  box-shadow: 0 4px 16px rgba(20, 20, 19, 0.18);
  display: flex;
  align-items: center;
  justify-content: center;
  touch-action: none;
  transition: box-shadow 0.2s ease, transform 0.1s ease, filter 0.2s ease;
  user-select: none;
  pointer-events: auto;
}
.ai-trigger:hover { filter: brightness(0.97); box-shadow: 0 6px 22px rgba(20,20,19,.26); }
.ai-trigger.dragging { cursor: grabbing; box-shadow: 0 10px 28px rgba(20,20,19,.32); }
.trigger-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
  display: block;
  pointer-events: none;
}

/* ---------- 聊天窗（社交软件式，原地展开）---------- */
.ai-chat {
  position: absolute;
  left: 0;
  bottom: 0;
  width: min(360px, calc(82vw - 24px));
  height: min(560px, calc(78vh - 24px));
  background: #f5f4ef;
  border: 1px solid #e8e6dc;
  border-radius: 18px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(20, 20, 19, 0.22);
  animation: aiIn 0.22s cubic-bezier(.22,1,.36,1);
  pointer-events: auto;
}
[data-theme="dark"] .ai-chat {
  background: #181714;
  border-color: #33302a;
  box-shadow: 0 20px 60px rgba(0,0,0,.55);
}
@keyframes aiIn {
  from { opacity: 0; transform: translateY(12px) scale(0.96); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

/* ---------- 顶部标题栏 ---------- */
.chat-hd {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  background: #faf9f5;
  border-bottom: 1px solid #e8e6dc;
  flex-shrink: 0;
  cursor: move;
  user-select: none;
  touch-action: none;
}
[data-theme="dark"] .chat-hd { background: #201f1c; border-color: #33302a; }
.chat-logo {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  object-fit: cover;
  flex-shrink: 0;
}
.chat-title {
  font-family: 'Poppins', Arial, sans-serif;
  font-weight: 600;
  font-size: 15px;
  color: #141413;
}
[data-theme="dark"] .chat-title { color: #f5f3ee; }
.chat-sub {
  font-size: 11px;
  color: #788c5d;
  background: rgba(120,140,93,.12);
  border-radius: 999px;
  padding: 2px 8px;
  margin-right: auto;
}
[data-theme="dark"] .chat-sub { color: #9fb084; background: rgba(159,176,132,.14); }
.chat-stop {
  background: transparent;
  border: none;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  font-size: 11px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #d97757;
  flex-shrink: 0;
  transition: 0.15s;
}
.chat-stop:hover { background: rgba(217,119,87,.12); }
[data-theme="dark"] .chat-stop:hover { background: rgba(217,119,87,.20); }
.chat-hd button { cursor: default; }
.chat-close {
  background: transparent;
  border: none;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  font-size: 14px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #5c5b55;
  flex-shrink: 0;
  transition: 0.15s;
}
.chat-close:hover { background: rgba(20,20,19,.08); color: #141413; }
[data-theme="dark"] .chat-close:hover { background: rgba(245,243,238,.10); color: #f5f3ee; }

/* ---------- 消息流 ---------- */
.chat-body {
  flex: 1;
  overflow-y: auto;
  padding: 14px 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: #f5f4ef;
}
[data-theme="dark"] .chat-body { background: #181714; }
.chat-empty, .chat-hint {
  font-family: 'Lora', Georgia, serif;
  font-size: 12.5px;
  line-height: 1.6;
  color: #b0aea5;
  text-align: center;
  padding: 16px 10px;
}
.chat-hint code { font-family: var(--font-mono); background: rgba(20,20,19,.06); padding: 0 4px; border-radius: 4px; }
[data-theme="dark"] .chat-hint code { background: rgba(245,243,238,.08); }

.msg-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: 88%;
}
.msg-row.is-user {
  align-self: flex-end;
  flex-direction: row-reverse;
}
.msg-row.is-ai {
  align-self: flex-start;
}
.msg-av {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-family: 'Poppins', Arial, sans-serif;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  background: #b0aea5;
}
.is-ai .msg-av { background: #d97757; }
.is-user .msg-av { background: #6a9bcc; }

.msg-bub {
  font-family: 'Lora', Georgia, serif;
  font-size: 13.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  padding: 9px 12px;
  border-radius: 14px;
}
.bub-ai {
  color: #141413;
  background: #ffffff;
  border: 1px solid #ece9e0;
  border-radius: 4px 16px 16px 16px;
}
.bub-user {
  color: #fff;
  background: #d97757;
  border-radius: 16px 4px 16px 16px;
}
[data-theme="dark"] .bub-ai { color: #f5f3ee; background: #26241f; border-color: #33302a; }
[data-theme="dark"] .bub-user { background: #c45f3e; }

.chat-err {
  font-family: 'Lora', Georgia, serif;
  font-size: 12.5px;
  color: #d97757;
  text-align: center;
}

/* ---------- 底部输入栏 ---------- */
.chat-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: #faf9f5;
  border-top: 1px solid #e8e6dc;
  flex-shrink: 0;
}
[data-theme="dark"] .chat-foot { background: #201f1c; border-color: #33302a; }
.chat-in {
  flex: 1;
  background: #ffffff;
  border: 1px solid #e8e6dc;
  border-radius: 999px;
  padding: 9px 14px;
  color: #141413;
  font-family: 'Lora', Georgia, serif;
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.chat-in::placeholder { color: #b0aea5; }
.chat-in:disabled { opacity: 0.6; }
[data-theme="dark"] .chat-in { background: #26241f; border-color: #33302a; color: #f5f3ee; }
.chat-in:focus { border-color: #d97757; box-shadow: 0 0 0 3px rgba(217,119,87,.14); }

.chat-send {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: none;
  background: #d97757;
  color: #fff;
  font-size: 18px;
  cursor: pointer;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  transition: filter 0.15s, transform 0.1s;
}
.chat-send:hover { filter: brightness(1.08); }
.chat-send:active { transform: scale(0.94); }
.chat-send.stop { background: #b0aea5; font-size: 13px; }

@media (max-width: 600px) {
  .ai-rig.expanded { width: calc(92vw - 16px); height: calc(82vh - 16px); }
  .ai-chat { width: 100%; height: 100%; left: 0; }
}
</style>
