<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { api } from '@/api'
import type { MarketIndex } from '@/types/market'
import { cl, fx, pc, sg } from '@/utils/format'
import StockDetailModal from './StockDetailModal.vue'

/* 港股行情（对应旧版 renderHK / loadHK）。
   分组与后端 HK_GROUPS 一一对应：前四个是固定成分（ulist 批量查），
   后三个是实时榜单（clist 取当日）。后端读 g 参数，见 api.hkIndex。 */
const GROUPS: [string, string][] = [
  ['index', '主要指数'],
  ['mainboard', '主板蓝筹'],
  ['hsblue', '恒生科技'],
  ['etf', 'ETF'],
  ['hot', '成交额榜'],
  ['gain', '涨幅榜'],
  ['gem', '创业板']
]

const group = ref('index')
const rows = ref<MarketIndex[]>([])
const label = ref('')
const loading = ref(true)
const error = ref('')
const detailStock = ref<{ code: string; name: string; secid: string } | null>(null)

let timer: number | undefined

async function load() {
  loading.value = true
  try {
    const r = await api.hkIndex(group.value)
    rows.value = r.list || []
    label.value = r.label || ''
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : '港股数据加载失败'
  } finally {
    loading.value = false
  }
}

function openDetail(r: MarketIndex) {
  detailStock.value = { code: r.code, name: r.name, secid: r.secid }
}

onMounted(() => {
  load()
  timer = window.setInterval(load, 30000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
watch(group, load)
</script>

<template>
  <div>
    <div class="section-title">🇭🇰 港股行情</div>
    <div class="muted" style="font-size: 13px; margin-bottom: 12px">
      恒生指数 / 主板蓝筹 / 恒生科技 / ETF 及实时榜单 · 每 30 秒自动刷新，点击行查看详情
    </div>

    <div v-if="error" class="err-banner">
      <span>{{ error }}</span>
      <button @click="load">重试</button>
    </div>

    <div class="pg-tools">
      <span class="lbl">分组</span>
      <div class="seg">
        <button v-for="g in GROUPS" :key="g[0]" :class="{ on: group === g[0] }" @click="group = g[0]">
          {{ g[1] }}
        </button>
      </div>
    </div>

    <div class="muted" style="font-size: 12px; margin-bottom: 8px">
      {{ label }} · 共 {{ rows.length }} 只 · 数据来源：东方财富
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
            <th>成交额</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!rows.length">
            <td colspan="6">
              <div class="empty">{{ loading ? '加载中…' : '暂无数据' }}</div>
            </td>
          </tr>
          <tr v-for="(s, i) in rows" :key="s.secid || s.code" @click="openDetail(s)">
            <td data-label="排名" class="muted">{{ i + 1 }}</td>
            <td data-label="代码/名称">
              <span class="c-name">{{ s.name }}</span>
              <span class="c-code">{{ s.code }}</span>
            </td>
            <td data-label="现价">{{ fx(s.price) }}</td>
            <td data-label="涨跌幅" :class="cl(s.pct)">{{ pc(s.pct) }}</td>
            <td data-label="涨跌额" :class="cl(s.change)">{{ sg(s.change) }}{{ fx(s.change) }}</td>
            <td data-label="成交额">{{ s.amount == null ? '—' : fx(s.amount) + '亿' }}</td>
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
