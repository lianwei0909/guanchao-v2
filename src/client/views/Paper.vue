<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { api } from '@/api'
import type { PaperItem, Quote } from '@/types/market'
import { paper, paperAdd, paperDel } from '@/utils/paper'
import { cl, fx, pc, sg } from '@/utils/format'
import StockDetailModal from './StockDetailModal.vue'

/* 模拟持仓（对应旧版 renderPaper / loadPaper / loadPaperQuotes）。
   本地记录买入成本与数量，按现价实时计算浮动盈亏；数据只存浏览器，不上传。 */
const rows = ref<PaperItem[]>([])
const quotes = ref<Record<string, Quote>>({})
const code = ref('')
const hint = ref('名称自动带出 · 成本价取当前价 · 数量默认 100 股')
const error = ref('')
const detailStock = ref<{ code: string; name: string; secid: string } | null>(null)

let timer: number | undefined
/** 代码格式：A股6位 / 港股5位 / 美股字母（与 /api/search 白名单一致） */
const CODE_RE = /^(\d{6}|\d{5}|[A-Za-z][A-Za-z0-9.\-]{0,7})$/

/** 逐仓计算：市值 / 成本 / 浮动盈亏 / 收益率 */
const calcRows = computed(() =>
  rows.value.map((p) => {
    const q = quotes.value[p.code]
    const mv = q ? q.price * p.shares : 0
    const cost = p.cost * p.shares
    const pl = q ? mv - cost : 0
    const rate = cost > 0 ? (pl / cost) * 100 : 0
    return { p, q, mv, cost, pl, rate }
  })
)

const total = computed(() => {
  let mv = 0
  let cost = 0
  calcRows.value.forEach((r) => {
    if (r.q) {
      mv += r.mv
      cost += r.cost
    }
  })
  const pl = mv - cost
  return { mv, cost, pl, rate: cost > 0 ? (pl / cost) * 100 : 0 }
})

async function refreshQuotes() {
  if (!rows.value.length) {
    quotes.value = {}
    return
  }
  try {
    const qs = await api.quotes(rows.value.map((p) => p.code))
    const map: Record<string, Quote> = {}
    qs.forEach((q) => {
      map[q.code] = q
    })
    quotes.value = map
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : '持仓行情刷新失败'
  }
}

async function add() {
  const c = code.value.trim()
  if (!c) {
    hint.value = '请输入股票代码'
    return
  }
  if (!CODE_RE.test(c)) {
    hint.value = '代码格式不对：A股6位 / 港股5位 / 美股字母'
    return
  }
  hint.value = '正在查询 ' + c + ' …'
  try {
    const list = await api.search(c)
    /* search 可能返回多个市场同名代码，优先取与输入完全一致的那条 */
    const hit = list.find((x) => x.code === c) || list[0]
    if (!hit) {
      hint.value = '没查到这只股票，请确认代码'
      return
    }
    if (!(hit.price > 0)) {
      hint.value = '取不到现价，请稍后再试'
      return
    }
    rows.value = paperAdd({
      code: hit.code,
      name: hit.name || hit.code,
      secid: hit.secid || '',
      shares: 100,
      cost: hit.price
    })
    code.value = ''
    hint.value = '已建仓 ' + (hit.name || hit.code) + ' 成本 ' + fx(hit.price) + ' × 100 股'
    refreshQuotes()
  } catch (e) {
    hint.value = '查询失败：' + (e instanceof Error ? e.message : '')
  }
}

function remove(c: string) {
  rows.value = paperDel(c)
  refreshQuotes()
}

function openDetail(p: PaperItem) {
  detailStock.value = { code: p.code, name: p.name, secid: p.secid }
}

onMounted(() => {
  rows.value = paper()
  refreshQuotes()
  timer = window.setInterval(refreshQuotes, 10000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div>
    <div class="section-title">💼 模拟持仓</div>
    <div class="muted" style="font-size: 13px; margin-bottom: 12px">
      本地记录买入成本与数量，实时按现价计算浮动盈亏 · 数据保存在浏览器，不上传
    </div>

    <div v-if="error" class="err-banner">
      <span>持仓行情刷新失败：{{ error }}</span>
      <button @click="refreshQuotes">重试</button>
    </div>

    <div v-if="rows.length" class="kpi-row">
      <div class="kpi">
        <div class="kpi-l">持仓市值</div>
        <div class="kpi-v" :class="cl(total.pl)">{{ fx(total.mv, 2) }}</div>
      </div>
      <div class="kpi">
        <div class="kpi-l">总成本</div>
        <div class="kpi-v">{{ fx(total.cost, 2) }}</div>
      </div>
      <div class="kpi">
        <div class="kpi-l">浮动盈亏</div>
        <div class="kpi-v" :class="cl(total.pl)">{{ sg(total.pl) }}{{ fx(total.pl, 2) }}</div>
      </div>
      <div class="kpi">
        <div class="kpi-l">总收益率</div>
        <div class="kpi-v" :class="cl(total.rate)">{{ pc(total.rate) }}</div>
      </div>
      <div class="kpi">
        <div class="kpi-l">持仓只数</div>
        <div class="kpi-v">{{ rows.length }} 只</div>
      </div>
    </div>

    <div class="pg-tools">
      <span class="lbl">建仓</span>
      <input
        v-model="code"
        class="wl-input"
        style="max-width: 190px"
        placeholder="输入代码，如 600519 / 00700 / NVDA"
        @keydown.enter="add"
      />
      <span style="font-size: 12px; color: var(--muted)">{{ hint }}</span>
      <button class="btn sm" @click="add">＋ 建仓</button>
    </div>

    <div class="tbl-wrap">
      <table class="tbl">
        <thead>
          <tr>
            <th>代码 / 名称</th>
            <th>成本价</th>
            <th>现价</th>
            <th>涨跌幅</th>
            <th>数量</th>
            <th>市值</th>
            <th>浮动盈亏</th>
            <th>收益率</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!rows.length">
            <td colspan="9">
              <div class="empty">还没有持仓，在上方输入代码后点「建仓」</div>
            </td>
          </tr>
          <tr v-for="r in calcRows" :key="r.p.code" @click="openDetail(r.p)">
            <td>
              <span class="c-name">{{ r.p.name }}</span>
              <span class="c-code">{{ r.p.code }}</span>
            </td>
            <td>{{ fx(r.p.cost) }}</td>
            <td>{{ r.q ? fx(r.q.price) : '--' }}</td>
            <td :class="cl(r.q?.pct)">{{ r.q ? pc(r.q.pct) : '--' }}</td>
            <td>{{ r.p.shares }}</td>
            <td>{{ r.q ? fx(r.mv, 2) : '--' }}</td>
            <td :class="cl(r.pl)">{{ r.q ? sg(r.pl) + fx(r.pl, 2) : '--' }}</td>
            <td :class="cl(r.rate)">{{ r.q ? pc(r.rate) : '--' }}</td>
            <td>
              <button class="btn sm ghost" @click.stop="remove(r.p.code)">删除</button>
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
