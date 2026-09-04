<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { usePoll } from '@/composables/usePoll'
import { api } from '@/api'
import type { SearchItem, SignalMark, SignalResp } from '@/types/market'
import type { SignalCardState as Card } from '@/types/signal'
import { cl, fx, pc } from '@/utils/format'
import { useSignalStore } from '@/stores/signal'
import { useWatchlistStore } from '@/stores/watchlist'
import SignalCard from '@/components/SignalCard.vue'
import StockDetailModal from '@/components/StockDetailModal.vue'

/* 盘中监控（多只股票持久化网格版）。
   后端 /api/signal：以分时均价线为基准，用段式识别捕捉连续 |dev|>=阈值 的区段，
   段内极值即为异动点。段式逻辑修复了原 armed 状态机的 3 个 bug：
   末尾段丢失 / 方向反转不结束旧 armed / 极端行情阈值失控。 */

/* 卡片状态类型与渲染已下沉到 SignalCard.vue / types/signal.ts，
   本文件只负责：列表持久化、轮询刷新、异动提醒。 */

/* 监控列表：localStorage 持久化，最多 6 只（再多就分两行网格会挤） */
const MAX = 6
const cards = ref<Card[]>([])
const kw = ref('')
const suggestions = ref<SearchItem[]>([])
let searchTimer: number | undefined

/* 详情弹窗：点击卡片标题打开个股详情（K线 / 分时 / 财务）。
   原先模板里引用了 detailStock，但 script 中并未声明，
   导致类型检查失败且弹窗永远打不开。 */
const detailStock = ref<{ code: string; name: string; secid: string } | null>(null)
function openDetail(c: Card) {
  detailStock.value = { code: c.code, name: c.sig?.name || c.name, secid: '' }
}

/* ---------- 异动提醒（浏览器通知 + 页面 toast + 提示音） ----------
   P2-4：监控列表与提醒开关统一取自 Pinia store（自动持久化），
   页面不再直接读写 localStorage。 */
const sigStore = useSignalStore()
const wl = useWatchlistStore()
const { alertEnabled, alertMuted } = storeToRefs(sigStore)
const toasts = ref<{ id: number; up: boolean; title: string; body: string }[]>([])
let toastId = 0
let audioCtx: AudioContext | undefined

function setAlert(v: boolean) {
  sigStore.setAlert(v)
}
function setMute(v: boolean) {
  sigStore.setMuted(v)
}
/** 切换提醒：首次开启时申请浏览器通知权限（拒绝也不影响页面内 toast） */
function toggleAlert() {
  const nv = !alertEnabled.value
  if (nv && typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {})
  }
  setAlert(nv)
}
function toggleMute() {
  setMute(!alertMuted.value)
}

/** 盘中风控：仅交易时段轮询与提醒（周一~周五 9:30-11:30 / 13:00-15:00） */
function isMarketOpen(): boolean {
  const day = new Date().getDay()
  if (day === 0 || day === 6) return false
  const m = new Date().getHours() * 60 + new Date().getMinutes()
  return (m >= 570 && m <= 690) || (m >= 780 && m <= 900)
}

/** 异动事件唯一 key：代码 + 方向 + 时间 + 价格（价格随时间变动，足够区分不同段） */
function keyOf(code: string, type: 'H' | 'L', m: SignalMark): string {
  return `${code}|${type}|${m.t}|${m.price}`
}
function seedSeen(c: Card, sig: SignalResp) {
  sig.high.forEach((m) => c.seen.add(keyOf(c.code, 'H', m)))
  sig.low.forEach((m) => c.seen.add(keyOf(c.code, 'L', m)))
}
/** 收集本次新增的异动（同时写入 seen，避免重复提醒）；返回新事件列表 */
function collectNew(c: Card, sig: SignalResp): { type: 'up' | 'down'; m: SignalMark }[] {
  const out: { type: 'up' | 'down'; m: SignalMark }[] = []
  sig.high.forEach((m) => {
    const k = keyOf(c.code, 'H', m)
    if (!c.seen.has(k)) {
      c.seen.add(k)
      out.push({ type: 'up', m })
    }
  })
  sig.low.forEach((m) => {
    const k = keyOf(c.code, 'L', m)
    if (!c.seen.has(k)) {
      c.seen.add(k)
      out.push({ type: 'down', m })
    }
  })
  return out
}

