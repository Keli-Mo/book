# 过期清理进度与软预算实现报告

## 实现摘要

- 在定时来源鉴权后、首次云端 I/O 前启动固定 `WORK_BUDGET_MS = 1200` 软预算。预算只阻止启动新的页面读取或候选处理，不充当网络/单操作硬超时。
- 返回新增 `processed` 与 `budgetExhausted`。`scanned` 仍表示取得的页面大小；`processed` 表示实际检查完成、游标可越过的连续前缀；其他计数只包含实际启动的候选。
- 新增 `saveCursor(nextCursor)`：事务重读 `shareCleanupState/v2`，按本调用持有的 `expectedRevision` 比较并递增；revision 已变化时以 `CLEANUP_STATE_CHANGED` 立即终止，不覆盖并发进度。
- 每个已处理候选（成功或可重试失败）结束后保存连续前缀。未到期行不逐条 checkpoint，仅在页尾或预算退出时集中保存；因此实际额外成本是每个候选一次游标事务读写，外加尾部未到期前缀需要时的一次事务读写。
- 只有完整处理短页最后一条时保存空游标；满页保留末条 ID，下一次空页再回绕。预算退出不越过尚未处理行；检查点失败停止后续删除。
- dry-run 不读取/写入正式游标、不删除文件，仍按软预算返回实际审核位置，未启动候选不计入 `candidates`/`validated`。
- 保留既有固定错误分类和脱敏日志；未加入 owner/reference、配额、v1 或下载限长改动。

## TDD 证据

### RED 1：页内进度在模拟硬超时前无法保存

命令：

`C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe scripts/test-share-expiry-cleanup.cjs`

旧实现运行新增的 51 条到期记录场景（每事务 30ms、删除 70ms、每次调用重新计时、3,000ms 到达即抛）时输出：

```text
FAIL 软预算逐候选检查点可在硬超时前多轮推进完整页: AssertionError: 软预算退出必须早于模拟硬超时
false !== true
1/15 项清理测试失败
```

失败原因符合预期：旧实现仅在整页末尾写游标，先撞上模拟硬超时并返回 `ok:false`，无法跨轮推进到第 51 条。其余原有 14 组通过。

### RED 2：正式游标读取耗尽预算后仍启动页面查询

同一命令在新增入口边界断言后输出：

```text
FAIL 正式游标读取已耗尽软预算时不再启动分页查询
1 !== 0
1/23 项清理测试失败
```

失败原因符合预期：实现当时已能在页面读取后停止，但正式游标读取本身耗尽 1,200ms 后仍额外启动了一次页面查询。

### GREEN

最终聚焦命令：

`C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe scripts/test-share-expiry-cleanup.cjs`

结果：退出码 0，`分享清理测试通过：23 组。`。覆盖 51 条多轮推进、软/模拟硬预算、checkpoint 失败、单候选未知删除错误、纯 active 页、短页/空页回绕、并发 revision、dry-run 只读、脱敏和迟到上传回收。

## 最终验证

- cleanup 聚焦：上述命令，23/23 通过，退出码 0。
- checkIn 协议：`C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe scripts/test-check-in-function.cjs`，38/38 通过，退出码 0。
- local-share-lifecycle：`C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe scripts/test-local-share-lifecycle.cjs`，通过，退出码 0。
- 语法检查：对 `cloudfunctions/cleanupExpiredShares/index.js` 和 `scripts/test-share-expiry-cleanup.cjs` 执行 Node `--check`，退出码 0。
- `git diff --check -- cloudfunctions/cleanupExpiredShares/index.js scripts/test-share-expiry-cleanup.cjs cloudfunctions/README.md`：退出码 0。

## 变更文件

- `cloudfunctions/cleanupExpiredShares/index.js`
- `scripts/test-share-expiry-cleanup.cjs`
- `cloudfunctions/README.md`
- `.superpowers/sdd/full-audit-cleanup-progress-report.md`

## 自查与疑点

- 按 brief 逐项核对，未发现遗漏；候选失败仍保存录音引用和可重试状态，checkpoint 失败不会继续删除后续记录。
- 进度写入频率有意提高为“每个已处理候选一次状态事务”，这是防止整页进度丢失的数据库成本；纯未到期页只在页尾写一次，空游标无变化时不写。
- 3,000ms 仅是 harness 虚拟硬预算；没有真实 sleep、线上调用或平台超时配置验收，不能据此宣称线上 3 秒已验收。上线前仍需核实组合索引、单事务/删除实际耗时、函数硬超时和吞吐。
- 工作树原有 `project.config.json`、`project.private.config.json` 及计划文件改动未触碰、未暂存。

## Commit

`fix: 为过期清理增加预算检查与可恢复进度`（本报告随该提交）。
