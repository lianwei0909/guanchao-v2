<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { api } from '@/api'
import type { Quote, SearchItem, WatchItem } from '@/types/market'
import { useWatchlistStore } from '@/stores/watchlist'
import { cl, fx, pc, sg, marketLabel } from '@/utils/format'
import { usePoll } from '@/composables/usePoll'
import StockDetailModal from '@/components/StockDetailModal.vue'

/* 自选股（对应旧版 renderWatchlist）。
   数据来自 Pinia store：弹窗里加 / 删自选后，这里即时刷新，无需重进页面。 */
const wl = useWatchlistStore()
const { items: list } = storeToRefs(wl)
const quotes = ref<Record<string, Quote>>({})
const kw = ref('')
const suggest = ref<SearchItem[]>([])
const error = ref('')
const detailStock = ref<{ code: string; name: string; secid: string } | null>(null)

let searchTimer: number | undefined

async function refreshQuotes() {
  if (!list.value.length) {
    quotes.value = {}
    return
  }
  try {
    const rows = await api.quotes(list.value.map((x) => x.code))
    const map: Record<string, Quote> = {}
    rows.forEach((r) => {
      map[r.code] = r
    })
    quotes.value = map
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : '行情刷新失败'
  }
}

function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer)
  const q = kw.value.trim()
  if (!q) {
    suggest.value = []
    return
  }
  /* 简单防抖，避免每敲一个字都打接口 */
  searchTimer = window.setTimeout(async () => {
    try {
      suggest.value = await api.search(q)
    } catch {
      suggest.value = []
    }
  }, 250)
}

function openFromSearch(item: SearchItem) {
  /* 按你要求：搜索结果点击后先弹个股详情，要不要加自选由弹窗里的 ⭐ 决定 */
  detailStock.value = { code: item.code, name: item.name, secid: item.secid }
  kw.value = ''
  suggest.value = []
}

function remove(code: string) {
  wl.remove(code)
  refreshQuotes()
}

function openDetail(x: WatchItem) {
  detailStock.value = { code: x.code, name: x.name, secid: x.secid }
}

/* 轮询收敛到 usePoll：卸载自动清理 + 页面隐藏时暂停 */
usePoll(refreshQuotes, 10000)
onUnmounted(() => {
  if (searchTimer) clearTimeout(searchTimer)
})
</script>

<template>
  <div>
    <div class="section-title">⭐ 自选股</div>
    <div class="muted" style="font-size: 13px; margin-bottom: 12px">
      搜索代码或名称添加；点击卡片查看详情，行情每 10 秒自动刷新
    </div>

    <div v-if="error" class="err-banner">
      <span>{{ error }}</span>
      <button @click="refreshQuotes">重试</button>
    </div>

    <div class="pg-tools">
      <div class="wl-search">
        <input
          v-model="kw"
          class="wl-input"
          placeholder="搜索股票：代码 / 名称，如 600519 或 茅台"
          autocomplete="off"
          @input="onSearchInput"
        />
        <div v-if="suggest.length" class="wl-suggest">
          <div
            v-for="s in suggest"
            :key="s.code"
            class="wl-sug"
            @click="openFromSearch(s)"
          >
            <span class="wl-sug-name">{{ s.name }}</span>
            <span class="wl-sug-code">{{ s.code }}</span>
            <span class="wl-sug-type">{{ s.mkt }}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="wl-cards">
      <div v-if="!list.length" class="empty" style="grid-column: 1/-1">
        还没有自选股，搜索代码或名称添加吧～
      </div>
      <div
        v-for="x in list"
        :key="x.code"
        class="wl-card"
        :class="cl(quotes[x.code]?.pct)"
        @click="openDetail(x)"
      >
        <button class="wl-del" title="删除" @click.stop="remove(x.code)">×</button>
        <div class="wl-card-name">{{ x.name }}<span class="wl-card-mkt">（{{ marketLabel(x.code) }}）</span></div>
        <div class="wl-card-code">{{ x.code }}</div>
        <template v-if="quotes[x.code]">
          <div class="wl-card-price">{{ fx(quotes[x.code].price) }}</div>
          <div class="wl-card-chg" :class="cl(quotes[x.code].pct)">
            {{ sg(quotes[x.code].change) }}{{ fx(quotes[x.code].change) }}
            {{ pc(quotes[x.code].pct) }}
          </div>
          <div class="wl-card-meta">
            换手 {{ fx(quotes[x.code].turnover) }}% · 市值 {{ fx(quotes[x.code].mktcap, 0) }}亿
          </div>
        </template>
        <template v-else>
          <div class="wl-card-price muted">--</div>
          <div class="wl-card-chg muted">加载中…</div>
        </template>
      </div>
    </div>

    <StockDetailModal
      v-if="detailStock"
      :code="detailStock.code"
      :name="detailStock.name"
      :secid="detailStock.secid"
      @close="detailStock = null"
    />
  </div>
</template>
