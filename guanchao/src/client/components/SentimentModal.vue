<script setup lang="ts">
import { computed } from 'vue'
import type { MarketStat, TopStock } from '@/types/market'
import { cl, fx, pc, yi } from '@/utils/format'

/* 市场情绪 KPI 点击后的榜单弹窗（对应旧版 openSentModal）。
   kind: up=涨幅 / down=跌幅 / flat=平盘 / amount=成交额 / flow=主力净流入
   行可点击 → 抛 pick 事件，由父组件打开个股详情。 */
const props = defineProps<{ kind: string; stat: MarketStat }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'pick', s: { code: string; name: string; secid: string }): void
}>()

const conf = computed(() => {
  const d = props.stat
  const M: Record<
    string,
    {
      t: string
      head: string
      list?: TopStock[]
      val: (x: TopStock) => string
      cls: (x: TopStock) => string
    }
  > = {
    up: {
      t: '涨幅 TOP 10',
      head: '涨幅',
      list: d.topUp || d.top10,
      val: (x) => pc(x.pct),
      cls: (x) => cl(x.pct)
    },
    down: {
      t: '跌幅 TOP 10',
      head: '跌幅',
      list: d.topDown,
      val: (x) => pc(x.pct),
      cls: (x) => cl(x.pct)
    },
    flat: {
      t: '平盘个股（抽样）',
      head: '涨跌幅',
      list: d.topFlat,
      val: (x) => pc(x.pct),
      cls: (x) => cl(x.pct)
    },
    amount: {
      t: '成交额 TOP 10',
      head: '成交额(亿)',
      list: d.topAmt,
      val: (x) => fx(x.amount, 2),
      cls: () => ''
    },
    flow: {
      t: '主力净流入 TOP 10',
      head: '主力净流入',
      list: d.topFlowIn,
      val: (x) => yi(x.flow),
      cls: (x) => cl(x.flow)
    }
  }
  return M[props.kind] || M.up
})

const rows = computed(() => conf.value.list || [])
/* 主力净流入榜额外带出流出榜（对齐旧版 openSentModal 的 extraHtml） */
const outRows = computed(() => (props.kind === 'flow' ? props.stat.topFlowOut || [] : []))

function pick(x: TopStock) {
  emit('pick', { code: x.code, name: x.name, secid: x.secid })
}
</script>

<template>
  <div class="modal-mask show" @click.self="emit('close')">
    <div class="modal" style="width: min(620px, calc(100% - 24px))">
      <div class="modal-head">
        <h3>{{ conf.t }}</h3>
        <button class="modal-close" @click="emit('close')">×</button>
      </div>

      <div class="yz-sec">
        <span class="yz-bar">▍</span>{{ conf.t }}（点击行查看个股详情）
      </div>

      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>排名</th>
              <th>名称</th>
              <th>代码</th>
              <th>现价</th>
              <th>{{ conf.head }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!rows.length">
              <td colspan="5"><div class="empty">暂无数据</div></td>
            </tr>
            <tr v-for="x in rows" :key="x.code" @click="pick(x)">
              <td class="muted">{{ x.rank }}</td>
              <td><span class="c-name">{{ x.name }}</span></td>
              <td class="muted">{{ x.code }}</td>
              <td>{{ fx(x.price) }}</td>
              <td :class="conf.cls(x)">{{ conf.val(x) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 主力净流入榜额外带出流出榜 -->
      <template v-if="outRows.length">
        <div class="yz-sec" style="margin-top: 16px">
          <span class="yz-bar">▍</span>主力净流出 TOP 10
        </div>
        <div class="tbl-wrap">
          <table class="tbl">
            <thead>
              <tr>
                <th>排名</th>
                <th>名称</th>
                <th>代码</th>
                <th>现价</th>
                <th>主力净流出</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="x in outRows" :key="x.code" @click="pick(x)">
                <td class="muted">{{ x.rank }}</td>
                <td><span class="c-name">{{ x.name }}</span></td>
                <td class="muted">{{ x.code }}</td>
                <td>{{ fx(x.price) }}</td>
                <td :class="cl(x.flow)">{{ yi(x.flow) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>
  </div>
</template>
