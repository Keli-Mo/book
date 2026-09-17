# 云端错误安全修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 修复已复现的 SDK 原始错误泄露，保留必要诊断及用户可理解的固定错误分类。

**Architecture:** 每个独立部署函数在出口将错误代码/文案映射到固定白名单，客户端云调用与展示再做分类保护；不记录原始 SDK Error、事件或任意错误码。所有失败仍保留本地文件与云端重试状态。

**Tech Stack:** wx-server-sdk 4.0.2、Node.js、Taro/TypeScript、现有 VM/SDK harness。

## Global Constraints

- 本地完成/回听不上传，只有主动分享才上传；30天首次commit期限不变。
- 100 MiB管理预算、10 MiB余量、90 MiB保存预算、82 MiB开始门槛不变。
- 不自动删本地文件，不修改删除/分享状态收敛语义；不放宽权限、不启用生产清理。
- 本任务不改变分享配额或v1兼容策略，不变更下载方式、依赖、运行时或超时。
- 只改下列明确文件，保留两个IDE配置和旧主目录；由主控审查后部署，不由实现代理操作云端。
- 使用 `fix: 中文` 本地提交，仅显式暂存本任务文件。

### Task 1: 函数出口与客户端错误脱敏

**Files:**
- Modify: `cloudfunctions/checkIn/index.js`
- Modify: `cloudfunctions/cleanupExpiredShares/index.js`
- Modify: `src/services/cloudCheckIn.ts`
- Test: `scripts/test-check-in-function.cjs`
- Test: `scripts/test-share-expiry-cleanup.cjs`
- Test: `scripts/test-cloud-error.cjs`
- Test: `scripts/test-cloud-check-in-service.cjs`
- Modify: `cloudfunctions/README.md`

**Interfaces:** 保留所有成功响应、既有内部业务错误码和 getReadableCloudError/getShareFailureMessage 签名。未知外部错误统一 CHECK_IN_ERROR/CLEANUP_FAILED；可识别网络错误仅保留白名单代码 ECONNRESET、ETIMEDOUT 和固定文案，事务冲突保留 DATABASE_TRANSACTION_CONFLICT。不能把“错误字段名叫 code”当作脱敏。

- [ ] Step 1: 在现有 harness 中捕获 console.error 参数，并允许注入读取、下载、删除结果/最终事务错误；不修改真实 handler 的业务结果。新增错误安全断言，至少覆盖 message、errMsg、任意 code、未知 action、deleteFile 返回的失败 errMsg。使用合成标记，不使用真实地址。

```js
const secretMarker = 'SYNTHETIC_PRIVATE_VALUE';
const unsafeMessage = `https://example.test/audio?token=${secretMarker}`;
const encoded = JSON.stringify({ response: result, logs: capturedLogs });
assert.equal(encoded.includes(secretMarker), false);
assert.equal(result.ok, false);
```

对 prepare、commit、detail、listMine、remove 的可达外部失败各检查一次；shareStatus 的现有“不确定错误保留”测试继续运行。清理逐条失败与外层失败都覆盖。客户端 getReadableCloudError 对 Error、普通对象、字符串、数字code、未知code均不能输出合成标记；云服务拒绝的 Error.message/code 也必须安全。已有要求原文保留的断言改为固定分类，并保留原“不把网络错误当缺文档”的状态/文件断言。

- [ ] Step 2: 使用内置 Node 分别运行上述四项测试，记录新增断言在未修复实现上确实因敏感标记被输出而失败；非断言原因的错误先修测试。

- [ ] Step 3: 用固定映射替代原文输出。内部 reject 的代码保留；参数错误改用 INVALID_ARGUMENT 固定分类。remove 中 FILE_DELETE_FAILED 必须传固定文案，不能传 fileResult.errMsg。未知 action 的日志标签固定为 unknown；日志只允许固定 action、固定 code，不带事件、Error、stack、原始 message、文件ID、owner、口令或URL。以下为必须遵守的出口算法：

```js
const knownActions = new Set(['prepare', 'commit', 'create', 'detail', 'listMine', 'shareStatus', 'remove']);
const publicMessages = Object.freeze({
  CHECK_IN_ERROR: '云端服务暂时不可用，请稍后重试',
  INVALID_ARGUMENT: '提交的信息格式不正确，请重试',
  ECONNRESET: '网络异常，请稍后重试',
  ETIMEDOUT: '网络请求超时，请稍后重试',
  DATABASE_TRANSACTION_CONFLICT: '服务繁忙，请稍后重试',
  FILE_DELETE_FAILED: '云录音删除未完成，请重试',
  FILE_REFERENCE_CONFLICT: '录音引用归属冲突，请联系管理员核验',
  FILE_REFERENCE_CHECK_FAILED: '录音引用核验失败，请稍后重试',
  FORBIDDEN: '无权操作这条录音',
  REQUEST_ID_CONFLICT: '分享请求不匹配，请重新进入后重试',
  REQUEST_DELETED: '该分享已删除，不能重新提交',
  SHARE_EXPIRED: '分享已过期或失效',
  SHARE_NOT_PREPARED: '请先准备分享后重试',
  SHARE_NOT_COMMITTED: '分享尚未完成，请稍后重试',
  INVALID_FILE_ID: '录音文件信息不匹配，请重试',
  RECORDING_FILE_MISMATCH: '录音文件校验失败，请重试',
  CLOUD_ENV_UNAVAILABLE: '云端服务配置暂不可用',
});
const safeCode = error => {
  const candidate = error?.code ?? error?.errCode ?? error?.errno;
  return typeof candidate === 'string' && Object.prototype.hasOwnProperty.call(publicMessages, candidate)
    ? candidate : 'CHECK_IN_ERROR';
};
// catch 内仅使用 safeCode(error)、publicMessages[code] 和白名单 action。
```

清理函数独立使用其固定代码集：INVALID_SHARE_PATH、INVALID_SHARE_FILE_ID、FILE_DELETE_UNCONFIRMED、CLEANUP_STATE_CHANGED、DATABASE_TRANSACTION_CONFLICT、CLEANUP_FAILED。仅允许精确匹配的内部 Error.message 充当已有业务代码，其他任意 message/code 全部归类 CLEANUP_FAILED。不改 dry-run 的统计、授权或数据行为。

客户端固定错误分类放在 cloudCheckIn.ts 中，复用一个错误分类入口，禁止继续拼接原始错误文案/任意code。callCheckInFunction 的 SDK reject 和业务失败均转为安全 Error；明确 SHARE_EXPIRED、REQUEST_DELETED、FILE_REFERENCE_CONFLICT 等业务码继续传递，以免改变恢复逻辑。getReadableCloudError 对部署缺失、集合缺失、网络、存储及未知错误只返回固定文案；getShareFailureMessage 的本地保留文案保持不变。不对整个项目做无关错误架构重写。

- [ ] Step 4: 四项聚焦测试通过，再跑本地服务/仓储/协调器集成 `scripts/test-local-share-lifecycle.cjs` 与 `tsc --noEmit --skipLibCheck`；保存 RED/GREEN 命令与结果。README 注明日志只有固定分类，不宣称已治理平台日志留存权限。

- [ ] Step 5: 自查仅上述文件改变，显式暂存并提交 `fix: 脱敏云函数错误响应与诊断日志`，回传报告供独立规格/质量复审。禁止部署、push及修改IDE配置。
