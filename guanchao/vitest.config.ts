import { defineConfig } from 'vitest/config'

/* 测试独立于前端构建配置：只跑 Node 侧（server/）的纯逻辑，
   不依赖网络，保证 CI 与离线环境都能执行。 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    testTimeout: 15000,
    reporters: ['default']
  }
})
