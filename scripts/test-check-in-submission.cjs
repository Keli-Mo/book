/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const sourcePath = path.resolve(__dirname, "../src/features/listeningPractice/checkInSubmissionCoordinator.ts");
assert.equal(fs.existsSync(sourcePath), true, "弱网打卡提交协调器模块应存在");

const load = () => {
  const compiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const moduleContainer = { exports: {} };
  vm.runInNewContext(compiled.outputText, {
    module: moduleContainer, exports: moduleContainer.exports,
    Promise, Map, Set, Object, Array, Number, String, RegExp, Error,
  });
  return moduleContainer.exports;
};

const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((ok, bad) => { resolve = ok; reject = bad; });
  return { promise, resolve, reject };
};

const createScheduler = () => {
  let now = 0, nextId = 1;
  const tasks = new Map();
  return {
    setTimeout(callback, delay) { const id = nextId++; tasks.set(id, { at: now + delay, callback, delay }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    advance(ms) {
      now += ms;
      const due = [...tasks.entries()].filter(([, task]) => task.at <= now).sort((a, b) => a[1].at - b[1].at);
      due.forEach(([id, task]) => { tasks.delete(id); task.callback(); });
    },
    delays: () => [...tasks.values()].map(task => task.delay),
  };
};

const item = (patch = {}) => ({
  requestId: "abcdef0123456789abcdef0123456789",
  localPath: "/saved/record.mp3", recoverable: true,
  context: { bookId: "3", bookTitle: "CASA", practiceId: "3-page-4", practiceIndex: 0, pageNumber: 4, sectionTitle: "导入", imageUrl: "https://example.test/4.png" },
  durationMs: 3200.4, fileSizeBytes: 1800, cloudFileId: "", status: "local", updatedAtMs: 1,
  ...patch,
});

const networkError = Object.assign(new Error("network timeout"), { code: "ETIMEDOUT" });
const mismatchError = Object.assign(new Error("recording mismatch"), { code: "RECORDING_FILE_MISMATCH" });

function harness(overrides = {}) {
  const scheduler = createScheduler();
  const calls = [], uploads = [], progresses = [];
  const controls = {
    recordingInfo: { fileSizeBytes: 1800, contentSha1: "a".repeat(40) },
    prepared: { state: "upload-required", id: "server-id", cloudPath: "checkins/owner/request-hash.mp3" },
    uploadPlans: [], commitPlans: [{ id: "server-id", shareToken: "token" }],
    markUploadedResult: undefined, completeResult: true,
    ...overrides,
  };
  const values = new Map();
  const store = {
    async update(requestId, patch) { calls.push(["update", requestId, plain(patch)]); const current = values.get(requestId); if (!current) return null; const next = { ...current, ...patch }; values.set(requestId, next); return next; },
    async markUploaded(requestId, cloudFileId) {
      calls.push(["markUploaded", requestId, cloudFileId]);
      if (controls.markUploadedResult === null) return null;
      const current = values.get(requestId); if (!current) return null;
      const next = { ...current, cloudFileId, status: "uploaded" }; values.set(requestId, next); return next;
    },
    async markFailed(requestId) { calls.push(["markFailed", requestId]); const current = values.get(requestId); if (!current) return null; const next = { ...current, status: "failed" }; values.set(requestId, next); return next; },
    async complete(requestId, committed) { calls.push(["complete", requestId, committed]); return controls.completeResult; },
  };
  const api = {
    pendingStore: store,
    getRecordingInfo: async filePath => { calls.push(["info", filePath]); if (controls.infoError) throw controls.infoError; return controls.recordingInfo; },
    prepareCheckIn: async input => { calls.push(["prepare", plain(input)]); if (controls.prepareError) throw controls.prepareError; return controls.prepared; },
    startPreparedCheckInUpload: (filePath, prepared) => {
      calls.push(["upload", filePath, plain(prepared)]);
      const plan = controls.uploadPlans.shift() || { result: "cloud://test.bucket/checkins/fresh.mp3" };
      const task = {
        aborted: false,
        onProgressUpdate(listener) { task.progressListener = listener; },
        abort() { task.aborted = true; calls.push(["abort"]); },
      };
      const result = plan.promise || (plan.error ? Promise.reject(plan.error) : Promise.resolve(plan.result));
      uploads.push({ task, plan, filePath, prepared });
      return { task, result };
    },
    commitCheckIn: async input => {
      calls.push(["commit", plain(input)]);
      const plan = controls.commitPlans.shift();
      if (plan instanceof Error) throw plan;
      if (plan && plan.promise) return plan.promise;
      return plan || { id: "server-id", shareToken: "token" };
    },
    scheduler,
    clock: { now: () => 100 },
  };
  const { createCheckInSubmissionCoordinator } = load();
  const coordinator = createCheckInSubmissionCoordinator(api);
  const submit = (pending, extra = {}) => { values.set(pending.requestId, { ...pending }); return coordinator.submit(pending, { onProgress: value => progresses.push(plain(value)), ...extra }); };
  return { coordinator, submit, values, calls, uploads, progresses, controls, scheduler };
}

const cases = [];
const test = (name, run) => cases.push({ name, run });

test("实际文件指纹大小必须匹配且规范 request/snapshot 贯穿", async () => {
  const bad = harness({ recordingInfo: { fileSizeBytes: 1801, contentSha1: "a".repeat(40) } });
  const rejected = await bad.submit(item()).promise;
  assert.equal(rejected.state, "failed"); assert.equal(rejected.error.code, "RECORDING_SIZE_MISMATCH");
  assert.deepEqual(bad.calls.map(call => call[0]), ["info", "markFailed"]);

  const h = harness(); const result = await h.submit(item({ requestId: "ABCDEF0123456789ABCDEF0123456789" })).promise;
  assert.equal(result.state, "committed");
  assert.deepEqual(h.calls.map(call => call[0]), ["info", "prepare", "upload", "markUploaded", "update", "commit", "complete"]);
  assert.equal(h.calls[1][1].requestId, "abcdef0123456789abcdef0123456789");
  assert.equal(h.calls[1][1].contentSha1, "a".repeat(40)); assert.equal(h.calls[1][1].fileSizeBytes, 1800);
  assert.equal(h.calls[5][1].recordingFileId, "cloud://test.bucket/checkins/fresh.mp3");
});

test("prepare 已提交时只完成本地项，不上传也不 commit", async () => {
  const h = harness({ prepared: { state: "committed", id: "done", shareToken: "stable" } });
  const result = await h.submit(item()).promise;
  assert.deepEqual(plain(result), { state: "committed", id: "done", shareToken: "stable", cleanupPending: false });
  assert.deepEqual(h.calls.map(call => call[0]), ["info", "prepare", "complete"]);
});

test("重启恢复已有 cloudFileId 跳过上传并直接 commit", async () => {
  const h = harness(); const result = await h.submit(item({ cloudFileId: "cloud://test.bucket/checkins/old.mp3", status: "failed" })).promise;
  assert.equal(result.state, "committed");
  assert.deepEqual(h.calls.map(call => call[0]), ["info", "prepare", "update", "commit", "complete"]);
  assert.equal(h.calls[3][1].recordingFileId, "cloud://test.bucket/checkins/old.mp3");
});

test("callback UploadTask 进度归一化，成功先持久 fileID 再 creating/commit", async () => {
  const h = harness(); const handle = h.submit(item());
  await flush();
  h.uploads[0].task.progressListener({ progress: -10 }); h.uploads[0].task.progressListener({ progress: 140 });
  const result = await handle.promise;
  assert.equal(result.state, "committed");
  assert.deepEqual(h.progresses, [
    { requestId: item().requestId, percent: null, uncertain: true },
    { requestId: item().requestId, percent: 0, uncertain: false },
    { requestId: item().requestId, percent: 100, uncertain: false },
  ]);
  assert.deepEqual(h.calls.map(call => call[0]), ["info", "prepare", "upload", "markUploaded", "update", "commit", "complete"]);
  assert.deepEqual(h.calls[4][2], { status: "creating" });
});

test("上传空 fileID 或持久化失败不得 commit", async () => {
  for (const options of [{ uploadPlans: [{ result: "" }] }, { markUploadedResult: null }]) {
    const h = harness(options); const result = await h.submit(item()).promise;
    assert.equal(result.state, "failed"); assert.equal(h.calls.some(call => call[0] === "commit"), false);
    assert.equal(h.calls.at(-1)[0], "markFailed");
  }
});

test("网络上传严格按 1s/3s 重试且同路径，失败后其他请求仍可提交", async () => {
  const h = harness({ uploadPlans: [{ error: networkError }, { error: networkError }, { result: "cloud://test.bucket/checkins/final.mp3" }] });
  const first = h.submit(item()); await flush(); assert.deepEqual(h.scheduler.delays(), [1000]);
  h.scheduler.advance(999); await flush(); assert.equal(h.uploads.length, 1);
  h.scheduler.advance(1); await flush(); assert.deepEqual(h.scheduler.delays(), [3000]);
  h.scheduler.advance(3000); await flush(); const result = await first.promise;
  assert.equal(result.state, "committed"); assert.equal(h.uploads.length, 3);
  assert.deepEqual(h.uploads.map(upload => upload.prepared.cloudPath), ["checkins/owner/request-hash.mp3", "checkins/owner/request-hash.mp3", "checkins/owner/request-hash.mp3"]);

  const blocked = harness({ uploadPlans: [{ error: Object.assign(new Error("permission denied"), { code: "AUTH_DENIED" }) }] });
  assert.equal((await blocked.submit(item()).promise).state, "failed");
  const next = await blocked.submit(item({ requestId: "bbbbbb0123456789abcdef0123456789" })).promise;
  assert.equal(next.state, "committed"); assert.equal(blocked.uploads.length, 2);
});

test("同 requestId 去重；上传和退避期取消均不重试、不提交、不清理", async () => {
  const waiting = deferred(); const h = harness({ uploadPlans: [{ promise: waiting.promise }] });
  const a = h.submit(item()), b = h.submit(item()); assert.strictEqual(a, b);
  await flush(); assert.equal(a.cancel(), true); const cancelled = await a.promise;
  assert.equal(cancelled.state, "cancelled"); assert.equal(h.uploads[0].task.aborted, true);
  assert.deepEqual(h.calls.map(call => call[0]), ["info", "prepare", "upload", "abort", "markFailed"]);

  const backoff = harness({ uploadPlans: [{ error: networkError }] }); const retry = backoff.submit(item()); await flush();
  assert.deepEqual(backoff.scheduler.delays(), [1000]); assert.equal(retry.cancel(), true);
  backoff.scheduler.advance(5000); await flush(); const retried = await retry.promise;
  assert.equal(retried.state, "cancelled"); assert.equal(backoff.uploads.length, 1);
  assert.equal(backoff.calls.some(call => call[0] === "commit"), false);
});

test("commit 不确定保留 fileID；重启复用，明确文件不匹配只修复重传一次", async () => {
  const uncertain = harness({ commitPlans: [networkError] }); const first = await uncertain.submit(item()).promise;
  assert.equal(first.state, "failed"); assert.equal(uncertain.values.get(item().requestId).cloudFileId, "cloud://test.bucket/checkins/fresh.mp3");
  const recovered = await uncertain.submit(uncertain.values.get(item().requestId)).promise;
  assert.equal(recovered.state, "committed"); assert.equal(uncertain.uploads.length, 1, "重启不得重复上传");

  const h = harness({ commitPlans: [mismatchError, mismatchError] }); const result = await h.submit(item()).promise;
  assert.equal(result.state, "failed"); assert.equal(h.uploads.length, 2, "明确 mismatch 最多只重传一次");
  assert.equal(h.calls.filter(call => call[0] === "commit").length, 2);
  assert.deepEqual(h.calls.filter(call => call[0] === "update").map(call => call[2]), [
    { status: "creating" }, { cloudFileId: "", status: "local" }, { status: "creating" },
  ]);
});

test("complete 本地清理失败仍返回云端成功 cleanupPending，冲突/删除不换 requestId", async () => {
  const cleanup = harness({ completeResult: false }); const done = await cleanup.submit(item()).promise;
  assert.equal(done.state, "committed"); assert.equal(done.cleanupPending, true);

  for (const code of ["REQUEST_ID_CONFLICT", "REQUEST_DELETED"]) {
    const h = harness({ commitPlans: [Object.assign(new Error(code), { code })] }); const result = await h.submit(item()).promise;
    assert.equal(result.state, "failed"); assert.equal(h.uploads.length, 1); assert.equal(h.calls.filter(call => call[0] === "prepare")[0][1].requestId, item().requestId);
    assert.equal(h.calls.filter(call => call[0] === "update").some(call => call[2].cloudFileId === ""), false);
  }
});

(async () => {
  let failures = 0;
  for (const { name, run } of cases) {
    try { await run(); console.log(`PASS ${name}`); } catch (error) { failures += 1; console.error(`FAIL ${name}: ${error.message}`); }
  }
  assert.equal(failures, 0, `${failures}/${cases.length} 项提交协调器契约失败`);
  console.log(`弱网打卡提交协调器测试通过：${cases.length} 组。`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
