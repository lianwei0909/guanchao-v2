/* PM2 备选方案（与 server/watchdog.js 二选一，不要同时启用，会抢端口）。

   默认推荐用零依赖的 server/watchdog.js（npm run start:supervised）。
   若你更习惯 PM2，或需要 cluster/监控面板等能力，再用本文件：

     npm i -g pm2
     pm2 start ecosystem.config.cjs
     pm2 save && pm2 startup     # 开机自启

   注意：
     - web 保持单实例：预测结果/K 线等缓存在进程内存中，多实例会导致
       命中率腰斩。若要横向扩展，请先落地「预计算 + 磁盘缓存」
       （见 docs/guanchao-技术审查与优化方案.md §3.2），再把 instances 调大。
     - ML 服务的解释器可用 ML_PYTHON 覆盖。 */
module.exports = {
  apps: [
    {
      name: 'guanchao-web',
      script: 'server/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '20s',          // 20s 内退出视为启动失败，避免无限重启刷屏
      restart_delay: 3000,
      max_memory_restart: '400M', // 兜底：内存异常增长时重启
      watch: false,
      env: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
        RATE_PER_MIN: '600'
      },
      out_file: 'logs/pm2-web-out.log',
      error_file: 'logs/pm2-web-err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss'
    },
    {
      name: 'guanchao-ml',
      script: 'ml_service/service.py',
      interpreter: process.env.ML_PYTHON || 'python',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 5,
      min_uptime: '15s',
      restart_delay: 5000,
      max_memory_restart: '2G',
      watch: false,
      out_file: 'logs/pm2-ml-out.log',
      error_file: 'logs/pm2-ml-err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss'
    }
  ]
};
