<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import { api } from '@/api'
import type { KlineItem, MinutePoint, NewsItem, StockDetail } from '@/types/market'
import { bindChartHover, drawKline, drawMinute } from '@/utils/chart'
import { cl, fx, pc, sg } from '@/utils/format'
import StockFinancials from './StockFinancials.vue'

/* 个股详情弹窗（对应旧版 openDetail）。
   图表沿用旧版 Canvas 绘制逻辑，已抽到 utils/chart.ts 并 TypeScript 化。 */
const props = defineProps<{ code: string; name?: string; secid?: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

type Period = 'minute' | 'day' | 'week' | 'month'
const PERIODS: { k: Period; label: string }[] = [
  { k: 'minute', label: '分时' },
  { k: 'day', label: '日K' },
  { k: 'week', label: '周K' },
  { k: 'month', label: '月K' }
]

const detail = ref<StockDetail | null>(null)
const period = ref<Period>('minute')
const chartRef = ref<HTMLCanvasElement | null>(null)
const loading = ref(true)
const err = ref('')

/* 财务分析：默认收起，展开才加载（同花顺限流约 20 秒/次，不展开就不打接口） */
const showFin = ref(false)
const news = ref<NewsItem[]>([])
const loadingNews = ref(false)

/* 图表数据缓存：悬停重绘时直接复用，不重复请求接口（悬停零网络开销） */
let cachedPts: MinutePoint[] = []
let cachedPreClose = 0
let cachedKs: KlineItem[] = []

async function loadChart() {
  await nextTick()
  const cv = chartRef.value
  if (!cv) return
  try {
    if (period.value === 'minute') {
      const d = await api.minute(props.code, props.secid)
      cachedPts = d.points || []
      cachedPreClose = d.preClose
      const lay = drawMinute(cv, cachedPts, cachedPreClose)
      if (lay) {
        bindChartHover(cv, {
          n: cachedPts.length,
          X: lay.X,
          paint: (i) => drawMinute(cv, cachedPts, cachedPreClose, i),
          tip: (i) => {
            const p = cachedPts[i]
            if (!p) return []
            const chg = cachedPreClose > 0 ? ((p.p - cachedPreClose) / cachedPreClose) * 100 : 0
            const cls = chg >= 0 ? 'up' : 'down'
            return [
              ['时间', p.t],
              ['价格', p.p.toFixed(2), cls],
              ['涨跌幅', (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%', cls],
              ['均价', p.avg > 0 ? p.avg.toFixed(2) : '--'],
              ['成交量', String(p.v || 0)]
            ]
          }
        })
      }
    } else {
      const d = await api.kline(props.code, period.value, 120, props.secid)
      cachedKs = d.klines || []
      const lay = drawKline(cv, cachedKs)
      if (lay) {
        bindChartHover(cv, {
          n: cachedKs.length,
          X: lay.X,
          paint: (i) => drawKline(cv, cachedKs, i),
          tip: (i) => {
            const k = cachedKs[i]
            if (!k) return []
            const prev = i > 0 ? cachedKs[i - 1].c : k.o
            const chg = prev > 0 ? ((k.c - prev) / prev) * 100 : 0
            return [
              ['日期', k.t],
              ['开盘', k.o.toFixed(2)],
              ['最高', k.h.toFixed(2), 'up'],
              ['最低', k.l.toFixed(2), 'down'],
              ['收盘', k.c.toFixed(2), k.c >= k.o ? 'up' : 'down'],
              ['涨跌幅', (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%', chg >= 0 ? 'up' : 'down'],
              ['成交量', String(k.v || 0)]
            ]
          }
        })
      }
    }
  } catch {
    drawKline(cv, [])
  }
}

async function load() {
  loading.value = true
  err.value = ''
  try {
    detail.value = await api.detail(props.code, props.secid)
    await loadChart()
  } catch (e) {
    err.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    loading.value = false
  }
}

function switchPeriod(p: Period) {
  period.value = p
  loadChart()
}

function toggleFin() {
  showFin.value = !showFin.value
}

/** 相关快讯：从三源聚合快讯（东财/同花顺/新浪）里按股票名称 / 代码过滤 */
async function loadNews() {
  loadingNews.value = true
  try {
    const d = await api.news('all', 'all')
    const kw = [props.name, props.code].filter((x): x is string => !!x)
    news.value = (d?.list || [])
      .filter((n) =>
        kw.some((k) => (n.title || '').includes(k) || (n.summary || '').includes(k))
      )
      .slice(0, 8)
  } catch {
    news.value = []
  } finally {
    loadingNews.value = false
  }
}

onMounted(() => {
  load()
  loadNews()
})
watch(
  () => props.code,
  () => {
    load()
    loadNews()
  }
)
</script>

<template>
  <div class="modal-mask show" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-head">
        <h3>
          {{ detail?.name || name || '--' }}
          <span class="muted" style="font-size: 13px; font-weight: 400">{{ code }}</span>
        </h3>
        <button class="modal-close" @click="emit('close')">×</button>
      </div>

      <div v-if="detail" style="display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap">
        <span
          :class="cl(detail.pct)"
          style="font-size: 30px; font-weight: 800; font-family: var(--font-mono)"
          >{{ fx(detail.price) }}</span
        >
        <span :class="cl(detail.change)" style="font-size: 15px; font-weight: 600"
          >{{ sg(detail.change) }}{{ fx(detail.change) }}</span
        >
        <span :class="cl(detail.pct)" style="font-size: 15px; font-weight: 600">{{
          pc(detail.pct)
        }}</span>
      </div>
      <div v-else-if="loading" class="empty">加载中…</div>
      <div v-else-if="err" class="empty">{{ err }}</div>

      <div class="chart-tabs" style="margin-top: 14px">
        <button
          v-for="p in PERIODS"
          :key="p.k"
          :class="{ on: period === p.k }"
          @click="switchPeriod(p.k)"
        >
          {{ p.label }}
        </button>
      </div>
      <div class="chart-box"><canvas ref="chartRef"></canvas></div>

      <div
        v-if="detail"
        style="
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 8px;
          margin-top: 12px;
        "
      >
        <div
          v-for="it in [
            { k: '今开', v: fx(detail.open), c: cl(detail.open - detail.preClose) },
            { k: '最高', v: fx(detail.high), c: 'up' },
            { k: '最低', v: fx(detail.low), c: 'down' },
            { k: '昨收', v: fx(detail.preClose), c: '' },
            { k: '换手', v: fx(detail.turnover) + '%', c: '' },
            { k: '总市值', v: fx(detail.mktcap, 0) + '亿', c: '' },
            { k: '市盈率', v: fx(detail.pe), c: '' },
            { k: '市净率', v: fx(detail.pb), c: '' }
          ]"
          :key="it.k"
          style="background: var(--card2); border-radius: 8px; padding: 8px 10px"
        >
          <div style="font-size: 11px; color: var(--muted)">{{ it.k }}</div>
          <div :class="it.c" style="font-size: 14px; font-weight: 600">{{ it.v }}</div>
        </div>
      </div>

      <!-- 财务分析（同花顺源，展开才加载，避免浪费限流额度） -->
      <button class="btn sm ghost" style="width: 100%; margin-top: 14px" @click="toggleFin">
        {{ showFin ? '▾' : '▸' }} 财务分析（数据来源：同花顺）
      </button>
      <StockFinancials v-if="showFin" :code="code" />

      <!-- 相关快讯：三源聚合后按股票名 / 代码过滤 -->
      <div style="margin-top: 14px">
        <div style="font-size: 12.5px; font-weight: 600; margin-bottom: 6px">📰 相关快讯</div>
        <div v-if="loadingNews" class="empty">加载中…</div>
        <div v-else-if="!news.length" class="empty">暂无相关快讯</div>
        <template v-else>
          <a
            v-for="(n, i) in news"
            :key="i"
            class="nw-item"
            :href="n.url || '#'"
            target="_blank"
            rel="noopener"
          >
            <span class="nw-title">{{ n.title }}</span>
            <div style="font-size: 11.5px; color: var(--muted); margin-top: 2px">
              {{ n.time }}
            </div>
          </a>
        </template>
      </div>
    </div>
  </div>
</template>
