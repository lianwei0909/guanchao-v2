<script setup lang="ts">
import type { SectorRow, SectorSort, SectorType } from '@/types/market'
import { cl, fx, pc, yi } from '@/utils/format'

/* 板块资金面板（从 Rank.vue 拆出）。
   只负责渲染与筛选交互，数据加载仍由父组件统一管理。 */
const props = defineProps<{
  sectors: SectorRow[]
  loading: boolean
  error: string
  secType: SectorType
  secSort: SectorSort
}>()

const emit = defineEmits<{
  (e: 'retry'): void
  (e: 'update:secType', v: SectorType): void
  (e: 'update:secSort', v: SectorSort): void
  (e: 'open-lead', row: SectorRow): void
}>()

/* 板块类型：行业约 90 个，概念约 380 个 */
const SEC_TYPES: [SectorType, string][] = [
  ['industry', '行业板块'],
  ['concept', '概念板块']
]
const SEC_SORTS: [SectorSort, string][] = [
  ['flow', '按主力净流入'],
  ['pct', '按涨幅']
]
</script>

<template>
  <div>
    <div v-if="error" class="err-banner">
      <span>{{ error }}</span>
      <button @click="emit('retry')">重试</button>
    </div>

    <div class="pg-tools">
      <span class="lbl">类型</span>
      <div class="seg">
        <button
          v-for="t in SEC_TYPES"
          :key="t[0]"
          :class="{ on: props.secType === t[0] }"
          @click="emit('update:secType', t[0])"
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
          :class="{ on: props.secSort === s[0] }"
          @click="emit('update:secSort', s[0])"
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
              <div class="empty">{{ loading ? '加载中…' : '暂无数据' }}</div>
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
              @click.stop="emit('open-lead', s)"
            >
              <span class="c-name">{{ s.lead || '—' }}</span>
              <span v-if="s.lead" class="c-code" :class="cl(s.leadPct)">{{ pc(s.leadPct) }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
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
</style>
