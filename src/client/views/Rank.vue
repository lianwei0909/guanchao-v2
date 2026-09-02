<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { api } from '@/api'
import type { HotRow, LimitRow, MarketStat, RankRow, SectorRow } from '@/types/market'
import { cl, fx, pc, sg, yi } from '@/utils/format'
import StockDetailModal from './StockDetailModal.vue'

/* A股行情（对应旧版 renderRank / loadRank）。
   三个视图：股票排行 / 板块资金 / 人气热度。
   后两者是由「全景盘面」迁入的明细数据 —— 总览页只保留指数级纵览，
   明细统一收敛到这里，避免总览页一次拉上千条导致卡顿。 */
type TabKey = 'rank' | 'sector' | 'hot'
const TABS: [TabKey, string][] = [
  ['rank', '股票排行'],
  ['sector', '板块资金'],
  ['hot', '人气热度']
]

/* 涨跌停 / 连板 / 炸板排在维度最前 —— 盘中最关心情绪面（同花顺源）。
   这四个维度走 /api/fuyao-limit，列结构与常规排行不同，故单独渲染。 */
const DIMS: [string, string][] = [
  ['limitUp', '涨停'],
  ['limitDown', '跌停'],
  ['limitLadder', '连板'],
  ['limitBreak', '炸板'],
  ['changePct', '涨幅榜'],
  ['changePctD', '跌幅榜'],
  ['amount', '成交额榜'],
  ['turnover', '换手率榜'],
  ['volumeRatio', '量比榜'],
  ['amplitude', '振幅榜'],
  ['mainNetInflow', '主力净流入榜'],
  ['pe', '市盈率榜']
]
/** 涨跌停类维度 → 同花顺 kind */
const LIMIT_DIMS: Record<string, 'up' | 'down' | 'ladder' | 'break'> = {
  limitUp: 'up',
  limitDown: 'down',
  limitLadder: 'ladder',
  limitBreak: 'break'
}
const isLimitDim = (d: string) => !!LIMIT_DIMS[d]

const MKTS: [string, string][] = [
  ['all', '全部A股'],
  ['sh', '沪A'],
  ['sz', '深A'],
  ['cyb', '创业板'],
  ['kcb', '科创板'],
  ['bj', '北交所']
]
/** 板块类型：行业约 90 个，概念约 380 个 */
const SEC_TYPES: [SectorType, string][] = [
  ['industry', '行业板块'],
  ['concept', '概念板块']
]
const SEC_SORTS: [SectorSort, string][] = [
  ['flow', '按主力净流入'],
  ['pct', '按涨幅']
]
type SectorType = 'industry' | 'concept'
type SectorSort = 'flow' | 'pct'

const tab = ref<TabKey>('rank')

/* ===== 股票排行 ===== */
const mkt = ref('all')
const dim = ref('limitUp')
const rows = ref<RankRow[]>([])
const loading = ref(true)
const error = ref('')

/* ===== 涨跌停 / 连板 / 炸板 ===== */
const limitRows = ref<LimitRow[]>([])
const limitTotal = ref<number | null>(null)
const limitDate = ref('')

/* ===== 全市场统计（三个视图共用，常驻显示）===== */
const stat = ref<MarketStat | null>(null)

/* ===== 板块资金 ===== */
const secType = ref<SectorType>('industry')
const secSort = ref<SectorSort>('flow')
const sectors = ref<SectorRow[]>([])
const secLoading = ref(true)
const secError = ref('')

/* ===== 人气热度 ===== */
const hots = ref<HotRow[]>([])
const hotLoading = ref(true)
const hotError = ref('')

const detailStock = ref<{ code: string; name: string; secid: string } | null>(null)

let timer: number | undefined
let tick = 0
/** 各视图是否已首次加载过 —— 板块资金要翻页拉全量，按需加载避免拖慢首屏 */
const loaded = ref<Record<string, boolean>>({})

async function loadRank() {
  loading.value = true
  try {
    if (isLimitDim(dim.value)) {
      const r = await api.fuyaoLimit(LIMIT_DIMS[dim.value], 50)
      limitRows.value = r.list || []
      limitTotal.value = r.total == null ? null : r.total
      limitDate.value = r.date || ''
    } else {
      rows.value = await api.rank(mkt.value, dim.value, 50)
    }
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    loading.value = false
  }
}

/* 统计与排行分开刷新：排行 15 秒，统计变化慢走 120 秒，省请求 */
async function loadStat() {
  try {
    stat.value = await api.marketStat()
  } catch {
    /* 统计失败不影响排行展示 */
  }
}

