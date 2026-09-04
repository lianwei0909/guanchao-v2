<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '@/api'
import type { NewsItem, StockDetail } from '@/types/market'
import { cl, fx, newsTime, pc, sg } from '@/utils/format'
import { useWatchlistStore } from '@/stores/watchlist'
import StockFinancials from '@/components/StockFinancials.vue'
import StockChart from '@/components/StockChart.vue'

/* 个股详情弹窗（对应旧版 openDetail）。
   图表子模块已抽为独立 StockChart.vue，此处只负责壳 / 详情数据 / 财务 / 快讯。 */
const props = defineProps<{ code: string; name?: string; secid?: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const detail = ref<StockDetail | null>(null)
const loading = ref(true)
const err = ref('')

/** 当前票是否在自选里 —— ⭐ 按钮填充状态。
   P2-4：直接由 Pinia store 派生，不再维护本地副本。 */
const wl = useWatchlistStore()
const watched = computed(() => (props.code ? wl.has(props.code) : false))
function toggleWatch() {
  if (!props.code || !props.name) return
  if (watched.value) {
    wl.remove(props.code)
  } else {
    wl.add({ code: props.code, name: props.name, secid: props.secid || '' })
  }
}

/* 财务分析：默认收起，展开才加载（同花顺限流约 20 秒/次，不展开就不打接口） */
const showFin = ref(false)
const news = ref<NewsItem[]>([])
const loadingNews = ref(false)

/* 详情加载：图表子模块（StockChart.vue）自行按 code 加载，这里只管详情数据 */
async function load() {
  loading.value = true
  err.value = ''
  try {
    detail.value = await api.detail(props.code, props.secid)
  } catch (e) {
    err.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    loading.value = false
  }
}

function toggleFin() {
  showFin.value = !showFin.value
}

/** 相关资讯只展示近 3 天 */
const NEWS_DAYS = 3

/* 相关资讯 = 个股公告 + 全市场快讯过滤，两条路并行。

   全市场 7×24 快讯池只有几十条，按股票名过滤后绝大多数个股一条都命中不了
   （表现为「相关快讯」常年空）。所以主数据源换成「交易所公告」——
   按代码精确查询、稳定命中；即时快讯作为补充，命中了才追加。 */
async function loadNews() {
  loadingNews.value = true
  try {
    /* 公告侧的时间窗交给后端（days=3，接口会多拉再过滤，避免过滤后为空） */
    const [ann, kx] = await Promise.all([
      api.stockNews(props.code, 10, NEWS_DAYS).catch(() => null),
      api.news('all', 'all').catch(() => null)
    ])

    const out: NewsItem[] = ann?.list ? ann.list.slice() : []
    const cutoff = Date.now() - NEWS_DAYS * 86400000

    /* 即时快讯：近 3 天 + 按股票名/代码过滤 + 去掉与公告重复的标题 */
    const kw = [props.name, props.code].filter((x): x is string => !!x && x.length >= 2)
    const seen = new Set(out.map((n) => n.title))
    ;(kx?.list || [])
      .filter((n) => {
        const ts = Date.parse(String(n.time || ''))
        /* 时间解析失败的一律保留，避免误杀 */
        return !isFinite(ts) || ts >= cutoff
      })
      .filter(
        (n) =>
          kw.some((k) => (n.title || '').includes(k) || (n.summary || '').includes(k)) &&
          !seen.has(n.title)
      )
      .slice(0, 4)
      .forEach((n) => out.push(n))

    news.value = out
  } catch {
    news.value = []
  } finally {
    loadingNews.value = false
  }
}

onMounted(() => {
  load()
  loadNews()
})
watch(
  () => props.code,
  () => {
    load()
    loadNews()
  }
)
watch(
  () => props.code,
  () => {
    load()
    loadNews()
  }
)
</script>

<template>
  <div class="modal-mask show" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-head">
        <h3>
          {{ detail?.name || name || '--' }}
          <span class="muted code-span">{{ code }}</span>
          <!-- 加自选：文字按钮（★/☆ 符号不够醒目），已加入则高亮 -->
          <button
            class="modal-watch"
            :class="{ on: watched }"
            :title="watched ? '从自选移除' : '加入自选'"
            @click="toggleWatch"
          >
            {{ watched ? '已自选' : '＋ 加自选' }}
          </button>
        </h3>
        <button class="modal-close" @click="emit('close')">×</button>
      </div>

      <div v-if="detail" style="display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap">
        <span
          :class="cl(detail.pct)"
          style="font-size: 30px; font-weight: 800; font-family: var(--font-mono)"
        >{{ fx(detail.price) }}</span>
        <span :class="cl(detail.change)" style="font-size: 15px; font-weight: 600">{{ sg(detail.change) }}{{ fx(detail.change) }}</span>
        <span :class="cl(detail.pct)" style="font-size: 15px; font-weight: 600">{{
          pc(detail.pct)
        }}</span>
      </div>
      <div v-else-if="loading" class="empty">加载中…</div>
      <div v-else-if="err" class="empty">{{ err }}</div>

      <!-- 分时 / K 线图：独立子组件 StockChart.vue，自管周期切换、悬停、空态 -->
      <StockChart :code="code" :secid="secid" />

      <div
        v-if="detail"
        style="
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 8px;
          margin-top: 12px;
        "
      >
        <div
          v-for="it in [
            { k: '今开', v: fx(detail.open), c: cl(detail.open - detail.preClose) },
            { k: '最高', v: fx(detail.high), c: 'up' },
            { k: '最低', v: fx(detail.low), c: 'down' },
            { k: '昨收', v: fx(detail.preClose), c: '' },
            { k: '换手', v: fx(detail.turnover) + '%', c: '' },
            { k: '总市值', v: fx(detail.mktcap, 0) + '亿', c: '' },
            { k: '市盈率', v: fx(detail.pe), c: '' },
            { k: '市净率', v: fx(detail.pb), c: '' }
          ]"
          :key="it.k"
          style="background: var(--card2); border-radius: 8px; padding: 8px 10px"
        >
          <div style="font-size: 11px; color: var(--muted)">{{ it.k }}</div>
          <div :class="it.c" style="font-size: 14px; font-weight: 600">{{ it.v }}</div>
        </div>
      </div>

      <!-- 财务分析（同花顺源，展开才加载，避免浪费限流额度） -->
      <button class="btn sm ghost" style="width: 100%; margin-top: 14px" @click="toggleFin">
        {{ showFin ? '▾' : '▸' }} 财务分析（数据来源：同花顺）
      </button>
      <StockFinancials v-if="showFin" :code="code" />

      <!-- 相关快讯：三源聚合后按股票名 / 代码过滤 -->
      <div style="margin-top: 14px">
        <div style="font-size: 12.5px; font-weight: 600; margin-bottom: 6px">📰 相关快讯</div>
        <div v-if="loadingNews" class="empty">加载中…</div>
        <div v-else-if="!news.length" class="empty">暂无相关快讯</div>
        <template v-else>
          <a
            v-for="(n, i) in news"
            :key="i"
            class="nw-item"
            :href="n.url || '#'"
            target="_blank"
            rel="noopener"
          >
            <span class="nw-title">{{ n.title }}</span>
            <div style="font-size: 11.5px; color: var(--muted); margin-top: 2px">
              {{ newsTime(n.time).abs }}<template v-if="newsTime(n.time).rel">
                · {{ newsTime(n.time).rel }}
              </template>
            </div>
          </a>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 弹窗头部「加自选」按钮 —— 与股票代码之间留出间隙 */
.code-span {
  font-size: 13px;
  font-weight: 400;
  margin: 0 0 0 6px;
}
/* 加自选：文字按钮，比 ★/☆ 符号更醒目 */
.modal-watch {
  border: 1px solid var(--border, #e3e8ef);
  background: transparent;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  margin-left: 10px;
  padding: 5px 11px;
  border-radius: 6px;
  color: var(--muted);
  white-space: nowrap;
  transition: all 0.15s;
}
.modal-watch:hover {
  border-color: var(--primary);
  color: var(--primary);
  background: rgba(13, 71, 161, 0.06);
}
.modal-watch.on {
  border-color: #f5a623;
  color: #f5a623;
  background: rgba(245, 166, 35, 0.1);
}
</style>
