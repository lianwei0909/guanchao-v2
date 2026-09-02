<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { api } from '@/api'
import type { MarketIndex, UsSectorRow } from '@/types/market'
import { cl, fx, pc, sg } from '@/utils/format'
import StockDetailModal from './StockDetailModal.vue'

/* 美股行情（对应旧版 renderUS / loadUS）。
   板块分组与后端 US_GROUPS 一致；个股 secid 前缀 105（东财美股市场码）。 */
const GROUPS: [string, string][] = [
  ['tech', '科技巨头'],
  ['chip', '半导体'],
  ['china', '中概股'],
  ['etf', 'ETF / 指数'],
  ['finance', '金融'],
  ['medical', '医疗健康'],
  ['ev', '电动车 / 新能源'],
  ['retail', '消费 / 零售'],
  ['comm', '通信 / 媒体'],
  ['energy', '能源 / 工业'],
  ['industrial', '工业制造'],
  ['consumer', '消费日常'],
  ['reit', 'REITs']
]

const group = ref('tech')
const rows = ref<UsSectorRow[]>([])
const indices = ref<MarketIndex[]>([])
const label = ref('')
const loading = ref(true)
const error = ref('')
const detailStock = ref<{ code: string; name: string; secid: string } | null>(null)

let timer: number | undefined

async function load() {
  loading.value = true
  try {
    const r = await api.usSector(group.value)
    rows.value = r.list || []
    label.value = r.label || ''
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : '美股数据加载失败'
  } finally {
    loading.value = false
  }
}

/* 三大指数单独取，变化慢，60 秒一次即可 */
async function loadIndices() {
  try {
    indices.value = await api.usIndex()
  } catch {
    /* 指数失败不影响板块表格 */
  }
}

function openDetail(r: UsSectorRow) {
  detailStock.value = { code: r.code, name: r.name, secid: r.secid }
}

/** 无报价的行（该时段未开盘）排在最后 */
const sorted = computed(() =>
  rows.value.slice().sort((a, b) => {
    if (a.price == null && b.price == null) return 0
    if (a.price == null) return 1
    if (b.price == null) return -1
    return 0
  })
)

onMounted(() => {
  load()
  loadIndices()
  timer = window.setInterval(() => {
    load()
    if (Math.round(Date.now() / 1000) % 60 < 15) loadIndices()
  }, 30000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
watch(group, load)
</script>

<template>
  <div>
    <div class="section-title">🇺🇸 美股行情</div>
    <div class="muted" style="font-size: 13px; margin-bottom: 12px">
      科技 / 半导体 / 中概 / ETF 等 13 个板块 · 每 30 秒自动刷新，点击行查看详情
    </div>

    <!-- 三大指数 -->
    <div v-if="indices.length" class="kpi-row">
      <div v-for="x in indices" :key="x.secid" class="kpi">
        <div class="kpi-l">{{ x.name }}</div>
        <div class="kpi-v" :class="cl(x.pct)">{{ fx(x.price) }}</div>
        <div class="kpi-s" :class="cl(x.pct)">{{ pc(x.pct) }}</div>
      </div>
    </div>

    <div v-if="error" class="err-banner">
      <span>{{ error }}</span>
      <button @click="load">重试</button>
    </div>

    <div class="pg-tools">
      <span class="lbl">板块</span>
      <div class="seg">
        <button v-for="g in GROUPS" :key="g[0]" :class="{ on: group === g[0] }" @click="group = g[0]">
          {{ g[1] }}
        </button>
      </div>
    </div>

    <div class="muted" style="font-size: 12px; margin-bottom: 8px">
      {{ label }} · 共 {{ rows.length }} 只 · 市值单位亿美元 · 数据来源：东方财富
    </div>

    <div class="tbl-wrap">
      <table class="tbl">
        <thead>
          <tr>
            <th>排名</th>
            <th>代码 / 名称</th>
            <th>现价</th>
            <th>涨跌幅</th>
            <th>涨跌额</th>
            <th>总市值</th>
            <th>市盈率</th>
            <th>市净率</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!rows.length">
            <td colspan="8">
              <div class="empty">{{ loading ? '加载中…' : '暂无数据' }}</div>
            </td>
          </tr>
          <tr v-for="(s, i) in sorted" :key="s.code" @click="openDetail(s)">
            <td data-label="排名" class="muted">{{ i + 1 }}</td>
            <td data-label="代码/名称">
              <span class="c-name">{{ s.name }}</span>
              <span class="c-code">{{ s.code }}</span>
            </td>
            <td data-label="现价">{{ s.price == null ? '—' : fx(s.price) }}</td>
            <td data-label="涨跌幅" :class="cl(s.pct)">{{ pc(s.pct) }}</td>
            <td data-label="涨跌额" :class="cl(s.change)">{{ sg(s.change) }}{{ fx(s.change) }}</td>
            <td data-label="总市值">{{ s.mktcap == null ? '—' : fx(s.mktcap, 0) }}</td>
            <td data-label="市盈率">{{ s.pe == null ? '—' : fx(s.pe) }}</td>
            <td data-label="市净率">{{ s.pb == null ? '—' : fx(s.pb) }}</td>
          </tr>
        </tbody>
      </table>
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
