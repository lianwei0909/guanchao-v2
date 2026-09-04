<script setup lang="ts">
import { computed, ref } from 'vue'
import { usePoll } from '@/composables/usePoll'
import { useRouter } from 'vue-router'
import { api } from '@/api'
import type { IndexQuote, MarketIndex, MarketStat } from '@/types/market'
import { cl, fx, pc, sg, yi } from '@/utils/format'

/* 市场总览（全景盘面改造版）。
   目标：一屏纵览各大市场大致数据，不再堆砌上千条明细
   （板块资金 / 热度等明细将迁往 A股行情页）。 */
const router = useRouter()

/** A股核心指数：展示主要宽基/板块指数（后端 /indices?scope=ashare 共返回 12 个，这里取主览常用的 8 个） */
const A_CORE = [
  '000001', '399001', '399006', '000688', '899050',
  '000300', '000016', '000905', '000852'
]

const aIdx = ref<IndexQuote[]>([])
const stat = ref<MarketStat | null>(null)
const hk = ref<MarketIndex[]>([])
const us = ref<MarketIndex[]>([])
const glob = ref<MarketIndex[]>([])
const loading = ref(true)
const errors = ref<Record<string, string>>({})
/** 全球市场默认展开（默认一屏纵览，不用再点一次） */
const showGlobal = ref(true)


const aCore = computed(() =>
  A_CORE.map((c) => aIdx.value.find((x) => x.code === c)).filter((x): x is IndexQuote => !!x)
)
/** 全球市场：剔除已在上方单独成栏的 A股 / 港股 / 美股，只留海外指数 */
const AHKUS = new Set(['100.HSI', '100.DJIA', '100.NDX', '100.SPX'])
const globForeign = computed(() =>
  glob.value.filter((x) => !x.secid.startsWith('1.') && !x.secid.startsWith('0.') && !AHKUS.has(x.secid))
)
/** 各市场独立容错：单个市场失败不拖垮整页 */
async function loadAll() {
  const errs: Record<string, string> = {}
  const run = async <T,>(k: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn()
    } catch (e) {
      errs[k] = e instanceof Error ? e.message : '加载失败'
      return null
    }
  }
  const [a, s, h, u, g] = await Promise.all([
    run('a', () => api.indices('ashare')),
    run('stat', () => api.marketStat()),
    run('hk', () => api.hkIndex('index')),
    run('us', () => api.usIndex()),
    run('global', () => api.globalIndex())
  ])
  if (a) aIdx.value = a
  if (s) stat.value = s
  if (h) hk.value = h.list || []
  if (u) us.value = u
  if (g) glob.value = g
  errors.value = errs
  loading.value = false
}

/* 轮询收敛到 usePoll：卸载自动清理 + 页面隐藏时暂停 */
usePoll(loadAll, 30000)
</script>

