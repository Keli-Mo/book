# 清理归属与引用防护实现报告

## 实现摘要

- `fileFor` 现要求非空 `_openid`、32 位小写十六进制 `requestId`、64 位小写十六进制 `payloadDigest`，并精确比较 `expiring-shares-v2/${sha256(owner)}/${requestId}-${payloadDigest}.mp3`。
- 保留可信云存储前缀和 `recordingFileId` 一致性校验；`active` 缺少 fileID 失败关闭，pending、deletePending 和 deleted 可仅保留完整可信路径。
- dry-run 与正式模式均在 `validated++` 前执行相同的绑定和全引用预检。引用查询固定为 `where({ recordingFileId }).limit(2)`，不按 owner、期限、状态或协议版本过滤；只接受空结果或唯一一条 `_id`、owner 均匹配目标的结果。
- 引用冲突、非数组结果和查询异常分别使用固定安全分类 `FILE_REFERENCE_CONFLICT`、`FILE_REFERENCE_CHECK_FAILED`；绑定不一致使用 `INVALID_SHARE_BINDING`，不输出原始 fileID、OPENID 或 SDK 错误。
- 正式清理首事务重读记录，再次确认期限、完整绑定和扫描时目标；绑定竞态不能复用旧预检结果。未知删除结果、墓碑、迟到上传、逐候选检查点和 revision CAS 行为保持不变。
- 引用查询成本纳入原 1,200ms 软预算。核验结束时预算已耗尽则不计 `validated` / `processed`，不写状态、不删除文件，游标不跨过该候选。

## TDD 证据

### RED

命令：

```powershell
& 'C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' 'scripts\test-share-expiry-cleanup.cjs'
```

生产改动前结果：退出码 1；原有 24 组通过，新增缺口中 7 组按预期失败，末行：

```text
FAIL 预演和正式模式都拒绝owner或请求摘要与路径不一致且不改变记录和文件: 0 !== 1
FAIL active必须有可信fileID，pending、deletePending和deleted可只保留完整可信路径: 4 !== 3
FAIL 同fileID的其他owner或同owner第二条记录都阻断且不能先写deletePending: 0 !== 1
FAIL 引用核验不按owner期限状态或旧协议过滤且只取两条: 1 !== 0
FAIL 引用查询异常和非数组结果固定失败关闭且不泄漏SDK错误: 0 !== 1
FAIL 引用核验耗尽软预算时不报validated且不写状态或推进游标: false !== true
FAIL 正式首事务拒绝预检后改变的完整绑定: 0 !== 1
7/31 项清理测试失败
```

这些失败分别证明旧实现未验证 owner/request/digest 绑定、允许 active 无 fileID、没有全引用查询、未将引用查询计入预算，且首事务不能识别预检后的绑定变化。

### GREEN

最终验证命令：

```powershell
& 'C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check 'cloudfunctions\cleanupExpiredShares\index.js'
& 'C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check 'scripts\test-share-expiry-cleanup.cjs'
& 'C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' 'scripts\test-share-expiry-cleanup.cjs'
& 'C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' 'scripts\test-check-in-function.cjs'
& 'C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' 'scripts\test-local-share-lifecycle.cjs'
git diff --check -- 'cloudfunctions/cleanupExpiredShares/index.js' 'scripts/test-share-expiry-cleanup.cjs' 'cloudfunctions/README.md'
```

最终结果：退出码 0。

```text
分享清理测试通过：31 组。
云函数协议测试通过：38 组，含乐观冲突、文件校验和墓碑。
本地分享集成通过：完成零联网、重启恢复、好友口令鉴权、30天过期重传、丢回包/本地回写失败幂等恢复、旧协议拦截、脱敏日志接线、本地不删除。
```

语法检查和任务文件 `git diff --check` 均无错误。预算专项断言确认 `referenceQueryMs=1200` 时返回 `budgetExhausted=true`、`validated=0`、`processed=0`、`nextCursor=""`，目标仍为 active，状态集合无写入，文件删除次数为 0。

## 文件

- `cloudfunctions/cleanupExpiredShares/index.js`
- `scripts/test-share-expiry-cleanup.cjs`
- `cloudfunctions/README.md`
- `.superpowers/sdd/full-audit-cleanup-ownership-report.md`

## Commit

- `fix: 清理前核验录音归属与全部引用`（本报告与实现同一提交；短 SHA 由提交后 `git log -1` 回传）

## 自查与疑点

- 已逐项核对 brief：真实 fixture、dry-run/正式一致预检、同 owner 别名、101 个总引用、查询异常、空引用、pending/active/deletePending/deleted、临期 commit 竞态、未知删除、检查点/回绕、迟到上传和预算成本均有覆盖。
- 引用检查是应用层当前读结果，不是数据库级跨文档锁；管理员在预检后并发制造别名仍不由本实现证明安全，README 已明确该边界。首事务仅保证目标记录自身的期限和完整绑定没有复用旧结果。
- 未读取或修改真实数据，未部署、push、调用云端、启用清理、修改权限/套餐/索引/变量/触发器。
- 保留了工作树中既有 IDE 配置和其他计划/QA dirty；未纳入本提交。
