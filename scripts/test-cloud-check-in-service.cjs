const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../src/services/cloudCheckIn.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const plain = value => JSON.parse(JSON.stringify(value));
function harness() {
  const calls = [], uploads = [], infoCalls = [];
  let deletes = 0;
  const controls = { response: { ok: true, data: { id: "id", shareToken: "token" } }, error: null, infoError: null, throwUpload: null };
  const task = { abort() { this.aborted = true; }, onProgressUpdate(callback) { this.progress = callback; } };
  const wx = {
    getFileInfo(options) {
      infoCalls.push(options);
      if (controls.infoError) options.fail(controls.infoError);
      else options.success(controls.infoResult || { size: 1000, digest: "A".repeat(40) });
    },
    cloud: {
      async callFunction({ name, data }) { calls.push({ name, data }); if (controls.error) throw controls.error; return { result: controls.response }; },
      uploadFile(options) { if (controls.throwUpload) throw controls.throwUpload; uploads.push(options); return task; },
      async deleteFile() { deletes++; },
    },
  };
  const mod = { exports: {} };
  vm.runInNewContext(compiled, { module: mod, exports: mod.exports, wx });
  return { api: mod.exports, controls, calls, uploads, infoCalls, task, deletes: () => deletes };
}
const input = { requestId: "A".repeat(32), durationMs: 1200, fileSizeBytes: 1000, contentSha1: "a".repeat(40),
  bookId: "3", bookTitle: "CASA", practiceId: "3-page-4", practiceIndex: 0, pageNumber: 4,
  sectionTitle: "导入", imageUrl: "https://example.test/4.png" };
const cases = [];
const test = (name, run) => cases.push({ name, run });

