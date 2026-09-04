<script setup lang="ts">
import { computed, ref } from 'vue'
import { api } from '@/api'
import type { DarkRow } from '@/types/market'
import { cl, fx, pc, yi } from '@/utils/format'
import { usePoll } from '@/composables/usePoll'
import StockDetailModal from '@/components/StockDetailModal.vue'

/* 暗盘监控（对应旧版 renderDark / loadDark）。
   数据为 A股大宗交易（盘后协议转让），非港股 IPO 暗盘。
   KPI 与两个分析面板始终基于全量统计，不随筛选变化 —— 保持监控视角稳定。 */
const FILTERS: [string, string][] = [
  ['all', '全部'],
  ['prem', '溢价'],
  ['disc', '折价'],
  ['flat', '平价']
]
const SORTS: [string, string][] = [
  ['amount', '成交额'],
  ['premium', '溢价率'],
  ['volume', '成交量']
]

const filter = ref('all')
const sortKey = ref('amount')
const rows = ref<DarkRow[]>([])
const date = ref('')
/** 可选交易日（降序）。selDate 为空表示自动取最新交易日 */
const dates = ref<string[]>([])
const selDate = ref('')
const loading = ref(true)
const error = ref('')
const detailStock = ref<{ code: string; name: string; secid: string } | null>(null)


/* KPI 概览（基于全量） */
const kpi = computed(() => {
  const r = rows.value
  const n = r.length
  const tot = r.reduce((a, b) => a + (b.amount || 0), 0)
  const premN = r.filter((x) => x.premium > 0).length
  const discN = r.filter((x) => x.premium < 0).length
  const eqN = n - premN - discN
  const avg = n ? r.reduce((a, b) => a + b.premium, 0) / n : 0
  const maxP = n ? Math.max(...r.map((x) => x.premium)) : 0
  const minP = n ? Math.min(...r.map((x) => x.premium)) : 0
  return { tot, premN, discN, eqN, avg, maxP, minP }
})

/* 主表数据：先筛选再排序（KPI 不受影响） */
const view = computed(() => {
  const v = rows.value.filter((x) => {
    if (filter.value === 'prem') return x.premium > 0
    if (filter.value === 'disc') return x.premium < 0
    if (filter.value === 'flat') return x.premium === 0
    return true
  })
  return v.slice().sort((a, b) => {
    if (sortKey.value === 'amount') return (b.amount || 0) - (a.amount || 0)
    if (sortKey.value === 'premium') return b.premium - a.premium
    return (b.volume || 0) - (a.volume || 0)
  })
})

/* 机构席位：按成交额聚合，买卖各取 TOP6 */
const seats = computed(() => {
  const buyMap: Record<string, number> = {}
  const sellMap: Record<string, number> = {}
  rows.value.forEach((r) => {
    if (r.buyer) buyMap[r.buyer] = (buyMap[r.buyer] || 0) + (r.amount || 0)
    if (r.seller) sellMap[r.seller] = (sellMap[r.seller] || 0) + (r.amount || 0)
  })
  const top = (m: Record<string, number>) =>
    Object.keys(m)
      .sort((a, b) => m[b] - m[a])
      .slice(0, 6)
      .map((n) => ({ n, v: m[n] }))
  const buy = top(buyMap)
  const sell = top(sellMap)
  return { buy, sell, maxBuy: buy.length ? buy[0].v : 1, maxSell: sell.length ? sell[0].v : 1 }
})

async function load() {
  try {
    const d = await api.dark(selDate.value || undefined)
    date.value = d?.date || ''
    dates.value = d?.dates || []
    rows.value = d?.list || []
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    loading.value = false
  }
}

/** 切换交易日；传空串回到「最新」 */
function pickDate(d: string) {
  selDate.value = d
  load()
}

function openDetail(r: DarkRow) {
  detailStock.value = { code: r.code, name: r.name, secid: r.secid }
}

/* 轮询收敛到 usePoll：卸载自动清理 + 页面隐藏时暂停 */
usePoll(load, 30000)
</script>

