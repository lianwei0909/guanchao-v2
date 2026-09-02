<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api } from '@/api'
import type { ForecastRow } from '@/types/market'
import { cl, fx, pc, sg, yi } from '@/utils/format'
import StockDetailModal from './StockDetailModal.vue'

/* 预测 PP（对应旧版 renderForecast / loadForecast）。
   打分口径：均线多头 40 + 资金流入 25 + 量能 20 + 位置安全 15，
   资金强度另加 5~10 分；命中 score>=50 才入选（50 分门槛蕴含「均线多头」必为真）。
   注意：目标价/支撑位由 K 线推导（20 日高低点 + 均线），属技术位参考，非收益承诺。 */
const rows = ref<ForecastRow[]>([])
const date = ref('')
const loading = ref(true)
const error = ref('')
const detailStock = ref<{ code: string; name: string; secid: string } | null>(null)
/** 展开因子明细的行 */
const expanded = ref<string | null>(null)

/** 因子中文名（与后端 weeklyFactors 的 8 个因子一一对应） */
const FACTOR_LABELS: [keyof NonNullable<ForecastRow['qf']>, string][] = [
  ['mom_12_1', '12期动量'],
  ['rev_4', '4期反转'],
  ['low_vol_12', '低波动'],
  ['amount_trend', '量能趋势'],
  ['trend_dev', '趋势位置'],
  ['trend_slope', '均线斜率'],
  ['pos_52', '距52周高'],
  ['low_amp_8', '低振幅']
]

const kpi = computed(() => {
  const r = rows.value
  if (!r.length) return null
  const avg = r.reduce((a, b) => a + b.score, 0) / r.length
  return {
    count: r.length,
    avg: Math.round(avg * 10) / 10,
    strong: r.filter(x => x.view === '强烈看多').length,
    bull: r.filter(x => x.bull).length,
    cash: r.filter(x => x.cash).length
  }
})

const viewClass = (v: string) =>
  v === '强烈看多' ? 'up' : v === '看多' ? 'up' : v === '偏多' ? 'muted' : 'down'

async function load() {
  loading.value = true
  error.value = ''
  try {
    const d = await api.forecast()
    rows.value = d.list || []
    date.value = d.date || ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : '预测数据加载失败'
  } finally {
    loading.value = false
  }
}

function toggleRow(code: string) {
  expanded.value = expanded.value === code ? null : code
}

onMounted(load)
</script>

