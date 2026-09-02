<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { api } from '@/api'
import type { YouziResp, YouziSeat } from '@/types/market'
import { cl, fx, pc, yi } from '@/utils/format'
import StockDetailModal from './StockDetailModal.vue'
import YouziPortraitModal from './YouziPortraitModal.vue'

/* 游资操作（对应旧版 renderYouzi / loadYouzi）。
   龙虎榜在收盘后（约 18:00）发布，故默认展示接口返回的最新交易日。
   席位聚合口径：机构专用 / 沪股通 / 深股通属被动席位，已排除出「游资净买」统计。 */
const data = ref<YouziResp | null>(null)
const loading = ref(true)
const error = ref('')

/** 个股 TOP 视角：买入 / 卖出 */
const stockSide = ref<'buy' | 'sell'>('buy')
/** 游资卡片搜索（192 个席位，不搜的话要滚很久） */
const seatKw = ref('')
/** 明细搜索：支持代码 / 名称 / 营业部 / 游资名号 */
const detailKw = ref('')
/** 席位初始展示数；点「展开更多」后放开全部（192 个全渲染会卡，故默认折叠） */
const SEAT_INIT = 32
/** 明细初始条数与每次「加载更多」的增量 */
const DETAIL_STEP = 50

/** 席位是否已展开全部 */
const seatExpanded = ref(false)
/** 明细当前展示条数 */
const detailShown = ref(DETAIL_STEP)

/** 切换搜索词时把明细重置回第一页，否则会带着上一次的条数 */
watch(detailKw, () => {
  detailShown.value = DETAIL_STEP
})

const portraitSeat = ref<YouziSeat | null>(null)
const detailStock = ref<{ code: string; name: string; secid: string } | null>(null)

let timer: number | undefined

async function load() {
  loading.value = true
  try {
    data.value = await api.youzi()
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : '游资数据加载失败'
  } finally {
    loading.value = false
  }
}

const kpi = computed(() => data.value?.kpi)
const stockTop = computed(() =>
  stockSide.value === 'buy'
    ? data.value?.stocksRank.buyTop || []
    : data.value?.stocksRank.sellTop || []
)

/** 明细关键字匹配（席位与明细各自独立复用） */
function matchSeat(s: { name: string }, kw: string) {
  return s.name.includes(kw)
}
function matchDetail(
  x: { code: string; name: string; dept: string; youzi: string },
  kw: string
) {
  return (
    x.code.includes(kw) ||
    x.name.toLowerCase().includes(kw) ||
    x.dept.toLowerCase().includes(kw) ||
    x.youzi.toLowerCase().includes(kw)
  )
}

/** 席位命中总数（未截断） */
const seatHit = computed(() => {
  const all = data.value?.hotSeats || []
  const kw = seatKw.value.trim()
  return kw ? all.filter(s => matchSeat(s, kw)).length : all.length
})

/** 游资卡片：过滤后按展开状态截断 */
const filteredSeats = computed(() => {
  const all = data.value?.hotSeats || []
  const kw = seatKw.value.trim()
  const hit = kw ? all.filter(s => matchSeat(s, kw)) : all
  return seatExpanded.value ? hit : hit.slice(0, SEAT_INIT)
})
/** 未展示的席位数量 */
const seatRest = computed(() => Math.max(0, seatHit.value - filteredSeats.value.length))

/** 明细命中总数（未截断） */
const detailHit = computed(() => {
  const all = data.value?.detail || []
  const kw = detailKw.value.trim().toLowerCase()
  return kw ? all.filter(x => matchDetail(x, kw)).length : all.length
})

/** 明细表：过滤后按当前展示条数截断 */
const filteredDetail = computed(() => {
  const all = data.value?.detail || []
  const kw = detailKw.value.trim().toLowerCase()
  const hit = kw ? all.filter(x => matchDetail(x, kw)) : all
  return hit.slice(0, detailShown.value)
})
/** 未展示的明细条数 */
const detailRest = computed(() => Math.max(0, detailHit.value - filteredDetail.value.length))

function loadMoreDetail() {
  detailShown.value += DETAIL_STEP
}

function openPortrait(s: YouziSeat) {
  portraitSeat.value = s
}

