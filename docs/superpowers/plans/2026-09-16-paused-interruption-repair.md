# 已暂停录音中断修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 已经收到原生 pause 确认的录音，后续系统中断不能因为没有第二次 pause 回调而被 watchdog 误结束。

**Architecture:** 仅区分稳定 paused 与尚待原生确认的状态；后者维持原有 watchdog，前者通知页面但不等待不存在的第二次 pause。恢复仍必须由用户主动执行。

**Tech Stack:** TypeScript RecorderCoordinator、现有虚拟调度器测试。

## Global Constraints

- 不修改录音时长、格式、暂停/继续按钮、保存、分享、容量或UI。
- 不取消 starting/recording/pausePending/resumePending 系统中断的安全停止保护。
- 不改全局 RecorderManager 绑定/所有权/终止隔离逻辑；用户暂停后不自动 resume。
- 只改本任务两个文件，保留其他工作；中文本地提交，不部署、不push。

### Task 1: 稳定暂停不建立中断确认 watchdog

**Files:**
- Modify: `src/features/listeningPractice/recorderCoordinator.ts`
- Test: `scripts/test-recorder-coordinator.cjs`

**Interfaces:** 既有 createRecorderCoordinator、RecorderOwner 及事件订阅签名完全不变。

- [ ] Step 1: 在现有测试 helpers 已定义后加入独立反例；使用现有 options、createNativeRecorder、createFakeScheduler，不再复制调度器。

```js
const stablePauseNative = createNativeRecorder();
const stablePauseScheduler = createFakeScheduler();
const stablePauseCoordinator = createRecorderCoordinator({
  getRecorderManager: () => stablePauseNative.manager,
  scheduler: stablePauseScheduler,
  operationTimeoutMs: 25,
});
const stablePauseOwner = stablePauseCoordinator.acquire().owner;
stablePauseOwner.start(options);
stablePauseNative.emit('start');
stablePauseOwner.pause();
stablePauseNative.emit('pause');
stablePauseNative.emit('interruptionBegin');
stablePauseScheduler.advance(100);
assert.equal(stablePauseNative.calls.stop, 0, '已确认暂停后系统打断不应强制结束');
assert.equal(stablePauseCoordinator.getPhase(), 'paused');
stablePauseNative.emit('interruptionEnd');
assert.equal(stablePauseNative.calls.resume, 0, '中断结束不能自动继续');
assert.equal(stablePauseOwner.resume().ok, true);
stablePauseNative.emit('resume');
assert.equal(stablePauseCoordinator.getPhase(), 'recording');
```

补充重复中断后仍 paused，以及 pending pause 没收到确认时仍触发安全 stop 的对照用例，断言原生 stop/resume 次数。使用公开接口，不加入测试专用生产方法。

- [ ] Step 2: 运行 `node scripts/test-recorder-coordinator.cjs`，确认新增反例因实际 stop=1 而失败。

- [ ] Step 3: 在 interruptionBegin 的原有 capability/phase guard 后、设置 systemPausePending 前，加入如下最小分支；其余逻辑保持原样：

```ts
if (phase === 'paused' && !pausePending && !resumePending && !systemPausePending) {
  notify('onInterruptionBegin');
  return;
}
```

稳定 paused 的原生确认已经完成，不建立新的 system-pause watchdog。页面现有中断状态处理会要求手动继续，不能调用 manager.resume()。

- [ ] Step 4: 运行 `scripts/test-recorder-coordinator.cjs`、`scripts/test-recording-interaction.cjs`、`scripts/test-practice-recording-wiring.cjs` 及 `tsc --noEmit --skipLibCheck`，确认新反例和原先录音中/pending resume中断用例同时通过。内置Node路径见主控brief。

- [ ] Step 5: 显式暂存两个修改并提交 `fix: 避免已暂停录音被系统中断误结束`；报告RED/GREEN及原有保护未改变的证据，等待独立复审。
