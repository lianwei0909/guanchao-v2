<script setup lang="ts">
/* 尚未迁移到 Vue 版的页面占位，提供回旧版的入口，保证迁移期不丢功能 */
defineProps<{ title?: string }>()
</script>

<template>
  <div class="empty" style="padding:48px 16px;text-align:center">
    <div style="font-size:15px;margin-bottom:8px">
      「{{ title || '该页面' }}」尚未迁移到 Vue 版
    </div>
    <div style="font-size:13px;opacity:.75;margin-bottom:16px">
      迁移进行中，期间可继续使用旧版，功能不受影响
    </div>
    <a class="btn ghost sm" href="/" style="text-decoration:none">前往旧版</a>
  </div>
</template>