<template>
  <div>
    <div class="section-title">📈 预测 PP</div>
    <div class="muted" style="font-size: 13px; margin-bottom: 12px">
      量化选股：均线多头 + 资金流入 + 量能 + 位置安全 · 选股日 {{ date || '—' }} ·
      点击行查看详情，点击 ⓘ 展开 8 项周线因子
    </div>

    <div v-if="error" class="err-banner">
      <span>{{ error }}</span>
      <button @click="load">重试</button>
    </div>

    <div v-if="kpi" class="kpi-row">
      <div class="kpi">
        <div class="kpi-l">入选数量</div>
        <div class="kpi-v">{{ kpi.count }}</div>
        <div class="kpi-s">score ≥ 50</div>
      </div>
      <div class="kpi">
        <div class="kpi-l">平均评分</div>
        <div class="kpi-v">{{ fx(kpi.avg, 1) }}</div>
        <div class="kpi-s">满分 100</div>
      </div>
      <div class="kpi">
        <div class="kpi-l">强烈看多</div>
        <div class="kpi-v up">{{ kpi.strong }}</div>
        <div class="kpi-s">score ≥ 85</div>
      </div>
      <div class="kpi">
        <div class="kpi-l">均线多头</div>
        <div class="kpi-v">{{ kpi.bull }}</div>
        <div class="kpi-s">MA5&gt;10&gt;20&gt;60</div>
      </div>
      <div class="kpi">
        <div class="kpi-l">资金流入</div>
        <div class="kpi-v up">{{ kpi.cash }}</div>
        <div class="kpi-s">主力净流入为正</div>
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
            <th>评分</th>
            <th>观点</th>
            <th>目标价</th>
            <th>支撑</th>
            <th>上涨空间</th>
            <th>风险</th>
            <th>盈亏比</th>
            <th>主力净流入</th>
            <th>量比</th>
            <th>因子</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!rows.length">
            <td colspan="14">
              <div class="empty">{{ loading ? '加载中…' : '今日无符合条件标的' }}</div>
            </td>
          </tr>
          <template v-for="(r, i) in rows" :key="r.code">
            <tr
              @click="detailStock = { code: r.code, name: r.name, secid: r.secid }"
            >
              <td data-label="排名" class="muted">{{ i + 1 }}</td>
              <td data-label="代码/名称">
                <span class="c-name">{{ r.name }}</span>
                <span class="c-code">{{ r.code }}</span>
              </td>
              <td data-label="现价">{{ fx(r.price) }}</td>
              <td data-label="涨跌幅" :class="cl(r.pct)">{{ pc(r.pct) }}</td>
              <td data-label="评分">
                <span class="score-pill" :class="viewClass(r.view)">{{ r.score }}</span>
              </td>
              <td data-label="观点" :class="viewClass(r.view)">{{ r.view }}</td>
              <td data-label="目标价">{{ fx(r.target) }}</td>
              <td data-label="支撑">{{ fx(r.support) }}</td>
              <td data-label="上涨空间" class="up">+{{ fx(r.upside, 2) }}%</td>
              <td data-label="风险" class="down">-{{ fx(r.risk, 2) }}%</td>
              <td data-label="盈亏比">{{ r.rr == null ? '—' : fx(r.rr) }}</td>
              <td data-label="主力净流入" :class="cl(r.mainNetInflow)">{{ yi(r.mainNetInflow) }}</td>
              <td data-label="量比">{{ fx(r.volumeRatio) }}</td>
              <td data-label="因子">
                <button class="btn sm ghost" @click.stop="toggleRow(r.code)">
                  {{ expanded === r.code ? '收起' : 'ⓘ' }}
                </button>
              </td>
            </tr>

            <!-- 因子明细（展开行） -->
            <tr v-if="expanded === r.code" class="exp-row">
              <td colspan="14">
                <div class="exp-box">
                  <div class="exp-grid">
                    <div><span class="muted">偏离 MA20</span><b :class="cl(r.dev)">{{ sg(r.dev) }}{{ fx(r.dev, 2) }}%</b></div>
                    <div><span class="muted">净流入占比</span><b :class="cl(r.netRatio)">{{ sg(r.netRatio) }}{{ fx(r.netRatio, 2) }}%</b></div>
                    <div><span class="muted">MA5 / MA10</span><b>{{ fx(r.ma5) }} / {{ fx(r.ma10) }}</b></div>
                    <div><span class="muted">MA20 / MA60</span><b>{{ fx(r.ma20) }} / {{ fx(r.ma60) }}</b></div>
                    <div><span class="muted">20日高 / 低</span><b>{{ fx(r.hi20) }} / {{ fx(r.lo20) }}</b></div>
                    <div>
                      <span class="muted">条件命中</span>
                      <b>
                        <span :class="r.bull ? 'up' : 'muted'">多头</span>
                        <span :class="r.cash ? 'up' : 'muted'">资金</span>
                        <span :class="r.vol ? 'up' : 'muted'">量能</span>
                        <span :class="r.safe ? 'up' : 'muted'">位置</span>
                      </b>
                    </div>
                  </div>

                  <div v-if="r.qf" style="margin-top: 10px">
                    <div style="font-size: 12.5px; font-weight: 700; margin-bottom: 6px">
                      周线 8 因子（合成分 {{ r.qfScore }}）
                    </div>
                    <div class="fac-grid">
                      <div v-for="[k, label] in FACTOR_LABELS" :key="k" class="fac-cell">
                        <span class="muted">{{ label }}</span>
                        <b :class="cl(r.qf[k])">{{ fx(r.qf[k], 2) }}</b>
                      </div>
                    </div>
                    <div class="muted" style="font-size: 11.5px; margin-top: 6px">
                      因子为单票时序视角的降级近似（缺全市场横截面），仅供展示参考
                    </div>
                  </div>
                </div>
              </td>
            </tr>
          </template>
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

<style scoped>
.score-pill {
  display: inline-block;
  min-width: 34px;
  padding: 1px 7px;
  border-radius: 5px;
  font-weight: 700;
  font-size: 12.5px;
  color: #fff;
  background: #78909c;
  text-align: center;
}
.score-pill.up {
  background: linear-gradient(135deg, #e53935, #ff7043);
}
.score-pill.down {
  background: linear-gradient(135deg, #43a047, #66bb6a);
}
.exp-row:hover {
  background: transparent;
}
.exp-box {
  padding: 10px 12px;
  background: rgba(13, 71, 161, 0.04);
  border-radius: 8px;
  font-size: 12.5px;
}
.exp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px 14px;
}
.exp-grid > div,
.fac-cell {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.exp-grid b > span {
  margin-left: 5px;
  font-weight: 600;
}
.fac-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 5px 14px;
}
</style>
