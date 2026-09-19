# 微信云托管从仓库根目录构建。镜像只包含 server/，不把小程序和云函数打进容器。
FROM node:20-bookworm-slim

WORKDIR /usr/src/app

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

COPY server/ ./

ENV NODE_ENV=production
ENV PORT=80
EXPOSE 80

CMD ["node", "src/index.js"]