/** 提示音：拉升高音、砸盘低音（WebAudio，无需音频文件） */
function beep(up: boolean) {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    audioCtx = audioCtx || new Ctx()
    const o = audioCtx.createOscillator()
    const g = audioCtx.createGain()
    o.connect(g)
    g.connect(audioCtx.destination)
    o.type = 'sine'
    o.frequency.value = up ? 880 : 440
    const t0 = audioCtx.currentTime
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28)
    o.start(t0)
    o.stop(t0 + 0.3)
  } catch {
    /* 浏览器不支持音频：静默忽略 */
  }
}

function fireAlert(type: 'up' | 'down', code: string, name: string, m: SignalMark) {
  const up = type === 'up'
  const title = `${up ? '▲ 拉升' : '▼ 砸盘'}提醒 · ${name}(${code})`
  const body = `${m.t} · ${fx(m.price)} · 偏离 ${up ? '+' : ''}${fx(m.dev, 2)}%${m.strong ? ' · 放量确认' : ''}`
  /* 1) 浏览器桌面通知 */
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      new Notification(title, { body, tag: `${code}${type}${m.t}` })
    } catch {
      /* 部分浏览器构造失败：忽略 */
    }
  }
  /* 2) 页面内 toast（右上角，6s 自动消失） */
  const id = ++toastId
  toasts.value.push({ id, up, title, body })
  window.setTimeout(() => {
    toasts.value = toasts.value.filter((x) => x.id !== id)
  }, 6000)
  /* 3) 提示音 */
  if (!alertMuted.value) beep(up)
}

function ensureCard(code: string, name: string): Card {
  let c = cards.value.find((x) => x.code === code)
  if (!c) {
    c = {
      code,
      name,
      sig: null,
      loading: false,
      error: '',
      pts: [],
      preClose: 0,
      showAllPoints: false,
      watched: wl.has(code),
      seen: new Set<string>()
    }
    cards.value.push(c)
  }
  return c
}

async function loadOne(code: string, name: string) {
  const c = ensureCard(code, name)
  c.loading = true
  c.error = ''
  try {
    const [m, s] = await Promise.all([api.minute(code), api.signal(code)])
    c.pts = m.points || []
    c.preClose = m.preClose
    const firstLoad = c.sig === null
    c.sig = s
    /* 新异动提醒：首次加载只建档（seed seen）不弹窗；之后出现的才算「新」 */
    if (firstLoad) seedSeen(c, s)
    else {
      const news = collectNew(c, s)
      if (alertEnabled.value) news.forEach((n) => fireAlert(n.type, c.code, c.name, n.m))
    }
    /* 图表重绘由 SignalCard 监听卡片数据变化自行触发（flush: post），
       父组件不再直接操作子组件内部的 canvas。 */
  } catch (e) {
    c.error = e instanceof Error ? e.message : '监控加载失败'
  } finally {
    c.loading = false
  }
}

/* 绘制分时图已随卡片下沉到 SignalCard.vue */

async function add(s: SearchItem) {
  if (cards.value.length >= MAX && !cards.value.some((x) => x.code === s.code)) return
  /* 持久化记录（先存以便刷新后还在） */
  sigStore.add({ code: s.code, name: s.name })
  kw.value = ''
  suggestions.value = []
  loadOne(s.code, s.name)
}

function remove(code: string) {
  const i = cards.value.findIndex((x) => x.code === code)
  if (i >= 0) cards.value.splice(i, 1)
  sigStore.remove(code)
}

async function onSearch() {
  const q = kw.value.trim()
  if (!q) {
    suggestions.value = []
    return
  }
  try {
    suggestions.value = (await api.search(q)).slice(0, 8)
  } catch {
    suggestions.value = []
  }
}

