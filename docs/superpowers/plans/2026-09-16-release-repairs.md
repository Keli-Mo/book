# 上线前安全与录音恢复修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 按任务先失败测试、再实现、再独立复审；用户已同意执行，不再重复询问执行方式。

**Goal:** 修复已确认的旧接口越权、分享重入卡住、云删除重试缺失、失效链接无法恢复和慢列表刷新问题。

**Architecture:** 保持现有云函数、单例提交协调器和本机录音仓储；收紧旧创建入口，在现有接口补充明确状态和可恢复操作。原始音频不迁移、不自动清理本机文件。

**Tech Stack:** Taro/React/TypeScript、微信云开发 Node 云函数、现有 Node 内存 SDK/页面测试。

## Global Constraints

- 仅修改最新工作树 `E:/REPOSITORY/haisha/haisha/.worktrees/all-books-device-recording`，保留已有未提交修改；不部署、不启用真实删除、不变更生产权限/索引/运行时。
- 默认本地完成零上传；仅用户点击分享才进行上传；本地回听不联网；30 天期限从首次 commit 起算，不由重试延长。
- 不自动删除本机历史、不清缓存、不改写旧期限、不删除服务端防重记录；恢复失败保留原文件与引用。
- 无证据不承诺旧记录归属、线上清理启用、真机验收或线上漏洞已修复。
- 界面保持简洁；仅新增恢复问题所必要的短状态和操作，不改版式、不增加班级模块。
- 本轮不提交已有混合改动、不 push；如后续提交，使用 `fix:`/`feat:` 英文前缀，后面的说明用中文。

## Task 1: 封堵旧创建入口及旧文件引用冲突

**Files:** `cloudfunctions/checkIn/index.js`、`scripts/test-check-in-function.cjs`、`scripts/test-local-share-lifecycle.cjs`（补齐真实数据库查询模拟，保留原集成断言）、`cloudfunctions/README.md`。

**Requirements:**

1. `create` 无条件返回稳定拒绝码 `LEGACY_CREATE_DISABLED`，未登录仍保持现有鉴权优先；不写数据库、不签 URL、不删文件。
2. 保留必要的已存在旧记录读取/本人删除，不伪造归属迁移。已有同一个 fileID 被不同 owner 引用时，详情和删除必须失败关闭；查询异常也必须失败关闭，不能继续签发/删除。
3. 当前有协议绑定的 prepare/commit 仍正常，不能重新开放任意 fileID 附加。针对所有特权文件操作判断冲突防护覆盖面，任何范围不清要先报告。
4. 把原先依赖 `create` 的历史兼容测试改为真实的已有记录 fixture，测试 owner、正确/错误口令和删除重试。
5. 文档说明旧客户端需升级才能新增、旧引用冲突需人工核验、本轮没有读取真实云库做存量审计。

**TDD anchors:**

```js
const h = harness();
const before = { ...h.metrics };
const result = await h.call('create', { ...input(), recordingFileId: 'cloud://test.bucket/checkins/legacy.mp3' });
assert.equal(result.code, 'LEGACY_CREATE_DISABLED');
assert.equal(h.records.size, 0);
assert.equal(h.metrics.signed, before.signed);
assert.equal(h.metrics.deletes, before.deletes);
```

为现存不同 owner 指向同一文件的两条 fixture 添加详情/删除拒绝、文件仍在、记录仍在、零签名和零删除断言；模拟归属查询异常。不要把攻击用例放在生产运行。

- [x] 先运行新增测试，确认旧代码因授权断言失败。
- [x] 最小实现拒绝入口与现存引用保护，更新文档。
- [x] `node scripts/test-check-in-function.cjs`；相关旧协议/新协议集成测试通过。
- [x] 独立复审并处理重要问题。

## Task 2: 分享生命周期和删除列表恢复

**Files:** `src/pages/CheckInDetail/CheckInDetail.tsx`、`src/pages/MyCheckIns/MyCheckIns.tsx`、`src/services/cloudCheckIn.ts`、`src/features/listeningPractice/checkInSubmissionCoordinator.ts`、`pendingCheckInStore.ts`、`recordingLibraryView.ts`（仅如合并列表需要）、`cloudfunctions/checkIn/index.js`；对应现有测试脚本。

**Requirements:**

1. 重开正在提交的同一录音，页面接收现有任务完成/失败，更新本机分享状态并解除 loading；不通过调用 submit 启动新任务来“观察”旧任务，不使用高频轮询。
2. 云删除失败的 `deletePending` 对 owner 可见并可重试，不能可播放/分享；即使原有效期已到也不能因列表过滤消失。非本人不可见，其他 pending/deleted 仍隐藏；同时有本机副本时不被合并列表吞掉。
3. 原设备缓存的链接在云端被删/文件明确缺失时，用户能主动恢复分享。任何网络、权限或未知错误不能当作“文件已丢”而清状态/重传；先核实云端状态，再只失效当前旧分享代次，保留本地文件和防重记录，用户再次明确操作时生成新代。正常本地回听不联网，不能提前上传。
4. 列表删除与异步刷新竞争时，旧刷新不得恢复已删除卡片；重复点击删除应去重，离页后不污染新页面。
5. 在现有样式内使用简洁恢复提示；不扩展为后台自动备份、主动撤销 API 或全局监听框架。

**Test anchors:** 使用已有页面运行时 harness，先断言重开后旧提交完成时 `loading=false`，失败时能重试；对已有云卡片启动延迟刷新→删除成功→返回旧结果，断言已删 ID 不再显示。对云端删除失败断言 owner 列表有 `deletePending`，回听/分享拒绝，重试成功后隐藏。对同一录音本地/云合并断言待删除云项保留独立重试操作。

**Recovery cases:** 未过期且云 active 无重复上传；云删除/过期/明确文件不存在能通过用户操作重新分享；网络失败零重传且原状态不丢；迟到核验不能清掉另一代新分享；分享中退出重进、删除后重进与保存失败路径均保留本地文件。

- [x] 逐个新增失败测试，记录失败原因。
- [x] 逐项最小实现并运行对应测试，不通过降低断言放行。
- [x] 运行 cloud function、detail runtime、submission、pending store、recording library 与 deletion page 测试。
- [x] 独立复审处理重要问题。

## Task 3: 回归收尾与发布边界

**Files:** 仅修正已报告的四个未使用项所涉及文件：`config/index.ts`、`src/pages/BookDetail/Components/BookPreview/BookPreview.tsx`、`src/pages/Home/Components/BottomBar/BottomBar.tsx`；更新本轮结果文档。

- [x] 先运行 `node node_modules/typescript/bin/tsc --noEmit --skipLibCheck` 捕获四条诊断，再移除未使用绑定/导入，不降低 tsconfig 严格度、不改变布局。
- [x] 全部 `scripts/test-*.cjs` 回归，含新加入的反例；`build:weapp` 和标准类型检查通过。
- [x] 独立整体复审，验证默认本地零上传、30 天分享和容量保护没有回退。
- [x] 记录修改文件、红绿证据、线上待部署、存量旧记录审计、云 ACL/清理与真机验收仍未完成。

完成结果：docs/qa/2026-09-16-release-repairs-results.md。代码保留在当前工作分支，未提交、推送、合并或部署。

本轮不执行审查计划中的生产清理启用、套餐调整、完整告警系统、教材授权审定或真机灌满空间测试。这些需完成代码修复后单独验收。
