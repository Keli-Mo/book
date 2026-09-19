# 微信云托管（koa-hwx1）

`Dockerfile` 与本目录同级。控制台绑定 `Keli-Mo/book` 的 `main` 时：

- 目标目录填 `server`
- Dockerfile 名称填 `Dockerfile`
- 容器端口填 **80**
- 服务名保持 `koa-hwx1`

```sh
cd server
npm ci
PORT=80 npm start
```

启动分流：`GET /api/app-entry` 返回 `{ "ok": true, "mode": "intro" | "practice" }`。用环境变量 `APP_ENTRY_MODE=practice` 切到听音跟读，未设置或其它值视为 `intro`。健康检查：`GET /health`。
