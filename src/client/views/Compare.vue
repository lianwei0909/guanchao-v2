<script setup lang="ts">
import { computed, ref } from 'vue'
import { api } from '@/api'
import type { CompareItem, SearchItem } from '@/types/market'
import { cl, fx, pc, yi } from '@/utils/format'

/* 对比分析（对应旧版 renderCompare / loadCompare）。
   最多同时对比 6 只：先搜索添加，再一次性拉取行情 + 5/20 日涨幅与均线。 */
const MAX = 6
const kw = ref('')
const picked = ref<{ code: string; name: string }[]>([])
const suggestions = ref<SearchItem[]>([])
const rows = ref<CompareItem[]>([])
const loading = ref(false)
const error = ref('')
const searching = ref(false)

let searchTimer: number | undefined

const canAdd = computed(() => picked.value.length < MAX)

async function onSearch() {
  const q = kw.value.trim()
  if (!q) {
    suggestions.value = []
    return
  }
  searching.value = true
  try {
    suggestions.value = (await api.search(q)).slice(0, 8)
  } catch {
    suggestions.value = []
  } finally {
    searching.value = false
  }
}

function onInput() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = window.setTimeout(onSearch, 300)
}

function add(s: SearchItem) {
  if (!canAdd.value) return
  if (picked.value.some(x => x.code === s.code)) return
  picked.value.push({ code: s.code, name: s.name })
  kw.value = ''
  suggestions.value = []
  load()
}

function remove(code: string) {
  picked.value = picked.value.filter(x => x.code !== code)
  if (picked.value.length) load()
  else {
    rows.value = []
    error.value = ''
  }
}

async function load() {
  if (!picked.value.length) return
  loading.value = true
  error.value = ''
  try {
    rows.value = await api.compare(picked.value.map(x => x.code))
  } catch (e) {
    error.value = e instanceof Error ? e.message : '对比数据加载失败'
  } finally {
    loading.value = false
  }
}

/** 各项指标的最优值（用于高亮）；涨跌类取最大，估值类取最小 */
const best = computed(() => {
  const r = rows.value
  if (r.length < 2) return {} as Record<string, number>
  const num = (arr: (number | null)[]) => arr.filter((x): x is number => x != null && isFinite(x))
  return {
    pct: Math.max(...num(r.map(x => x.pct))),
    chg5: Math.max(...num(r.map(x => x.chg5))),
    chg20: Math.max(...num(r.map(x => x.chg20))),
    mainNetInflow: Math.max(...num(r.map(x => x.mainNetInflow))),
    pe: Math.min(...num(r.map(x => x.pe).filter(x => x > 0))),
    turnover: Math.max(...num(r.map(x => x.turnover)))
  }
})
const isBest = (key: string, v: number | null) =>
  v != null && isFinite(v) && best.value[key] === v && rows.value.length > 1
</script>

