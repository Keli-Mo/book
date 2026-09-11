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
    markUploaded(requestId, cloudFileId) {
      calls.push(["markUploaded", requestId, cloudFileId]);
      const plan = controls.markUploadedPlans?.shift();
      if (plan?.throw) throw plan.throw;
      if (plan?.reject) return Promise.reject(plan.reject);
      if (plan?.promise) return plan.promise;
      if (controls.markUploadedResult === null) return null;
      const current = values.get(requestId); if (!current) return null;
      const next = { ...current, cloudFileId, status: "uploaded" }; values.set(requestId, next); return next;
    },
    async markFailed(requestId) { calls.push(["markFailed", requestId]); const current = values.get(requestId); if (!current) return null; const next = { ...current, status: "failed" }; values.set(requestId, next); return next; },
    async complete(requestId, committed) { calls.push(["complete", requestId, committed]); return controls.completeResult; },
  };
  const api = {
    pendingStore: store,
    getRecordingInfo: async filePath => { calls.push(["info", filePath]); if (controls.infoError) throw controls.infoError; if (controls.infoPromise) return controls.infoPromise; return controls.recordingInfo; },
    prepareCheckIn: async input => { calls.push(["prepare", plain(input)]); if (controls.prepareError) throw controls.prepareError; if (controls.preparePromise) return controls.preparePromise; return controls.prepared; },
    startPreparedCheckInUpload: (filePath, prepared) => {
      calls.push(["upload", filePath, plain(prepared)]);
      const plan = controls.uploadPlans.shift() || { result: "cloud://test.bucket/checkins/fresh.mp3" };
      if (plan.throw) throw plan.throw;
      const task = {
        aborted: false,
        onProgressUpdate(listener) { task.progressListener = listener; if (plan.progressError) throw plan.progressError; },
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

test("指纹阶段离页可取消，返回后不得继续 prepare 或上传", async () => {
  const info = deferred(); const h = harness({ infoPromise: info.promise });
  const handle = h.submit(item());
  assert.equal(handle.cancel(), true);
  info.resolve({ fileSizeBytes: 1800, contentSha1: "a".repeat(40) });
  const result = await handle.promise;
  assert.equal(result.state, "cancelled");
  assert.deepEqual(h.calls.map(call => call[0]), ["info", "markFailed"]);
  assert.equal(h.values.get(item().requestId).localPath, item().localPath, "取消后必须保留本地录音");
});

test("prepare 阶段离页可取消，upload-required 返回后不得启动后续链路", async () => {
  const prepare = deferred(); const h = harness({ preparePromise: prepare.promise });
  const handle = h.submit(item()); await flush();
  assert.equal(handle.cancel(), true);
  prepare.resolve({ state: "upload-required", id: "server-id", cloudPath: "checkins/owner/request-hash.mp3" });
  const result = await handle.promise;
  assert.equal(result.state, "cancelled");
  assert.deepEqual(h.calls.map(call => call[0]), ["info", "prepare", "markFailed"]);
  assert.equal(h.values.get(item().requestId).localPath, item().localPath, "取消后必须保留本地录音");
});

test("prepare 阶段虽已请求取消，服务端若已提交仍如实报告 committed", async () => {
  const prepare = deferred(); const h = harness({ preparePromise: prepare.promise });
  const handle = h.submit(item()); await flush();
  assert.equal(handle.cancel(), true);
  prepare.resolve({ state: "committed", id: "done", shareToken: "stable" });
  assert.deepEqual(plain(await handle.promise), { state: "committed", id: "done", shareToken: "stable", cleanupPending: false });
  assert.deepEqual(h.calls.map(call => call[0]), ["info", "prepare", "complete"]);
});

test("重启恢复已有 cloudFileId 跳过上传并直接 commit", async () => {
  const h = harness(); const result = await h.submit(item({ cloudFileId: "cloud://test.bucket/checkins/old.mp3", status: "failed" })).promise;
  assert.equal(result.state, "committed");
  assert.deepEqual(h.calls.map(call => call[0]), ["info", "prepare", "update", "commit", "complete"]);
  assert.equal(h.calls[3][1].recordingFileId, "cloud://test.bucket/checkins/old.mp3");
});

test("callback UploadTask 进度归一化，成功先持久 fileID 再 creating/commit", async () => {
  const uploadResult = deferred(); const h = harness({ uploadPlans: [{ promise: uploadResult.promise }] }); const handle = h.submit(item());
  await flush();
  h.uploads[0].task.progressListener({ progress: -10 }); h.uploads[0].task.progressListener({ progress: 140 });
  uploadResult.resolve("cloud://test.bucket/checkins/fresh.mp3");
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

test("首次进度回调内同步取消时不启动上传且结算 cancelled", async () => {
  const h = harness();
  let handle;
  let cancelResult;
  handle = h.submit(item(), {
    onProgress: () => { cancelResult = handle.cancel(); },
  });
  const result = await handle.promise;
  assert.equal(cancelResult, true);
  assert.equal(result.state, "cancelled");
  assert.equal(h.uploads.length, 0, "取消成功后不得再启动上传");
  assert.deepEqual(h.calls.map(call => call[0]), ["info", "prepare", "markFailed"]);
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

test("缺失的旧云录音会清空 fileID，并且只重传一次", async () => {
  for (const missing of [
    Object.assign(new Error("微信云存储文件不存在"), { errCode: -503003 }),
    Object.assign(new Error("FILE_NOT_FOUND"), { code: "FILE_NOT_FOUND" }),
    Object.assign(new Error("STORAGE_FILE_NONEXIST"), { code: "STORAGE_FILE_NONEXIST" }),
  ]) {
    const h = harness({ commitPlans: [missing, { id: "server-id", shareToken: "token" }] });
    const result = await h.submit(item({ cloudFileId: "cloud://test.bucket/checkins/missing.mp3", status: "failed" })).promise;
    assert.equal(result.state, "committed");
    assert.equal(h.uploads.length, 1, `${missing.errCode ?? missing.code} 只能触发一次重传`);
    assert.equal(h.calls.filter(call => call[0] === "commit").length, 2);
    assert.deepEqual(h.calls.filter(call => call[0] === "update").map(call => call[2]), [
      { status: "creating" }, { cloudFileId: "", status: "local" }, { status: "creating" },
    ]);
  }
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

test("upload 已成功进入 markUploaded 门闩后不可取消，且仍只提交一次", async () => {
  const gate = deferred(); const h = harness({ markUploadedPlans: [{ promise: gate.promise }] });
  const handle = h.submit(item()); await flush(); await flush();
  assert.equal(h.calls.at(-1)[0], "markUploaded");
  assert.equal(handle.cancel(), false, "fileID 已返回后进入持久化门闩，不得谎称取消成功");
  gate.resolve({ ...item(), cloudFileId: "cloud://test.bucket/checkins/fresh.mp3", status: "uploaded" });
  const result = await handle.promise;
  assert.equal(result.state, "committed");
  assert.equal(h.calls.filter(call => call[0] === "commit").length, 1);
  assert.equal(h.calls.filter(call => call[0] === "complete").length, 1);
});

test("markUploaded 的 null、同步 throw 与异步 reject 均不触发上传重试", async () => {
  for (const [plan, expected] of [
    [{ markUploadedResult: null }, "PENDING_PERSIST_FAILED"],
    [{ markUploadedPlans: [{ throw: networkError }] }, networkError],
    [{ markUploadedPlans: [{ reject: networkError }] }, networkError],
  ]) {
    const h = harness(plan); const handle = h.submit(item()); await flush();
    assert.deepEqual(h.scheduler.delays(), [], "持久化错误不得进入上传退避");
    const result = await handle.promise;
    assert.equal(result.state, "failed");
    if (typeof expected === "string") assert.equal(result.error.code, expected);
    else assert.strictEqual(result.error, expected, "原始持久化错误必须保留");
    assert.equal(h.calls.filter(call => call[0] === "upload").length, 1);
    assert.equal(h.calls.some(call => call[0] === "commit"), false);
  }
});

test("同步 start throw 走上传重试；进度订阅 throw 不丢 result 或泄漏 rejection", async () => {
  const retry = harness({ uploadPlans: [{ throw: networkError }, { result: "cloud://test.bucket/checkins/ok.mp3" }] });
  const handle = retry.submit(item()); await flush(); assert.deepEqual(retry.scheduler.delays(), [1000]);
  retry.scheduler.advance(1000); await flush(); assert.equal((await handle.promise).state, "committed");
  assert.equal(retry.calls.filter(call => call[0] === "upload").length, 2);

  const unhandled = []; const listener = error => unhandled.push(error); process.on("unhandledRejection", listener);
  try {
    const resolved = harness({ uploadPlans: [{ progressError: new Error("progress unavailable"), result: "cloud://test.bucket/checkins/ok.mp3" }] });
    assert.equal((await resolved.submit(item()).promise).state, "committed");
    const rejected = harness({ uploadPlans: [{ progressError: new Error("progress unavailable"), error: networkError }, { result: "cloud://test.bucket/checkins/ok.mp3" }] });
    const pending = rejected.submit(item()); await flush(); assert.deepEqual(rejected.scheduler.delays(), [1000]);
    rejected.scheduler.advance(1000); await flush(); assert.equal((await pending.promise).state, "committed");
    await flush(); assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", listener);
  }
});

test("非法与迟到的 UploadTask progress 保持不确定，不能污染新尝试、取消或完成后的页面", async () => {
  const firstResult = deferred(), secondResult = deferred();
  const h = harness({ uploadPlans: [{ promise: firstResult.promise }, { promise: secondResult.promise }] });
  const handle = h.submit(item()); await flush(); const first = h.uploads[0].task;
  first.progressListener({ progress: undefined }); first.progressListener({ progress: Number.NaN }); first.progressListener({ progress: "30" });
  assert.deepEqual(h.progresses.slice(-3), Array.from({ length: 3 }, () => ({ requestId: item().requestId, percent: null, uncertain: true })));
  firstResult.reject(networkError); await flush(); h.scheduler.advance(1000); await flush(); const second = h.uploads[1].task;
  const countBeforeStale = h.progresses.length; first.progressListener({ progress: 33 });
  assert.equal(h.progresses.length, countBeforeStale, "旧 attempt 事件不得写入当前 UI");
  second.progressListener({ progress: 120 }); assert.deepEqual(h.progresses.at(-1), { requestId: item().requestId, percent: 100, uncertain: false });
  secondResult.resolve("cloud://test.bucket/checkins/ok.mp3");
  assert.equal((await handle.promise).state, "committed"); const terminalCount = h.progresses.length;
  second.progressListener({ progress: 40 }); assert.equal(h.progresses.length, terminalCount, "完成后迟到事件必须静默");

  const waiting = deferred(); const cancelled = harness({ uploadPlans: [{ promise: waiting.promise }] });
  const cancelledHandle = cancelled.submit(item()); await flush(); const task = cancelled.uploads[0].task;
  assert.equal(cancelledHandle.cancel(), true); await cancelledHandle.promise; const cancelCount = cancelled.progresses.length;
  task.progressListener({ progress: 50 }); assert.equal(cancelled.progresses.length, cancelCount, "取消后迟到事件必须静默");
});

(async () => {
  let failures = 0;
  for (const { name, run } of cases) {
    try { await run(); console.log(`PASS ${name}`); } catch (error) { failures += 1; console.error(`FAIL ${name}: ${error.message}`); }
  }
  assert.equal(failures, 0, `${failures}/${cases.length} 项提交协调器契约失败`);
  console.log(`弱网打卡提交协调器测试通过：${cases.length} 组。`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
