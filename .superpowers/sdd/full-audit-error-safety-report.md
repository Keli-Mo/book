# 云端错误安全实现报告

## 实现摘要

- `checkIn` 云函数将异常出口限制为固定 code/message 白名单；参数错误统一为 `INVALID_ARGUMENT`，未知 action 使用固定分类，日志只记录白名单 action 与 code。
- `cleanupExpiredShares` 将逐条清理和批次异常归入固定代码集，不再记录记录 ID、原始 Error、message、errMsg 或任意 SDK code。
- 客户端 `cloudCheckIn.ts` 复用统一错误分类入口；云函数 reject、结构化失败和可读提示均不拼接原始文案或任意 code，同时保留明确业务码与分享失败的既有本地提示语义。
- 测试 harness 捕获 `console.error` 的完整参数，并以合成标记覆盖 prepare、commit、detail、listMine、remove、未知 action、删除返回失败、最终事务失败、清理逐条/外层失败，以及客户端 Error/普通对象/字符串/数字 code/未知 code。
- README 说明应用日志与响应只使用固定分类，同时明确不据此宣称平台日志留存或访问权限已治理。

## RED 命令与失败理由

```powershell
$node='C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $node 'scripts\test-check-in-function.cjs'
& $node 'scripts\test-share-expiry-cleanup.cjs'
& $node 'scripts\test-cloud-error.cjs'
& $node 'scripts\test-cloud-check-in-service.cjs'
```

四项在未修复实现上均退出 1：

- checkIn 返回合成 URL/口令标记，而非固定网络分类；
- 清理日志包含合成标记；
- `getReadableCloudError` 原样返回合成错误 message；
- 云服务 reject 与结构化错误保留原始 Error.message/code。

测试捕获改为 `util.inspect` 后另做故障注入：临时把原始 Error 加回 checkIn/清理日志，两项聚焦测试均因检测到 `SYNTHETIC_PRIVATE_VALUE` 退出 1；恢复安全日志实现后再验证。

独立复审补修继续按 TDD 执行。新增断言后，checkIn 测试以 3 项失败退出 1：未知 action 没有固定日志、`getWXContext()` 原始异常直接外抛、`event=null` 在 catch 中二次读取 action 再外抛；cleanup 测试以 2 项失败退出 1：上下文异常直接外抛、外部错误仅把 `code` 命名为 `DATABASE_TRANSACTION_CONFLICT` 即被误认成内部分类。

## GREEN 命令与输出

```powershell
& $node 'scripts\test-check-in-function.cjs'
& $node 'scripts\test-share-expiry-cleanup.cjs'
& $node 'scripts\test-cloud-error.cjs'
& $node 'scripts\test-cloud-check-in-service.cjs'
& $node 'scripts\test-local-share-lifecycle.cjs'
& $node 'node_modules\typescript\bin\tsc' --noEmit --skipLibCheck
```

最终输出：

- checkIn 云函数协议：38/38；
- 分享清理：14/14；
- 云开发错误提示脚本：通过；
- 客户端打卡服务：14/14；
- 本地分享生命周期集成：通过；
- TypeScript：退出 0，无输出。

## 变更文件

- `cloudfunctions/checkIn/index.js`
- `cloudfunctions/cleanupExpiredShares/index.js`
- `src/services/cloudCheckIn.ts`
- `scripts/test-check-in-function.cjs`
- `scripts/test-share-expiry-cleanup.cjs`
- `scripts/test-cloud-error.cjs`
- `scripts/test-cloud-check-in-service.cjs`
- `cloudfunctions/README.md`
- `.superpowers/sdd/full-audit-error-safety-report.md`

## Commit

- `fix: 脱敏云函数错误响应与诊断日志`（本报告随同该提交；最终哈希以 `git log -1` 为准）。
- `fix: 补齐云函数入口错误脱敏`（独立复审补修；最终哈希以 `git log -1` 为准）。

## 自查与疑点

- 仅处理错误脱敏；没有修改 commit 下载包一致性、清理游标/预算、配额、v1、下载限长、权限、超时或依赖。
- 未访问真实数据、未调用云 API、未部署、未 push、未修改 IDE 配置。
- 保留工作树已有 `project.config.json`、`project.private.config.json` 与其他未跟踪计划文件，不纳入暂存。
- 现有成功响应、分享状态不确定时保留本地文件/状态、删除失败重试及墓碑收敛测试均继续通过。
- 两个 `getWXContext()` 均已纳入安全 catch；checkIn 的 null/非对象事件固定归类 `INVALID_ARGUMENT`，未知 action 固定记录 `unknown`；清理只允许精确内部 Error.message 进入固定分类，任意同名外部 code 归入 `CLEANUP_FAILED`。
- 应用层已阻断已覆盖路径的原始错误输出；平台自身日志留存、访问权限及运行环境仍需由发布负责人独立核验。