test("分享核验只接受明确的状态枚举，不上传且拒绝畸形成功包", async () => {
  const h = harness();
  assert.equal(typeof h.api.getCheckInShareStatus, "function");
  for (const state of ["active", "deleted", "expired", "missing", "invalid"]) {
    h.controls.response.data = { state };
    assert.deepEqual(plain(await h.api.getCheckInShareStatus("id", "A".repeat(32))), { state });
  }
  assert.deepEqual(plain(h.calls[0].data), { action: "shareStatus", id: "id", shareRequestId: "a".repeat(32) });
  for (const data of [null, {}, { state: "unknown" }, { state: false }]) {
    h.controls.response.data = data;
    await assert.rejects(h.api.getCheckInShareStatus("id", "a".repeat(32)), error => error.code === "SHARE_RESPONSE_INVALID");
  }
  assert.equal(h.uploads.length, 0); assert.equal(h.deletes(), 0);
  h.controls.response = { ok: false, code: "SHARE_STATUS_UNAVAILABLE", message: "暂时无法核验分享，请稍后重试" };
  await assert.rejects(h.api.getCheckInShareStatus("id", "a".repeat(32)), error => error.code === "SHARE_STATUS_UNAVAILABLE");
  assert.equal(h.uploads.length, 0); assert.equal(h.deletes(), 0);
});
test("本人恢复源只发送 id，并严格校验云端恢复字段", async () => {
  const h = harness();
  assert.equal(typeof h.api.getCheckInRecoverySource, "function");
  h.controls.response.data = { id: "record-id", recordingUrl: "https://temp.example.test/audio.mp3",
    expiresAtMs: 1_800_000_000_000, fileSizeBytes: 1000, contentSha1: "a".repeat(40), ignored: "not-trusted" };
  assert.deepEqual(plain(await h.api.getCheckInRecoverySource("record-id")), {
    id: "record-id", recordingUrl: "https://temp.example.test/audio.mp3",
    expiresAtMs: 1_800_000_000_000, fileSizeBytes: 1000, contentSha1: "a".repeat(40) });
  assert.deepEqual(plain(h.calls[0].data), { action: "recoverySource", id: "record-id" });
  assert.equal(h.uploads.length, 0); assert.equal(h.deletes(), 0);
  h.controls.response.data = { id: "legacy", recordingUrl: "https://temp.example.test/legacy.mp3" };
  assert.deepEqual(plain(await h.api.getCheckInRecoverySource("legacy")), h.controls.response.data);
  for (const data of [
    { id: "other", recordingUrl: "https://temp.example.test/audio.mp3" },
    { id: "record-id", recordingUrl: "http://temp.example.test/audio.mp3" },
    { id: "record-id", recordingUrl: "not-a-url" },
    { id: "record-id", recordingUrl: "https://?x=private" },
    { id: "record-id", recordingUrl: "https:///audio" },
    { id: "record-id", recordingUrl: "https://temp.example.test/audio.mp3", fileSizeBytes: 0 },
    { id: "record-id", recordingUrl: "https://temp.example.test/audio.mp3", fileSizeBytes: 1.5 },
    { id: "record-id", recordingUrl: "https://temp.example.test/audio.mp3", fileSizeBytes: 8 * 1024 * 1024 + 1 },
    { id: "record-id", recordingUrl: "https://temp.example.test/audio.mp3", contentSha1: "A".repeat(40) },
    { id: "record-id", recordingUrl: "https://temp.example.test/audio.mp3", contentSha1: "bad" },
  ]) {
    h.controls.response.data = data;
    await assert.rejects(h.api.getCheckInRecoverySource("record-id"), error => error.code === "RECOVERY_RESPONSE_INVALID");
  }
});
test("新协议与原生 SHA1 接口存在", async () => {
  const { api } = harness();
  for (const name of ["prepareCheckIn", "commitCheckIn", "getCheckInRecordingInfo", "startPreparedCheckInUpload"])
    assert.equal(typeof api[name], "function", `${name} 必须导出`);
});
test("原生 getFileInfo 使用 sha1 和实际 saved 路径", async () => {
  const h = harness();
  assert.deepEqual(plain(await h.api.getCheckInRecordingInfo("/saved/record.mp3")), { fileSizeBytes: 1000, contentSha1: "a".repeat(40) });
  assert.equal(h.infoCalls[0].filePath, "/saved/record.mp3"); assert.equal(h.infoCalls[0].digestAlgorithm, "sha1");
  const error = { errMsg: "getFileInfo:fail", code: "ENOENT" }; h.controls.infoError = error;
  await assert.rejects(h.api.getCheckInRecordingInfo("/missing"), e => e === error);
});
test("文件信息原生回调数据无效时明确拒绝，不能被当成可上传文件", async () => {
  for (const infoResult of [
    { size: 0, digest: "a".repeat(40) },
    { size: 1000, digest: undefined },
    { size: 1000, digest: "invalid" },
    { size: 1.5, digest: "a".repeat(40) },
  ]) {
    const h = harness(); h.controls.infoResult = infoResult;
    await assert.rejects(h.api.getCheckInRecordingInfo("/saved/record.mp3"), error => error.code === "RECORDING_INFO_INVALID");
  }
});
test("prepare/commit 保留快照、规范 requestId，不自动上传删除", async () => {
  const h = harness(); const before = plain(input);
  h.controls.response.data = { state: "upload-required", id: "id", cloudPath: "expiring-shares-v2/owner/record.mp3" };
  await h.api.prepareCheckIn(input);
  assert.equal(h.calls[0].data.action, "prepare"); assert.equal(h.calls[0].data.requestId, "a".repeat(32));
  assert.equal(h.calls[0].data.shareVersion, 2);
  assert.equal(h.calls[0].data.contentSha1, input.contentSha1); assert.equal(h.uploads.length, 0);
  h.controls.response.data = { id: "id", shareToken: "token", expiresAtMs: 1_800_000_000_000 };
  await h.api.commitCheckIn({ ...input, recordingFileId: "cloud://test.bucket/checkins/path.mp3" });
  assert.equal(h.calls[1].data.action, "commit"); assert.equal(h.calls[1].data.recordingFileId, "cloud://test.bucket/checkins/path.mp3");
  assert.equal(h.calls[1].data.shareVersion, 2);
  assert.deepEqual(input, before); assert.equal(h.deletes(), 0);
});

test("旧云函数的上传路径在上传前拒绝，不创建无期限分享", async () => {
  const h = harness();
  h.controls.response.data = { state: "upload-required", id: "id", cloudPath: "checkins/owner/record.mp3" };
  await assert.rejects(h.api.prepareCheckIn(input), e => e.code === "SHARE_PROTOCOL_MISMATCH");
  assert.equal(h.uploads.length, 0);
  assert.equal(h.deletes(), 0);
});

