# 录音回听会话隔离 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 两个录音回听入口快速停止/重播时，旧播放的 play/time/stop/end/error 不再覆盖新播放状态或误报失败。

**Architecture:** 复用已经覆盖示范音频代次隔离的 createTrackAudioController，增添可选原生 play/time 回调；两页均使用按次新建、失效后销毁的控制器，不再复用永久录音音频实例。既有示范音频使用方式保持不变，不复制第二套会话状态机。

**Tech Stack:** TypeScript、Taro InnerAudioContext、现有页面 vm harness。

## Global Constraints

- 录音器、格式、容量、保存、上传、到期和分享 UI 不变；不得提前上传。
- 回听仍由用户点击，详情仅在 isPlaying=true 时显示 当前 / 总时长，onPlay 确认前不得提前设为正在播放。
- 打开目录不能停止播放，换训练/隐藏/卸载必须停止回听；首次无音源不调用原生 stop。
- 先失效旧代，再销毁上下文，所有回调仅当前代有效；销毁同步回调也必须隔离。
- 仅修改列出的文件。原 IDE 配置与其他任务变更保留。本地中文提交，不部署、不 push。

### Task 1: 为录音复用会话控制器并覆盖两页

**Files:**
- Modify: `src/features/listeningPractice/audioPlayback.ts`
- Modify: `src/pages/Practice/Practice.tsx`
- Modify: `src/pages/CheckInDetail/CheckInDetail.tsx`
- Test: `scripts/test-audio-playback.cjs`
- Test: `scripts/test-check-in-detail-runtime.cjs`
- Test (only affected audio fixture assertions): `scripts/test-practice-book-route.cjs`

**Interfaces:** createTrackAudioController 前三个参数和 toggle/stop/dispose 不变；第四个可选 hooks `{ onPlay?: () => void; onTimeUpdate?: (seconds: number) => void }`。TrackAudio 补充原生 onPlay/onTimeUpdate/currentTime 类型。stopPracticePlayback 接受两个 AudioStopController，通过控制器安全 stop，不再对控制器检查 src。

- [ ] Step 1: 先扩充既有假音频事件触发，针对训练页和本地详情各加入 play A → stop A → play B → A 的全部迟到事件，断言 B 仍显示停止按钮、详情进度不倒退/跳变、无额外 toast。再触发 B ended/error 验证正常复位。旧实现应实际 RED，不用正则存在性代替行为测试。
- [ ] Step 2: 控制器聚焦用例覆盖新增 play/time hook 的代次判断，destroy 同步触发旧事件及 dispose 后迟到事件；未提供 hooks 时示范音频现有语义不变。
- [ ] Step 3: 在 startTrack 注册 hooks 监听，执行前检查当前 generation；销毁和结束沿用现有失效顺序，不添加第二套 generation。详情的秒数用现有 getPlaybackPositionMs 做 finite/负数/总长裁剪，不接受 NaN/Infinity。
- [ ] Step 4: Practice 的 recordingAudioRef 改为控制器引用（可以同名以减少无关改动）。初始化不创建原生回听实例；onTrackChange(null) 复位，onPlay 才设正在回听，onError 用既有固定提示。各处 stopAudioIfLoaded(recordingAudioRef.current) 改为控制器 stop；播放用 toggle('recording', tempRecordingPath)，隐藏/切换 stop，卸载 dispose。回调还应在 mounted 且未隐藏时才影响页面，避免新事件在离页边界复活 UI。
- [ ] Step 5: CheckInDetail 同样用控制器与 hooks 更新 isPlaying/position。保留 playAttemptRef 的云 URL 刷新保护，并在刷新失败 catch 也检查 mounted/visible/attempt，旧请求失败不能对新播放或隐藏页弹提示。停止/保存重试/隐藏/卸载都失效当前播放，卸载 dispose 不写 state。
- [ ] Step 6: 更新旧测试里“初始化就有一个录音实例”/固定 audios 下标的假设，以实际 src 和事件定位实例。destroy 是释放播放的边界，断言释放而非强求额外 stop；不要保留专供测试的空实例或删掉离页/换书断言。现有源码正则接线检查应对应新控制器，但新增核心保护必须行为验证。
- [ ] Step 7: 运行 test-audio-playback、test-check-in-detail-runtime、test-practice-book-route、test-practice-recording-wiring、test-local-share-lifecycle 和 tsc --noEmit --skipLibCheck。逐项保留 RED/GREEN 输出和实际覆盖；不执行真实学生录音。
- [ ] Step 8: 自查后显式暂存任务文件与实现报告，本地提交 `fix: 隔离录音回听会话与迟到播放回调`，等待独立复审。
