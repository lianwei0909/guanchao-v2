<script setup lang="ts">
/* 屏幕居中的加载提示（切换周期 / 点击筛选 / 重新预测等场景共用）。
   与表格内的「加载中…」文字不同：这个是用户主动触发加载时的全屏聚焦提示，
   用于在此期间隐藏旧数据，避免用户误读上一批结果。 */
defineProps<{ text?: string }>()
</script>

<template>
  <div class="loading-overlay">
    <span class="spin-dot"></span>
    {{ text || '加载中，请稍后…' }}
  </div>
</template>

<style scoped>
/* 跟随主题：底色/文字用 surface/text，不再硬编码白底
   （原 #fff 底 + var(--primary) 文字，深色下主色反转为浅色、浅字白底看不清） */
.loading-overlay {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 150;
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 15px 24px;
  font-size: 15px;
  font-weight: 700;
  line-height: 1.5;
  max-width: min(560px, 88vw);
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow-lg);
}
.spin-dot {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: loading-spin 0.9s linear infinite;
  flex: none;
}
@keyframes loading-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
