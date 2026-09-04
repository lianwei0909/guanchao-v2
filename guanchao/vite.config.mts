import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/* 单一前端：Vue 3 入口为根目录 index.html（遗留版 js/app.js 已移除）。
 dev 跑在 5173，/api 代理到 9000 复用同一套后端；
 build 产物落在 dist-build/，由 server/app.js 直接托管。

 emptyOutDir 必须为 true：Vite 产物带内容哈希，关闭清理会让历史 chunk
 无限累积（实测曾堆积到 356 个 JS / 3.52MB，实际仅需约 30 个文件）。 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': r('./src/client') }
  },
  build: {
    target: 'es2020',
    outDir: 'dist-build',
    emptyOutDir: true,
    cssCodeSplit: true,
    /* 单包超过该体积时提示，用于监控是否又长出巨型 chunk */
    chunkSizeWarningLimit: 900,
    sourcemap: false,
    rollupOptions: {
      input: r('./index.html'),
      output: {
        /* 稳定的三方依赖单独成包：业务代码迭代时用户不必重新下载 vue 全家桶 */
        manualChunks: {
          vue: ['vue', 'vue-router', 'pinia']
        }
      }
    }
  },
  server: {
    port: 5173,
    open: '/',
    proxy: {
      '/api': {
        target: 'http://localhost:9000',
        changeOrigin: true
      }
    }
  }
})
