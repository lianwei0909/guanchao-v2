import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
/* 复用旧版样式表，保证迁移过程中视觉完全一致 */
import '../../css/style.css'

createApp(App).use(createPinia()).use(router).mount('#app')
