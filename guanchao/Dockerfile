# 多阶段构建：先把前端编译成静态产物，运行镜像只保留 dist + server
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# 运行阶段：后端零第三方依赖（仅用 Node 内置模块），无需安装任何 npm 包
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=9000

COPY --from=build /app/server ./server
COPY --from=build /app/dist ./dist

# 运行期数据（自选同步 / 邮件配置）落在这里，挂载卷可持久化
RUN mkdir -p /app/data/sync && chown -R node:node /app/data
USER node

EXPOSE 9000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
