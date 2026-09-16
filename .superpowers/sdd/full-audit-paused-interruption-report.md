# 已暂停录音系统中断审计报告

## 实现摘要

在 `interruptionBegin` 的既有 capability/phase guard 后增加最小分支：当 phase 已是 `paused`，且没有 pause/resume/system-pause pending 时，仅通知页面中断开始，不建立 system-pause watchdog。该分支不调用原生 `resume`，用户仍需显式继续；其余 starting、recording、pending pause、pending resume 与终止隔离逻辑保持原样。

新增测试覆盖：

- 已确认暂停后重复收到 `interruptionBegin`，经过 watchdog 时间仍保持 `paused`，原生 `stop`/`resume` 均为 0；手动 resume 后才回到 `recording`。
- pause 已发出但未收到确认时，仍在确认窗口结束后触发一次安全 `stop`，保持原有保护。

## TDD 证据

### RED

命令：

```powershell
& 'C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' scripts/test-recorder-coordinator.cjs
```

输出（新增生产分支前）：

```text
node:assert:152
  throw new AssertionError(obj);
  ^

AssertionError [ERR_ASSERTION]: 已确认暂停后重复系统打断不应强制结束

1 !== 0

    at Object.<anonymous> (E:\REPOSITORY\haisha\haisha\.worktrees\all-books-device-recording\scripts\test-recorder-coordinator.cjs:115:8)
...
Node.js v24.19.0
```

该失败证明反例命中了现有 system-pause watchdog 的实际 `stop=1` 行为，而非测试拼写或环境错误。

### GREEN

命令：

```powershell
& 'C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' scripts/test-recorder-coordinator.cjs
```

输出：

```text
录音协调器测试通过：全局事件、所有权、托管 terminal、draining 与安全降级契约正确。
```

命令：

```powershell
& 'C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' scripts/test-recording-interaction.cjs
```

输出：

```text
录音交互测试通过：时间线、错误、能力检测与状态机契约正确。
```

命令：

```powershell
& 'C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' scripts/test-practice-recording-wiring.cjs
```

输出：

```text
训练页录音接线测试通过：状态机、切页竞态、本地完成与详情路由已进入生产路径。
```

命令：

```powershell
& 'C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' node_modules/typescript/bin/tsc --noEmit --skipLibCheck
```

输出：无（退出码 0）。

## 文件与提交

- `src/features/listeningPractice/recorderCoordinator.ts`
- `scripts/test-recorder-coordinator.cjs`
- `.superpowers/sdd/full-audit-paused-interruption-report.md`
- 修复提交：`2b46c3f fix: 避免已暂停录音被系统中断误结束`

## 自查

- 仅在已确认 `paused` 且三个 pending 标记均为 false 时跳过 system-pause watchdog。
- 未修改录音时长、格式、按钮、保存、分享、容量或 UI。
- 未取消 starting/recording/pausePending/resumePending 的系统中断保护。
- 未改变全局录音器绑定、所有权或终止隔离；`interruptionEnd` 仍不会自动 resume。
- 仅使用公开协调器接口编写测试；未增加生产测试专用方法。
- 未部署、未 push；保留工作树中其他配置与计划文件的既有变更。
