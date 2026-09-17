# 录音回听迟到回调隔离实现报告

## 实现摘要

- 在既有 `createTrackAudioController` 上增加可选 `onPlay` / `onTimeUpdate` hooks；两类事件与既有 `stop` / `ended` / `error` 共用同一 generation 判断，没有新增第二套代次控制器。
- 训练页和录音详情页不再初始化空的原生回听实例；每次用户点击播放才由控制器创建独立原生会话，停止、切换、隐藏和卸载均先使当前会话失效再销毁。
- 训练页仅在当前页面仍挂载且可见时响应播放回调；录音详情页同样限制 UI/提示回调，并用 `getPlaybackPositionMs` 统一处理负数、非有限值及总时长裁剪。
- 详情页保留云临时 URL 的 `playAttemptRef` 门闩，并为刷新失败 catch 补齐 mounted / visible / attempt 校验，旧请求失败不再对新播放或隐藏页弹提示。
- `stopPracticePlayback` 现在接受两个控制器并调用安全 `stop`，不再检查录音控制器的 `src`；无会话时不会创建原生实例或调用原生 `stop`。

## TDD 证据

### RED

命令：

```powershell
& 'C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' scripts/test-audio-playback.cjs
& 'C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' scripts/test-check-in-detail-runtime.cjs
```

实现前结果（均退出码 1）：

```text
AssertionError [ERR_ASSERTION]: 当前会话的 onPlay 应转发给页面 hook
actual: []
expected: [ 'play' ]

AssertionError [ERR_ASSERTION]: 再次播放必须创建独立 B 会话
operator: notStrictEqual

RED_EXITS audio=1 detail=1
```

失败原因符合预期：旧控制器没有 play/time hooks，详情页还复用同一个原生音频实例，无法隔离 A 会话迟到回调。

### GREEN

固定 Node 依次执行：

```powershell
& 'C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' scripts/test-audio-playback.cjs
& 'C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' scripts/test-check-in-detail-runtime.cjs
& 'C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' scripts/test-practice-book-route.cjs
& 'C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' scripts/test-practice-recording-wiring.cjs
& 'C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' scripts/test-local-share-lifecycle.cjs
& 'C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' node_modules/typescript/bin/tsc --noEmit --skipLibCheck
```

结果：六项全部退出码 0。

```text
音频播放测试通过：首次停止保护、离页停止与分享进度均正确。
音频教材回归通过：换书、换训练停止两路音频，目录布局变化保持播放。
录音详情运行时测试通过：本地零云请求、离页分享门闩、隐藏提交恢复、长计时器与云播放迟到均正确。
教材路由测试通过：真实路由、首尾边界、恢复页、教材内容、打卡与历史回跳正确。
训练页录音接线测试通过：状态机、切页竞态、本地完成与详情路由已进入生产路径。
本地分享集成通过：完成零联网、重启恢复、好友口令鉴权、30天过期重传、丢回包/本地回写失败幂等恢复、旧协议拦截、脱敏日志接线、本地不删除。
tsc --noEmit --skipLibCheck：退出码 0，无诊断。
```

新增行为覆盖实证：控制器 destroy 同步触发与 dispose 后迟到事件；训练页和详情页 play A → stop A → play B → A 的 play/time/stop/ended/error；B 播放态与详情进度保持；当前会话 ended/error 正常复位；隐藏后的云 URL 刷新失败不弹提示；未提供 hooks 的示范音频语义保持不变。

## 变更文件

- `src/features/listeningPractice/audioPlayback.ts`
- `src/pages/Practice/Practice.tsx`
- `src/pages/CheckInDetail/CheckInDetail.tsx`
- `scripts/test-audio-playback.cjs`
- `scripts/test-check-in-detail-runtime.cjs`
- `scripts/test-practice-book-route.cjs`（仅音频假实例事件参数及受影响断言）
- `.superpowers/sdd/full-audit-playback-isolation-report.md`

## Commit

- 基线：`de02cc6`
- 本报告与实现使用单一提交：`fix: 隔离录音回听会话与迟到播放回调`（短 SHA 由提交后 handoff 提供）

## 自查疑点

- 未发现未解决疑点。打开目录不停止、换训练/隐藏/卸载释放、无音源不调用原生 stop、回听只在点击后创建实例、onPlay 前不进入播放态、详情仅播放中显示当前/总时长均有行为测试或既有格式化测试覆盖。
- 工作树中原有 IDE 配置、其他计划及并行审计进度文件均未读取修改或纳入本提交。
- 未访问云端、未执行真实学生录音、未部署、未 push。
