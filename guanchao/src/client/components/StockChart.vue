<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import { api } from '@/api'
import type { KlineItem, MinutePoint } from '@/types/market'
import { bindChartHover, drawKline, drawMinute, type ChartLayout } from '@/utils/chart'
import { fmtAmt, fmtVol } from '@/utils/format'

/* 个股 K 线 / 分时图（从 StockDetailModal 抽离的独立子组件）。
   图表沿用旧版 Canvas 绘制逻辑，已抽到 utils/chart.ts 并 TypeScript 化。
   周期切换、悬停联动、加载遮罩、K 线空态全部在此内闭环，
   父组件只传 code / secid，不再关心绘图细节。 */
const props = defineProps<{ code: string; secid?: string }>()

type Period = 'minute' | 'day' | 'week' | 'month'
const PERIODS: { k: Period; label: string }[] = [
  { k: 'minute', label: '分时' },
  { k: 'day', label: '日K' },
  { k: 'week', label: '周K' },
  { k: 'month', label: '月K' }
]

const period = ref<Period>('minute')
const chartRef = ref<HTMLCanvasElement | null>(null)
const chartLoading = ref(false)
const chartNote = ref('')
/** K 线是否有数据：美股日K/周K/月K 后端返回空数组，需要渲染空态而不是空白画布 */
const hasKlines = ref(false)

/* 图表数据缓存：悬停重绘时直接复用，不重复请求接口（悬停零网络开销） */
let cachedPts: MinutePoint[] = []
let cachedPreClose = 0
let cachedKs: KlineItem[] = []
/* 客户端按「代码|周期」缓存，切换周期即时出图、不重复打接口（服务端也有 10 分钟缓存） */
const chartCache = new Map<string, { pts?: MinutePoint[]; pre?: number; ks?: KlineItem[] }>()
/* 当前图表的布局（drawMinute/drawKline 返回），悬停命中检测要用 */
let chartLay: ChartLayout | null = null

async function loadChart() {
  await nextTick()
  const cv = chartRef.value
  if (!cv) return
  const key = props.code + '|' + period.value
  const cached = chartCache.get(key)
  /* 命中客户端缓存：直接重绘，零网络开销（切换周期 <16ms） */
  if (cached) {
    if (period.value === 'minute') {
      cachedPts = cached.pts || []
      cachedPreClose = cached.pre || 0
      chartLay = drawMinute(cv, cachedPts, cachedPreClose)
      bindHover()
    } else {
      cachedKs = cached.ks || []
      chartNote.value = ''
      hasKlines.value = cachedKs.length > 0
      chartLay = drawKline(cv, cachedKs, -1, period.value)
      bindHover()
    }
    return
  }
  chartLoading.value = true
  chartNote.value = ''
  try {
    if (period.value === 'minute') {
      const d = await api.minute(props.code, props.secid)
      cachedPts = d.points || []
      cachedPreClose = d.preClose
      chartCache.set(key, { pts: cachedPts, pre: cachedPreClose })
      chartLay = drawMinute(cv, cachedPts, cachedPreClose)
      bindHover()
    } else {
      const d = await api.kline(props.code, period.value, 120, props.secid)
      cachedKs = d.klines || []
      chartNote.value = d.note || ''
      hasKlines.value = cachedKs.length > 0
      chartCache.set(key, { ks: cachedKs })
      chartLay = drawKline(cv, cachedKs, -1, period.value)
      bindHover()
    }
  } catch {
    chartLay = drawKline(cv, [])
  } finally {
    chartLoading.value = false
  }
}

