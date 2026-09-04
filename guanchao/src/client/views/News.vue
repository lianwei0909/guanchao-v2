<script setup lang="ts">
import { ref, watch } from 'vue'
import { api } from '@/api'
import type { NewsItem, NewsStock } from '@/types/market'
import { newsTime, toTs } from '@/utils/format'
import { usePoll } from '@/composables/usePoll'
import StockDetailModal from '@/components/StockDetailModal.vue'

/* 股票快讯（对应旧版 renderNews / loadNews）。
   分类 + 来源过滤均由服务端完成（三源并行抓取后统一过滤），前端只负责渲染。 */
const TABS: [string, string][] = [
  ['all', '全部'],
  ['a', 'A股'],
  ['hk', '港股'],
  ['us', '美股'],
  ['alert', '异动']
]
const SRCS: [string, string][] = [
  ['all', '全部来源'],
  ['东方财富', '东方财富'],
  ['同花顺', '同花顺'],
  ['新浪财经', '新浪']
]

const tab = ref('all')
const src = ref('all')
const rows = ref<NewsItem[]>([])
const loading = ref(true)
const error = ref('')
/** 点击快讯里识别出的个股 → 打开详情弹窗 */
const detailStock = ref<{ code: string; name: string; secid: string } | null>(null)

function openStock(s: NewsStock) {
  detailStock.value = { code: s.code, name: s.name, secid: s.secid }
}

const srcKey = (s: string) => (s === '同花顺' ? 'ths' : s === '新浪财经' ? 'sina' : 'em')

/** 包装一层，名称短一些调用方便 */
const nwTime = newsTime

async function load() {
  loading.value = true
  error.value = ''
  try {
    const d = await api.news(tab.value, src.value)
    /* 强制按时间倒序：最新的一条排在最上面 */
    rows.value = (d?.list || []).slice().sort((a, b) => toTs(b.time) - toTs(a.time))
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    loading.value = false
  }
}

/* 轮询收敛到 usePoll：卸载自动清理 + 页面隐藏时暂停 */
usePoll(load, 60000)
watch([tab, src], load)
</script>

<template>
  <div>
    <div class="section-title">📰 股票快讯 · 多渠道</div>
    <div class="muted" style="font-size: 13px; margin-bottom: 12px">
      东方财富 · 同花顺 · 新浪 三源聚合，实时滚动更新
    </div>

    <div class="pg-tools">
      <span class="lbl">分类</span>
      <div class="seg">
        <button
          v-for="t in TABS"
          :key="t[0]"
          :class="{ on: tab === t[0] }"
          @click="tab = t[0]"
        >
          {{ t[1] }}
        </button>
      </div>
    </div>
    <div class="pg-tools">
      <span class="lbl">来源</span>
      <div class="seg">
        <button
          v-for="s in SRCS"
          :key="s[0]"
          :class="{ on: src === s[0] }"
          @click="src = s[0]"
        >
          {{ s[1] }}
        </button>
      </div>
    </div>

    <div v-if="error" class="err-banner">
      <span>{{ error }}</span>
      <button @click="load">重试</button>
    </div>

    <div v-if="loading && !rows.length" class="empty">加载中…</div>
    <div v-else-if="!rows.length" class="empty">当前筛选下暂无快讯</div>
    <div
      v-else
      style="
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 14px;
        overflow: hidden;
      "
    >
      <!-- 港股 / 美股分类天然稀疏，数量过少时说明一下，避免误以为没加载 -->
      <div
        v-if="rows.length < 6 && (tab === 'hk' || tab === 'us')"
        class="empty"
        style="padding: 8px 12px; font-size: 12.5px"
      >
        该分类快讯本身较少（已聚合 东方财富 / 同花顺 / 新浪 三源），以上为当前全部命中
      </div>

      <a
        v-for="(n, i) in rows"
        :key="i"
        class="nw-item"
        :href="n.url || '#'"
        target="_blank"
        rel="noopener"
        :title="nwTime(n.time).full"
      >
        <div class="nw-meta">
          <span class="nw-time">{{ nwTime(n.time).abs }}</span>
          <span class="nw-rel">{{ nwTime(n.time).rel }}</span>
          <span v-if="n.tag" class="nw-tag">{{ n.tag }}</span>
          <span
            v-for="(s, j) in n.sources && n.sources.length ? n.sources : [n.source || '']"
            :key="j"
            class="nw-src"
            :class="'s-' + srcKey(s)"
          >{{ s }}</span>
        </div>
        <span class="nw-title">{{ n.title }}</span>
        <div v-if="n.summary" class="nw-sum">{{ n.summary }}</div>
        <!-- 原文里识别出的个股：可点开详情。prevent 阻止 a 标签跳转外链 -->
        <div v-if="n.stocks && n.stocks.length" class="nw-stocks">
          <span
            v-for="s in n.stocks"
            :key="s.code"
            class="nw-stock"
            @click.prevent.stop="openStock(s)"
          >{{ s.name }}</span>
        </div>
      </a>
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
/* 快讯里识别出的个股标签 */
.nw-stocks {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.nw-stock {
  padding: 1px 8px;
  border-radius: 5px;
  font-size: 11.5px;
  font-weight: 600;
  font-family: var(--font-mono);
  color: var(--accent);
  background: var(--accent-soft);
  cursor: pointer;
}
.nw-stock:hover {
  background: var(--accent);
  color: #fff;
}
</style>
