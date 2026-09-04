<script setup lang="ts">
import { ref, watch } from 'vue'
import { api } from '@/api'
import type { CalendarDay, ConceptDay } from '@/types/market'
import { cl } from '@/utils/format'
import { usePoll } from '@/composables/usePoll'
import StockDetailModal from '@/components/StockDetailModal.vue'

/* 财经日历 + 题材炒作 融合版块。
   参考「股票资讯」(News) 的卡片列表 UI：顶部 seg 分段切换两个子版，
   下方统一以卡片流按日分组展示。两个数据源相互独立，切 tab 时各自加载。 */

const TABS: [string, string][] = [
  ['calendar', '🗓️ 财经日历'],
  ['concept', '🔥 题材炒作']
]

const tab = ref<'calendar' | 'concept'>('calendar')

/* ---- 财经日历状态 ---- */
const days = ref<CalendarDay[]>([])
const calLoading = ref(true)
const calError = ref('')

/* ---- 题材炒作状态 ---- */
const themes = ref<ConceptDay[]>([])
const thmLoading = ref(true)
const thmError = ref('')

const detailStock = ref<{ code: string; name: string; secid: string } | null>(null)

/** 事件类型：eco 字段存在即为经济数据类（有前值/预期/公布） */
function isEco(it: CalendarDay['items'][number]) {
  return !!it.eco
}

function secidOfCode(code: string): string {
  return (code.startsWith('6') ? '1.' : '0.') + code
}
function fmtHeat(n: number): string {
  if (n >= 10000) return (n / 10000).toFixed(1) + '万'
  return String(n)
}

async function loadCalendar() {
  calLoading.value = true
  calError.value = ''
  try {
    days.value = await api.calendar()
  } catch (e) {
    calError.value = e instanceof Error ? e.message : '日历加载失败'
  } finally {
    calLoading.value = false
  }
}

async function loadConcept() {
  thmLoading.value = true
  thmError.value = ''
  try {
    themes.value = await api.concept()
  } catch (e) {
    thmError.value = e instanceof Error ? e.message : '题材加载失败'
  } finally {
    thmLoading.value = false
  }
}

function load() {
  if (tab.value === 'calendar') loadCalendar()
  else loadConcept()
}

/* 两个源刷新周期不同，取折中：每 5 分钟整体刷新当前 tab */
usePoll(load, 300000)
watch(tab, load)
</script>

