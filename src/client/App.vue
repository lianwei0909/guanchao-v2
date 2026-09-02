<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'

const router = useRouter()
const route = useRoute()

/* 与旧版 index.html 的导航项一一对应，保证迁移期入口不缺失 */
const navs = [
  { route: '/stock-overview', label: '全景盘面', icon: '🌐' },
  { route: '/stock-rank', label: 'A股行情', icon: '🏆' },
  { route: '/stock-treemap', label: '大盘云图', icon: '🧩' },
  { route: '/stock-watchlist', label: '自选股', icon: '⭐' },
  { route: '/stock-dark', label: '暗盘监控', icon: '🌙' },
  { route: '/stock-youzi', label: '游资操作', icon: '🐉' },
  { route: '/stock-us', label: '美股行情', icon: '🇺🇸' },
  { route: '/stock-hk', label: '港股行情', icon: '🇭🇰' },
  { route: '/stock-azt-compare', label: '对比分析', icon: '⚖️' },
  { route: '/stock-forecast', label: '预测PP', icon: '📈' },
  { route: '/stock-paper-portfolio', label: '模拟持仓', icon: '💼' },
  { route: '/stock-signal-monitor', label: '盘中监控', icon: '📡' },
  { route: '/stock-news', label: '股票资讯', icon: '📰' }
]
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <img src="/icons/guanchao-logo.png" alt="观潮" class="brand-logo" />
        <span class="brand-name">观潮</span>
      </div>

      <div class="nav-group">行情</div>
      <button
        v-for="n in navs"
        :key="n.route"
        class="nav-item"
        :class="{ on: route.path === n.route }"
        @click="router.push(n.route)"
      >
        <span style="margin-right:6px">{{ n.icon }}</span>{{ n.label }}
      </button>

      <div class="sidebar-foot">
        <span style="font-size:11px;opacity:.6;padding:0 12px">Vue 版 · 迁移中</span>
      </div>
    </aside>

    <div class="main">
      <div class="content">
        <router-view />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 侧边栏品牌区 —— 观字 logo + 观潮楷体大字（与 favicon 字体一致） */
.brand-logo {
  width: 36px;
  height: 36px;
  border-radius: 9px;
  object-fit: cover;
  box-shadow: 0 2px 10px rgba(13, 71, 161, 0.35);
  flex-shrink: 0;
  display: block;
}
.brand-name {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 4px;
  color: var(--text, #1a1a2e);
  font-family: 'STKaiti', 'KaiTi', '楷体', serif;
  margin-left: 2px;
}
</style>