async function loadSectors() {
  secLoading.value = true
  try {
    sectors.value = await api.sectorCapital(secType.value, secSort.value)
    secError.value = ''
  } catch (e) {
    secError.value = e instanceof Error ? e.message : '板块资金加载失败'
  } finally {
    secLoading.value = false
  }
}

async function loadHot() {
  hotLoading.value = true
  try {
    hots.value = await api.hot()
    hotError.value = ''
  } catch (e) {
    hotError.value = e instanceof Error ? e.message : '人气榜加载失败'
  } finally {
    hotLoading.value = false
  }
}

/** 切到某个视图时才首次拉数据 */
function ensureLoaded() {
  const t = tab.value
  if (loaded.value[t]) return
  loaded.value[t] = true
  if (t === 'sector') loadSectors()
  else if (t === 'hot') loadHot()
}

function openDetail(r: RankRow) {
  detailStock.value = { code: r.code, name: r.name, secid: r.secid }
}
/** 涨跌停/连板/炸板行：同花顺只给代码，市场码由代码前缀推断 */
function openLimit(r: LimitRow) {
  if (!r.code) return
  const m = /^(6|9)/.test(r.code) ? '1' : '0'
  detailStock.value = { code: r.code, name: r.name, secid: `${m}.${r.code}` }
}
/** 板块领涨股：无代码时不响应点击 */
function openLead(s: SectorRow) {
  if (!s.leadCode) return
  detailStock.value = { code: s.leadCode, name: s.lead, secid: s.leadSecid }
}
function openHot(r: HotRow) {
  detailStock.value = { code: r.code, name: r.name, secid: r.secid }
}

/** 连板天梯的日期 20250620 → 2025-06-20 */
const ladderDate = computed(() =>
  /^\d{8}$/.test(limitDate.value)
    ? `${limitDate.value.slice(0, 4)}-${limitDate.value.slice(4, 6)}-${limitDate.value.slice(6, 8)}`
    : limitDate.value
)

