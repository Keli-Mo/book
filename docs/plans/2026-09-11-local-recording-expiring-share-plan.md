# 本地录音库与 30 天分享实施计划

> **For agentic workers:** 使用 subagent-driven-development 或 executing-plans 逐任务实施；TDD、独立审查与最终集成回归。用户明确不使用 using-superpowers。

**Goal:** 完成练习只存本地，点击分享才上传，新分享 30 天失效并可清理，旧云记录不误删。

**Architecture:** 复用可靠的 saveFile/指纹/提交协调器。本地 requestId 保持稳定，新增 shareRequestId 作为每代云分享的独立编号；分享信息回写本地而不删除文件。checkIn 的新版分享协议 prepare 预留记录，commit 幂等确认；独立定时清理函数仅清理明确带新协议期限的记录。

**Tech Stack:** Taro 4、React 18、TypeScript、微信云开发 Node SDK、现有 Node assert 测试。

## Global Constraints

- 只有用户点击分享才允许 prepare/upload/commit；打开、回听、完成练习、恢复联网不上传。
- 新分享默认有效 30 天；有效期内复用，不自动续期；过期后新编号、新口令、新云路径，旧链接不得复活。
- 云端过期不删除本地文件；本地满额明确提示，不自动按年龄或先进先出删除录音。
- 旧云记录无新协议期限时保持兼容，不自动过期；旧本地 pending 原路径迁移，不复制或删文件。
- 页面简单，移除待提交/已上传待确认技术状态；保留页数、教材内页、日期、时长、回听与分享。
- 手机、iPad、Android Pad 与离页停播、播放当前秒数、录音暂停/并播能力不得回退。
- 中文注释；提交格式 feat/fix/docs/test: 中文。不得修改用户的 project.config.json、project.private.config.json 或主目录未提交内容。
- 不切换套餐，不开启付费项目；只提交云函数与部署说明，未经上线前核查不运行生产清理。

## Task 1: 本地持久录音与分享代次

Files: `src/features/listeningPractice/pendingCheckInStore.ts`, `checkInSubmissionCoordinator.ts`, `checkInSubmissionRuntime.ts`, `src/services/cloudCheckIn.ts`；相应 store/runtime/submission/cloud service 测试。

Interfaces:
```ts
type RecordingShare = { id: string; shareToken: string; expiresAtMs: number };
// PendingCheckIn 新增可选字段，老数据仍能读取：
// createdAtMs?: number; completedAtMs?: number; shareRequestId?: string; share?: RecordingShare;
// requestId 始终标识本地文件，不作为新版分享云 requestId。
store.complete(requestId, true): Promise<boolean>; // 只标完成且持久化，绝不删文件
store.beginShare(requestId): Promise<PendingCheckIn | null>; // 原代未失效继续，新代持久化后才允许上传
store.markShared(requestId, share: RecordingShare): Promise<PendingCheckIn | null>;
// 服务 input 新增 shareVersion?: 2；新版响应 expiresAtMs: number。
// SubmissionResult committed 附 expiresAtMs，cleanupPending 表示分享信息回写未成功，不能删本地。
```

- [ ] RED: 在现有仓储测试追加 complete 后文件保留、重启恢复、beginShare 同代重用及到期换代、旧 pending 兼容、元数据写失败不得上传。例：`assert.equal(await store.complete(id,true),true); assert.equal(files.has(savedPath),true); assert.equal(store.list().length,1);` 在旧实现应失败。
- [ ] GREEN: 复用存储 key，增加稳定创建时间/完成时间及分享代次。总预算 100 MiB、最多 500 条（保护元数据体积），提示清理而不是联网提交。共享新代提交使用 shareRequestId，但所有本地 update 用稳定 requestId。已成功分享回写 id/token/expiresAtMs，不调用删除操作。
- [ ] RED/GREEN: 协调器测试覆盖 prepare 已提交、commit 丢响应重试、过期代拒绝、同一录音去重、写失败保留文件、有效链接重用、取消/迟到回调不污染新代。旧指纹修复/网络退避用例保持。
- [ ] 验证：`node scripts/test-pending-check-in.cjs`、`node scripts/test-check-in-submission.cjs`、`node scripts/test-cloud-check-in-service.cjs`、两个 runtime 测试、真实文件 roundtrip 测试。记录 RED/GREEN，提交并独立审查。

## Task 2: 云端分享有效期和可重试清理

