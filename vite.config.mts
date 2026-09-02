import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/* 与旧版（根目录 index.html + js/app.js + js/api.js）并存：
   - 旧版继续由 server.js 托管在 9000 端口，功能不受影响
   - Vue 版入口是 index-vue.html，dev 跑在 5173，/api 代理到 9000 复用同一套后端
   注意：必须显式指定 input，否则 Vite 会把根目录的旧 index.html 当成入口。 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': r('./src/client') }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: r('./index-vue.html')
    }
  },
  server: {
    port: 5173,
    open: '/index-vue.html',
    proxy: {
      '/api': {
        target: 'http://localhost:9000',
        changeOrigin: true
      }
    }
  }
})
