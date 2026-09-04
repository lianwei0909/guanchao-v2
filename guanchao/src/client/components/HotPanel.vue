<script setup lang="ts">
import type { HotRow } from '@/types/market'
import { cl, fx, pc } from '@/utils/format'

/* 人气热度面板（从 Rank.vue 拆出）。
   按成交额换算人气值，越活跃排名越高。 */
const props = defineProps<{
  hots: HotRow[]
  loading: boolean
  error: string
}>()

const emit = defineEmits<{
  (e: 'retry'): void
  (e: 'open', row: HotRow): void
}>()
</script>

<template>
  <div>
    <div v-if="error" class="err-banner">
      <span>{{ error }}</span>
      <button @click="emit('retry')">重试</button>
    </div>

    <div class="muted" style="font-size: 12px; margin-bottom: 8px">
      按成交额换算人气值，越活跃排名越高 · 共 {{ props.hots.length }} 只
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
          <tr v-if="!props.hots.length">
            <td colspan="5">
              <div class="empty">{{ props.loading ? '加载中…' : '暂无数据' }}</div>
            </td>
          </tr>
          <tr v-for="r in props.hots" :key="r.code" @click="emit('open', r)">
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
</template>
