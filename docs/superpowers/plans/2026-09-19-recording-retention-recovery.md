# 录音升级保留与主动恢复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. 每项任务 TDD、自测、独立审查通过后继续。

**Goal:** 保留旧录音索引、补齐回听诊断，允许本人主动从已有有效分享恢复录音，不清除任何测试数据。

**Architecture:** 固定现有存储键，仓储负责无损索引读写和串行替换；云函数仅提供本人授权恢复信息；独立恢复模块管理下载/校验/保存，详情页面只展示失败后主动恢复入口。复用现有原生边界测试工具，不新增依赖。

**Tech Stack:** TypeScript / React / Taro、微信原生文件与音频 API、wx-server-sdk、Node 自带测试 runner。

## Global Constraints

- 本轮不实现、启用、部署或执行测试数据清除；将来清除前必须再次向用户确认具体范围和数量。
- 不更改用户的 project.config.json、project.private.config.json、cloudfunctions/cleanupExpiredShares/config.json。
- 不提前上传，不自动下载恢复，不续期；正常本机回听仍零云请求。
- 不删除旧录音文件、异常索引或未知原始字段；恢复失败保留原引用。
- 未知错误不可当作文件不存在；元数据读取失败不可当空库覆盖。
- 不记录 OPENID、完整路径、云文件 ID、口令、签名 URL 或原始 SDK 任意错误消息。
- 应用预算 100 MiB，保留 10 MiB 安全余量，单文件上限 8 MiB；不能自动淘汰旧文件。
- 恢复必须服务端验证本人，不接受仅分享口令；不绕过已过期/已删除状态，不改变普通分享收听。
- 不推送、不部署；commit 使用英文类型前缀和中文说明。只提交本任务文件。
- 验证 Node 固定为 `C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`，工作区为 `E:/REPOSITORY/haisha/haisha/.worktrees/all-books-device-recording`。

### Task 1: 无损索引与缺失文件保留

**Files:**
- Modify: `src/features/listeningPractice/pendingCheckInStore.ts`
- Modify: `scripts/test-pending-check-in.cjs`, `scripts/test-pending-check-in-runtime.cjs`
- Create: `scripts/test-recording-retention.cjs`

**Interfaces:** 原有仓储方法兼容；新增可选 `fileAvailability: "available" | "missing" | "unavailable"` 表示检查结果，与 recoverable（是否持久化成功）分离。storage adapter 的 set 接受原始数据，以保留未知项；实际 runtime 仍调用同一个 wx.setStorageSync。

- [ ] RED：通过真实仓储，构造有效旧记录但 file.exists=false；`await store.cleanup(); assert.equal(store.list().length, 1)`。目前会失败。分别测试 file.exists 抛错、无指纹旧项、未知数组项/重复 ID、非数组损坏数据、索引快照写失败以及显式删除后不通过快照复活。
- [ ] Run：固定 Node 执行 `--test --test-concurrency=1 --test-timeout=30000 scripts/test-recording-retention.cjs`，记录预期断言失败。
- [ ] GREEN：cleanup 仅更新可用性并输出固定诊断，不自动删除；无效原始项保留但不当成可播放记录。首次覆盖已有索引前把原始数组保存为 `pending-check-ins-v1-upgrade-backup`，失败则禁止覆盖；不自动从该备份恢复。损坏非数组不能当空库，空存储的 undefined/null/空字符串与损坏区分。未知项和重复项均不得静默丢弃。
- [ ] 验证：运行上述新测试及 pending-check-in、pending-check-in-runtime、recording-file-roundtrip、local-recording-retry-runtime、recording-library-view 测试。调整旧的“缺失即移除”断言为本次批准的保留契约，但保留显式删除的验证。确保 key-aware mock 不把备份当主索引。
- [ ] 提交：`fix: 保留旧录音索引与不可用文件引用`；报告 RED/GREEN 命令、结果、范围。完成独立 spec + quality 审查。

### Task 2: 本人云恢复授权端点

**Files:**
- Modify: `cloudfunctions/checkIn/index.js`
- Modify: `src/services/cloudCheckIn.ts`
- Modify: `scripts/test-check-in-function.cjs`, `scripts/test-cloud-check-in-service.cjs`

**Interfaces:**
```ts
interface RecordingRecoverySource {
  id: string;
  recordingUrl: string;
  expiresAtMs?: number;
  fileSizeBytes?: number;
  contentSha1?: string;
}
getCheckInRecoverySource(id: string): Promise<RecordingRecoverySource>;
// checkIn action: "recoverySource", 只接收 id，鉴权使用 getWXContext 的 OPENID。
```

