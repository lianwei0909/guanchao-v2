<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { api } from '@/api'
import type { MinutePoint, SearchItem, SignalResp } from '@/types/market'
import { bindChartHover, drawMinute } from '@/utils/chart'
import { cl, fx, pc, sg } from '@/utils/format'

/* 盘中监控（对应旧版 /api/signal）。
   逻辑：以当日分时均价线为基准算偏离度，标准差推算阈值，
   偏离突破阈值并回落时记为一个异动点（高点拉升 / 低点砸盘）。
   分时图复用 utils/chart 的 drawMinute，异动点另用列表给出时间与偏离度。 */
const kw = ref('')
const suggestions = ref<SearchItem[]>([])
const cur = ref<{ code: string; name: string } | null>(null)

const sig = ref<SignalResp | null>(null)
const loading = ref(false)
const error = ref('')

const chartRef = ref<HTMLCanvasElement | null>(null)
let cachedPts: MinutePoint[] = []
let cachedPreClose = 0

let searchTimer: number | undefined

async function onSearch() {
  const q = kw.value.trim()
  if (!q) {
    suggestions.value = []
    return
  }
  try {
    suggestions.value = (await api.search(q)).slice(0, 8)
  } catch {
    suggestions.value = []
  }
}

function onInput() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = window.setTimeout(onSearch, 300)
}

function pick(s: SearchItem) {
  cur.value = { code: s.code, name: s.name }
  kw.value = ''
  suggestions.value = []
  load()
}

async function load() {
  if (!cur.value) return
  loading.value = true
  error.value = ''
  sig.value = null
  try {
    /* 两条请求：分时用于绘图（含 preClose），signal 给出异动点 */
    const [m, s] = await Promise.all([api.minute(cur.value.code), api.signal(cur.value.code)])
    cachedPts = m.points || []
    cachedPreClose = m.preClose
    sig.value = s
    await nextTick()
    paint()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '监控数据加载失败'
  } finally {
    loading.value = false
  }
}

function paint(hoverIdx = -1) {
  const cv = chartRef.value
  if (!cv) return
  const lay = drawMinute(cv, cachedPts, cachedPreClose, hoverIdx)
  if (!lay) return
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
        ['均价', p.avg.toFixed(2)]
      ]
    }
  })
}
</script>