<template>
  <div>
    <div class="section-title">🌐 市场总览</div>
    <div class="muted" style="font-size: 13px; margin-bottom: 14px">
      A股 / 港股 / 美股 / 全球主要指数一屏纵览 · 每 30 秒自动刷新
    </div>

    <!-- ===== A股 ===== -->
    <div class="panel" style="margin-bottom: 12px; cursor: pointer" @click="router.push('/stock-rank')">
      <div class="ov-sec-h">
        <span>🇨🇳 A股</span>
        <span class="ov-sec-more">进入 A股行情 →</span>
      </div>
      <div v-if="loading && !aCore.length" class="empty">加载中…</div>
      <div v-else-if="errors.a" class="empty">A股指数加载失败：{{ errors.a }}</div>
      <div v-else class="idx-board">
        <div v-for="x in aCore" :key="x.code" class="idx-card" :class="cl(x.pct)">
          <div class="idx-card-n">{{ x.name }}</div>
          <div class="idx-card-p">{{ fx(x.price) }}</div>
          <div class="idx-card-c" :class="cl(x.pct)">{{ pc(x.pct) }}</div>
          <div class="idx-card-x">
            <span class="idx-amt">{{ sg(x.change) }}{{ fx(x.change) }}</span> ·
            <span class="idx-amt">额{{ fx(x.amount, 0) }}亿</span>
          </div>
        </div>
      </div>

      <!-- A股市场宽度 -->
      <div v-if="stat" style="margin-top: 10px">
        <div style="display: flex; gap: 14px; flex-wrap: wrap; font-size: 13px">
          <span>上涨 <b class="up">{{ stat.up }}</b></span>
          <span>下跌 <b class="down">{{ stat.down }}</b></span>
          <span>平盘 <b>{{ stat.flat }}</b></span>
          <span>停牌 <b class="muted">{{ stat.suspend == null ? '—' : stat.suspend }}</b></span>
          <span>成交额 <b>{{ fx(stat.amount, 3) }}万亿</b></span>
          <span>主力净流入
            <b :class="cl(stat.mainFlow)">
              {{ stat.mainFlow == null ? '统计中…' : yi(stat.mainFlow) }}
            </b>
          </span>
        </div>
      </div>
      <div v-else-if="errors.stat" class="empty" style="font-size: 12px">
        市场统计失败：{{ errors.stat }}
      </div>
    </div>

    <!-- ===== 港股 / 美股 并排 ===== -->
    <div class="ov-two">
      <div class="panel" style="cursor: pointer" @click="router.push('/stock-hk')">
        <div class="ov-sec-h">
          <span>🇭🇰 港股</span>
          <span class="ov-sec-more">详情 →</span>
        </div>
        <div v-if="errors.hk" class="empty">加载失败：{{ errors.hk }}</div>
        <div v-else-if="!hk.length" class="empty">暂无数据</div>
        <div v-else class="idx-board">
          <div v-for="x in hk" :key="x.code" class="idx-card" :class="cl(x.pct)">
            <div class="idx-card-n">{{ x.name }}</div>
            <div class="idx-card-p">{{ fx(x.price) }}</div>
            <div class="idx-card-c" :class="cl(x.pct)">{{ pc(x.pct) }}</div>
            <div class="idx-card-x">
              <span class="idx-amt">{{ sg(x.change) }}{{ fx(x.change) }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="panel" style="cursor: pointer" @click="router.push('/stock-us')">
        <div class="ov-sec-h">
          <span>🇺🇸 美股</span>
          <span class="ov-sec-more">详情 →</span>
        </div>
        <div v-if="errors.us" class="empty">加载失败：{{ errors.us }}</div>
        <div v-else-if="!us.length" class="empty">暂无数据</div>
        <div v-else class="idx-board">
          <div v-for="x in us" :key="x.code" class="idx-card" :class="cl(x.pct)">
            <div class="idx-card-n">{{ x.name }}</div>
            <div class="idx-card-p">{{ fx(x.price) }}</div>
            <div class="idx-card-c" :class="cl(x.pct)">{{ pc(x.pct) }}</div>
            <div class="idx-card-x">
              <span class="idx-amt">{{ sg(x.change) }}{{ fx(x.change) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ===== 全球（默认收起）===== -->
    <div class="panel" style="margin-top: 12px">
      <div class="ov-sec-h" style="cursor: pointer" @click="showGlobal = !showGlobal">
        <span>🌍 全球市场</span>
        <span class="ov-sec-more">{{ showGlobal ? '收起 ▲' : `展开 ${globForeign.length} 个 ▼` }}</span>
      </div>
      <div v-if="showGlobal">
        <div v-if="errors.global" class="empty">加载失败：{{ errors.global }}</div>
        <div v-else-if="!globForeign.length" class="empty">暂无数据</div>
        <div v-else class="idx-board">
          <div v-for="x in globForeign" :key="x.secid" class="idx-card" :class="cl(x.pct)">
            <div class="idx-card-n">{{ x.name }}</div>
            <div class="idx-card-p">{{ fx(x.price) }}</div>
            <div class="idx-card-c" :class="cl(x.pct)">{{ pc(x.pct) }}</div>
            <div class="idx-card-x">
              <span class="idx-amt">{{ sg(x.change) }}{{ fx(x.change) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ov-two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.ov-sec-h {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
  font-weight: 700;
  margin-bottom: 10px;
}
.ov-sec-more {
  font-size: 12px;
  font-weight: 500;
  color: var(--muted);
}
@media (max-width: 720px) {
  .ov-two {
    grid-template-columns: 1fr;
  }
}
</style>
