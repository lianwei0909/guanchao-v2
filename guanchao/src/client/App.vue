<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useThemeStore } from '@/stores/theme'
import Ticker from './components/Ticker.vue'
import AiPanel from './components/AiPanel.vue'

const router = useRouter()
const route = useRoute()

/* 导航项按用户指定顺序排列 */
const navs = [
  { route: '/stock-overview', label: '全景盘面', icon: '🌐' },
  { route: '/stock-treemap', label: '大盘云图', icon: '🧩' },
  { route: '/stock-watchlist', label: '自选股', icon: '⭐' },
  { route: '/stock-signal-monitor', label: '盘中监控', icon: '📡' },
  { route: '/stock-rank', label: 'A股行情', icon: '🏆' },
  { route: '/stock-us', label: '美股行情', icon: '🇺🇸' },
  { route: '/stock-hk', label: '港股行情', icon: '🇭🇰' },
  { route: '/stock-dark', label: '暗盘监控', icon: '🌙' },
  { route: '/stock-youzi', label: '游资操作', icon: '🐉' },
  { route: '/stock-rzrq', label: '融资融券', icon: '💰' },
  { route: '/stock-calendar', label: '市场事件', icon: '📅' },
  { route: '/stock-forecast', label: '预测PP', icon: '📈' },
  { route: '/stock-paper-portfolio', label: '模拟持仓', icon: '💼' },
  { route: '/stock-news', label: '股票资讯', icon: '📰' }
]

/* 深浅色主题切换（P2-4：状态收敛到 Pinia store，DOM 属性与持久化由 store 负责） */
const theme = useThemeStore()
const isDark = computed(() => theme.isDark)
function toggleTheme() {
  theme.toggle()
}
onMounted(() => {
  theme.init()
})
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <img src="/icons/guanchao-logo.png" alt="观潮" class="brand-logo" />
        <span class="brand-name">观潮</span>
      </div>

      <button
        v-for="n in navs"
        :key="n.route"
        class="nav-item"
        :class="{ on: route.path === n.route }"
        @click="router.push(n.route)"
      >
        <span class="nav-ic">{{ n.icon }}</span>{{ n.label }}
      </button>

      <div class="sidebar-foot">
        <button class="nav-item" @click="toggleTheme">
          <span class="nav-ic">{{ isDark ? '☀️' : '🌙' }}</span>{{ isDark ? '切换浅色' : '切换深色' }}
        </button>
      </div>
    </aside>

    <div class="main">
      <Ticker />
      <div class="content">
        <router-view />
      </div>
    </div>

    <!-- 全局 AI 解读助手：悬浮可拖动图标，所有界面可见 -->
    <AiPanel />
  </div>
</template>

<style scoped>
/* 侧边栏品牌区 —— 观字 logo + 观潮楷体大字（与 favicon 字体一致）
   logo 宽度与 .nav-ic 同为 24px、间距同为 12px，
   使「观潮」与下方导航项的文字落在同一条左基线上 */
.brand-logo {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  object-fit: cover;
  flex-shrink: 0;
  display: block;
}
.brand-name {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 4px;
  color: var(--text);
  font-family: 'STKaiti', 'KaiTi', '楷体', serif;
}
</style>
