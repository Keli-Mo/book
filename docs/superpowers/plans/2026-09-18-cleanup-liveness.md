# 清理慢单条可推进修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复引用查询900ms＋标记事务350ms导致跨调用永久停滞的问题，同时保留删除鉴权、未完成不跨越、可恢复墓碑和运行余量。

**Architecture:** 用户于2026-09-18明确选择按实际时限与安全余量收尾。将新候选准入截止和已准入候选的续处理截止分开。原1200ms仍用于停止接新任务，但不再是候选每一步共同的截止；续处理根据可信 runtime context 限制，前置保留1000ms。预算不够时保留当前位置，明确报告无进展，不能省略校验或跳过候选。新规则取代2026-09-16计划中“每一步均不得越过1200ms”的约束。

**Tech Stack:** Node.js 云函数、现有内存事务和虚拟时间测试，无新依赖。

## Global Constraints

- 本地优先、主动分享才上传、首次提交30天、无自动本地删除、单文件8MiB不变。
- 保留SDK来源鉴权、可信bucket前缀、owner/request/digest绑定、完整fileID引用检查、事务重读和revision CAS。
- 旧无期限记录不清理；永久墓碑保留，迟到上传可在后续回绕再次删除。
- 不把event字段当执行时限，不依赖客户端输入扩大预算。
- 本任务不部署、不启用生产清理、不操作真实录音、不改运行配置/权限/费用、不推送。
- 不改两份IDE配置和主目录旧修改；只显式暂存任务文件；英文fix前缀、中文提交正文。
- 使用固定Node `C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`。模拟时延不是线上性能保证。

### Task 1: 候选准入、续处理和零进展可观测性

**Files:**
- Modify: `cloudfunctions/cleanupExpiredShares/index.js`
- Test: `scripts/test-share-expiry-cleanup.cjs`
- Modify: `cloudfunctions/README.md`

**Interfaces:** handler增加第二参数`runtimeContext`，只读`runtimeContext.time_limit_in_ms`。已有统计和`nextCursor`含义不变；零进展由`processed===0 && budgetExhausted`表示，须发固定无敏感信息的诊断类别。不新增外部存储协议或队列。

- [ ] Step 1: 扩展harness调用接口，把`controls.runtimeContext`作为第二参数传入实际handler。新增两条过期记录、多轮调用的RED用例：

```js
const h = harness([row(1), row(2)]);
Object.assign(h.controls, {
  referenceQueryMs: 900, transactionMs: 350, deleteMs: 50,
  hardBudgetMs: 3000, runtimeContext: { time_limit_in_ms: 3000 },
});
for (let i = 0; i < 4 && (h.files.size || h.state.get('v2')?.cursor); i++) {
  const result = await h.call();
  assert.equal(result.ok, true);
  assert.ok(h.clock.elapsedMs < 3000);
}
assert.equal(h.files.size, 0);
assert.equal(h.records.get(idFor(2)).status, 'deleted');
assert.equal(h.state.get('v2').cursor, '');
```

先运行实际cleanup测试，确认旧实现因为文件仍剩2个而RED。保留原有31组安全/并发/迟到上传测试；只对明确被新方案取代的1200ms候选内截止断言做对应调整，不能删断言求绿。

- [ ] Step 2: handler入口记录开始时间，计算以下两个绝对截止（可使用小闭包，无需新模块）：

```js
const configured = runtimeContext?.time_limit_in_ms;
const limit = Number.isSafeInteger(configured) && configured > 0
  ? Math.min(configured, 20000) : 3000;
const workMs = Math.max(0, limit - 1000);
const finishBy = startedAt + workMs;
const admitBy = startedAt + Math.min(1200, workMs);
```

1000ms是发起后续操作的预留策略，不是RPC可取消硬保证。若时限不足1000ms，鉴权后不启动任何数据库/存储I/O。缺失/非法runtimeContext按最后核实的3000ms回退；客户端event同名字段不参与。

- [ ] Step 3: 页面读取和每条新候选准入使用`admitBy`；已准入候选的引用查询后、标记事务前/冲突重试前、删除前、结束事务前/冲突重试前、检查点前/冲突重试前使用`finishBy`。保持每次调用新鲜的引用与事务校验，不缓存前一次安全结论。允许一条在1200ms后但finishBy前继续，不允许启动下一个候选。

预算分支使用统一的内部标识或固定错误类别区分真正业务失败；不得把预算中断计为已完成候选，未完成行游标不跨越。若文件已删但结束写入来不及，保留deletePending，下一次幂等确认缺失后完成。若结束已完成但检查点来不及，保留旧持久游标，下次可重复核验；不可报告未保存的新游标。

- [ ] Step 4: 避免页尾多余写入：已在单候选完成后保存位置，而续处理预算已到，则保留该位置返回budgetExhausted，下一次空页再回绕。不要为了页尾清空游标在截止之后启动另一个事务。所有事务冲突重试也应停止于finishBy，而非只在第一轮检查。

- [ ] Step 5: 为以下每个边界写具体断言并跑RED/GREEN：

1. 原复现900/350/50在多轮调用后两个文件消失、两个墓碑保留、游标最终回绕，均未触及3000ms。
2. 引用查询1200ms：低于finishBy时能继续核验；引用查询达到finishBy时不标记、不删除、不推进。
3. 可信1000ms/500ms配置：零数据库/删除；可信更长配置允许较慢的合成单条安全收尾；20秒上限有效。
4. 缺失/无效context和event伪造时限不能扩大实际预算。NaN/Infinity/字符串/负数/小数均不采用。
5. 标记、删除或结束事务耗尽续处理预算，保留可重试状态，不启动超预算删除或无界冲突重试；下一次恢复正确。使用各步骤耗时注入或已有hook，勿用真实sleep。
6. 零进展budgetExhausted输出固定类别`CLEANUP_BUDGET_EXHAUSTED`的脱敏日志，不冒充正常完成；README说明需告警并检查配置/操作时延。不引入自动放宽预算或自动续费。
7. dry-run仍零写零删；检查点失败/并发CAS不能覆盖较新进度；不丢旧安全断言。

- [ ] Step 6: 运行固定Node的`scripts/test-share-expiry-cleanup.cjs`、`scripts/test-check-in-function.cjs`、`scripts/test-local-share-lifecycle.cjs`及`--check cloudfunctions/cleanupExpiredShares/index.js`；`git diff --check`。完整回归交主控单次执行，不与诊断竞争。
- [ ] Step 7: 更新README：两个截止、1000ms预留、未完成重试、零进展日志/告警、时限不足时保持安全、真实云端测量和权限验收仍待完成。不得宣称任意网络延迟必能完成或自动清理已启用。
- [ ] Step 8: 自查并显式提交三个任务文件 `fix: 为过期清理区分准入与收尾预算`，报告至`.superpowers/sdd/2026-09-18-cleanup-liveness-report.md`，附TDD命令/结果、所有改动、边界和剩余风险；等待独立复审。