function onInput() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = window.setTimeout(onSearch, 300)
}

/** 是否处于盘外（用于页面提示，随每次轮询刷新） */
const paused = ref(false)
function refreshAll() {
  /* 盘外不轮询、不提醒（避免收盘后无效刷新与重复弹窗） */
  if (!isMarketOpen()) {
    paused.value = true
    return
  }
  paused.value = false
  cards.value.forEach((c) => loadOne(c.code, c.name))
}

/** 卡片内的自选 toggle —— 状态独立维护在 Card 上，与详情弹窗互不干扰 */
function toggleWatchCard(c: Card) {
  if (c.watched) {
    wl.remove(c.code)
    c.watched = false
  } else {
    wl.add({ code: c.code, name: c.name, secid: '' })
    c.watched = true
  }
}

onMounted(() => {
  /* 从 store 恢复监控列表，并立即加载一次（不论是否盘中，便于查看上次数据） */
  const stored = sigStore.items
  stored.forEach((s) => {
    const c = ensureCard(s.code, s.name)
    loadOne(c.code, c.name)
  })
})
/* 盘中每 10 秒刷一次（变化快，保证异动及时捕捉与提醒）。
   注意这是全站最大的请求放大器：N 张卡片 = 每轮 N 次上游请求，
   因此必须走 usePoll —— 页面切到后台时自动停，回到前台立即补一次。 */
usePoll(refreshAll, 10000)
onUnmounted(() => {
  if (searchTimer) clearTimeout(searchTimer)
})

/* 点位展开/收起：状态仍由父组件持有（要持久化语义一致），子组件只发事件 */
function togglePoints(code: string) {
  const c = cards.value.find((x) => x.code === code)
  if (c) c.showAllPoints = !c.showAllPoints
}
</script>

<template>
  <div>
    <div class="section-title">📡 盘中监控</div>
    <div class="muted" style="font-size: 12px; margin-bottom: 10px">
      以分时均价线为基准捕捉异动拉升 / 砸盘 · 已添加的股票刷新页面仍保留
    </div>

    <!-- 搜索区（一直显示） -->
    <div class="pg-tools">
      <span class="lbl">添加</span>
      <input
        v-model="kw"
        class="kw-input"
        type="text"
        placeholder="输入代码或名称搜索…"
        @input="onInput"
        @keyup.enter="onSearch"
      />
      <button class="btn sm" @click="onSearch">🔍 搜索</button>
      <button v-if="cards.length" class="btn sm ghost" @click="refreshAll">⟳ 刷新全部</button>
      <button
        class="btn sm ghost"
        :class="{ on: alertEnabled }"
        :title="alertEnabled ? '异动提醒已开启（弹窗+通知+提示音）' : '开启后拉升/砸盘将及时提醒'"
        @click="toggleAlert"
      >
        {{ alertEnabled ? '🔔 提醒开' : '🔕 提醒关' }}
      </button>
      <button
        v-if="alertEnabled"
        class="btn sm ghost"
        :title="alertMuted ? '取消静音' : '静音提示音'"
        @click="toggleMute"
      >
        {{ alertMuted ? '🔇' : '🔊' }}
      </button>
      <span class="muted" style="font-size: 11px">
        已添加 {{ cards.length }} / {{ MAX }}
      </span>
    </div>

    <div v-if="paused" class="muted" style="font-size: 12px; margin-bottom: 8px">
      ⏸ 当前为非交易时段，已暂停轮询与异动提醒；开盘后将自动恢复
    </div>

    <!-- 搜索结果：放大、更明显，禁用表格方框 -->
    <div v-if="suggestions.length" class="sug-box">
      <div
        v-for="s in suggestions"
        :key="s.code"
        class="sug-item"
        @click="add(s)"
      >
        <span class="sug-name">{{ s.name }}</span>
        <span class="sug-code">{{ s.code }}</span>
        <span class="sug-mkt">{{ s.mkt }}</span>
        <span :class="cl(s.pct)" class="sug-pct">{{ pc(s.pct) }}</span>
      </div>
    </div>

    <!-- 监控网格：左右并排，每只占 1/2，整体缩小一半 -->
    <div v-if="!cards.length" class="empty" style="margin-top: 20px">
      搜索添加股票开始监控 · 已添加的会自动持久化在浏览器
    </div>

    <div class="sig-grid">
      <SignalCard
        v-for="c in cards"
        :key="c.code"
        :card="c"
        @remove="remove"
        @open="openDetail"
        @toggle-watch="toggleWatchCard"
        @toggle-points="togglePoints"
      />
    </div>

    <StockDetailModal
      v-if="detailStock"
      :code="detailStock.code"
      :name="detailStock.name"
      :secid="detailStock.secid"
      @close="detailStock = null"
    />

    <!-- 异动提醒 toast（右上角，拉升红 / 砸盘绿） -->
    <div class="alert-toasts">
      <transition-group name="toast">
        <div v-for="t in toasts" :key="t.id" class="alert-toast" :class="t.up ? 'up' : 'down'">
          <div class="at-title">{{ t.title }}</div>
          <div class="at-body">{{ t.body }}</div>
        </div>
      </transition-group>
    </div>
  </div>