test("prepare 已提交与 commit 缺失有效期均报告协议不匹配，不伪造期限", async () => {
  for (const action of ["prepare", "commit"]) {
    const h = harness();
    h.controls.response.data = { id: "id", shareToken: "token", ...(action === "prepare" ? { state: "committed" } : {}) };
    const call = () => action === "prepare" ? h.api.prepareCheckIn(input) : h.api.commitCheckIn({ ...input, recordingFileId: "cloud://file" });
    await assert.rejects(call(), e => e.code === "SHARE_PROTOCOL_MISMATCH");
    h.controls.response.data.expiresAtMs = 1_800_000_000_000;
    assert.equal((await call()).expiresAtMs, 1_800_000_000_000);
    assert.equal(h.deletes(), 0);
  }
});

test("云端成功包仍需校验状态、编号、口令和期限类型", async () => {
  const h = harness();
  for (const data of [null, [], {}, { state: "unknown" }, { state: "upload-required", id: "", cloudPath: "expiring-shares-v2/a.mp3" },
    { state: "upload-required", id: "id", cloudPath: "https://unexpected.test/audio.mp3" }]) {
    h.controls.response.data = data;
    await assert.rejects(h.api.prepareCheckIn(input), e => e.code === "SHARE_RESPONSE_INVALID");
  }
  for (const patch of [{ id: " " }, { shareToken: null }, { expiresAtMs: "1800000000000" }, { expiresAtMs: -1 }, { expiresAtMs: NaN }, { expiresAtMs: 1.5 }]) {
    h.controls.response.data = { id: "id", shareToken: "token", expiresAtMs: 1_800_000_000_000, ...patch };
    await assert.rejects(h.api.commitCheckIn({ ...input, recordingFileId: "cloud://file" }), e => e.code === "SHARE_RESPONSE_INVALID");
  }
});

test("新版分享缺响应包或成功包缺 data 属于响应异常，不能混为一般失败", async () => {
  const h = harness();
  for (const response of [undefined, null, {}, { ok: true }, { ok: "true", data: {} }]) {
    h.controls.response = response;
    await assert.rejects(h.api.prepareCheckIn(input), e => e.code === "SHARE_RESPONSE_INVALID");
    await assert.rejects(h.api.commitCheckIn({ ...input, recordingFileId: "cloud://file" }), e => e.code === "SHARE_RESPONSE_INVALID");
  }
});