/* 悬停联动（重绘零网络开销） */
function bindHover() {
  const cv = chartRef.value
  if (!cv || !chartLay) return
  const lay = chartLay
  if (period.value === 'minute') {
    bindChartHover(cv, {
      n: cachedPts.length,
      X: lay.X,
      paint: (i) => drawMinute(cv, cachedPts, cachedPreClose, i),
      tip: (i) => {
        const p = cachedPts[i]
        if (!p) return []
        const chg = cachedPreClose > 0 ? ((p.p - cachedPreClose) / cachedPreClose) * 100 : 0
        const cls = chg >= 0 ? 'up' : 'down'
        /* 振幅按全日最高/最低算 —— 分时点本身不带 high/low */
        const hi = Math.max(...cachedPts.map((x) => x.p))
        const lo = Math.min(...cachedPts.map((x) => x.p))
        const amp = cachedPreClose > 0 ? ((hi - lo) / cachedPreClose) * 100 : 0
        return [
          ['时间', p.t],
          ['价格', p.p.toFixed(2), cls],
          ['涨跌幅', (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%', cls],
          ['均价', p.avg > 0 ? p.avg.toFixed(2) : '--'],
          ['振幅', amp.toFixed(2) + '%'],
          ['成交量', fmtVol(p.v)],
          /* 分时接口每个点都带 amt（成交额），所以只有分时浮层能显示这一项 */
          ['成交额', fmtAmt(p.amt)]
        ]
      }
    })
  } else {
    /* K 线分支 period 必为 day/week/month；闭包内 TS 丢失收窄，先固化 */
    const kp: 'day' | 'week' | 'month' = period.value
    bindChartHover(cv, {
      n: cachedKs.length,
      X: lay.X,
      paint: (i) => drawKline(cv, cachedKs, i, kp),
      tip: (i) => {
        const k = cachedKs[i]
        if (!k) return []
        const prev = i > 0 ? cachedKs[i - 1].c : k.o
        const chg = prev > 0 ? ((k.c - prev) / prev) * 100 : 0
        const amp = prev > 0 ? ((k.h - k.l) / prev) * 100 : 0
        const label = PERIODS.find((x) => x.k === period.value)?.label || ''
        return [
          ['日期', k.t + '　' + label],
          ['开盘', k.o.toFixed(2)],
          ['最高', k.h.toFixed(2), 'up'],
          ['最低', k.l.toFixed(2), 'down'],
          ['收盘', k.c.toFixed(2), k.c >= k.o ? 'up' : 'down'],
          ['涨跌幅', (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%', chg >= 0 ? 'up' : 'down'],
          ['振幅', amp.toFixed(2) + '%'],
          ['成交量', fmtVol(k.v)]
          /* K 线接口（腾讯 fqkline）只返回 日期/开/收/高/低/量，无成交额，
             这里不能补 —— 分时才有点级 amt。二者不一致是数据能力的真实反映。 */
        ]
      }
    })
  }
}

function switchPeriod(p: Period) {
  period.value = p
  loadChart()
}

onMounted(() => {
  /* 不同标的打开时清空客户端 K 线缓存（组件通常随 modal v-if 重建，
     这里再兜底 watch，避免同实例复用旧缓存） */
  chartCache.clear()
  loadChart()
})
watch(
  () => props.code,
  () => {
    chartCache.clear()
    loadChart()
  }
)
</script>

<template>
  <div>
    <div class="chart-tabs">
      <button
        v-for="p in PERIODS"
        :key="p.k"
        :class="{ on: period === p.k }"
        @click="switchPeriod(p.k)"
      >
        {{ p.label }}
      </button>
    </div>
    <!-- 图例：仅 K 线态显示，颜色与 chart.ts 的 CHART_COLORS 一一对应 -->
    <div v-if="period !== 'minute' && hasKlines" class="chart-legend">
      <span style="color: var(--up)">MA5</span>
      <span style="color: var(--c3)">MA10</span>
      <span style="color: var(--accent)">MA20</span>
      <span style="color: var(--down)">MA60</span>
      <span class="muted">VOL · MACD(12,26,9)</span>
    </div>
    <!-- 分时无 MACD 副图，画布更矮（360px）；K 线为 主图+VOL+MACD 三区，需要 430px。
         二者不强行等高 —— 等高等价于给分时留一块空白。 -->
    <div class="chart-box" :style="{ height: period === 'minute' ? '360px' : '430px' }">
      <canvas ref="chartRef"></canvas>
      <div v-if="chartLoading" class="chart-mask">加载中…</div>
      <!-- 数据源不可用（如美股日K/周K/月K 后端返回 klines:[]）时显示空态，而不是空白画布 -->
      <div v-else-if="period !== 'minute' && !hasKlines" class="chart-empty">
        <div class="ce-ic">📉</div>
        <div class="ce-t">该周期暂无 K 线数据</div>
        <div class="ce-s">{{ chartNote || '当前数据源不支持此周期的 K 线。' }}</div>
        <button class="btn sm ghost" @click="switchPeriod('minute')">切到分时</button>
      </div>
    </div>
    <div v-if="chartNote" class="muted" style="font-size: 13px; margin-top: 6px">
      {{ chartNote }}
    </div>
  </div>
</template>

<style scoped>
/* 图表周期切换（与父弹窗的 .seg 同款胶囊风格） */
.chart-tabs {
  display: flex;
  gap: 6px;
  margin-top: 14px;
}
.chart-tabs button {
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-muted);
  font-size: 12.5px;
  font-weight: 600;
  padding: 5px 14px;
  border-radius: 999px;
  cursor: pointer;
  transition: 0.15s;
}
.chart-tabs button.on {
  background: var(--primary);
  color: var(--bg);
  border-color: var(--primary);
}
.chart-legend {
  display: flex;
  gap: 14px;
  font-size: 12px;
  font-weight: 600;
  margin-top: 8px;
}
/* 图表容器相对定位，供加载遮罩 / 空态绝对定位 */
.chart-box {
  position: relative;
}
.chart-mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--muted);
  background: color-mix(in srgb, var(--surface) 55%, transparent);
  border-radius: 8px;
}
.chart-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  text-align: center;
  color: var(--muted);
  background: color-mix(in srgb, var(--surface) 55%, transparent);
  border-radius: 8px;
}
.chart-empty .ce-ic {
  font-size: 30px;
}
.chart-empty .ce-t {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
.chart-empty .ce-s {
  font-size: 12px;
  max-width: 80%;
}
</style>