</template>

<style scoped>
/* 搜索框与下拉结果 */
/* 统一搜索框尺寸 350×40（与 css/style.css 的 .wl-input 一致） */
.kw-input {
  width: 350px;
  height: 40px;
  max-width: 100%;
  padding: 0 14px;
  border-radius: 12px;
  border: 1px solid var(--border2, #e3e8ef);
  background: var(--bg-input, transparent);
  color: var(--text, inherit);
  font-size: 14px;
  outline: none;
  box-sizing: border-box;
  transition: 0.15s;
}
.kw-input:focus {
  border-color: var(--accent, var(--primary));
  box-shadow: 0 0 0 3px var(--accent-soft, rgba(13, 71, 161, 0.12));
}
/* 下拉浮在下方监控卡片之上 */
.sug-box {
  position: relative;
  z-index: 30;
  border-radius: 10px;
  margin-bottom: 12px;
  overflow: hidden;
  background: linear-gradient(135deg, rgba(13, 71, 161, 0.08), rgba(25, 118, 210, 0.05));
  border: 1px solid rgba(13, 71, 161, 0.15);
}
.sug-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
  transition: background 0.12s;
}
.sug-item:hover {
  background: rgba(255, 255, 255, 0.6);
}
.sug-name {
  font-weight: 700;
}
.sug-code {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--muted);
}
.sug-mkt {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(13, 71, 161, 0.1);
  color: var(--primary);
}
.sug-pct {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 13px;
}

/* 监控网格：左右并排，每只占 1/2，整体缩小 */
.sig-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
@media (max-width: 720px) {
  .sig-grid {
    grid-template-columns: 1fr;
  }
}
/* 提醒开关高亮（与 nav .on 同色系） */
.btn.sm.ghost.on {
  border-color: #0d47a1;
  color: var(--primary);
  background: rgba(13, 71, 161, 0.08);
}

/* 卡片头部实时拉升/砸盘角标 */
/* 异动提醒 toast（右上角固定） */
.alert-toasts {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 300;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 320px;
}
.alert-toast {
  padding: 10px 14px;
  border-radius: 10px;
  color: #fff;
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.22);
  border-left: 4px solid rgba(255, 255, 255, 0.6);
}
.alert-toast.up {
  background: var(--up);
}
.alert-toast.down {
  background: linear-gradient(135deg, #43a047, #2e7d32);
}
.at-title {
  font-size: 13px;
  font-weight: 700;
  margin-bottom: 3px;
}
.at-body {
  font-size: 12.5px;
  opacity: 0.95;
  font-family: var(--font-mono);
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.3s, transform 0.3s;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(20px);
}
</style>