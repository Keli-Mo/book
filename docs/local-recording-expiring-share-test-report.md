# 本地录音限时分享自测记录

日期：2026-09-11。分支：`codex/local-recording-expiring-share`。这是代码与模拟适配器验证，不是线上部署或真机验收证明。

## 全量脚本

根代理分批独立执行全部 31 个 `scripts/test-*.cjs`，31/31 退出码为 0。首轮发现的默认教材入口与旧 UI 字段断言已修正后重新完整执行；曾停滞的录音测试进程结束后也已独立重跑通过。

| 脚本 | 退出码 |
| --- | --- |
+| test-audio-playback.cjs | 0 |
| test-book-assets-remote.cjs | 0 |
| test-book-audio-map-validator.cjs | 0 |
| test-book-catalog.cjs | 0 |
| test-book-library-pages.cjs | 0 |
| test-book-practice.cjs | 0 |
| test-check-in-detail-runtime.cjs | 0 |
| test-check-in-function.cjs | 0 |
| test-check-in-submission-runtime.cjs | 0 |
| test-check-in-submission.cjs | 0 |
| test-cloud-check-in-service.cjs | 0 |
| test-cloud-error.cjs | 0 |
| test-device-layout.cjs | 0 |
| test-home-navigation.cjs | 0 |
| test-hotspot-layout.cjs | 0 |
| test-local-recording-pages.cjs | 0 |
| test-local-share-lifecycle.cjs | 0 |
| test-my-check-ins-pending.cjs | 0 |
| test-pending-check-in-runtime.cjs | 0 |
| test-pending-check-in.cjs | 0 |
| test-practice-book-route.cjs | 0 |
| test-practice-directory-component.cjs | 0 |
| test-practice-directory.cjs | 0 |
| test-practice-recording-wiring.cjs | 0 |
| test-recorder-coordinator.cjs | 0 |
| test-recording-file-roundtrip.cjs | 0 |
| test-recording-interaction.cjs | 0 |
| test-recording-library-view.cjs | 0 |
| test-responsive-page-contract.cjs | 0 |
| test-share-expiry-cleanup.cjs | 0 |
| test-ui-refinements.cjs | 0 |

## 编译与静态检查

- `npx tsc --noEmit --skipLibCheck --noUnusedLocals false --noUnusedParameters false`：退出码 0。沿用仓库兼容参数，不宣称原始严格 TS 检查通过。
- 对本次修改的生产 TS/TSX/云函数 JS 执行 ESLint：退出码 0、规则错误/警告均为 0；工具仍输出既有 Browserslist 数据陈旧提示。
- `npm run build:weapp -- --no-cache`：退出码 0；保留既有 Sass 弃用、Browserslist 和包体积建议警告。
- 教材映射测试仍报告 6 个已有轻微越界警告；未在本次录音存储改动中重排教材热点。

## 已覆盖与未覆盖

已覆盖保存后真实文件字节/指纹、完成零上传、重启恢复、有效分享复用、30 天失效换代、丢回包恢复、离页取消与迟到事件、分享状态写失败、旧云历史、清理失败重试和新旧文件范围隔离。

尚未执行真实微信麦克风、iOS/Android/Pad 设备录音、实际分享卡片发送、线上权限和短签名到期验证。云函数尚未部署，生产清理未启用；按部署说明完成目标环境验收后才能上线。
