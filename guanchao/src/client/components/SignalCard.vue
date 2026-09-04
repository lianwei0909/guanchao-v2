<script setup lang="ts">
import type { SignalCardState } from '@/types/signal'
import { ref, computed, watch } from 'vue'
import { bindChartHover, drawMinute } from '@/utils/chart'
import { cl, fx, sg } from '@/utils/format'

/* 盘中监控的单个卡片（从 Signal.vue 中拆出）。
   只负责渲染与卡片内交互，数据刷新/持久化由父组件负责 ——
   父组件因此从 849 行降到约 550 行，职责也更清晰。 */
const props = defineProps<{ card: SignalCardState }>()

const emit = defineEmits<{
  (e: 'remove', code: string): void
  (e: 'open', card: SignalCardState): void
  (e: 'toggle-watch', card: SignalCardState): void
  (e: 'toggle-points', code: string): void
}>()

function togglePoints() {
  emit('toggle-points', props.card.code)
}

/* 真实当前价：分时最后一根的实时成交价（每 10 秒刷新）。
   不要用 preClose*(1+curDev/100) —— curDev 是相对均价线的偏离、异动中还是段内极值，
   乘到昨收上得到的是无意义的派生值，并非真实当前价。 */
const curPrice = computed(() => {
  const pts = props.card.pts
  return pts && pts.length ? pts[pts.length - 1].p : null
})
const curChg = computed(() => {
  const price = curPrice.value
  const pc = props.card.preClose
  return price != null && pc > 0 ? ((price - pc) / pc) * 100 : 0
})

/* canvas 引用留在组件内部，不回写到卡片对象上 —— 子组件不修改 prop */
const cvRef = ref<HTMLCanvasElement | null>(null)

/* 父组件每 10 秒轮询更新卡片数据 —— 这里监听数据与 canvas 挂载自动重绘。
   flush: 'post' 确保在 DOM 更新后再绘制，避免拿到旧尺寸。
   （原先是在父组件的 loadOne() 里手动调 paint，父组件因此耦合了子组件内部细节） */
watch(
  [cvRef, () => props.card.pts, () => props.card.preClose, () => props.card.sig],
  () => paint(),
  { flush: 'post' }
)

