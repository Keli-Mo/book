# 海沙牛娃英语跟读

基于 Taro 4、React 和 TypeScript 的微信小程序，提供多教材书架、示范听力、跟读录音、本地回听及微信分享。`book` 仓库的 `main` 汇总当前开发进度；同步源码不等于已经上传或发布小程序。

## 当前状态

- 已完成教材导航、手机/Pad 布局、录音保存与失败恢复、分享有效期和异常提示等修复。
- 录音默认保存在本机，用户点击分享后才上传；新版分享有效期为 30 天。
- 本地管理预算为 100 MiB，保留 10 MiB 安全余量；容量不足不自动淘汰旧录音。
- 云端过期清理代码已具备，但最后确认的线上删除开关关闭、无定时触发器。不会因为拉取或构建本仓库而开启清理。
- 隐私保护指引、清理部署验收及发布操作仍需收尾，不能将本分支当成已完成全部生产验收的证明。

最新进度及剩余事项见 [项目进度](docs/PROJECT_STATUS.md)。早期计划和审查文档是历史记录，应结合最新进度阅读。

## 本地开发

使用 Node.js 和 Yarn。最近本机验证使用 Node.js 24.19.0；依赖版本以 `yarn.lock` 为准。

```sh
yarn install --frozen-lockfile
yarn build:weapp
```

构建输出在 `dist/`。微信开发者工具导入本仓库根目录，由 `project.config.json` 的 `miniprogramRoot` 指向 `dist/`。不要导入旧项目目录的构建产物。

开发监听：

```sh
yarn dev:weapp
```

部分专项检查：

```sh
yarn test:responsive-pages
node scripts/test-recording-save-journal.cjs
node scripts/test-share-expiry-cleanup.cjs
```

其他测试位于 `scripts/test-*.cjs`。本机全量验收采用逐文件独立 Node 进程、每文件 30 秒限时执行；自动测试不能代替微信真机授权和云端权限验收。

## 代码与部署说明

- `src/`：页面、教材数据和录音/分享逻辑。
- `server/`：微信云托管 Koa 服务；`server/Dockerfile` 与代码同级，发布时目标目录填 `server`，端口 80。
- `cloudfunctions/checkIn/`：分享准备、确认、读取及本人恢复授权。
- `cloudfunctions/cleanupExpiredShares/`：独立过期清理函数。
- `scripts/`：回归测试和素材校验工具。
- `docs/`：设计、部署说明及验收证据。
- `prototypes/`：历史 UI 原型与演示素材。

部署规则见 [云函数说明](cloudfunctions/README.md) 和 [本地录音与分享部署说明](docs/local-recording-expiring-share-deployment.md)。当前小程序 AppID 和云环境配置属于现有项目；更换环境前应核对教材资源、权限及云函数配套情况。不要将密钥写入仓库。

`dist/`、`node_modules/` 和临时输出不纳入 Git，需在目标机器安装依赖并重新构建。本仓库也不是云数据库、完整云端教材或学生录音的备份。

保留目标仓库已有的 MIT `LICENSE`；教材封面、图片、示范音频及其他第三方素材的使用与传播授权须单独确认，不能仅凭代码许可证推定。