<template>
  <div>
    <div class="section-title">🌑 暗盘监控</div>
    <div class="muted" style="font-size: 13px; margin-bottom: 12px">
      A股大宗交易盘后协议转让 · 折溢价分布、买卖席位、成交明细，反映机构与大资金动向
    </div>
    <div v-if="error" class="err-banner">
      <span>{{ error }}</span>
      <button @click="load">重试</button>
    </div>

    <!-- 交易日选择：可直接输入任意日期，或点近期交易日快捷切换 -->
    <div class="pg-tools">
      <span class="lbl">交易日</span>
      <input
        v-model="selDate"
        type="date"
        class="wl-input"
        style="max-width: 160px"
        @change="load"
      />
      <div class="seg">
        <button :class="{ on: !selDate }" @click="pickDate('')">最新</button>
        <button
          v-for="d in dates"
          :key="d"
          :class="{ on: selDate === d }"
          @click="pickDate(d)"
        >
          {{ d.slice(5) }}
        </button>
      </div>
    </div>

    <div class="pg-tools">
      <span class="lbl">筛选</span>
      <div class="seg">
        <button
          v-for="f in FILTERS"
          :key="f[0]"
          :class="{ on: filter === f[0] }"
          @click="filter = f[0]"
        >
          {{ f[1] }}
        </button>
      </div>
      <span class="lbl" style="margin-left: 12px">排序</span>
      <div class="seg">
        <button
          v-for="s in SORTS"
          :key="s[0]"
          :class="{ on: sortKey === s[0] }"
          @click="sortKey = s[0]"
        >
          {{ s[1] }}
        </button>
      </div>
    </div>

    <!-- KPI 概览（全量） -->
    <div v-if="rows.length" class="kpi-row">
      <div class="kpi">
        <div class="kpi-l">交易日</div>
        <div class="kpi-v" style="font-size: 18px">{{ date || '--' }}</div>
      </div>
      <div class="kpi">
        <div class="kpi-l">成交笔数</div>
        <div class="kpi-v">{{ rows.length }} 笔</div>
        <div class="kpi-s">溢价{{ kpi.premN }} / 平价{{ kpi.eqN }} / 折价{{ kpi.discN }}</div>
      </div>
      <div class="kpi">
        <div class="kpi-l">合计成交额</div>
        <div class="kpi-v">{{ yi(kpi.tot) }}</div>
      </div>
      <div class="kpi">
        <div class="kpi-l">最高溢价</div>
        <div class="kpi-v up">{{ pc(kpi.maxP) }}</div>
      </div>
      <div class="kpi">
        <div class="kpi-l">最大折价</div>
        <div class="kpi-v down">{{ pc(kpi.minP) }}</div>
      </div>
      <div class="kpi">
        <div class="kpi-l">平均溢价率</div>
        <div class="kpi-v" :class="cl(kpi.avg)">{{ pc(kpi.avg) }}</div>
      </div>
    </div>

    <!-- 折溢价分布（全量，置于主表数据上方） -->
    <div v-if="rows.length" class="panel" style="margin: 12px 0">
      <div class="section-title ov-st" style="margin: 0 0 8px; text-align: left">📐 折溢价分布</div>
      <div class="ov-breadth" style="margin-bottom: 8px">
        <div class="ov-b-up" :style="{ width: (kpi.premN / Math.max(kpi.premN, kpi.discN, kpi.eqN, 1)) * 100 + '%' }"></div>
        <div class="ov-b-flat" :style="{ width: (kpi.eqN / Math.max(kpi.premN, kpi.discN, kpi.eqN, 1)) * 100 + '%' }"></div>
        <div class="ov-b-down" :style="{ width: (kpi.discN / Math.max(kpi.premN, kpi.discN, kpi.eqN, 1)) * 100 + '%' }"></div>
      </div>
      <div class="kpi-row" style="margin-bottom: 0">
        <div class="kpi">
          <div class="kpi-l">溢价成交</div>
          <div class="kpi-v up">{{ kpi.premN }} 笔</div>
        </div>
        <div class="kpi">
          <div class="kpi-l">平价</div>
          <div class="kpi-v flat">{{ kpi.eqN }} 笔</div>
        </div>
        <div class="kpi">
          <div class="kpi-l">折价成交</div>
          <div class="kpi-v down">{{ kpi.discN }} 笔</div>
        </div>
        <div class="kpi">
          <div class="kpi-l">平均溢价率</div>
          <div class="kpi-v" :class="cl(kpi.avg)">{{ pc(kpi.avg) }}</div>
        </div>
      </div>
    </div>

    <!-- 机构席位统计（全量，置于主表数据上方） -->
    <div v-if="rows.length" class="panel" style="margin: 12px 0">
      <div class="section-title ov-st" style="margin: 0 0 8px; text-align: left">
        🏢 机构席位统计（买方 TOP / 卖方 TOP）
      </div>
      <div class="yz-rank-grid">
        <div class="yz-rank">
          <div class="yz-rank-h">买方席位 TOP（按成交额）</div>
          <div class="yz-rank-list">
            <div v-if="!seats.buy.length" class="empty">暂无</div>
            <div v-for="b in seats.buy" :key="b.n" class="rb">
              <span class="rb-name">{{ b.n }}</span>
              <span class="rb-track">
                <span class="rb-fill up" :style="{ width: Math.round((b.v / seats.maxBuy) * 100) + '%' }"></span>
              </span>
              <span class="rb-val up">{{ yi(b.v) }}</span>
            </div>
          </div>
        </div>
        <div class="yz-rank">
          <div class="yz-rank-h">卖方席位 TOP（按成交额）</div>
          <div class="yz-rank-list">
            <div v-if="!seats.sell.length" class="empty">暂无</div>
            <div v-for="s in seats.sell" :key="s.n" class="rb">
              <span class="rb-name">{{ s.n }}</span>
              <span class="rb-track">
                <span class="rb-fill down" :style="{ width: Math.round((s.v / seats.maxSell) * 100) + '%' }"></span>
              </span>
              <span class="rb-val down">{{ yi(s.v) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 主表 -->
    <div class="tbl-wrap">
      <table class="tbl">
        <thead>
          <tr>
            <th>排名</th>
            <th>代码 / 名称</th>
            <th>成交价</th>
            <th>收盘价</th>
            <th>溢价率</th>
            <th>成交量</th>
            <th>成交额</th>
            <th>买方席位</th>
            <th>卖方席位</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!view.length">
            <td colspan="9">
              <div class="empty">
                {{ loading ? '加载中…' : rows.length ? '当前筛选条件下暂无数据' : '暂无数据' }}
              </div>
            </td>
          </tr>
          <tr v-for="(s, i) in view" :key="s.code + i" @click="openDetail(s)">
            <td data-label="排名" class="muted">{{ i + 1 }}</td>
            <td data-label="代码/名称">
              <span class="c-name">{{ s.name }}</span>
              <span class="c-code">{{ s.code }}</span>
            </td>
            <td data-label="成交价">{{ fx(s.price) }}</td>
            <td data-label="收盘价" class="muted">{{ fx(s.close) }}</td>
            <td data-label="溢价率" :class="cl(s.premium)">{{ pc(s.premium) }}</td>
            <td data-label="成交量">{{ fx(s.volume, 2) }}万股</td>
            <td data-label="成交额">{{ yi(s.amount) }}</td>
            <td
              data-label="买方席位"
              style="max-width: 200px; overflow: hidden; text-overflow: ellipsis"
              :title="s.buyer || ''"
            >
              {{ s.buyer || '--' }}
            </td>
            <td
              data-label="卖方席位"
              style="max-width: 200px; overflow: hidden; text-overflow: ellipsis"
              :title="s.seller || ''"
            >
              {{ s.seller || '--' }}
            </td>
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
