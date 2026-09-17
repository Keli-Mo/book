# 清理归属与引用安全 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 自动清理准备启用前，拒绝归属不一致、存在其他记录引用或查询失败的目标；预演不能把这类候选报告为校验通过。

**Architecture:** 保留独立云函数部署。在 `fileFor` 以 node:crypto 校验 v2 服务端路径绑定；删除前和只读预演都检查是否存在额外引用，遇异常 fail closed。正式删除事务重读同一记录并重新验证绑定；沿用已完成预算/检查点与永久墓碑协议。

## Global Constraints

- 不启用生产清理、不访问/删除真实文件，不改存储/数据库权限、套餐、索引、变量或触发器。
- 旧协议仍不候选；期限、前缀、SDK SOURCE 鉴权、未知错误保留原引用、迟到上传回收不变。
- 不自动选“真正 owner”，不重写污染数据，不把缺失字段补成猜测值。
- 只修改本任务文件，其他任务/IDE配置保留；中文本地提交，不部署、不 push。

### Task 1: 预演与实际删除前验证确定性归属和所有引用

**Files:**
- Modify: `cloudfunctions/cleanupExpiredShares/index.js`
- Test: `scripts/test-share-expiry-cleanup.cjs`
- Modify: `cloudfunctions/README.md`

**Interfaces:** 只增加固定安全分类 `INVALID_SHARE_BINDING`、`FILE_REFERENCE_CONFLICT`、`FILE_REFERENCE_CHECK_FAILED`；原返回统计/期限不变。新增校验不得输出原始文件 ID、OPENID 或 SDK error。

- [ ] Step 1: 更新现有 row fixture 为真实结构，提供非空 `_openid`、32 位小写十六进制 requestId、64 位小写 payloadDigest，并用真实 sha256(owner) 组成 cloudPath。仍可保留测试排序 idFor，禁止通过测试专用生产开关放过旧伪造结构。
- [ ] Step 2: 在生产改动前添加RED：错 owner、缺 owner、requestId/digest 与路径不符，在 dry-run 和正式模式均失败且文件、状态不被改变；其他 owner 或同 owner 的第二份记录引用同 fileID，也必须保留文件，不能先写 deletePending 再报错。以101个引用（包含未到期、旧记录、墓碑）证明不因状态/owner过滤而漏掉别名，并测试查询异常。
- [ ] Step 3: fileFor 验证 owner 非空字符串、request/digest 规范，再比较完整期望路径 `expiring-shares-v2/${sha256(owner)}/${requestId}-${payloadDigest}.mp3`；保留完整可信 prefix 和 recordingFileId 一致性检查。active 缺 recordingFileId 视为不安全；pending 和其墓碑允许只有可信路径。
- [ ] Step 4: 增加精简引用核验，查 recordingFileId 等值且 limit(2)，不可过滤 owner、期限、状态或旧记录。数据库文档 _id 唯一，允许的引用最多只有目标本身一条，所以取到第二条已经足够证明冲突，无须无限分页。即使同 owner 的第二条也拒绝，避免删除仍被另一记录使用的音频。结果只能为空或一条 `_id` 与 owner 都匹配目标的记录；非数组、超过一条、异常、错误归属均固定分类失败关闭。现有软预算到期前后不得开始删除；预算内无法完成核验就安全失败/留待下一轮，不报validated成功。
- [ ] Step 5: dry-run 与正式入口在 `validated++` 前执行相同绑定及引用校验。正式 cleanOne 的首个事务须重读记录、再次确认期限和完整绑定，确保被扫描的 pending 已 commit 时不误删；若事务内绑定变更不能通过旧的检查结果。删除和最终墓碑流程不放宽。
- [ ] Step 6: 补合法 pending/active/deleted 全路径、多引用/空引用、错误前缀、临期commit竞争、未知删除结果、检查点推进/回绕及迟到上传测试；已有软预算场景应纳入引用查询成本，不能以关掉预算使测试通过。
- [ ] Step 7: 运行 cleanup、checkIn协议、local-share-lifecycle；README 将 validated 说明更新为绑定与引用预检，注明不证明实际ACL/管理员并发修改安全。无需更改接口文档为已上线或已启用。
- [ ] Step 8: 显式暂存任务文件与实现报告，本地提交 `fix: 清理前核验录音归属与全部引用`，等待独立复审。