Files: `cloudfunctions/checkIn/index.js`；新增 `cloudfunctions/cleanupExpiredShares/`（package/config/index/必要纯逻辑）；`scripts/test-check-in-function.cjs` 与新增 `scripts/test-share-expiry-cleanup.cjs`。

Interfaces: 新版 prepare/commit 请求携带 `shareVersion: 2`，成功返回 `expiresAtMs` 毫秒时间戳；旧 create/prepare/commit 兼容。新记录标记 `shareVersion: 2`，prepare 保存上传路径、payloadDigest、待上传期限；commit 确认后生成服务端 30 天期限。detail/list 均按服务端期限过滤/拒绝过期代，返回 `SHARE_EXPIRED`，旧无期限记录不清理。由后端实现者先确认具体记录字段，保持对 Task 1 的返回接口不变。

- [ ] RED: 测试新版 prepare 持久预留、同请求幂等、不同载荷冲突、过期 detail 不签 URL、过期/删除中/墓碑 commit 不复活、旧记录仍可读。
- [ ] GREEN: 在现有事务协议扩展状态，不绕过 OPENID 校验；实际云文件继续验证内容。临时链接期限尽量不超过分享剩余时间，私有存储部署条件写明。
- [ ] RED/GREEN: 清理测试验证分页、并发和重试；只处理新版 expired/pending 记录；标删除中再删文件，确认文件已删除后收敛墓碑；失败保留引用；旧无 expiresAt 数据始终跳过；仅受信定时入口能执行。待上传孤儿需要可枚举已预留文件路径，迟到上传后仍可再次清理。
- [ ] 不把数据库 TTL 当作文件删除。不把永久公开 URL 当成严格到期控制。默认未启用生产删除，部署文档说明验权、dry-run、索引、启用步骤与缓存限制。
- [ ] 验证两个云端脚本与旧云函数用例，记录 RED/GREEN，提交并独立审查。

## Task 3: 本地完成、列表与分享页

Files: `src/pages/Practice/Practice.tsx`、`src/pages/MyCheckIns/*`、`src/pages/CheckInDetail/*`、相关页面测试与新增运行时行为测试。必要时新增纯 helper `src/features/listeningPractice/recordingLibraryView.ts`，负责合并/去重与本地详情适配。

Interfaces: 本地详情路由 `/pages/CheckInDetail/CheckInDetail?localId=<requestId>`。分享接收仍是 `?id=<cloudId>&token=<token>`；localId 不得出现在分享卡片。调用 Task 1 的 complete/beginShare/markShared，只有分享按钮启动 submission。

- [ ] RED: 测试完成练习不调用云端，指向 localId；本地详情加载/回听不调用云端；分享成功仍存在本地文件；无云有效链接不会暴露本地路径；分享上传失败只提示分享失败。
- [ ] GREEN: Practice 完成只持久完成标记，成功再 redirect 本地详情；保存失败不能伪装完成；已完成录音不作为待恢复重录对象。保留已存在录音协调器及切页竞态防护。
- [ ] GREEN: 统一我的录音列表，本地先展示；云历史为兼容补充，云网络错误不能遮盖本地。按本地 share.id 对云记录去重。卡片回听进入详情，删除明确本地/云端影响且不得在上传中删文件。不显示待提交等技术状态。
- [ ] GREEN: 本地详情播放 localPath，分享点击 beginShare 后协调器上传，完成变为“发送给朋友”；有效链接直接原生分享。播放仅 isPlaying 显示当前/总时长；页面隐藏停播并取消尚可取消上传；顶部返回首页。到期新分享；旧链接不能复活。非持久保存警告必须保留。
- [ ] 验证对应页面/路由/响应式/播放测试与新增真实行为测试。记录 RED/GREEN，提交并独立审查。

## Task 4: 集成验收与部署手册

Files: 新增 `docs/local-recording-expiring-share-deployment.md`，必要更新 README 与测试脚本注册。

- [ ] 跑 scripts 下全部 test-*.cjs（基线已通过），再运行宽松 TS、修改文件 lint、微信构建、git diff --check。
- [ ] 独立全分支审查并修复所有阻断问题，重点历史本地丢失、云过期与重新分享竞态。
- [ ] 写明云端未部署/清理未启用的真实状态，以及手机、Pad、断网、重启、过期、旧数据的实际验收步骤。
- [ ] 不自动推送/合并、不切套餐；给出分支和中文提交，可回滚基线 `a7a1e76`。
