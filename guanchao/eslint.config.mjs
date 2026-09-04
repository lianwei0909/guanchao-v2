import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'

/* 说明：
   - 后端是 CommonJS（server/），前端是 ESM + TS（src/），两套规则分开配。
   - 后端重点开 no-undef：它能直接发现分层拆分后漏掉的 import。
   - 本文件用 ESM 语法，因此扩展名必须是 .mjs（package.json 不能设
     "type":"module"，否则后端 CommonJS 模块全部无法加载）。 */
export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'data/**', 'coverage/**', 'public/**']
  },

  /* ---------- 后端（server/）：CommonJS ---------- */
  {
    files: ['server/**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-undef': 'error',
      'no-unused-vars': 'off', // 拆分后存在跨模块导出的中间变量，暂不约束
      'no-empty': 'off',
      'no-cond-assign': 'off' // 代码里有 `if (seen[x] = 1)` 这类惯用写法
    }
  },

  /* ---------- 测试：ESM ---------- */
  {
    files: ['tests/**/*.{js,ts}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: { 'no-undef': 'off' }
  },

  /* ---------- 前端 TS ---------- */
  ...tseslint.configs.recommended.map((c) => ({ ...c, files: ['src/**/*.ts'] })),

  /* ---------- 前端 Vue ---------- */
  ...pluginVue.configs['flat/recommended'].map((c) => ({ ...c, files: ['src/**/*.vue'] })),
  {
    files: ['src/**/*.vue'],
    languageOptions: {
      /* vue-eslint-parser 解析 <script lang="ts"> 时需要显式指定 TS 解析器 */
      parserOptions: {
        parser: tseslint.parser,
        ecmaVersion: 2022,
        sourceType: 'module'
      },
      globals: { ...globals.browser, ...globals.node }
    },
    rules: {
      'vue/multi-word-component-names': 'off',
      /* 纯格式类规则交给 Prettier，避免与现有代码风格冲突产生大量噪音 */
      'vue/max-attributes-per-line': 'off',
      'vue/html-self-closing': 'off',
      'vue/attributes-order': 'off',
      'vue/singleline-html-element-content-newline': 'off'
    }
  }
]