- [ ] RED：本人有效 v2/合法旧记录返回精确 ID 与 URL；其他用户即使持有正确 shareToken 也不能恢复、不能签 URL；过期/删除/未提交/引用矛盾不签名；返回坏 ID、非 HTTPS URL、非法大小或 SHA 的客户端响应被拒绝。
- [ ] Run：固定 Node 执行 `--test --test-concurrency=1 --test-timeout=30000 scripts/test-check-in-function.cjs scripts/test-cloud-check-in-service.cjs`，记录 recoverySource 尚不支持时的预期失败。
- [ ] GREEN：复用现有 getDetail 的期限与引用核验，不复制大段签名逻辑；在签发前强制 owner 比较。普通 detail 继续允许正确分享口令。返回仅必要恢复字段；旧记录没有指纹则省略，不伪造。服务端/客户端固定错误分类，不将原始异常暴露用户或日志。新端点缺失时安全失败，不回退到绕过身份核验的公开 detail。
- [ ] 验证：上述测试及 local-share-lifecycle、bounded-recording-download、share-expiry-cleanup 测试无回归。
- [ ] 提交：`feat: 增加本人录音恢复授权接口`；报告 RED/GREEN 和独立 spec + quality 审查。

### Task 3: 主动恢复与回听诊断的端到端接入

**Files:**
- Create: `src/features/listeningPractice/recordingRecovery.ts`
- Modify: `src/features/listeningPractice/pendingCheckInStore.ts`, `pendingCheckInRuntime.ts`
- Modify: `src/pages/CheckInDetail/CheckInDetail.tsx`
- Modify: `src/pages/Practice/Practice.tsx`（仅回听错误诊断）
- Create: `scripts/test-recording-recovery.cjs`
- Modify: `scripts/test-check-in-detail-runtime.cjs`

**Interfaces:**
```ts
// 仓储恢复替换必须在既有串行 mutation 中，拒绝快照已被删除/替换/换分享的情况。
restoreRecording(snapshot: PendingCheckIn, tempFilePath: string,
  info: { fileSizeBytes: number; contentSha1: string }): Promise<PendingCheckIn | null>;
// runtime 主动入口，运行时只在点击“从分享恢复”时调用。
recoverPendingRecording(requestId: string): Promise<PendingCheckIn>;
```

- [ ] RED：真实模块测试本人授权源、下载字节校验、保存后精确路径、同 ID 替换与重新加载；断网、超限、30 秒超时、存储不足、索引写失败、身份不匹配、删除/换分享后迟到结果均不覆盖旧引用。页面测试播放失败写脱敏日志、正常无恢复按钮和云调用、失败后主动恢复按钮成功可回听、隐藏返回后状态同步。
- [ ] Run：固定 Node 执行 `--test --test-concurrency=1 --test-timeout=30000 scripts/test-recording-recovery.cjs scripts/test-check-in-detail-runtime.cjs`，记录预期失败。
- [ ] GREEN：恢复模块分离为纯协调逻辑和原生边界，可复用现有 runtime。下载采用 wx.downloadFile（通过恢复源提供的 HTTPS 短期 URL），检查 statusCode=200；进度发现超过 8 MiB 立即 abort，完成后实际 size/sha1 校验，30 秒超时（必要时早于 v2 源期限）。临时文件失败清理不得触及旧保存文件；若原生回调迟到，清理本次创建的临时资源，不触发上传。
- [ ] 仓储串行校验与恢复：保存前核实快照仍对应当前记录、份额和身份信息；检查实际容量，保存临时文件后再核实信息，写入同 ID 新路径成功后才更新内存。不主动删除旧音频；一次恢复的保存/索引中断有明确可重试状态，不产生无限持久副本。保存后索引写失败不能回退到已经移动的临时路径。
- [ ] 页面保持最小变化：本机播放失败才显示恢复候选；点击时再做授权检查。重试按钮防重复；恢复期间禁止该页播放/分享；隐藏页不补启动播放；返回页从仓储同步。没有有效候选时仍保留原录音记录并说明不能恢复。原始 errCode/分类通过现有脱敏日志函数输出。
- [ ] 诊断补足定位证据：播放开始/失败区分本机与云来源；本机失败后只读检查该路径的访问结果和实际文件信息，输出固定阶段、错误码、字节数及与既有指纹是否一致，不输出路径或指纹本身。探针失败不能改变索引或触发联网。平台/微信/小程序版本仅通过可用原生接口读取并限长，不影响播放；缺少接口或版本信息时省略，不猜测。新增测试验证诊断脱敏与无副作用。
- [ ] 验证：新测试以及音频、Practice、详情、保存、删除、提交、容量与界面契约相关测试；全量 41+ 测试 runner、TypeScript 和微信构建；独立审查。
- [ ] 提交：`fix: 支持旧录音主动恢复并补齐回听诊断`。

### Task 4: 收尾与真机诊断交付

**Files:** `docs/local-recording-expiring-share-deployment.md`、`docs/recording-retention-recovery-acceptance-2026-09-19.md`。

- [ ] 记录实际变更、完整命令与结果、部署依赖（新增 checkIn 端点先于客户端）、故障手机如何回传脱敏错误码。
- [ ] 明确本轮未清除任何测试录音，清除须再次确认；原生旧文件失效根因未获日志前仍为未确认。
- [ ] 真机需要验证：旧录音播放诊断 → 主动恢复 → 关闭小程序 → 断网重启回听；Android/iOS/Pad。无设备条件时如实列为待验收，不伪造通过。
- [ ] 全分支本次变更审查与证据检查；保留现有分支，不推送、不部署、不自动归档任务。
