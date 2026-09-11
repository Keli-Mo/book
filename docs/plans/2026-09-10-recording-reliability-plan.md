# 录音与打卡可靠性实施计划

> **执行要求：** 使用 `subagent-driven-development` 按任务实施；任何录音或云端行为修改都必须先有按预期失败的回归测试。

**目标：** 强化录音权限、暂停恢复、系统中断、后台切换、本地文件、弱网上传、幂等创建和可恢复删除。

**架构：** 纯录音状态机隔离原生异步回调；待上传仓储保存本地文件和上下文；云函数用确定性 ID 与事务保证同一请求只创建一次。

**技术栈：** `RecorderManager`、`InnerAudioContext`、Taro 文件/Storage API、微信云开发、Node VM 测试。

## 全局约束

- 示范音频与录音使用独立上下文并允许同时运行。
- 最低微信基础库为 2.3.0；录音固定推荐 `16000Hz`、单声道、`48000bps` MP3，五分钟约 1.8MB，实际时长和文件大小只认 `onStop` 原生 `duration/fileSize`。
- 系统中断结束后仅提示用户手动恢复，绝不自动调用 `resume()` 或自动偷录。
- 失败后尽量保留用户录音，禁止在结果不确定时删除云文件。
- 微信持久化本地文件总额为 10MB；待上传录音最多 3 条、合计不超过 8MiB、保留 7 天。超限时先清理过期或丢失文件项；仍超限则提示用户清理指定旧录音或联网提交，不能静默删除有效待上传录音。
- Task 4 修改 `Practice.scss` 时，固定 CSS 像素必须写成大写 `PX`（如 `44PX` 编译为 `44px`）；小写 `px` 会转换为 `rpx`。动态运行时 inline style 可使用 `` `${value}px` ``。

---

### Task 1：录音状态机与能力检测

**Files:**

- Create: `src/features/listeningPractice/recordingStateMachine.ts`
- Modify: `src/features/listeningPractice/recordingInteraction.ts`
- Modify: `scripts/test-recording-interaction.cjs`

**Interfaces:**

```ts
export type RecordingState =
  | "checking" | "unsupported" | "idle" | "starting" | "recording"
  | "paused" | "stopping" | "recorded" | "uploading" | "error";
export type PauseReason = "user" | "background" | "interruption" | null;
export function reduceRecording(session: RecordingSession, event: RecordingEvent): RecordingSession;
export function detectRecorderCapabilities(value: unknown): RecorderCapabilities;
```

- [ ] 写能力完整、无录音、无暂停三种失败测试。
- [ ] 写快速连点、旧 session、旧 operation、卸载后回调和中断不自动恢复测试。
- [ ] 运行测试确认导出不存在导致失败。
- [ ] 实现最小 reducer、会话代次和原始错误格式化。
- [ ] 运行测试确认通过。
- [ ] 提交 `feat: 增加录音状态机与能力检测`。

### Task 2：本地待上传录音仓储

**Files:**

- Create: `src/features/listeningPractice/pendingCheckInStore.ts`
- Create: `scripts/test-pending-check-in.cjs`
- Modify: `package.json`

**Interfaces:**

```ts
export type PendingCheckIn = {
  requestId: string;
  localPath: string;
  recoverable: boolean;
  context: CheckInContext;
  durationMs: number;
  fileSizeBytes: number;
  cloudFileId: string;
  status: "local" | "uploaded" | "creating" | "failed";
  updatedAtMs: number;
};
```

- [ ] 写 requestId、`onStop` 原生 `duration/fileSize`、`saveFile` 返回 `savedFilePath` 后立即替换临时路径、最多 3 条/合计 8MiB、7 天过期和清理失败测试。
- [ ] 写保存失败时仍保留当前临时路径但标记不可恢复的测试。
- [ ] 写超过队列条数或 8MiB 时先清理过期/丢失文件、仍超限则不删除有效项且返回“清理历史录音或联网提交”提示的测试。
- [ ] 运行测试确认模块缺失失败。
- [ ] 用注入的 storage/file adapter 实现，按原生 `fileSize` 记账；仅清理过期或丢失文件项，用户确认后才可删除未过期待上传录音，避免测试依赖真实微信环境。
- [ ] 运行测试确认通过。
- [ ] 提交 `feat: 持久保存待上传跟读录音`。

### Task 3：云端 prepare/commit 原子幂等

**Files:**

- Modify: `cloudfunctions/checkIn/index.js`
- Modify: `scripts/test-check-in-function.cjs`
- Modify: `src/services/cloudCheckIn.ts`