<template>
  <div>
    <div class="section-title">⚖️ 对比分析</div>
    <div class="muted" style="font-size: 13px; margin-bottom: 12px">
      最多同时对比 {{ MAX }} 只 · 含近 5/20 日涨幅与均线 · 同行最优值高亮
    </div>

    <!-- 添加区 -->
    <div class="pg-tools">
      <span class="lbl">添加</span>
      <input
        v-model="kw"
        class="kw-input"
        type="text"
        :disabled="!canAdd"
        :placeholder="canAdd ? '输入代码或名称搜索…' : `已达上限 ${MAX} 只`"
        style="flex: 0 0 240px"
        @input="onInput"
        @keyup.enter="onSearch"
      />
      <span class="muted" style="font-size: 12px">
        已选 {{ picked.length }} / {{ MAX }}<template v-if="searching"> · 搜索中…</template>
      </span>
    </div>

    <div v-if="suggestions.length" class="sug-box">
      <div
        v-for="s in suggestions"
        :key="s.code"
        class="sug-item"
        @click="add(s)"
      >
        <span class="c-name">{{ s.name }}</span>
        <span class="c-code">{{ s.code }}</span>
        <span :class="cl(s.pct)" style="font-size: 12px; margin-left: auto">{{ pc(s.pct) }}</span>
      </div>
    </div>

    <!-- 已选标签 -->
    <div v-if="picked.length" class="chip-row">
      <span v-for="p in picked" :key="p.code" class="chip">
        {{ p.name }}
        <span class="muted" style="font-size: 11px">{{ p.code }}</span>
        <button class="chip-x" title="移除" @click="remove(p.code)">×</button>
      </span>
    </div>

    <div v-if="error" class="err-banner">
      <span>{{ error }}</span>
      <button @click="load">重试</button>
    </div>

    <div v-if="!picked.length" class="empty">搜索并添加股票后开始对比</div>

    <div v-else class="tbl-wrap">
      <table class="tbl">
        <thead>
          <tr>
            <th>代码 / 名称</th>
            <th>现价</th>
            <th>涨跌幅</th>
            <th>近5日</th>
            <th>近20日</th>
            <th>MA5</th>
            <th>MA20</th>
            <th>成交额</th>
            <th>换手</th>
            <th>量比</th>
            <th>主力净流入</th>
            <th>市盈率</th>
            <th>市净率</th>
            <th>总市值</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!rows.length">
            <td colspan="14">
              <div class="empty">{{ loading ? '加载中…' : '暂无数据' }}</div>
            </td>
          </tr>
          <tr v-for="r in rows" :key="r.code">
            <td data-label="代码/名称">
              <span class="c-name">{{ r.name }}</span>
              <span class="c-code">{{ r.code }}</span>
            </td>
            <td data-label="现价">{{ fx(r.price) }}</td>
            <td data-label="涨跌幅" :class="cl(r.pct)">
              <b :class="{ hl: isBest('pct', r.pct) }">{{ pc(r.pct) }}</b>
            </td>
            <td data-label="近5日" :class="cl(r.chg5)">
              <b :class="{ hl: isBest('chg5', r.chg5) }">{{
                r.chg5 == null ? '—' : pc(r.chg5)
              }}</b>
            </td>
            <td data-label="近20日" :class="cl(r.chg20)">
              <b :class="{ hl: isBest('chg20', r.chg20) }">{{
                r.chg20 == null ? '—' : pc(r.chg20)
              }}</b>
            </td>
            <td data-label="MA5">{{ r.ma5 == null ? '—' : fx(r.ma5) }}</td>
            <td data-label="MA20">{{ r.ma20 == null ? '—' : fx(r.ma20) }}</td>
            <td data-label="成交额">{{ yi(r.amount) }}</td>
            <td data-label="换手">
              <b :class="{ hl: isBest('turnover', r.turnover) }">{{ fx(r.turnover) }}%</b>
            </td>
            <td data-label="量比">{{ fx(r.volumeRatio) }}</td>
            <td data-label="主力净流入" :class="cl(r.mainNetInflow)">
              <b :class="{ hl: isBest('mainNetInflow', r.mainNetInflow) }">{{
                yi(r.mainNetInflow)
              }}</b>
            </td>
            <td data-label="市盈率">
              <b :class="{ hl: isBest('pe', r.pe > 0 ? r.pe : null) }">{{
                r.pe > 0 ? fx(r.pe) : '—'
              }}</b>
            </td>
            <td data-label="市净率">{{ r.pb ? fx(r.pb) : '—' }}</td>
            <td data-label="总市值">{{ fx(r.mktcap, 0) }}亿</td>
          </tr>
        </tbody>
      </table>
    </div>
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
.kw-input:disabled {
  opacity: 0.6;
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
.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px 4px 10px;
  border-radius: 14px;
  font-size: 12.5px;
  background: rgba(13, 71, 161, 0.09);
  border: 1px solid rgba(13, 71, 161, 0.2);
}
.chip-x {
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  padding: 0 2px;
  color: var(--muted);
}
.chip-x:hover {
  color: #e53935;
}
/* 同行最优值高亮 */
.hl {
  color: #e53935;
  text-decoration: underline;
  text-underline-offset: 2px;
}
</style>
