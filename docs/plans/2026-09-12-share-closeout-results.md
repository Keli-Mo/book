# 分享异常处理收尾验收

## 范围

用户已反馈分享恢复正常；本轮补齐错误分类、控制台诊断和自动化回归，不以本地测试代替线上版本核验。基线为 `c8241bf`，工作区为 `.worktrees/all-books-device-recording`。

不修改页面布局、录音状态机、保存/删除策略、云函数、项目配置及套餐；不推送、部署、清缓存或操作真实录音。不启用过期自动删除。

## 修复和诊断

- `prepare` 在上传前校验回包。旧版 `checkins/` 路径返回 `SHARE_PROTOCOL_MISMATCH`，不再继续创建无期限云分享；新版路径仍为 `expiring-shares-v2/`。
- `prepare` 已提交结果及 `commit` 成功结果都必须包含有效编号、口令和数值型 `expiresAtMs`。缺失期限按协议不匹配处理；其他错误格式按 `SHARE_RESPONSE_INVALID` 处理。绝不在本机自行补 30 天。
- 页面区分服务版本、服务返回异常、服务配置、网络异常和本机状态保存失败；成功但回写未完成只提示“本机状态未同步”，不显示为可发送状态。
- 提交失败记录阶段，例如 `[recording] share.preparing.failed` / `share.committing.failed`；真正的本地分享写入异常为 `share.metadata.write.failed`；回写待完成为 `share.local_write.pending`，完成为 `share.ready`。
- 统一接入已有 `logRecordingDiagnostic`：仅控制台，记录时间、录音编号前 8 位、错误码和分类。不输出原始错误全文、录音路径、分享口令、签名 URL，不落盘、不上传。日志自身报错不改变分享结果。

## 验证结果

先增加失败测试，复现旧云端返回被误报为 `committed + cleanupPending`；再修复并观察测试通过。页面错误分类和运行时日志接线也分别观察到修改前断言失败。

- 全量 `scripts/test-*.cjs`：40/40 通过，本次无超时重试。完整输出见 `.superpowers/sdd/share-closeout-regression.json`。
- `test-cloud-check-in-service.cjs`：13 组通过，包括旧上传路径拦截、缺失/非法期限、空包/畸形成功包、合法新版响应及旧 `create` 兼容。
- `test-check-in-submission.cjs`：30 组通过，包括并发去重、失败重试、取消时序及日志不可用。
- `test-local-share-lifecycle.cjs`：使用真实客户端服务、协调器、仓储及本地云函数实现；仅替换微信 SDK、文件系统、数据库和时钟。覆盖另一账号持正确口令可读取、错误/空口令拒绝、30 天过期、重启恢复、云端提交成功丢回包、本地分享回写失败后恢复，以及本地文件始终保留。旧版 prepare 被拦截时上传次数为 0；已上传的结果恢复时总上传次数仍为 1。
- `test-check-in-detail-runtime.cjs`：真实页面点击回调按错误分类提示，失败解除 loading，回写失败不能虚报可发送；原有离页、回听及分享状态测试通过。
- 本轮 5 个生产文件 ESLint：通过。
- `npm run build:weapp`：退出码 0。仍有现有 Browserslist 数据过旧、第三方 Sass 弃用和包体积提示；未借此升级依赖。
- 完整 TypeScript 检查并非全绿：`--noEmit --skipLibCheck` 仍报 4 个未使用变量/参数错误，位于本轮未修改的 `config/index.ts:7`、`BookPreview.tsx:157/229`、`BottomBar.tsx:4`。关闭这两项未使用检查后类型检查通过；本轮不顺带修改其他页面。

## 实际环境边界

独立只读审查未发现 Critical/Important 问题，提出 1 项空响应分类缺口；已补失败测试并修正该分类，旧业务失败码仍保留。

以上好友访问是测试身份模拟，不是实际微信转发。尚需用户用另一微信验证收到卡片、进入详情及播放音频；也需在手机上确认普通退出重进后同一录音可回听。不要清除缓存来测试重启。

本轮不会自动迁移已经被旧云函数提交的历史分享请求。若历史请求在云端升级后返回 `REQUEST_ID_CONFLICT`，日志会保留错误码，需要核对该请求的云端记录与协议版本；不能直接删除数据或把所有冲突都当成可以换代重传。

云端 30 天失效、私有存储权限及实际定时清理仍须按 `docs/local-recording-expiring-share-deployment.md` 单独进行部署验收。本轮不代表生产清理已启用。
