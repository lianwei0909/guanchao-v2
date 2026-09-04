<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { api } from '@/api'
import type { IndexQuote } from '@/types/market'
import { cl, fx, pc } from '@/utils/format'
import { usePoll } from '@/composables/usePoll'

/* 顶部指数滚动播放条（迁移自旧版 #idxTicker / loadTicker）。
   用 /indices（不传 scope）拿到全市场一篮子核心指数（A股 + 港股 + 全球），
   复制一份后配合 CSS translateX(-50%) 实现无缝循环。
   数值原地更新，避免刷新时滚动动画跳回原点。 */
const rows = ref<IndexQuote[]>([])
const trackRef = ref<HTMLElement | null>(null)

/* 右上角实时时钟 + 盘中/收盘状态（迁移自旧版 topClock / mktStatus）。
   交易时段判断：周一至周五 9:30-11:30 / 13:00-15:00；盘中绿色常亮光点，否则暖黄。 */
const clock = ref('')
const mktStatus = ref('')
const mktLive = ref(false)   // true=盘中（绿点），false=收盘/休市（暖黄点）
function pad(n: number) {
  return String(n).padStart(2, '0')
}
function tickClock() {
  const d = new Date()
  clock.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const day = d.getDay()
  const m = d.getHours() * 60 + d.getMinutes()
  const open = day >= 1 && day <= 5 && ((m >= 570 && m <= 690) || (m >= 780 && m <= 900))
  mktLive.value = open
  // 状态文本：休市 / 未开盘 / 盘中 / 午间休市 / 已收盘（按用户需求重点是「盘中 / 收盘」）
  if (day === 0 || day === 6) mktStatus.value = '休市'
  else if (open) mktStatus.value = '盘中'
  else if (m < 570) mktStatus.value = '未开盘'
  else if (m > 900) mktStatus.value = '收盘'
  else mktStatus.value = '午间休市'
}

async function load() {
  try {
    const data = await api.indices()
    if (!data || !data.length) return
    if (!rows.value.length) {
      rows.value = data
    } else {
      /* 原地更新，元素不重建，CSS 动画位置保持不变 */
      data.forEach((d, i) => {
        const t = rows.value[i]
        if (t) Object.assign(t, d)
      })
    }
  } catch {
    /* 失败不打断滚动，保留上一次数据 */
  }
}

/** 按内容宽度换算时长，保持约 55px/s 匀速（与旧版一致） */
function setDur() {
  const el = trackRef.value
  if (!el) return
  const w = el.scrollWidth / 2 || rows.value.length * 220
  el.style.setProperty('--it-dur', Math.max(24, Math.round(w / 55)) + 's')
}

const doubled = computed(() => (rows.value.length ? [...rows.value, ...rows.value] : []))

watch(rows, () => nextTick(setDur), { flush: 'post' })

/* 行情 30s 一轮、时钟每秒走字；两者都在页面隐藏时自动暂停、卸载自动清理 */
usePoll(load, 30000)
usePoll(tickClock, 1000)
</script>

<template>
  <div class="idx-ticker">
    <span class="it-logo">指数</span>
    <div class="it-view">
      <div v-if="!rows.length" class="it-loading">加载指数中…</div>
      <div v-else ref="trackRef" class="it-track">
        <span v-for="(x, i) in doubled" :key="i" class="it-item">
          <span class="it-n">{{ x.name }}</span>
          <span class="it-p">{{ fx(x.price) }}</span>
          <span class="it-c" :class="cl(x.pct)">{{ pc(x.pct) }}</span>
        </span>
      </div>
    </div>

    <!-- 右上角：实时时钟 + 盘中/收盘状态徽章（盘中绿点常亮，收盘暖黄常亮） -->
    <div class="top-clock">
      <span class="clock-text">{{ clock }}</span>
      <span class="mkt-badge">
        <span class="live" :class="mktLive ? 'on' : 'off'"></span>
        <span class="mkt-text">{{ mktStatus }}</span>
      </span>
    </div>
  </div>
</template>
