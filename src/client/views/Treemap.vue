<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'

/* 大盘云图：直接嵌入 52etf.site（与旧版一致）。
   实测该站响应头无 X-Frame-Options、也无 CSP frame-ancestors，允许被 iframe 嵌入，
   数据、交互、配色都由对方维护，本侧只保留容器与入口按钮。 */
const TM_SITE = 'https://52etf.site/'
const frameKey = ref(0)
const router = useRouter()

function reload() {
  frameKey.value++ // 重设 key 强制重建 iframe
}
function openNew() {
  window.open(TM_SITE, '_blank', 'noopener')
}
/** 退出全屏云图：有上一页则返回上一页，否则回自选股 */
function exit() {
  if (window.history.length > 1) router.back()
  else router.push('/stock-watchlist')
}
</script>

<template>
  <div class="tm-embed">
    <div class="tm-embed-bar">
      <span class="tm-embed-title">🗺️ 大盘云图</span>
      <span class="tm-embed-note">数据源 52etf.site · 面积=流通市值 颜色=涨跌幅</span>
      <span class="tm-embed-actions">
        <button class="btn sm ghost" title="在新窗口打开源站" @click="openNew">↗ 新窗口</button>
        <button class="btn sm ghost" title="重新加载" @click="reload">⟳</button>
        <button class="btn sm ghost" title="退出，回到常规界面" @click="exit">✕</button>
      </span>
    </div>
    <iframe
      :key="frameKey"
      class="tm-embed-frame"
      :src="TM_SITE"
      referrerpolicy="no-referrer"
      loading="eager"
      allow="fullscreen; clipboard-write"
    ></iframe>
  </div>
</template>