<template>
  <div>
    <div class="section-title">📅 市场事件</div>
    <div class="muted" style="font-size: 13px; margin-bottom: 12px">
      财经日历（财联社）· 每日题材炒作（同花顺）聚合，实时滚动更新
    </div>

    <div class="pg-tools">
      <span class="lbl">版块</span>
      <div class="seg">
        <button
          v-for="t in TABS"
          :key="t[0]"
          :class="{ on: tab === t[0] }"
          @click="tab = t[0] as any"
        >
          {{ t[1] }}
        </button>
      </div>
    </div>

    <!-- ============ 财经日历 ============ -->
    <template v-if="tab === 'calendar'">
      <div v-if="calError" class="err-banner">
        <span>{{ calError }}</span>
        <button @click="loadCalendar">重试</button>
      </div>
      <div v-if="calLoading && !days.length" class="empty">加载中…</div>
      <div v-else-if="!days.length" class="empty">暂无日历数据</div>

      <div v-else class="cc-list">
        <section v-for="d in days" :key="d.day" class="cc-day">
          <header class="cc-hd">
            <span class="cc-date">{{ d.day.slice(5) }}</span>
            <span class="cc-week">{{ d.week }}</span>
            <span class="cc-cnt">{{ d.items.length }} 项</span>
          </header>
          <a
            v-for="(it, i) in d.items"
            :key="i"
            class="cc-it nw-item"
            :class="{ red: it.red }"
            href="javascript:void(0)"
          >
            <div class="cc-meta">
              <span class="cc-time">{{ it.time || '全天' }}</span>
              <span class="cc-star" :title="'重要性 ' + it.star">
                <span v-for="n in 5" :key="n" :class="{ on: n <= it.star }">★</span>
              </span>
              <span v-if="it.country" class="cc-country">{{ it.country }}</span>
            </div>
            <span class="cc-title">{{ it.title }}</span>
            <span v-if="isEco(it) && it.eco" class="cc-eco">
              前值 <b>{{ it.eco.previous ?? '—' }}</b>
              · 预期 <b>{{ it.eco.forecast ?? '—' }}</b>
              · 公布
              <b :class="it.eco.actual != null && it.eco.actual !== '' ? 'up' : ''">{{ it.eco.actual ?? '—' }}</b>
              <i v-if="it.eco.unit">{{ it.eco.unit }}</i>
            </span>
          </a>
        </section>
      </div>
    </template>

    <!-- ============ 题材炒作 ============ -->
    <template v-else>
      <div v-if="thmError" class="err-banner">
        <span>{{ thmError }}</span>
        <button @click="loadConcept">重试</button>
      </div>
      <div v-if="thmLoading && !themes.length" class="empty">加载中…</div>
      <div v-else-if="!themes.length" class="empty">暂无题材数据</div>

      <div v-else class="cc-list">
        <section v-for="d in themes" :key="d.date" class="cc-day">
          <header class="cc-hd">
            <span class="cc-date">{{ d.date }}</span>
            <span class="cc-cnt">{{ d.events.length }} 条题材</span>
          </header>
          <article
            v-for="ev in d.events"
            :key="ev.id"
            class="cc-it nw-item"
          >
            <div class="cc-meta">
              <span v-if="ev.direction" class="cc-dir">{{ ev.direction }}</span>
              <span class="cc-heat">🔥 {{ fmtHeat(ev.heat) }}</span>
            </div>
            <span class="cc-title">{{ ev.title }}</span>
            <div v-if="ev.themes && ev.themes.length" class="cc-themes">
              <span v-for="t in ev.themes" :key="t.code" class="cc-theme">{{ t.name }}</span>
            </div>
            <div v-if="ev.stocks && ev.stocks.length" class="cc-stocks">
              <span class="cc-stocks-lbl">龙头</span>
              <span
                v-for="s in ev.stocks"
                :key="s.code"
                class="cc-stock"
                @click.prevent.stop="detailStock = { code: s.code, name: s.name, secid: secidOfCode(s.code) }"
              >
                {{ s.name }}
                <i :class="cl(s.pct)">{{ s.pct >= 0 ? '+' : '' }}{{ s.pct.toFixed(2) }}%</i>
              </span>
            </div>
          </article>
        </section>
      </div>
    </template>

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
/* 融合版块容器：沿用 News 的卡片流风格 */
.cc-list {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 14px;
  overflow: hidden;
}
.cc-day {
  border-bottom: 1px solid var(--border);
}
.cc-day:last-child {
  border-bottom: none;
}
.cc-hd {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  position: sticky;
  top: 0;
  z-index: 1;
}
.cc-date {
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 15px;
  color: var(--text);
}
.cc-week {
  color: var(--muted);
  font-size: 13px;
}
.cc-cnt {
  margin-left: auto;
  color: var(--muted);
  font-size: 12px;
}
.cc-it {
  display: block;
  padding: 11px 14px;
  border-bottom: 1px solid var(--border2);
  text-decoration: none;
  color: inherit;
}
.cc-it:last-child {
  border-bottom: none;
}
.cc-it:hover {
  background: var(--surface-2);
}
.cc-it.red {
  background: color-mix(in srgb, var(--down) 8%, transparent);
}
.cc-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 5px;
}
.cc-time {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--text-muted);
  background: var(--bg-chip);
  padding: 2px 7px;
  border-radius: 999px;
  white-space: nowrap;
}
.cc-star {
  font-size: 11px;
  letter-spacing: -1px;
  color: var(--border2);
}
.cc-star .on {
  color: #e0a83c;
}
.cc-country {
  font-size: 11px;
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 7px;
}
.cc-title {
  display: block;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  line-height: 1.55;
}
.cc-it:hover .cc-title {
  color: var(--primary);
}
.cc-eco {
  display: block;
  font-size: 12.5px;
  margin-top: 6px;
  color: var(--text-muted);
  line-height: 1.6;
}
.cc-eco b {
  color: var(--text);
  font-family: var(--font-mono);
}
.cc-eco i {
  font-style: normal;
  margin-left: 2px;
  opacity: 0.7;
}
.cc-eco .up {
  color: var(--up);
}

/* 题材炒作专属 */
.cc-dir {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 999px;
  padding: 2px 8px;
}
.cc-heat {
  font-size: 12px;
  color: var(--down);
}
.cc-themes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 7px;
}
.cc-theme {
  font-size: 11.5px;
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 8px;
}
.cc-stocks {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
}
.cc-stocks-lbl {
  font-size: 11px;
  color: var(--muted);
}
.cc-stock {
  font-size: 12.5px;
  font-weight: 600;
  font-family: var(--font-mono);
  color: var(--accent);
  cursor: pointer;
}
.cc-stock i {
  font-style: normal;
  font-size: 11px;
  margin-left: 2px;
}
</style>