<template>
  <div>
    <div class="section-title">📡 盘中监控</div>
    <div class="muted" style="font-size: 13px; margin-bottom: 12px">
      以分时均价线为基准捕捉异动拉升 / 砸盘 · 阈值由当日分时标准差推算
    </div>

    <div class="pg-tools">
      <span class="lbl">股票</span>
      <input
        v-model="kw"
        class="kw-input"
        type="text"
        placeholder="输入代码或名称搜索…"
        style="flex: 0 0 240px"
        @input="onInput"
        @keyup.enter="onSearch"
      />
      <button v-if="cur" class="btn sm ghost" @click="load">⟳ 刷新</button>
    </div>

    <div v-if="suggestions.length" class="sug-box">
      <div v-for="s in suggestions" :key="s.code" class="sug-item" @click="pick(s)">
        <span class="c-name">{{ s.name }}</span>
        <span class="c-code">{{ s.code }}</span>
        <span :class="cl(s.pct)" style="font-size: 12px; margin-left: auto">{{ pc(s.pct) }}</span>
      </div>
    </div>

    <div v-if="error" class="err-banner">
      <span>{{ error }}</span>
      <button @click="load">重试</button>
    </div>

    <div v-if="!cur" class="empty">搜索一只股票开始监控</div>

    <template v-else>
      <div class="section-title" style="font-size: 15px">
        {{ sig?.name || cur.name }}
        <span class="muted" style="font-size: 12px; font-weight: 400">{{ cur.code }}</span>
      </div>

      <!-- 异动概览 -->
      <div v-if="sig" class="kpi-row">
        <div class="kpi">
          <div class="kpi-l">异动阈值</div>
          <div class="kpi-v">±{{ fx(sig.threshold, 2) }}%</div>
          <div class="kpi-s">偏离均价线幅度</div>
        </div>
        <div class="kpi">
          <div class="kpi-l">拉升异动</div>
          <div class="kpi-v up">{{ sig.high.length }}</div>
          <div class="kpi-s">次</div>
        </div>
        <div class="kpi">
          <div class="kpi-l">砸盘异动</div>
          <div class="kpi-v down">{{ sig.low.length }}</div>
          <div class="kpi-s">次</div>
        </div>
        <div class="kpi">
          <div class="kpi-l">分时点数</div>
          <div class="kpi-v">{{ sig.points.length }}</div>
          <div class="kpi-s">个</div>
        </div>
      </div>

      <div v-if="loading && !sig" class="empty">加载中…</div>

      <!-- 分时图 -->
      <div class="chart-box">
        <canvas ref="chartRef" class="chart-cv"></canvas>
      </div>

      <!-- 异动明细 -->
      <div v-if="sig">
        <div class="sig-two">
          <div>
            <div style="font-size: 13px; font-weight: 700; margin-bottom: 6px" class="up">
              拉升异动（{{ sig.high.length }}）
            </div>
            <div v-if="!sig.high.length" class="muted" style="font-size: 12px">无</div>
            <table v-else class="tbl">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>价格</th>
                  <th>偏离</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(m, i) in sig.high" :key="`h${i}`">
                  <td data-label="时间">{{ m.t }}</td>
                  <td data-label="价格" class="up">{{ fx(m.price) }}</td>
                  <td data-label="偏离" class="up">+{{ fx(m.dev, 2) }}%</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div>
            <div style="font-size: 13px; font-weight: 700; margin-bottom: 6px" class="down">
              砸盘异动（{{ sig.low.length }}）
            </div>
            <div v-if="!sig.low.length" class="muted" style="font-size: 12px">无</div>
            <table v-else class="tbl">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>价格</th>
                  <th>偏离</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(m, i) in sig.low" :key="`l${i}`">
                  <td data-label="时间">{{ m.t }}</td>
                  <td data-label="价格" class="down">{{ fx(m.price) }}</td>
                  <td data-label="偏离" class="down">{{ fx(m.dev, 2) }}%</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 全部点位偏离度（可折叠查看趋势） -->
        <details style="margin-top: 14px">
          <summary style="cursor: pointer; font-size: 13px; font-weight: 700">
            全部分时点位（{{ sig.points.length }}）
          </summary>
          <div class="tbl-wrap" style="max-height: 260px; overflow: auto; margin-top: 8px">
            <table class="tbl">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>价格</th>
                  <th>均价</th>
                  <th>偏离</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(p, i) in sig.points" :key="i">
                  <td data-label="时间">{{ p.t }}</td>
                  <td data-label="价格">{{ fx(p.p) }}</td>
                  <td data-label="均价">{{ fx(p.avg) }}</td>
                  <td data-label="偏离" :class="cl(p.dev)">{{ sg(p.dev) }}{{ fx(p.dev, 2) }}%</td>
                </tr>
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </template>
  </div>
</template>

<style scoped>
.kw-input {
  padding: 5px 10px;
  border: 1px solid var(--border, #e3e8ef);
  border-radius: 7px;
  font-size: 13px;
  background: transparent;
  color: inherit;
  outline: none;
}
.kw-input:focus {
  border-color: var(--primary);
}
.sug-box {
  border: 1px solid var(--border, #e3e8ef);
  border-radius: 8px;
  max-width: 420px;
  margin-bottom: 10px;
  overflow: hidden;
}
.sug-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  cursor: pointer;
  font-size: 13px;
}
.sug-item:hover {
  background: rgba(13, 71, 161, 0.07);
}
.chart-box {
  border: 1px solid var(--border, #e3e8ef);
  border-radius: 10px;
  padding: 6px;
  margin-bottom: 14px;
}
.chart-cv {
  width: 100%;
  height: 280px;
  display: block;
}
.sig-two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
@media (max-width: 720px) {
  .sig-two {
    grid-template-columns: 1fr;
  }
}
</style>
