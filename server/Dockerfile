# 构建上下文是本目录（云托管「目标目录」填 server）。
FROM node:20-bookworm-slim

WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . ./

ENV NODE_ENV=production
ENV PORT=80
EXPOSE 80

CMD ["node", "src/index.js"]
