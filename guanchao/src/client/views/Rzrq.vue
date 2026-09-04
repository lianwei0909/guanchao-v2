<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { api } from '@/api'
import type { RzrqRankResp, RzrqTrend } from '@/types/market'
import { cl, fx, pc } from '@/utils/format'
import StockDetailModal from '@/components/StockDetailModal.vue'

/* 融资融券（两融）：学习 go-stock 的 GetRzrqTrend / GetRzrqRank。
   走势 = 全市场融资余额 + 融资净买入（最近 30 交易日）；
   排名 = 个股 / 行业 / 概念 两融余额榜（默认按净买入额排序）。 */

const RANK_TYPES: [('ggList' | 'hyList' | 'gnList'), string][] = [
  ['ggList', '个股'],
  ['hyList', '行业'],
  ['gnList', '概念']
]

const trend = ref<RzrqTrend | null>(null)
const rankType = ref<'ggList' | 'hyList' | 'gnList'>('ggList')
const rank = ref<RzrqRankResp | null>(null)
const loading = ref(true)
const error = ref('')
const rankLoading = ref(false)
const rankError = ref('')
const chartRef = ref<HTMLCanvasElement | null>(null)
const detailStock = ref<{ code: string; name: string; secid: string } | null>(null)

/* A 股 secid 推导：6 开头走沪市 1.，其余走深市 0. */
function secidOfCode(code: string): string {
  return (code.startsWith('6') ? '1.' : '0.') + code
}

/* ---------- 加载 ---------- */
async function loadTrend() {
  loading.value = true
  error.value = ''
  try {
    trend.value = (await api.rzrq('trend')) as RzrqTrend
  } catch (e) {
    error.value = e instanceof Error ? e.message : '两融走势加载失败'
  } finally {
    loading.value = false
    drawChart()
  }
}
async function loadRank() {
  rankLoading.value = true
  rankError.value = ''
  try {
    rank.value = (await api.rzrq('rank', { type: rankType.value, len: 20 })) as RzrqRankResp
  } catch (e) {
    rankError.value = e instanceof Error ? e.message : '两融排名加载失败'
  } finally {
    rankLoading.value = false
  }
}

/* KPI：取最新一日 */
const kpi = computed(() => {
  const t = trend.value
  if (!t || !t.date.length) return null
  const i = t.date.length - 1
  return {
    date: t.date[i],
    rzye: t.rzye[i],
    rzjlr: t.rzjlr[i],
    spj: t.spj[i],
    spzf: t.spzf[i],
    upd: t.updateTime
  }
})