- [ ] 先测试非法 requestId、同 ID 不同载荷、不同用户相同 ID、重复 commit 返回同一 `id/shareToken`。
- [ ] 扩展云数据库 mock 支持确定性 doc 与事务，运行测试确认旧 `add` 方案失败。
- [ ] 增加 `prepare`：返回 `checkins/<openid-hash>/<requestId>.mp3` 和确定性记录 ID。
- [ ] 增加 `commit`：事务读取/创建；载荷摘要冲突则拒绝，重复载荷返回原记录。
- [ ] 宽容读取没有 `requestId/status` 的旧记录。
- [ ] 运行云函数测试确认通过。
- [ ] 提交 `fix: 保证打卡创建原子幂等`。

### Task 4：Practice 接入中断、后台与本地文件

**Files:**

- Modify: `src/pages/Practice/Practice.tsx`
- Modify: `src/pages/Practice/Practice.scss`
- Modify: `scripts/test-recording-interaction.cjs`
- Modify: `scripts/test-audio-playback.cjs`

- [ ] 先写 `starting/stopping` 禁用、能力降级、中断、页面隐藏确认超时和示范音频并行契约测试。
- [ ] 运行测试确认页面当前直接按字符串状态处理而失败。
- [ ] 用 reducer 驱动 RecorderManager；注册中断回调并清理可选监听。
- [ ] 页面隐藏冻结时间线、尝试暂停；超时进入确认态，返回后不允许误上传。
- [ ] 使用 `format: "mp3"`、`sampleRate: 16000`、`numberOfChannels: 1`、`encodeBitRate: 48000` 启动录音；有效 `onStop` 只使用原生 `duration/fileSize`，先保存本地文件并立即改用 `savedFilePath` 写待上传元数据，再允许回听或提交。
- [ ] 中断结束只显示手动恢复提示；不调用 `resume()`，原生已停止时仅按有效 `onStop` 转入 `recorded`。
- [ ] 无 pause/resume 时隐藏暂停；无 RecorderManager 时显示升级提示。
- [ ] 运行录音、音频和业务类型测试。
- [ ] 提交 `fix: 适配录音中断与后台生命周期`。

### Task 5：弱网上传、恢复与删除补偿

**Files:**

- Modify: `src/services/cloudCheckIn.ts`
- Modify: `src/pages/Practice/Practice.tsx`
- Modify: `src/pages/MyCheckIns/MyCheckIns.tsx`
- Modify: `src/pages/CheckInDetail/CheckInDetail.tsx`
- Modify: `cloudfunctions/checkIn/index.js`
- Modify: `scripts/test-pending-check-in.cjs`
- Modify: `scripts/test-check-in-function.cjs`

- [ ] 先测试微信云存储 callback 形式 `Taro.cloud.uploadFile`（底层 `wx.cloud.uploadFile`）返回的 `UploadTask` 进度订阅与 `abort()`、1 秒/3 秒两次自动重试、上传进度降级、重启后 commit、删除半失败再重试。
- [ ] 运行测试确认旧单次上传和先删文件逻辑失败。
- [ ] 使用微信云存储 callback 形式 `Taro.cloud.uploadFile`（底层 `wx.cloud.uploadFile`）获取 `UploadTask`，订阅 `onProgressUpdate` 并在用户取消时 `abort()`；所有重试复用同一 `requestId` 的确定性 `cloudPath`。
- [ ] 上传同一确定性路径，先持久化 `cloudFileId` 再 commit；在 commit 明确成功前保留 `savedFilePath` 和待上传项，失败或响应不确定时保留并重试。
- [ ] 页面展示上传百分比或不确定进度，并提供显式重试，不在后台自动耗流量。
- [ ] 删除先标记 `deletePending`，再删文件和数据库；普通列表隐藏待删除记录。
- [ ] 详情和列表兼容旧快照字段。
- [ ] 运行待上传、云函数、录音和页面测试。
- [ ] 提交 `fix: 支持弱网上传与可恢复打卡删除`。

### Task 6：录音阶段回归与真机清单

- [ ] 自动验证 0.5 秒边界、5 分钟、暂停计时、错误原文、重复请求和失败清理。
- [ ] 运行微信构建。
- [ ] 输出 iOS/Android/Pad 的权限、锁屏、来电、后台、蓝牙、扬声器、耳机和网络切换点击清单。
- [ ] 未获真实设备结果的项目明确标为“待真机确认”，不以模拟测试冒充。
