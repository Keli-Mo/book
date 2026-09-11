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
      else options.success({ size: 1000, digest: "A".repeat(40) });
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
test("prepare/commit 保留快照、规范 requestId，不自动上传删除", async () => {
  const h = harness(); const before = plain(input);
  await h.api.prepareCheckIn(input);
  assert.equal(h.calls[0].data.action, "prepare"); assert.equal(h.calls[0].data.requestId, "a".repeat(32));
  assert.equal(h.calls[0].data.contentSha1, input.contentSha1); assert.equal(h.uploads.length, 0);
  await h.api.commitCheckIn({ ...input, recordingFileId: "cloud://test.bucket/checkins/path.mp3" });
  assert.equal(h.calls[1].data.action, "commit"); assert.equal(h.calls[1].data.recordingFileId, "cloud://test.bucket/checkins/path.mp3");
  assert.deepEqual(input, before); assert.equal(h.deletes(), 0);
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
test("上传失败、同步异常、commit 不确定均保留原始错误且不删文件", async () => {
  const h = harness(), prepared = { state: "upload-required", id: "id", cloudPath: "checkins/path.mp3" };
  const error = { errMsg: "uploadFile:fail timeout", code: "ETIMEDOUT" };
  const upload = h.api.startPreparedCheckInUpload("/saved/record.mp3", prepared); h.uploads[0].fail(error);
  await assert.rejects(upload.result, e => e === error);
  h.controls.throwUpload = error;
  const sync = h.api.startPreparedCheckInUpload("/saved/record.mp3", prepared); await assert.rejects(sync.result, e => e === error);
  h.controls.error = error; await assert.rejects(h.api.commitCheckIn({ ...input, recordingFileId: "cloud://file" }), e => e === error);
  assert.equal(h.deletes(), 0); assert.equal(h.calls.length, 1);
});
test("结构化服务错误 code/message 保留且旧服务导出兼容", async () => {
  const h = harness(); h.controls.response = { ok: false, code: "REQUEST_ID_CONFLICT", message: "同一请求对应另一录音" };
  await assert.rejects(h.api.prepareCheckIn(input), e => e.code === "REQUEST_ID_CONFLICT" && e.message === "同一请求对应另一录音");
  h.controls.response = { ok: true, data: { id: "legacy", shareToken: "token" } };
  await h.api.createCheckIn({ ...input, recordingFileId: "cloud://file" });
  assert.equal(h.calls.at(-1).data.action, "create");
  for (const name of ["getCheckInDetail", "listMyCheckIns", "removeCheckIn", "uploadCheckInRecording", "removeUploadedRecording"])
    assert.equal(typeof h.api[name], "function");
});
test("可读协议错误保留 Error.code，码优先级稳定且不丢 0", async () => {
  const h = harness();
  const error = Object.assign(new Error("同一请求对应另一录音"), { code: "REQUEST_ID_CONFLICT" });
  const readable = h.api.getReadableCloudError(error);
  assert.match(readable, /REQUEST_ID_CONFLICT/); assert.match(readable, /同一请求对应另一录音/);
  h.controls.response = { ok: false, code: "INVALID_FILE_ID", message: "录音路径不匹配" };
  await assert.rejects(h.api.prepareCheckIn(input), e => /INVALID_FILE_ID/.test(h.api.getReadableCloudError(e)));
  for (const message of ["协议调用失败", "uploadFile:fail"]) {
    for (const fields of [{ errCode: 0, errno: 2, code: 3 }, { errno: 0, code: 3 }, { code: 0 }]) {
      const text = h.api.getReadableCloudError(Object.assign(new Error(message), fields));
      assert.match(text, /错误码 0/); assert.match(text, new RegExp(message));
      assert.doesNotMatch(text, /错误码 [23]/);
    }
  }
});
(async () => { let failures = 0; for (const { name, run } of cases) {
  try { await run(); console.log(`PASS ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}: ${e.message}`); }
} assert.equal(failures, 0, `${failures}/${cases.length} 项服务契约失败`);
console.log(`客户端打卡服务测试通过：${cases.length} 组。`);
})().catch(e => { console.error(e.message); process.exitCode = 1; });