/* ---------- Canvas 走势图（主题感知） ---------- */
function cssv(n: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(n).trim()
}
function thColors() {
  return {
    up: cssv('--up') || '#d97757',
    down: cssv('--down') || '#788c5d',
    text: cssv('--text') || '#141413',
    muted: cssv('--muted') || '#5c5b55',
    faint: cssv('--text-faint') || '#b0aea5',
    border: cssv('--border2') || '#eee',
    surface: cssv('--surface') || '#fff'
  }
}
function drawChart() {
  const cv = chartRef.value
  const t = trend.value
  if (!cv || !t || !t.date.length) return
  const g = cv.getContext('2d')
  if (!g) return
  const dpr = window.devicePixelRatio || 1
  const w = cv.clientWidth || 0
  const h = cv.clientHeight || 0
  /* 首次加载时 DOM 可能未完成布局，跳过避免画到 0×0 */
  if (w < 10 || h < 10) return
  cv.width = Math.round(w * dpr)
  cv.height = Math.round(h * dpr)
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  const col = thColors()
  g.clearRect(0, 0, w, h)

  /* 预估左右轴标签宽度后动态分配 padding */
  const PAD_L = 74   /* 左轴放 "X.XXX万亿" 约 70+px */
  const PAD_R = 68   /* 右轴放 "+/-X.XXX万亿" */
  const PAD_T = 20
  const PAD_B = 30
  const plotW = w - PAD_L - PAD_R
  const plotH = h - PAD_T - PAD_B
  const n = t.date.length
  const X = (i: number) => PAD_L + (n <= 1 ? 0 : (i / (n - 1)) * plotW)

  /* ---- 左轴：融资余额（亿元）---- */
  const rzyeV = t.rzye
  const rzyeMax = Math.max(...rzyeV)
  const rzyeMin = Math.min(...rzyeV)
  const margin = (rzyeMax - rzyeMin) * 0.12 || 100
  const yL = (v: number) =>
    PAD_T + plotH - ((v - (rzyeMin - margin)) / (rzyeMax - rzyeMin + 2 * margin)) * plotH

  /* ---- 右轴：融资净买入（亿元），取整到百亿级让刻度好看 ---- */
  const jAbsMax = Math.max(...t.rzjlr.map(Math.abs), 10)
  /* 取整到最近的 100 或 200 的倍数 */
  const jStep = jAbsMax < 500 ? 100 : jAbsMax < 1500 ? 200 : 500
  const jMax = Math.ceil(jAbsMax / jStep) * jStep
  const yR = (v: number) => PAD_T + plotH / 2 - (v / jMax) * (plotH / 2)

  /* ---- 网格线 ---- */
  g.strokeStyle = col.border
  g.lineWidth = 1
  for (let k = 0; k <= 4; k++) {
    const y = PAD_T + (plotH * k) / 4
    g.beginPath(); g.moveTo(PAD_L, y); g.lineTo(PAD_L + plotW, y); g.stroke()
  }

  /* ---- 净买入零轴线（虚线）---- */
  g.strokeStyle = col.faint
  g.setLineDash([4, 3])
  g.beginPath(); g.moveTo(PAD_L, yR(0)); g.lineTo(PAD_L + plotW, yR(0)); g.stroke()
  g.setLineDash([])

  /* ---- 柱状图：融资净买入（先画，在线下层）---- */
  const bw = Math.max(2, (plotW / n) * 0.58)
  t.rzjlr.forEach((v, i) => {
    const cx = X(i)
    const y0 = yR(0)
    const y1 = yR(v)
    g.fillStyle = v >= 0 ? col.up : col.down
    g.globalAlpha = 0.5
    g.fillRect(cx - bw / 2, Math.min(y0, y1), bw, Math.abs(y1 - y0))
    g.globalAlpha = 1
  })

  /* ---- 折线图：融资余额（左轴）---- */
  g.strokeStyle = col.up
  g.lineWidth = 2
  g.lineJoin = 'round'
  g.beginPath()
  rzyeV.forEach((v, i) => (i === 0 ? g.moveTo(X(i), yL(v)) : g.lineTo(X(i), yL(v))))
  g.stroke()

  /* 末端圆点 */
  const li = n - 1
  g.fillStyle = col.up
  g.beginPath(); g.arc(X(li), yL(rzyeV[li]), 3.5, 0, Math.PI * 2); g.fill()

  /* ---- 轴标签 ---- */
  g.font = '11px ' + (getComputedStyle(document.documentElement).getPropertyValue('--font-mono') || 'monospace')
  g.textBaseline = 'middle'

  /* 左轴：融资余额（万亿元）*/
  g.fillStyle = col.up
  g.textAlign = 'right'
  for (let k = 0; k <= 4; k++) {
    const v = rzyeMax + margin - ((rzyeMax - rzyeMin + 2 * margin) * k) / 4
    g.fillText((v / 10000).toFixed(2) + '万亿', PAD_L - 6, PAD_T + (plotH * k) / 4)
  }

  /* 右轴：融资净买入（亿元）— 用取整后的 jMax */
  g.fillStyle = col.muted
  g.textAlign = 'left'
  g.fillText('+' + jMax, PAD_L + plotW + 6, PAD_T)
  g.fillText('0', PAD_L + plotW + 6, yR(0))
  g.fillText('-' + jMax, PAD_L + plotW + 6, PAD_T + plotH)

  /* 底部日期 */
  g.fillStyle = col.muted
  g.textAlign = 'center'
  const stops = [0, Math.floor(n * 0.25), Math.floor(n * 0.5), Math.floor(n * 0.75), n - 1]
  stops.forEach((i) => {
    if (i < 0 || i >= n) return
    g.fillText(t.date[i] ? t.date[i].slice(5) : '', X(i), h - 12)
  })

  /* 图例（右上角区域） */
  g.textAlign = 'left'
  g.fillStyle = col.up
  g.fillText('\u25A0 \u878D\u8D44\u4F59\u989D', PAD_L, PAD_T - 9)
  g.fillStyle = col.muted
  g.fillText('\u25AC \u51C0\u4E70\u5165\uFF08\u4EBF\uFF09', PAD_L + 76, PAD_T - 9)
}

/* 主题切换时重绘 Canvas（监听 data-theme 属性） */
let mo: MutationObserver | null = null
let ro: ResizeObserver | null = null
function onResize() {
  drawChart()
}
onMounted(() => {
  loadTrend()
  loadRank()
  /* 主题切换重绘 */
  mo = new MutationObserver(() => drawChart())
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  window.addEventListener('resize', onResize)
  /* ResizeObserver：容器尺寸变化时重绘（解决首次加载尺寸为 0 的问题） */
  if (chartRef.value) {
    ro = new ResizeObserver(() => drawChart())
    ro.observe(chartRef.value)
  }
  /* 首次绘制延迟到 DOM 布局完成后再画（nextTick + rAF 双保险） */
  nextTick(() => requestAnimationFrame(() => drawChart()))
})
onBeforeUnmount(() => {
  mo?.disconnect()
  ro?.disconnect()
  window.removeEventListener('resize', onResize)
})