/* 绘制分时图并重绘悬停态。仅依赖本卡片的数据，因此随卡片一起下沉。 */
function paint(hoverIdx = -1) {
  const c = props.card
  const cv = cvRef.value
  if (!cv) return
  /* canvas 刚挂载时可能尚未布局（clientWidth = 0），此时 setupCanvas 会退回 600，
     位图被 CSS 压缩到卡片宽度 → 图形变形、右侧价格轴被挤扁，看起来像"没撑满"。
     等一帧让布局完成再绘制。 */
  if (!cv.clientWidth) {
    requestAnimationFrame(() => paint(hoverIdx))
    return
  }
  const lay = drawMinute(cv, c.pts, c.preClose, hoverIdx)
  if (!lay) return
  bindChartHover(cv, {
    n: c.pts.length,
    X: lay.X,
    paint: (i) => drawMinute(cv, c.pts, c.preClose, i),
    tip: (i) => {
      const p = c.pts[i]
      if (!p) return []
      const chg = c.preClose > 0 ? ((p.p - c.preClose) / c.preClose) * 100 : 0
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
  <div class="sig-card">
    <!-- 卡片头部：名称 + 代码 + 删除按钮（右上角 ✕） -->
    <div class="sig-head">
      <div class="sig-name-block">
        <span class="sig-name" style="cursor: pointer" @click="emit('open', card)">
          {{ card.sig?.name || card.name }}
        </span>
        <span class="sig-code">{{ card.code }}</span>
        <!-- 当前股价（实时，最后一根分时真实成交价） -->
        <span v-if="curPrice != null && card.sig" class="sig-price" :class="cl(curChg)">
          {{ fx(curPrice) }}
        </span>
        <!-- 加自选：文字按钮 -->
        <button
          class="mini-watch"
          :class="{ on: card.watched }"
          :title="card.watched ? '从自选移除' : '加入自选'"
          @click="emit('toggle-watch', card)"
        >
          {{ card.watched ? '已自选' : '＋ 加自选' }}
        </button>
        <!-- 实时拉升/砸盘角标 -->
        <span
          v-if="card.sig && card.sig.state !== 'none'"
          class="live-badge"
          :class="card.sig.state"
        >
          {{ card.sig.state === 'up' ? '▲ 拉升中' : '▼ 砸盘中' }}
          {{ card.sig.curDev >= 0 ? '+' : '' }}{{ fx(card.sig.curDev, 2) }}%
        </span>
      </div>
      <button class="sig-del" title="从监控移除" @click="emit('remove', card.code)">×</button>
    </div>

    <!-- KPI 小行：阈值 + 拉升 + 砸盘 + 点数 -->
    <div v-if="card.sig" class="mini-kpi">
      <div class="mk">
        <div class="mk-l">阈值</div>
        <div class="mk-v">±{{ fx(card.sig.threshold, 2) }}%</div>
      </div>
      <div class="mk">
        <div class="mk-l">拉升</div>
        <div class="mk-v up">{{ card.sig.high.length }}</div>
      </div>
      <div class="mk">
        <div class="mk-l">砸盘</div>
        <div class="mk-v down">{{ card.sig.low.length }}</div>
      </div>
      <div class="mk">
        <div class="mk-l">点数</div>
        <div class="mk-v">{{ card.sig.points.length }}</div>
      </div>
    </div>

    <div v-if="card.loading && !card.sig" class="empty sm">加载中…</div>
    <div v-else-if="card.error" class="empty sm">{{ card.error }}</div>

    <!-- 分时图 -->
    <div v-if="card.sig" class="chart-box">
      <canvas ref="cvRef" class="chart-cv"></canvas>
    </div>

    <!-- 异动用 chip 横向排列 -->
    <div v-if="card.sig" class="sig-events-block">
      <div class="se-half">
        <span class="se-label up">▲ 拉升</span>
        <template v-if="card.sig.high.length">
          <span v-for="(m, i) in card.sig.high" :key="`h${i}`" class="se-chip up">
            {{ m.t }} · {{ fx(m.price) }} · +{{ fx(m.dev, 2) }}%{{ m.strong ? ' · 放量' : '' }}
          </span>
        </template>
        <span v-else class="muted-sm">无</span>
      </div>

      <div class="se-half">
        <span class="se-label down">▼ 砸盘</span>
        <template v-if="card.sig.low.length">
          <span v-for="(m, i) in card.sig.low" :key="`l${i}`" class="se-chip down">
            {{ m.t }} · {{ fx(m.price) }} · {{ fx(m.dev, 2) }}%{{ m.strong ? ' · 放量' : '' }}
          </span>
        </template>
        <span v-else class="muted-sm">无</span>
      </div>
    </div>

    <!-- 分时点位：默认 7 行，展开看全部 -->
    <div v-if="card.sig && card.sig.points.length" class="pts">
      <div class="pts-head" @click="togglePoints">
        <span class="muted-sm">分时点位（{{ card.sig.points.length }}）</span>
        <span class="muted-sm">{{ card.showAllPoints ? '收起 ▲' : '展开 ▼' }}</span>
      </div>
      <table class="pts-tbl">
        <thead>
          <tr>
            <th>时间</th>
            <th>价格</th>
            <th>均价</th>
            <th>偏离</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(p, i) in card.sig.points.slice(
              0,
              card.showAllPoints ? card.sig.points.length : 7
            )"
            :key="i"
          >
            <td>{{ p.t }}</td>
            <td>{{ fx(p.p) }}</td>
            <td>{{ fx(p.avg) }}</td>
            <td :class="cl(p.dev)">{{ sg(p.dev) }}{{ fx(p.dev, 2) }}%</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.sig-card {
  padding: 10px 12px;
  border: 1px solid var(--border, #e3e8ef);
  border-radius: 10px;
  background: var(--card);
  position: relative;
}
.sig-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.sig-name-block {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
/* 卡片名称+代码放大 4px（原 14 / 11.5） */
.sig-name {
  font-size: 18px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sig-code {
  font-size: 15.5px;
  color: var(--muted);
  font-family: var(--font-mono);
}
/* 卡片头部的当前股价：等宽数字，跟随涨跌色 */
.sig-price {
  font-size: 15.5px;
  font-weight: 700;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
/* 右上角删除按钮 */
.sig-del {
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  color: var(--muted);
  border-radius: 4px;
}
.sig-del:hover {
  color: var(--up);
  background: rgba(229, 57, 53, 0.08);
}

/* 卡片头部「加自选」文字按钮 —— 与个股弹窗同款 */
.mini-watch {
  border: 1px solid var(--border, #e3e8ef);
  background: transparent;
  cursor: pointer;
  font-size: 11.5px;
  font-weight: 600;
  line-height: 1;
  margin-left: 6px;
  padding: 3px 8px;
  border-radius: 5px;
  color: var(--muted);
  white-space: nowrap;
  transition: all 0.15s;
}
.mini-watch:hover {
  border-color: var(--primary);
  color: var(--primary);
  background: rgba(13, 71, 161, 0.06);
}
.mini-watch.on {
  border-color: #f5a623;
  color: #f5a623;
  background: rgba(245, 166, 35, 0.1);
}

/* 缩小版 KPI */
.mini-kpi {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
  margin-bottom: 6px;
}
.mk {
  padding: 4px 6px;
  border-radius: 6px;
  background: var(--card2);
  text-align: center;
}
.mk-l {
  font-size: 10.5px;
  color: var(--muted);
}
.mk-v {
  font-size: 13px;
  font-weight: 700;
  margin-top: 1px;
}

/* 分时图：padding 归零 + overflow hidden，让 canvas 真正撑满外层盒子 */
.chart-box {
  border-radius: 8px;
  padding: 0;
  margin-bottom: 8px;
  background: var(--card2);
  overflow: hidden;
  min-height: 220px;
}
.chart-cv {
  width: 100%;
  height: 100%;
  min-height: 220px;
  display: block;
}

/* 异动：合并到同一行，仅文字色（红/绿） */
.sig-events-block {
  display: flex;
  gap: 10px;
  margin-bottom: 8px;
  justify-content: center;
  font-size: 13px;
}
.se-half {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
}
.se-label {
  font-size: 13.5px;
  font-weight: 700;
  flex-shrink: 0;
}
.se-label.up {
  color: var(--up);
}
.se-label.down {
  color: #43a047;
}
.se-chip {
  padding: 0 2px;
  font-size: 12.5px;
  font-family: var(--font-mono);
  font-weight: 600;
}
.se-chip.up {
  color: #c62828;
}
.se-chip.down {
  color: #2e7d32;
}
.muted-sm {
  font-size: 14px;
  color: var(--muted);
}

/* 分时点位：默认 7 行 */
.pts {
  margin-top: 6px;
  border-top: 1px dashed var(--border);
  padding-top: 6px;
}
.pts-head {
  display: flex;
  justify-content: space-between;
  cursor: pointer;
  padding: 2px 0;
  margin-bottom: 4px;
}
.pts-tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 14.5px;
  font-family: var(--font-mono);
}
.pts-tbl th,
.pts-tbl td {
  padding: 3px 6px;
  text-align: center;
}
.pts-tbl thead th {
  color: var(--muted);
  font-weight: 500;
  border-bottom: 1px solid var(--border);
}

.empty.sm {
  padding: 8px;
  font-size: 12px;
}

/* 卡片头部实时拉升/砸盘角标 */
.live-badge {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 700;
  padding: 1px 8px;
  border-radius: 999px;
  white-space: nowrap;
  animation: lb-pulse 1.1s ease-in-out infinite;
}
.live-badge.up {
  color: #c62828;
  background: rgba(229, 57, 53, 0.12);
  border: 1px solid rgba(229, 57, 53, 0.35);
}
.live-badge.down {
  color: #2e7d32;
  background: rgba(67, 160, 71, 0.12);
  border: 1px solid rgba(67, 160, 71, 0.35);
}
@keyframes lb-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
</style>
