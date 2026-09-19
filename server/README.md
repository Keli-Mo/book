# 微信云托管（koa-hwx1）

小程序仓库根目录的 `Dockerfile` 只打包本目录。控制台绑定 `Keli-Mo/book` 的 `main` 时，容器端口填 **80**，服务名保持 `koa-hwx1`。

```sh
cd server
npm ci
PORT=80 npm start
```

启动分流：`GET /api/app-entry` 返回 `{ "ok": true, "mode": "intro" | "practice" }`。用环境变量 `APP_ENTRY_MODE=practice` 切到听音跟读，未设置或其它值视为 `intro`。健康检查：`GET /health`。