watch(rankType, () => loadRank())
</script>

<template>
  <div>
    <div class="section-title">💰 融资融券</div>

    <!-- 走势区 -->
    <div v-if="error" class="err-banner">
      <span>{{ error }}</span>
      <button @click="loadTrend">重试</button>
    </div>

    <div v-if="kpi" class="kpi-row">
      <div class="kpi">
        <div class="kpi-l">融资余额</div>
        <div class="kpi-v up">{{ (kpi.rzye / 10000).toFixed(2) }}</div>
        <div class="kpi-s">万亿 · {{ kpi.date }}</div>
      </div>
      <div class="kpi">
        <div class="kpi-l">融资净买入</div>
        <div class="kpi-v" :class="cl(kpi.rzjlr)">{{ pc(kpi.rzjlr) }}</div>
        <div class="kpi-s">亿 · 当日</div>
      </div>
      <div class="kpi">
        <div class="kpi-l">上证收盘</div>
        <div class="kpi-v">{{ fx(kpi.spj) }}</div>
        <div class="kpi-s">元</div>
      </div>
      <div class="kpi">
        <div class="kpi-l">上证涨幅</div>
        <div class="kpi-v" :class="cl(kpi.spzf)">{{ pc(kpi.spzf) }}</div>
        <div class="kpi-s">当日</div>
      </div>
    </div>

    <div class="chart-box">
      <canvas ref="chartRef" v-show="!loading && !error"></canvas>
      <div v-if="loading" class="empty">加载中…</div>
    </div>
    <div class="muted" style="font-size: 12px; margin: 6px 0 18px">
      全市场融资融券余额走势（最近 30 交易日）· 数据更新 {{ trend?.updateTime || '—' }} · 同花顺源
    </div>

    <!-- 排名区 -->
    <div class="pg-tools">
      <span class="lbl">维度</span>
      <div class="seg">
        <button
          v-for="[k, label] in RANK_TYPES"
          :key="k"
          :class="{ on: rankType === k }"
          @click="rankType = k"
        >
          {{ label }}
        </button>
      </div>
      <span class="muted" style="font-size: 12px; margin-left: 8px">按净买入额排序 · 金额单位亿元</span>
    </div>

    <div v-if="rankError" class="err-banner">
      <span>{{ rankError }}</span>
      <button @click="loadRank">重试</button>
    </div>

    <div class="tbl-wrap">
      <table class="tbl">
        <thead>
          <tr>
            <th>排名</th>
            <th>代码 / 名称</th>
            <th>两融余额</th>
            <th>融资余额</th>
            <th>融券余额</th>
            <th>净买入额</th>
            <th>涨跌幅</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!rank || !rank.list.length">
            <td colspan="7">
              <div class="empty">{{ rankLoading ? '加载中…' : '暂无数据' }}</div>
            </td>
          </tr>
          <tr
            v-for="(r, i) in rank?.list"
            :key="r.code"
            :class="rankType === 'ggList' ? 'clickable' : ''"
            @click="rankType === 'ggList' ? (detailStock = { code: r.code, name: r.name, secid: secidOfCode(r.code) }) : null"
          >
            <td data-label="排名" class="muted">{{ i + 1 }}</td>
            <td data-label="代码/名称">
              <span class="c-name">{{ r.name }}</span>
              <span class="c-code">{{ r.code }}</span>
            </td>
            <td data-label="两融余额">{{ fx(r.lrye) }} 亿</td>
            <td data-label="融资余额">{{ fx(r.rzye) }} 亿</td>
            <td data-label="融券余额">{{ fx(r.rqye) }} 亿</td>
            <td data-label="净买入额" :class="cl(r.jmr)">{{ fx(r.jmr) }} 亿</td>
            <td data-label="涨跌幅" :class="cl(r.pct)">{{ pc(r.pct) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="muted" style="font-size: 12px; margin-top: 10px">
      数据仅供研究，不构成投资建议。融资融券属杠杆交易，风险高于普通证券交易。
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

<style scoped>
.chart-box {
  position: relative;
  height: 340px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
}
.chart-box canvas {
  width: 100%;
  height: 100%;
  display: block;
}
.clickable {
  cursor: pointer;
}
.clickable:hover .c-name {
  text-decoration: underline;
}
</style>
