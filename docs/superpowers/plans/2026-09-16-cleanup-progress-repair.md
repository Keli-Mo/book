# 清理任务预算与持久进度修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 避免云函数在一页 50 条全部完成之前被平台终止，导致后续记录永远得不到清理机会。

**Architecture:** 页内逐个候选完成后保存可恢复游标；设置保守的 1,200 ms 软预算，停止启动新的工作并返回下一次可恢复位置。预算不是网络超时替代，也不保证单个数据库/存储操作必能在现网 3 秒内完成。沿用现有游标 revision 的 CAS 并发保护和永久墓碑，不增加定时器或启用真实删除。

**Tech Stack:** Node.js 云函数、既有 vm + 内存事务测试。

## Global Constraints

- 不改变到期规则、30 天分享、SDK trigger 鉴权、前缀要求和 dry-run 默认值。
- 不删除墓碑或略过所有 deleted 行；已删除路径的迟到上传仍应在后续全轮清理。
- 不记录路径、文件 ID、口令、OPENID 或原始异常；沿用刚完成的安全错误分类。
- 不部署、不访问/删除真实文件、不改线上开关/超时/环境变量、不推送 Git。
- 只处理进度和预算；owner/ref 绑定防护单独实现，禁止混入配额、v1 或下载限长。

### Task 1: 候选完成后检查点与软预算

**Files:**
- Modify: `cloudfunctions/cleanupExpiredShares/index.js`
- Test: `scripts/test-share-expiry-cleanup.cjs`
- Modify: `cloudfunctions/README.md`

**Interfaces:** 现有字段含义保留：`scanned` 是本次取得的页大小，`candidates/validated/deleted/failed` 是实际处理的计数。允许新增 `processed` 与 `budgetExhausted` 两个统计字段；`nextCursor` 必须表示实际处理到的位置，不可声称整页已完成。

- [ ] Step 1: 扩展现有 harness 的虚拟 Date.now() 和操作耗时注入，不使用真实 sleep。添加 51 条到期记录，每次事务 30 ms、删除 70 ms，模拟函数 3,000 ms 硬预算（测试里到达时抛超时），每次调用重新计时。旧实现应多轮一直停在第一页且最后一条 active；新断言应要求多轮推进到 51，且正常软预算退出时间小于硬预算。先得到针对现实现的 RED。
- [ ] Step 2: 增加 checkpoint 失败、单候选未知删除错误、纯 active 未到期页、分页尾部/空页、并发 revision 前进，以及 dry-run 不写状态的测试。所有失败场景必须保持录音引用与可重试状态，不能靠吞错断言成功。
- [ ] Step 3: 在 handler 授权后、第一次云端 I/O 前记录预算起点，用固定 `WORK_BUDGET_MS = 1200` 控制启动新候选。若已经耗尽预算，保留原游标并正常返回 `budgetExhausted: true`，不为追求进度强行启动一个可能超时的操作。
- [ ] Step 4: 建立一个小的 `saveCursor(nextCursor)` 闭包，使用事务重读并比较本调用持有的 expectedRevision；只在一致时保存并更新 expectedRevision。冲突/变化必须中止本次继续处理，不能覆盖并发执行者新进度；使用现有安全代码 `CLEANUP_STATE_CHANGED` 或 `DATABASE_TRANSACTION_CONFLICT`，不暴露动态异常。
- [ ] Step 5: for 循环维护 lastProcessedCursor 和 processed。每个候选无论成功还是可重试失败，处理结束后持久化当前连续前缀；失败会在后续回绕重试，不应阻塞后面的安全记录。只跳过的未到期条目不逐条写数据库，页尾/预算退出统一保存其已扫描前缀，避免无效写放大。
- [ ] Step 6: 仅在已处理完最后一条且页长小于 PAGE_SIZE 时保存空游标；满页保存最后已处理 ID，下一次获取空页时回绕。页内因预算退出保存最后已处理 ID，绝不能跳过本次尚未处理行。保存失败立即返回 ok:false，不继续更多删除。
- [ ] Step 7: dry-run 仍不读写正式游标，不做删除；可按同一软预算返回 nextCursor，供只读审核续查，不假称未处理候选已经 validated。
- [ ] Step 8: 运行 cleanup 聚焦脚本、checkIn 协议脚本、local-share-lifecycle 集成。报告虚拟时钟模拟的边界，明确该测试不是线上延迟或 3 秒配置验收。README 记录软预算/检查点/并发/失败回绕及上线前仍需核实索引和单操作耗时。
- [ ] Step 9: 自查后显式暂存三个任务文件和实现报告，本地提交 `fix: 为过期清理增加预算检查与可恢复进度`，等待独立复审。