onMounted(() => {
  load()
  /* 龙虎榜收盘后才更新，5 分钟刷一次足够 */
  timer = window.setInterval(load, 300000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div>
    <div class="section-title">🐉 游资操作</div>
    <div class="muted" style="font-size: 13px; margin-bottom: 12px">
      龙虎榜席位聚合 · 交易日 {{ data?.date || '—' }} · 点击游资卡片查看画像，点击个股查看详情
    </div>

    <div v-if="error" class="err-banner">
      <span>{{ error }}</span>
      <button @click="load">重试</button>
    </div>

    <!-- KPI -->
    <div v-if="kpi" class="kpi-row">
      <div class="kpi">
        <div class="kpi-l">游资净买入</div>
        <div class="kpi-v" :class="cl(kpi.netSum)">{{ yi(kpi.netSum) }}</div>
        <div class="kpi-s">已排除机构/股通席位</div>
      </div>
      <div class="kpi">
        <div class="kpi-l">上榜游资</div>
        <div class="kpi-v">{{ kpi.seatCount }}</div>
        <div class="kpi-s">知名游资名号</div>
      </div>
      <div class="kpi">
        <div class="kpi-l">涉及股票</div>
        <div class="kpi-v">{{ kpi.stockCount }}</div>
        <div class="kpi-s">只</div>
      </div>
      <div class="kpi">
        <div class="kpi-l">龙虎榜成交</div>
        <div class="kpi-v">{{ fx(kpi.dealAmt, 2) }}<span style="font-size: 13px"> 亿</span></div>
        <div class="kpi-s">上榜个股合计</div>
      </div>
      <div class="kpi">
        <div class="kpi-l">活跃营业部</div>
        <div class="kpi-v">{{ kpi.deptCount }}</div>
        <div class="kpi-s">家</div>
      </div>
    </div>

    <div v-if="loading && !data" class="empty">加载中…</div>

    <template v-if="data">
      <!-- ===== 游资卡片 ===== -->
      <div class="pg-tools">
        <span class="lbl">游资席位</span>
        <input
          v-model="seatKw"
          class="kw-input"
          type="text"
          placeholder="搜索游资名号…"
          style="flex: 0 0 200px"
        />
        <span class="muted" style="font-size: 12px">
          共 {{ seatHit }} 个席位<template v-if="seatKw.trim()"> · 命中 {{ seatHit }}</template>
          <template v-if="seatRest && !seatExpanded">
            · 已显示 {{ filteredSeats.length }}
          </template>
        </span>
      </div>

      <div class="yz-grid">
        <div
          v-for="s in filteredSeats"
          :key="s.rawName"
          class="yz-card"
          :class="{ known: s.isKnown }"
          @click="openPortrait(s)"
        >
          <div class="yz-card-h">
            <span class="yz-avatar" :class="cl(s.net)">{{ s.initial }}</span>
            <span class="yz-name">{{ s.name }}</span>
          </div>
          <div class="yz-net" :class="cl(s.net)">{{ yi(s.net) }}</div>
          <div class="yz-meta">
            <span>{{ s.stocks }} 只股</span>
            <span>{{ s.depts }} 营业部</span>
            <span v-if="s.isKnown" class="yz-badge">知名</span>
          </div>
        </div>
      </div>
      <div v-if="!filteredSeats.length" class="empty">无匹配席位</div>

      <!-- 席位展开 / 收起 -->
      <div v-if="seatHit > SEAT_INIT" class="more-row">
        <button class="btn sm ghost" @click="seatExpanded = !seatExpanded">
          {{ seatExpanded ? '收起' : `展开更多（还有 ${seatRest} 个）` }}
        </button>
      </div>

      <!-- ===== 个股 TOP10 ===== -->
      <div class="pg-tools" style="margin-top: 16px">
        <span class="lbl">个股 TOP</span>
        <div class="seg">
          <button :class="{ on: stockSide === 'buy' }" @click="stockSide = 'buy'">净买入</button>
          <button :class="{ on: stockSide === 'sell' }" @click="stockSide = 'sell'">净卖出</button>
        </div>
      </div>

      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>排名</th>
              <th>代码 / 名称</th>
              <th>现价</th>
              <th>涨跌幅</th>
              <th>净买入</th>
              <th>买入</th>
              <th>卖出</th>
              <th>成交额</th>
              <th>换手</th>
              <th>原因</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!stockTop.length">
              <td colspan="10"><div class="empty">暂无数据</div></td>
            </tr>
            <tr
              v-for="(s, i) in stockTop"
              :key="s.code"
              @click="detailStock = { code: s.code, name: s.name, secid: s.secid }"
            >
              <td data-label="排名" class="muted">{{ i + 1 }}</td>
              <td data-label="代码/名称">
                <span class="c-name">{{ s.name }}</span>
                <span class="c-code">{{ s.code }}<template v-if="s.inst"> · 机构</template></span>
              </td>
              <td data-label="现价">{{ fx(s.price) }}</td>
              <td data-label="涨跌幅" :class="cl(s.pct)">{{ pc(s.pct) }}</td>
              <td data-label="净买入" :class="cl(s.net)">{{ yi(s.net) }}</td>
              <td data-label="买入" class="up">{{ fx(s.buy) }}亿</td>
              <td data-label="卖出" class="down">{{ fx(s.sell) }}亿</td>
              <td data-label="成交额">{{ fx(s.dealAmt) }}亿</td>
              <td data-label="换手">{{ fx(s.turnover) }}%</td>
              <td data-label="原因" class="reason-cell">{{ s.reason }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- ===== 营业部明细 ===== -->
      <div class="pg-tools" style="margin-top: 16px">
        <span class="lbl">营业部明细</span>
        <input
          v-model="detailKw"
          class="kw-input"
          type="text"
          placeholder="搜索代码 / 名称 / 营业部 / 游资…"
          style="flex: 0 0 240px"
        />
        <span class="muted" style="font-size: 12px">
          共 {{ detailHit }} 条<template v-if="detailKw.trim()"> · 命中 {{ detailHit }}</template>
          <template v-if="detailRest"> · 已显示 {{ filteredDetail.length }}</template>
        </span>
      </div>

      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>代码 / 名称</th>
              <th>游资</th>
              <th>营业部</th>
              <th>买入</th>
              <th>卖出</th>
              <th>净额</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!filteredDetail.length">
              <td colspan="6"><div class="empty">无匹配记录</div></td>
            </tr>
            <tr v-for="(d, i) in filteredDetail" :key="`${d.code}-${d.dept}-${i}`">
              <td data-label="代码/名称">
                <span
                  class="c-name lead-cell"
                  @click.stop="detailStock = { code: d.code, name: d.name, secid: '' }"
                  >{{ d.name }}</span
                >
                <span class="c-code">{{ d.code }}</span>
              </td>
              <td data-label="游资">{{ d.youzi }}</td>
              <td data-label="营业部" class="reason-cell">{{ d.dept }}</td>
              <td data-label="买入" class="up">{{ fx(d.buy) }}亿</td>
              <td data-label="卖出" class="down">{{ fx(d.sell) }}亿</td>
              <td data-label="净额" :class="cl(d.net)">{{ yi(d.net) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 明细加载更多：每次追加 50 条 -->
      <div v-if="detailRest" class="more-row">
        <button class="btn sm ghost" @click="loadMoreDetail">
          加载更多（还有 {{ detailRest }} 条）
        </button>
      </div>
    </template>

    <YouziPortraitModal
      v-if="portraitSeat"
      :seat="portraitSeat"
      :date="data?.date || ''"
      @close="portraitSeat = null"
    />
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
.yz-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px;
}
/* 展开 / 加载更多按钮居中 */
.more-row {
  display: flex;
  justify-content: center;
  margin: 12px 0 4px;
}
.yz-card {
  border: 1px solid var(--border, #e3e8ef);
  border-radius: 10px;
  padding: 10px 12px;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.yz-card:hover {
  border-color: var(--primary);
  box-shadow: 0 2px 10px rgba(13, 71, 161, 0.12);
}
.yz-card.known {
  border-left: 3px solid #e53935;
}
.yz-card-h {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.yz-avatar {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  font-size: 13px;
  font-weight: 700;
  color: #fff;
  background: #78909c;
  flex-shrink: 0;
}
.yz-name {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.yz-net {
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 4px;
}
.yz-meta {
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: var(--muted);
  flex-wrap: wrap;
}
.yz-badge {
  padding: 0 5px;
  border-radius: 3px;
  background: #ffebee;
  color: #e53935;
  font-weight: 700;
}
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
.reason-cell {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--muted);
}
.lead-cell {
  cursor: pointer;
}
.lead-cell:hover {
  text-decoration: underline;
}
</style>
