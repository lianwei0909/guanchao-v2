<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api } from '@/api'
import type { YouziPortrait, YouziSeat } from '@/types/market'
import { cl, fx, yi } from '@/utils/format'

/* 游资画像（对应旧版 /api/youzi-portrait）。
   展示该名号下的关联营业部 + 当日交易明细，用于判断席位联动与操作风格。 */
const props = defineProps<{ seat: YouziSeat; date?: string }>()
const emit = defineEmits<{
  (e: 'close'): void
  /** 点击明细里的个股：交给上层打开个股详情弹窗（避免弹窗套弹窗的层级冲突） */
  (e: 'openStock', s: { code: string; name: string; secid: string }): void
}>()

/** 由 6 位代码推断东财 secid：6/9 开头为沪市(1)，其余归深市/北交所(0) */
function secidOf(code: string): string {
  return (/^(6|9)/.test(code) ? '1' : '0') + '.' + code
}

const data = ref<YouziPortrait | null>(null)
const loading = ref(true)
const err = ref('')

/* 汇总：净买入合计 / 买入合计 / 卖出合计 / 涉及股票数 */
const sum = computed(() => {
  const ts = data.value?.trades || []
  const net = ts.reduce((a, b) => a + (b.net || 0), 0)
  const buy = ts.reduce((a, b) => a + (b.buy || 0), 0)
  const sell = ts.reduce((a, b) => a + (b.sell || 0), 0)
  return { net, buy, sell, codes: new Set(ts.map(x => x.code)).size }
})

onMounted(async () => {
  try {
    data.value = await api.youziPortrait(props.seat.name, props.date)
  } catch (e) {
    err.value = e instanceof Error ? e.message : '画像加载失败'
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="modal-mask show" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-head">
        <h3>
          {{ seat.name }}
          <span class="muted" style="font-size: 13px; font-weight: 400">
            {{ seat.isKnown ? '知名游资' : '未归类营业部' }}
          </span>
        </h3>
        <button class="modal-close" @click="emit('close')">×</button>
      </div>

      <!-- 席位概览 -->
      <div class="kpi-row" style="margin-bottom: 12px">
        <div class="kpi">
          <div class="kpi-l">净买入</div>
          <div class="kpi-v" :class="cl(seat.net)">{{ yi(seat.net) }}</div>
          <div class="kpi-s">当日席位合计</div>
        </div>
        <div class="kpi">
          <div class="kpi-l">涉及股票</div>
          <div class="kpi-v">{{ seat.stocks }}</div>
          <div class="kpi-s">只</div>
        </div>
        <div class="kpi">
          <div class="kpi-l">关联营业部</div>
          <div class="kpi-v">{{ data?.depts.length ?? seat.depts }}</div>
          <div class="kpi-s">家</div>
        </div>
        <div class="kpi">
          <div class="kpi-l">明细净额</div>
          <div class="kpi-v" :class="cl(sum.net)">{{ yi(sum.net) }}</div>
          <div class="kpi-s">买 {{ fx(sum.buy) }} / 卖 {{ fx(sum.sell) }} 亿</div>
        </div>
      </div>

      <div v-if="loading" class="empty">加载中…</div>
      <div v-else-if="err" class="empty">{{ err }}</div>

      <template v-if="data">
        <!-- 关联营业部 -->
        <div style="font-size: 13px; font-weight: 700; margin: 4px 0 6px">
          关联营业部（{{ data.depts.length }}）
        </div>
        <div v-if="!data.depts.length" class="muted" style="font-size: 12px">无匹配营业部</div>
        <ul v-else style="margin: 0 0 12px; padding-left: 18px; font-size: 12.5px">
          <li v-for="d in data.depts" :key="d" style="margin-bottom: 3px">{{ d }}</li>
        </ul>

        <!-- 交易明细 -->
        <div style="font-size: 13px; font-weight: 700; margin: 4px 0 6px">
          当日交易明细（{{ data.trades.length }}）
        </div>
        <div class="tbl-wrap" style="max-height: 300px; overflow: auto">
          <table class="tbl">
            <thead>
              <tr>
                <th>代码 / 名称</th>
                <th>营业部</th>
                <th>买入</th>
                <th>卖出</th>
                <th>净额</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!data.trades.length">
                <td colspan="5"><div class="empty">暂无交易明细</div></td>
              </tr>
              <tr v-for="(t, i) in data.trades" :key="`${t.code}-${t.dept}-${i}`">
                <td data-label="代码/名称">
                  <span
                    class="c-name stock-link"
                    @click="
                      emit('openStock', { code: t.code, name: t.name, secid: secidOf(t.code) })
                    "
                  >{{ t.name }}</span>
                  <span class="c-code">{{ t.code }}</span>
                </td>
                <td data-label="营业部" class="dept-cell">{{ t.dept }}</td>
                <td data-label="买入" class="up">{{ fx(t.buy) }}亿</td>
                <td data-label="卖出" class="down">{{ fx(t.sell) }}亿</td>
                <td data-label="净额" :class="cl(t.net)">{{ yi(t.net) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 个股名可点开详情 */
.stock-link {
  cursor: pointer;
}
.stock-link:hover {
  text-decoration: underline;
}
.dept-cell {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--muted);
}
</style>
