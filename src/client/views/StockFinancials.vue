<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '@/api'
import type { AbilityBlock, FinancialRow } from '@/types/market'

/* 个股财务分析（同花顺 fuyao 源）。
   注意：实测返回的 index_id 与文档不完全一致 —— 部分带 calculate_ 前缀
   （如 calculate_operating_income_yoy_growth_ratio），故中文名映射做宽松匹配。 */
const props = defineProps<{ code: string }>()

type Tab = 'indicators' | 'income' | 'balance' | 'cashflow'
const TABS: [Tab, string][] = [
  ['indicators', '财务指标'],
  ['income', '利润表'],
  ['balance', '资产负债表'],
  ['cashflow', '现金流量表']
]

const tab = ref<Tab>('indicators')
const abilities = ref<AbilityBlock[]>([])
const rows = ref<FinancialRow[]>([])
const loading = ref(false)
const error = ref('')

/* 报告期：只列「已披露」的期间，默认选最新一期。
   A股披露节奏（最晚时点）：一季报 4/30、中报 8/31、三季报 10/31、年报 次年 4/30。
   请求尚未披露的报告期会让上游直接报错（实测 2026-09 请求 2026-3 → 502），
   所以必须按当前日期裁剪，而不是无脑列全 Y-1..Y-4。 */
function availableReports(now = new Date()): string[] {
  const Y = now.getFullYear()
  const M = now.getMonth() + 1
  const out: string[] = []
  if (M >= 10) out.push(`${Y}-3`)
  if (M >= 8) out.push(`${Y}-2`)
  if (M >= 4) out.push(`${Y}-1`)
  /* 上一年年报在次年 4/30 前披露：1-3 月时它还没出，退回前年年报 */
  out.push(M >= 4 ? `${Y - 1}-4` : `${Y - 2}-4`)
  out.push(`${Y - 1}-3`, `${Y - 1}-2`, `${Y - 1}-1`, `${Y - 2}-4`, `${Y - 2}-3`)
  return out.filter((r, i) => out.indexOf(r) === i)   // 去重且保持顺序
}

const reportOptions = computed(() => availableReports())
/** 默认选中最新已披露报告期 */
const report = ref(reportOptions.value[0])

/** 2026-2 → 2026年中报 */
function reportLabel(r: string): string {
  const [y, q] = r.split('-')
  const name = q === '1' ? '一季报' : q === '2' ? '中报' : q === '3' ? '三季报' : '年报'
  return `${y}年${name}`
}

const ID_NAME: Record<string, string> = {
  total_assets_growth_ratio: '总资产增长率',
  net_profit_yoy_growth_ratio: '净利润同比增长率',
  operating_income_yoy_growth_ratio: '营业收入同比增长率',
  operating_profit_yoy_growth_ratio: '营业利润同比增长率',
  sale_gross_margin: '销售毛利率',
  sale_net_interest_ratio: '销售净利率',
  total_assets_net_ratio: '总资产收益率',
  index_deduct_weighted_avg_roe: '扣非加权净资产收益率',
  index_weighted_avg_roe: '净资产收益率',
  current_ratio: '流动比率',
  quick_ratio: '速动比率',
  assets_debt_ratio: '资产负债率',
  cash_ratio: '现金比率',
  earned_interest_multiple: '已获利息倍数',
  long_term_debt_equity_ratio: '长期负债权益比率',
  total_assets_turnover_ratio: '总资产周转率',
  inventory_turnover_ratio: '存货周转率',
  current_assets_turnover_ratio: '流动资产周转率',
  receive_account_turnover_ratio: '应收账款周转率',
  cash_operating_index: '现金营运指数',
  operating_cash_flow_net_divide_income: '销售现金比率',
  net_profit_cash_content: '净利润现金含量',
  operating_cash_net_yoy_growth_ratio: '现金流量净额增长率',
  cash_meet_invest_ratio: '现金满足投资比率'
}
const ABILITY_NAME: Record<string, string> = {
  growth: '成长能力',
  profitability: '盈利能力',
  solvency: '偿债能力',
  operation: '营运能力',
  'cash-flow': '现金流'
}

function idName(id: string): string {
  if (ID_NAME[id]) return ID_NAME[id]
  return ID_NAME[id.replace(/^calculate_/, '')] || id
}

/** 百分比类指标（按名称识别，与文档口径一致） */
function isPct(name: string): boolean {
  return /增长率|毛利率|净利率|收益率|资产负债率|现金比率|含量/.test(name)
}

