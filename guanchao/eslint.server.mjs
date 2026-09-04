/* 服务端（CommonJS）专项 Lint 配置。

   存在的理由：服务端是纯 JS，没有 TypeScript 兜底，
   本次审查中的 P0 级缺陷（forecast.js 评分闭包引用未声明变量）正是因为
   缺少 no-undef 检查才一路跑到生产。这份配置把它变成 CI 的硬门禁。

   运行：npm run lint:server */
import globals from 'globals'

export default [
  {
    files: ['server/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        // Node 18+ 全局（globals 包可能未覆盖，显式补齐）
        fetch: 'readonly',
        AbortController: 'readonly',
        TextDecoder: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        structuredClone: 'readonly'
      }
    },
    rules: {
      // P0 防线：引用未声明变量直接失败（本次 P0-1 的唯一发现手段）
      'no-undef': 'error',
      // 死代码防线：未使用的变量/导入一并拦截
      // args:'none'  —— 回调参数常需保留以表达签名
      // caughtErrors:'none' —— 允许 catch (e) {} 这类刻意忽略
      'no-unused-vars': ['error', {
        args: 'none',
        caughtErrors: 'none',
        varsIgnorePattern: '^_'
      }]
    }
  }
]