test("分享提示分类且不向用户泄露云端原文或口令", async () => {
  const h = harness();
  for (const [error, expected] of [
    [{ code: "SHARE_PROTOCOL_MISMATCH" }, /版本不匹配/],
    [{ code: "SHARE_RESPONSE_INVALID" }, /返回异常/],
    [{ code: "PENDING_PERSIST_FAILED" }, /本机状态保存失败/],
    [{ errMsg: "request:fail network disconnected token=secret" }, /网络异常/],
    [{ code: "STORAGE_PREFIX_REQUIRED" }, /服务配置/],
    [{ code: "UNKNOWN", message: "https://private.test/audio?token=secret" }, /分享失败/],
  ]) {
    const title = h.api.getShareFailureMessage(error);
    assert.match(title, expected);
    assert.doesNotMatch(title, /secret|private\.test|cloud:\/\//);
  }
});
test("callback 上传返回原始 UploadTask 与独立结果 Promise", async () => {
  const h = harness();
  const upload = h.api.startPreparedCheckInUpload("/saved/record.mp3", { state: "upload-required", id: "id", cloudPath: "checkins/owner/request-digest.mp3" });
  assert.strictEqual(upload.task, h.task); assert.equal(h.uploads[0].cloudPath, "checkins/owner/request-digest.mp3");
  assert.equal(h.uploads[0].filePath, "/saved/record.mp3"); assert.equal(typeof h.uploads[0].success, "function");
  upload.task.onProgressUpdate(() => {}); upload.task.abort(); assert.equal(h.task.aborted, true);
  h.uploads[0].success({ fileID: "cloud://test.bucket/checkins/ok.mp3" });
  assert.equal(await upload.result, "cloud://test.bucket/checkins/ok.mp3");
  assert.equal(h.calls.length, 0, "本层不自动 commit，由页面先持久化 fileID");
});
test("上传失败与同步异常仍交由固定展示分类且不删文件", async () => {
  const h = harness(), prepared = { state: "upload-required", id: "id", cloudPath: "checkins/path.mp3" };
  const error = { errMsg: "uploadFile:fail timeout", code: "ETIMEDOUT" };
  const upload = h.api.startPreparedCheckInUpload("/saved/record.mp3", prepared); h.uploads[0].fail(error);
  await assert.rejects(upload.result, e => e === error);
  h.controls.throwUpload = error;
  const sync = h.api.startPreparedCheckInUpload("/saved/record.mp3", prepared); await assert.rejects(sync.result, e => e === error);
  assert.equal(h.deletes(), 0); assert.equal(h.calls.length, 0);
});
test("云服务拒绝与结构化失败只保留白名单 code 和固定文案", async () => {
  const secretMarker = "SYNTHETIC_PRIVATE_VALUE";
  const unsafeMessage = `https://example.test/audio?token=${secretMarker}`;
  const h = harness();
  h.controls.error = Object.assign(new Error(unsafeMessage), { code: `UNKNOWN_${secretMarker}` });
  await assert.rejects(h.api.commitCheckIn({ ...input, recordingFileId: "cloud://file" }), e =>
    e.code === "CHECK_IN_ERROR" && e.message === "云端服务暂时不可用，请稍后重试" && !JSON.stringify(e).includes(secretMarker));
  h.controls.error = Object.assign(new Error(unsafeMessage), { code: "ETIMEDOUT" });
  await assert.rejects(h.api.commitCheckIn({ ...input, recordingFileId: "cloud://file" }), e =>
    e.code === "ETIMEDOUT" && e.message === "网络请求超时，请稍后重试");
  h.controls.error = null;
  h.controls.response = { ok: false, code: "REQUEST_ID_CONFLICT", message: unsafeMessage };
  await assert.rejects(h.api.prepareCheckIn(input), e =>
    e.code === "REQUEST_ID_CONFLICT" && e.message === "分享请求不匹配，请重新进入后重试");
  h.controls.response = { ok: false, code: `UNKNOWN_${secretMarker}`, message: unsafeMessage };
  await assert.rejects(h.api.prepareCheckIn(input), e =>
    e.code === "CHECK_IN_ERROR" && e.message === "云端服务暂时不可用，请稍后重试");
  h.controls.response = { ok: true, data: { id: "legacy", shareToken: "token" } };
  await h.api.createCheckIn({ ...input, recordingFileId: "cloud://file" });
  assert.equal(h.calls.at(-1).data.action, "create");
  for (const name of ["getCheckInDetail", "listMyCheckIns", "removeCheckIn", "uploadCheckInRecording", "removeUploadedRecording"])
    assert.equal(typeof h.api[name], "function");
});
test("可读协议错误仅按白名单分类且不输出原始 code/message", async () => {
  const h = harness();
  const secretMarker = "SYNTHETIC_PRIVATE_VALUE";
  const error = Object.assign(new Error(`同一请求对应另一录音 ${secretMarker}`), { code: "REQUEST_ID_CONFLICT" });
  const readable = h.api.getReadableCloudError(error);
  assert.equal(readable, "分享请求不匹配，请重新进入后重试"); assert.doesNotMatch(readable, new RegExp(secretMarker));
  for (const fields of [{ errCode: 0, errno: 2, code: 3 }, { errno: 0, code: 3 }, { code: 0 }, { code: `UNKNOWN_${secretMarker}` }]) {
    const text = h.api.getReadableCloudError(Object.assign(new Error(`协议调用失败 ${secretMarker}`), fields));
    assert.equal(text, "操作失败，请稍后重试");
    assert.doesNotMatch(text, /错误码|SYNTHETIC_PRIVATE_VALUE/);
  }
});
(async () => { let failures = 0; for (const { name, run } of cases) {
  try { await run(); console.log(`PASS ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}: ${e.message}`); }
} assert.equal(failures, 0, `${failures}/${cases.length} 项服务契约失败`);
console.log(`客户端打卡服务测试通过：${cases.length} 组。`);
})().catch(e => { console.error(e.message); process.exitCode = 1; });