onMounted(() => {
  loadRank()
  loadStat()
  loaded.value.rank = true
  timer = window.setInterval(() => {
    tick += 1
    if (tab.value === 'rank') {
      /* 同花顺限流约 20 秒/次 + 后端缓存 5 分钟，涨跌停类 60 秒刷一次即可 */
      if (isLimitDim(dim.value)) {
        if (tick % 4 === 0) loadRank()
      } else {
        loadRank()
      }
    }
    /* 板块 / 热度变化较慢，60 秒刷一次即可（4 × 15s） */
    if (tick % 4 === 0) {
      if (tab.value === 'sector') loadSectors()
      if (tab.value === 'hot') loadHot()
    }
    if (tick % 8 === 0) loadStat()
  }, 15000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
watch([mkt, dim], loadRank)
watch([secType, secSort], () => {
  if (loaded.value.sector) loadSectors()
})
watch(tab, ensureLoaded)
</script>

<template>
  <div>
    <div class="section-title">🏆 A股行情</div>
    <div class="muted" style="font-size: 13px; margin-bottom: 12px">
      股票排行 · 板块资金 · 人气热度 —— 明细数据每 15～60 秒自动更新，点击行查看个股详情
    </div>

    <!-- 全市场统计（三个视图共用） -->
    <div v-if="stat" class="kpi-row">
      <div class="kpi">
        <div class="kpi-l">上涨家数</div>
        <div class="kpi-v up">{{ stat.up }}</div>
        <div class="kpi-s">占比 {{ stat.upPct }}%</div>
      </div>
      <div class="kpi">
        <div class="kpi-l">下跌家数</div>
        <div class="kpi-v down">{{ stat.down }}</div>
        <div class="kpi-s">占比 {{ stat.downPct }}%</div>
      </div>
      <div class="kpi">
        <div class="kpi-l">停牌 / 无数据</div>
        <div class="kpi-v muted">{{ stat.suspend == null ? '—' : stat.suspend }}</div>
        <div class="kpi-s">未计入涨跌家数</div>
      </div>
      <div class="kpi">
        <div class="kpi-l">两市成交额</div>
        <div class="kpi-v">{{ fx(stat.amount, 3) }}<span style="font-size: 13px"> 万亿</span></div>
        <div class="kpi-s">{{ fx(stat.amountYi, 0) }} 亿元</div>
      </div>
      <div class="kpi">
        <div class="kpi-l">主力净流入合计</div>
        <div class="kpi-v" :class="cl(stat.mainFlow)">
          {{ stat.mainFlow == null ? '统计中…' : yi(stat.mainFlow) }}
        </div>
        <div class="kpi-s">{{ stat.partial ? '精确统计中…' : '样本 ' + stat.sample + ' 只' }}</div>
      </div>
    </div>

    <!-- 视图切换 -->
    <div class="pg-tools">
      <div class="seg">
        <button v-for="t in TABS" :key="t[0]" :class="{ on: tab === t[0] }" @click="tab = t[0]">
          {{ t[1] }}
        </button>
      </div>
    </div>

    <!-- ===== 股票排行 ===== -->
    <div v-if="tab === 'rank'">
      <div v-if="error" class="err-banner">
        <span>{{ error }}</span>
        <button @click="loadRank">重试</button>
      </div>

      <!-- 市场筛选只对常规排行生效：同花顺四个池不支持按板块细分 -->
      <div v-if="!isLimitDim(dim)" class="pg-tools">
        <span class="lbl">市场</span>
        <div class="seg">
          <button v-for="m in MKTS" :key="m[0]" :class="{ on: mkt === m[0] }" @click="mkt = m[0]">
            {{ m[1] }}
          </button>
        </div>
      </div>
      <div class="pg-tools">
        <span class="lbl">维度</span>
        <div class="seg">
          <button v-for="d in DIMS" :key="d[0]" :class="{ on: dim === d[0] }" @click="dim = d[0]">
            {{ d[1] }}
          </button>
        </div>
      </div>

      <div class="muted" style="font-size: 12px; margin-bottom: 8px">
        <template v-if="isLimitDim(dim)">
          数据来源：同花顺<template v-if="limitDate"> · 交易日 {{ ladderDate }}</template>
          <template v-if="limitTotal != null"> · 全市场 {{ limitTotal }} 只</template>
          <template v-else> · 共 {{ limitRows.length }} 只</template>
        </template>
        <template v-else>数据来源：东方财富 · 前 50 名</template>
      </div>

      <!-- ===== 涨停池 ===== -->
      <div v-if="dim === 'limitUp'" class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>排名</th>
              <th>代码 / 名称</th>
              <th>现价</th>
              <th>涨跌幅</th>
              <th>涨停时间</th>
              <th>连板</th>
              <th>封单额</th>
              <th>涨停原因</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!limitRows.length">
              <td colspan="8">
                <div class="empty">{{ loading ? '加载中…' : '今日无涨停' }}</div>
              </td>
            </tr>
            <tr v-for="(s, i) in limitRows" :key="s.code" @click="openLimit(s)">
              <td data-label="排名" class="muted">{{ i + 1 }}</td>
              <td data-label="代码/名称">
                <span class="c-name">{{ s.name }}</span>
                <span class="c-code">{{ s.code }}<template v-if="s.isST"> · ST</template></span>
              </td>
              <td data-label="现价">{{ fx(s.price) }}</td>
              <td data-label="涨跌幅" :class="cl(s.pct)">{{ pc(s.pct) }}</td>
              <td data-label="涨停时间">{{ s.limitTime || '—' }}</td>
              <td data-label="连板">
                <span v-if="s.boardText" class="board-tag">{{ s.boardText }}</span>
                <span v-else class="muted">—</span>
              </td>
              <td data-label="封单额">{{ s.sealMoney == null ? '—' : fx(s.sealMoney) + '亿' }}</td>
              <td data-label="涨停原因" class="reason-cell">{{ s.reason || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- ===== 跌停池 ===== -->
      <div v-else-if="dim === 'limitDown'" class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>排名</th>
              <th>代码 / 名称</th>
              <th>现价</th>
              <th>涨跌幅</th>
              <th>首次跌停</th>
              <th>最后跌停</th>
              <th>换手率</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!limitRows.length">
              <td colspan="7">
                <div class="empty">{{ loading ? '加载中…' : '今日无跌停' }}</div>
              </td>
            </tr>
            <tr v-for="(s, i) in limitRows" :key="s.code" @click="openLimit(s)">
              <td data-label="排名" class="muted">{{ i + 1 }}</td>
              <td data-label="代码/名称">
                <span class="c-name">{{ s.name }}</span>
                <span class="c-code">{{ s.code }}</span>
              </td>
              <td data-label="现价">{{ fx(s.price) }}</td>
              <td data-label="涨跌幅" :class="cl(s.pct)">{{ pc(s.pct) }}</td>
              <td data-label="首次跌停">{{ s.firstTime || '—' }}</td>
              <td data-label="最后跌停">{{ s.lastTime || '—' }}</td>
              <td data-label="换手率">
                {{ s.turnoverPct == null ? '—' : fx(s.turnoverPct) + '%' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- ===== 连板天梯 ===== -->
      <div v-else-if="dim === 'limitLadder'" class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>排名</th>
              <th>代码 / 名称</th>
              <th>连板数</th>
              <th>次日封板</th>
              <th>标记等级</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!limitRows.length">
              <td colspan="5">
                <div class="empty">{{ loading ? '加载中…' : '今日无连板' }}</div>
              </td>
            </tr>
            <tr v-for="(s, i) in limitRows" :key="s.code" @click="openLimit(s)">
              <td data-label="排名" class="muted">{{ i + 1 }}</td>
              <td data-label="代码/名称">
                <span class="c-name">{{ s.name }}</span>
                <span class="c-code">{{ s.code }}</span>
              </td>
              <td data-label="连板数">
                <span class="board-tag">{{ s.board }} 板</span>
              </td>
              <td data-label="次日封板">
                <span v-if="s.sealNext === null" class="muted">—</span>
                <span v-else :class="s.sealNext ? 'up' : 'down'">
                  {{ s.sealNext ? '是' : '否' }}
                </span>
              </td>
              <td data-label="标记等级" class="muted">{{ s.signLevel ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- ===== 炸板池 ===== -->
      <div v-else-if="dim === 'limitBreak'" class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>排名</th>
              <th>代码 / 名称</th>
              <th>现价</th>
              <th>涨跌幅</th>
              <th>开板次数</th>
              <th>换手率</th>
              <th>成交额</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!limitRows.length">
              <td colspan="7">
                <div class="empty">{{ loading ? '加载中…' : '今日无炸板' }}</div>
              </td>
            </tr>
            <tr v-for="(s, i) in limitRows" :key="s.code" @click="openLimit(s)">
              <td data-label="排名" class="muted">{{ i + 1 }}</td>
              <td data-label="代码/名称">
                <span class="c-name">{{ s.name }}</span>
                <span class="c-code">{{ s.code }}</span>
              </td>
              <td data-label="现价">{{ fx(s.price) }}</td>
              <td data-label="涨跌幅" :class="cl(s.pct)">{{ pc(s.pct) }}</td>
              <td data-label="开板次数">{{ s.openTimes ?? '—' }}</td>
              <td data-label="换手率">
                {{ s.turnoverPct == null ? '—' : fx(s.turnoverPct) + '%' }}
              </td>
              <td data-label="成交额">
                {{ s.turnover == null ? '—' : fx(s.turnover) + '亿' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- ===== 常规排行 ===== -->
      <div v-else class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>排名</th>
              <th>代码 / 名称</th>
              <th>现价</th>
              <th>涨跌幅</th>
              <th>涨跌额</th>
              <th>成交额</th>
              <th>振幅</th>
              <th>换手</th>
              <th>量比</th>
              <th>市盈率</th>
              <th>主力净流入</th>
              <th>总市值</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!rows.length">
              <td colspan="12">
                <div class="empty">{{ loading ? '加载中…' : '暂无数据' }}</div>
              </td>
            </tr>
            <tr v-for="(s, i) in rows" :key="s.code" @click="openDetail(s)">
              <td data-label="排名" class="muted">{{ i + 1 }}</td>
              <td data-label="代码/名称">
                <span class="c-name">{{ s.name }}</span>
                <span class="c-code">{{ s.code }}</span>
              </td>
              <td data-label="现价">{{ fx(s.price) }}</td>
              <td data-label="涨跌幅" :class="cl(s.pct)">{{ pc(s.pct) }}</td>
              <td data-label="涨跌额" :class="cl(s.change)">{{ sg(s.change) }}{{ fx(s.change) }}</td>
              <td data-label="成交额">{{ yi(s.amount) }}</td>
              <td data-label="振幅">{{ fx(s.amplitude) }}%</td>
              <td data-label="换手">{{ fx(s.turnover) }}%</td>
              <td data-label="量比">{{ fx(s.volumeRatio) }}</td>
              <td data-label="市盈率">{{ fx(s.pe) }}</td>
              <td data-label="主力净流入" :class="cl(s.mainNetInflow)">{{ yi(s.mainNetInflow) }}</td>
              <td data-label="总市值">{{ yi(s.mktcap) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ===== 板块资金 ===== -->
    <div v-if="tab === 'sector'">
      <div v-if="secError" class="err-banner">
        <span>{{ secError }}</span>
        <button @click="loadSectors">重试</button>
      </div>

      <div class="pg-tools">
        <span class="lbl">类型</span>
        <div class="seg">
          <button
            v-for="t in SEC_TYPES"
            :key="t[0]"
            :class="{ on: secType === t[0] }"
            @click="secType = t[0]"
          >
            {{ t[1] }}
          </button>
        </div>
      </div>
      <div class="pg-tools">
        <span class="lbl">排序</span>
        <div class="seg">
          <button
            v-for="s in SEC_SORTS"
            :key="s[0]"
            :class="{ on: secSort === s[0] }"
            @click="secSort = s[0]"
          >
            {{ s[1] }}
          </button>
        </div>
      </div>

      <div class="muted" style="font-size: 12px; margin-bottom: 8px">
        共 {{ sectors.length }} 个板块 · 金额单位亿元 · 点击领涨股查看详情
      </div>

      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>排名</th>
              <th>板块名称</th>
              <th>涨跌幅</th>
              <th>主力净流入</th>
              <th>超大单</th>
              <th>大单</th>
              <th>中单</th>
              <th>小单</th>
              <th>涨 / 跌</th>
              <th>领涨股</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!sectors.length">
              <td colspan="10">
                <div class="empty">{{ secLoading ? '加载中…' : '暂无数据' }}</div>
              </td>
            </tr>
            <tr v-for="(s, i) in sectors" :key="s.secid || s.code">
              <td data-label="排名" class="muted">{{ i + 1 }}</td>
              <td data-label="板块名称">
                <span class="c-name">{{ s.name }}</span>
              </td>
              <td data-label="涨跌幅" :class="cl(s.pct)">{{ pc(s.pct) }}</td>
              <td data-label="主力净流入" :class="cl(s.flow)">{{ yi(s.flow) }}</td>
              <td data-label="超大单" :class="cl(s.superAmt)">
                <div>{{ yi(s.superAmt) }}</div>
                <div class="c-code">{{ fx(s.superPct) }}%</div>
              </td>
              <td data-label="大单" :class="cl(s.bigAmt)">
                <div>{{ yi(s.bigAmt) }}</div>
                <div class="c-code">{{ fx(s.bigPct) }}%</div>
              </td>
              <td data-label="中单" :class="cl(s.midAmt)">
                <div>{{ yi(s.midAmt) }}</div>
                <div class="c-code">{{ fx(s.midPct) }}%</div>
              </td>
              <td data-label="小单" :class="cl(s.smallAmt)">
                <div>{{ yi(s.smallAmt) }}</div>
                <div class="c-code">{{ fx(s.smallPct) }}%</div>
              </td>
              <td data-label="涨跌家数">
                <span class="up">{{ s.up }}</span>
                <span class="muted"> / </span>
                <span class="down">{{ s.down }}</span>
              </td>
              <td
                data-label="领涨股"
                :class="s.leadCode ? 'lead-cell' : ''"
                @click.stop="openLead(s)"
              >
                <span class="c-name">{{ s.lead || '—' }}</span>
                <span v-if="s.lead" class="c-code" :class="cl(s.leadPct)">{{ pc(s.leadPct) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ===== 人气热度 ===== -->
    <div v-if="tab === 'hot'">
      <div v-if="hotError" class="err-banner">
        <span>{{ hotError }}</span>
        <button @click="loadHot">重试</button>
      </div>

      <div class="muted" style="font-size: 12px; margin-bottom: 8px">
        按成交额换算人气值，越活跃排名越高 · 共 {{ hots.length }} 只
      </div>

      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>排名</th>
              <th>代码 / 名称</th>
              <th>现价</th>
              <th>涨跌幅</th>
              <th>人气值</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!hots.length">
              <td colspan="5">
                <div class="empty">{{ hotLoading ? '加载中…' : '暂无数据' }}</div>
              </td>
            </tr>
            <tr v-for="r in hots" :key="r.code" @click="openHot(r)">
              <td data-label="排名" class="muted">{{ r.rank }}</td>
              <td data-label="代码/名称">
                <span class="c-name">{{ r.name }}</span>
                <span class="c-code">{{ r.code }}</span>
              </td>
              <td data-label="现价">{{ fx(r.price) }}</td>
              <td data-label="涨跌幅" :class="cl(r.pct)">{{ pc(r.pct) }}</td>
              <td data-label="人气值">{{ fx(r.heat, 0) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
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
/* 领涨股可点击时给一点视觉提示 */
.lead-cell {
  cursor: pointer;
}
.lead-cell:hover .c-name {
  text-decoration: underline;
}
/* 连板标签 */
.board-tag {
  display: inline-block;
  padding: 1px 7px;
  border-radius: 4px;
  font-size: 11.5px;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(135deg, #e53935, #ff7043);
  white-space: nowrap;
}
/* 涨停原因通常较长，限宽并省略 */
.reason-cell {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--muted);
}
</style>
