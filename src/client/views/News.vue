<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { api } from '@/api'
import type { NewsItem } from '@/types/market'

/* 股票快讯（对应旧版 renderNews / loadNews）。
   分类 + 来源过滤均由服务端完成（三源并行抓取后统一过滤），前端只负责渲染。 */
const TABS: [string, string][] = [
  ['all', '全部'],
  ['a', 'A股'],
  ['hk', '港股'],
  ['us', '美股'],
  ['alert', '异动']
]
const SRCS: [string, string][] = [
  ['all', '全部来源'],
  ['东方财富', '东方财富'],
  ['同花顺', '同花顺'],
  ['新浪财经', '新浪']
]

const tab = ref('all')
const src = ref('all')
const rows = ref<NewsItem[]>([])
const loading = ref(true)
const error = ref('')

const srcKey = (s: string) => (s === '同花顺' ? 'ths' : s === '新浪财经' ? 'sina' : 'em')

/* 注意：三源返回的时间格式并不统一 ——
   有的带时区（2026-09-02T08:03:59.000Z），有的不带（2026-09-02T16:50:12）。
   一律 replace 成斜杠会把带 Z 的串解析错，这里优先用原生 ISO 解析，失败再兜底。 */
function parseDate(iso: string): Date | null {
  const d1 = new Date(iso)
  if (!isNaN(d1.getTime())) return d1
  const d2 = new Date(String(iso).replace(/-/g, '/').replace('T', ' '))
  return isNaN(d2.getTime()) ? null : d2
}

/** ISO 时间串 → 绝对时间 + 相对时间 */
function nwTime(iso?: string) {
  const full = String(iso || '').replace('T', ' ')
  if (!iso) return { abs: '--', rel: '', full }
  const d = parseDate(iso)
  if (!d) return { abs: '--', rel: '', full }
  const now = new Date()
  const pad = (v: number) => ('0' + v).slice(-2)
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes())
  const d0 = d.toDateString()
  const n0 = now.toDateString()
  const y = new Date(now.getTime() - 86400000).toDateString()
  const abs =
    d0 === n0
      ? hm
      : d0 === y
        ? '昨天 ' + hm
        : pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + hm
  const m = Math.floor((now.getTime() - d.getTime()) / 60000)
  const rel =
    m < 1
      ? '刚刚'
      : m < 60
        ? m + ' 分钟前'
        : m < 1440
          ? Math.floor(m / 60) + ' 小时前'
          : Math.floor(m / 1440) + ' 天前'
  return { abs, rel, full }
}

/** 时间串 → 时间戳（解析失败返回 0） */
function toTs(iso?: string): number {
  if (!iso) return 0
  const d = parseDate(iso)
  return d ? d.getTime() : 0
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const d = await api.news(tab.value, src.value)
    /* 强制按时间倒序：最新的一条排在最上面 */
    rows.value = (d?.list || []).slice().sort((a, b) => toTs(b.time) - toTs(a.time))
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    loading.value = false
  }
}

let timer: number | undefined
onMounted(() => {
  load()
  timer = window.setInterval(load, 60000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
watch([tab, src], load)
</script>

<template>
  <div>
    <div class="section-title">📰 股票快讯 · 多渠道</div>
    <div class="muted" style="font-size: 13px; margin-bottom: 12px">
      东方财富 · 同花顺 · 新浪 三源聚合，实时滚动更新
    </div>

    <div class="pg-tools">
      <span class="lbl">分类</span>
      <div class="seg">
        <button
          v-for="t in TABS"
          :key="t[0]"
          :class="{ on: tab === t[0] }"
          @click="tab = t[0]"
        >
          {{ t[1] }}
        </button>
      </div>
    </div>
    <div class="pg-tools">
      <span class="lbl">来源</span>
      <div class="seg">
        <button
          v-for="s in SRCS"
          :key="s[0]"
          :class="{ on: src === s[0] }"
          @click="src = s[0]"
        >
          {{ s[1] }}
        </button>
      </div>
    </div>

    <div v-if="error" class="err-banner">
      <span>{{ error }}</span>
      <button @click="load">重试</button>
    </div>

    <div v-if="loading && !rows.length" class="empty">加载中…</div>
    <div v-else-if="!rows.length" class="empty">当前筛选下暂无快讯</div>
    <div
      v-else
      style="
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 14px;
        overflow: hidden;
      "
    >
      <!-- 港股 / 美股分类天然稀疏，数量过少时说明一下，避免误以为没加载 -->
      <div
        v-if="rows.length < 6 && (tab === 'hk' || tab === 'us')"
        class="empty"
        style="padding: 8px 12px; font-size: 12.5px"
      >
        该分类快讯本身较少（已聚合 东方财富 / 同花顺 / 新浪 三源），以上为当前全部命中
      </div>

      <a
        v-for="(n, i) in rows"
        :key="i"
        class="nw-item"
        :href="n.url || '#'"
        target="_blank"
        rel="noopener"
        :title="nwTime(n.time).full"
      >
        <div class="nw-meta">
          <span class="nw-time">{{ nwTime(n.time).abs }}</span>
          <span class="nw-rel">{{ nwTime(n.time).rel }}</span>
          <span v-if="n.tag" class="nw-tag">{{ n.tag }}</span>
          <span
            v-for="(s, j) in n.sources && n.sources.length ? n.sources : [n.source || '']"
            :key="j"
            class="nw-src"
            :class="'s-' + srcKey(s)"
            >{{ s }}</span
          >
        </div>
        <span class="nw-title">{{ n.title }}</span>
        <div v-if="n.summary" class="nw-sum">{{ n.summary }}</div>
      </a>
    </div>
  </div>
</template>