function fmtVal(v: string | null, name: string): string {
  if (v == null || v === '') return '--'
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v)
  return isPct(name) ? n.toFixed(2) + '%' : n.toFixed(2)
}

/** 报表金额：原币元 → 亿元 */
function yi(v?: number, d = 2): string {
  if (v == null || !Number.isFinite(v)) return '--'
  return (v / 1e8).toFixed(d)
}

const STAT_FIELDS: Record<string, [string, string][]> = {
  income: [
    ['operating_income', '营业收入'],
    ['operating_costs', '营业成本'],
    ['operating_profit', '营业利润'],
    ['net_profit', '净利润'],
    ['parent_holder_net_profit', '归母净利润'],
    ['basic_eps', '基本每股收益']
  ],
  balance: [
    ['assets_total', '资产总计'],
    ['total_current_assets', '流动资产合计'],
    ['total_debt', '负债合计'],
    ['holder_equity_total', '所有者权益合计'],
    ['cash', '货币资金'],
    ['accounts_receivable', '应收账款']
  ],
  cashflow: [
    ['act_cash_flow_net', '经营活动现金流净额'],
    ['invest_cash_flow_net', '投资活动现金流净额'],
    ['financing_cash_flow_net', '筹资活动现金流净额'],
    ['cash_equivalents_net_addition', '现金及等价物净增加额']
  ]
}

async function loadIndicators() {
  loading.value = true
  error.value = ''
  try {
    const d = await api.financialIndicators(props.code, report.value)
    abilities.value = d?.abilities || []
    if (!abilities.value.length) error.value = '该报告期暂无财务指标'
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败'
    abilities.value = []
  } finally {
    loading.value = false
  }
}

async function loadStatement() {
  if (tab.value === 'indicators') return
  loading.value = true
  error.value = ''
  try {
    const d = await api.financials(props.code, tab.value, 'annual', 4)
    rows.value = d?.list || []
    if (!rows.value.length) error.value = '暂无报表数据'
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败'
    rows.value = []
  } finally {
    loading.value = false
  }
}

function switchTab(t: Tab) {
  tab.value = t
  if (t === 'indicators') loadIndicators()
  else loadStatement()
}

onMounted(loadIndicators)
watch(() => props.code, () => (tab.value === 'indicators' ? loadIndicators() : loadStatement()))
</script>

<template>
  <div>
    <div class="pg-tools" style="margin-top: 10px">
      <div class="seg">
        <button v-for="t in TABS" :key="t[0]" :class="{ on: tab === t[0] }" @click="switchTab(t[0])">
          {{ t[1] }}
        </button>
      </div>
    </div>

    <div v-if="tab === 'indicators'" class="pg-tools">
      <span class="lbl">报告期</span>
      <select v-model="report" class="wl-input" style="max-width: 150px" @change="loadIndicators">
        <option v-for="r in reportOptions" :key="r" :value="r">{{ reportLabel(r) }}</option>
      </select>
    </div>

    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="error" class="empty">{{ error }}</div>

    <!-- 财务指标：五类分组 -->
    <template v-else-if="tab === 'indicators'">
      <div v-for="a in abilities" :key="a.ability" style="margin-bottom: 10px">
        <div style="font-size: 12.5px; font-weight: 600; margin: 6px 0">
          {{ ABILITY_NAME[a.ability] || a.ability }}
        </div>
        <div
          style="
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(128px, 1fr));
            gap: 8px;
          "
        >
          <div
            v-for="it in a.indicators"
            :key="it.index_id"
            style="background: var(--card2); border-radius: 8px; padding: 7px 9px"
          >
            <div style="font-size: 11px; color: var(--muted)">{{ idName(it.index_id) }}</div>
            <div style="font-size: 13.5px; font-weight: 600">
              {{ fmtVal(it.value, idName(it.index_id)) }}
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- 三张报表 -->
    <template v-else-if="rows.length">
      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>报告期</th>
              <th v-for="f in STAT_FIELDS[tab]" :key="f[0]">{{ f[1] }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.period_end_ms">
              <td class="muted">{{ r.fiscal_year }} {{ r.fiscal_period }}</td>
              <td v-for="f in STAT_FIELDS[tab]" :key="f[0]">
                {{ f[0] === 'basic_eps' ? (r.basic_eps ?? '--') : yi(r[f[0]] as number) + '亿' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <div style="font-size: 11.5px; color: var(--muted); margin-top: 8px">
      数据来源：同花顺（金额单位已换算为亿元，每股收益单位为元）
    </div>
  </div>
</template>
