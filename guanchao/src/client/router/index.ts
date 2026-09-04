import { createRouter, createWebHashHistory } from 'vue-router'
import Overview from '@/views/Overview.vue'
import Pending from '@/views/Pending.vue'

/* 沿用 hash 路由，与旧版链接（#/stock-overview 等）完全兼容，
   已收藏的地址不会失效。未迁移的页面统一走 Pending 占位。 */
const routes = [
  { path: '/', redirect: '/stock-overview' },
  { path: '/stock-overview', name: 'overview', component: Overview },

  /* ---- 以下页面待迁移 ---- */
  {
    path: '/stock-treemap',
    name: 'treemap',
    component: () => import('@/views/Treemap.vue')
  },
  {
    path: '/stock-watchlist',
    name: 'watchlist',
    component: () => import('@/views/Watchlist.vue')
  },
  {
    path: '/stock-rank',
    name: 'rank',
    component: () => import('@/views/Rank.vue')
  },
  {
    path: '/stock-dark',
    name: 'dark',
    component: () => import('@/views/Dark.vue')
  },
  {
    path: '/stock-youzi',
    name: 'youzi',
    component: () => import('@/views/Youzi.vue')
  },
  {
    path: '/stock-us',
    name: 'us',
    component: () => import('@/views/UsMarket.vue')
  },
  {
    path: '/stock-hk',
    name: 'hk',
    component: () => import('@/views/HkMarket.vue')
  },
  {
    path: '/stock-forecast',
    name: 'forecast',
    component: () => import('@/views/Forecast.vue')
  },
  {
    path: '/stock-paper-portfolio',
    name: 'paper',
    component: () => import('@/views/Paper.vue')
  },
  {
    path: '/stock-signal-monitor',
    name: 'signal',
    component: () => import('@/views/Signal.vue')
  },
  {
    path: '/stock-news',
    name: 'news',
    component: () => import('@/views/News.vue')
  },
  {
    path: '/stock-rzrq',
    name: 'rzrq',
    component: () => import('@/views/Rzrq.vue')
  },
  {
    /* 财经日历 + 题材炒作 融合为一个版块，旧链接兼容重定向到日历 tab */
    path: '/stock-calendar',
    name: 'calendar',
    component: () => import('@/views/CalendarConcept.vue'),
    alias: ['/stock-concept']
  },

  { path: '/:pathMatch(.*)*', component: Pending, props: { title: '未知页面' } }
]

export default createRouter({
  history: createWebHashHistory(),
  routes
})
