/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const source = fs.readFileSync(path.resolve(__dirname, "../src/features/listeningPractice/recordingSessionRecovery.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const context = { bookId: "book-a", bookTitle: "Book A", practiceId: "page-a", practiceIndex: 2,
  pageNumber: 24, imageUrl: "image-a", sectionTitle: "Review" };
const nativeResult = { tempFilePath: "/tmp/a.mp3", duration: 1200, fileSize: 4000 };
const oldSessionId = "a".repeat(32);
const flushPromises = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); };

const makeScheduler = () => {
  let now = 0;
  let nextId = 1;
  const tasks = new Map();
  return {
    setTimeout(callback, delay) { const id = nextId++; tasks.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    async advance(ms) {
      const target = now + ms;
      while (true) {
        const due = [...tasks.entries()].filter(([, task]) => task.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        now = due[1].at;
        tasks.delete(due[0]);
        due[1].callback();
        await flushPromises();
      }
      now = target;
      await flushPromises();
    },
  };
};

const scenario = (stage, {
  persisted = true, saveThrows = false, launch = true,
  coordinatorStatus = "none", coordinatorPhase = "idle",
} = {}) => {
  let entry = stage ? { version: 1, id: oldSessionId, stage, context, startedAtMs: 1,
    ...(stage === "terminal" ? { terminal: { tempFilePath: nativeResult.tempFilePath,
      durationMs: nativeResult.duration, fileSizeBytes: nativeResult.fileSize } } : {}) } : null;
  const calls = { clear: [], recordTerminal: [], saved: [], begin: [], retry: 0, stop: 0,
    abandon: 0, abandonArgs: [], diagnostics: [], removed: [] };
  const existingPending = { requestId: "b".repeat(32), localPath: "/safe/already-saved.mp3", recoverable: true };
  const pendingItems = [existingPending];
  const scheduler = makeScheduler();
  const journal = {
    read() { return entry; },
    clear(id) { calls.clear.push(id); if (entry?.id !== id) return false; entry = null; return true; },
    markAbandoned(id) { return entry?.id === id; },
    recordTerminal(id, result) { calls.recordTerminal.push({ id, result }); return entry?.id === id; },
  };
  let recovery = null;
  let recoveryStatus = coordinatorStatus;
  let phase = coordinatorPhase;
  const recoverResult = async (result) => {
    if (!recovery) return false;
    recoveryStatus = "saving";
    const saved = await recovery.recover(result);
    if (saved) { recovery = null; recoveryStatus = "none"; }
    else recoveryStatus = "failed";
    return saved;
  };
  const coordinator = {
    beginEntryRecovery(options) { calls.begin.push(options); recovery = options; recoveryStatus = "waiting"; phase = "uncertain"; return true; },
    retryEntryRecovery() {
      calls.retry += 1;
      if (recovery?.terminalResult) return recoverResult(recovery.terminalResult);
      calls.stop += 1;
      return Promise.resolve(false);
    },
    abandonUnconfirmedRecording(options) {
      calls.abandon += 1;
      calls.abandonArgs.push(options);
      recovery = null;
      recoveryStatus = "none";
      phase = "draining";
      return true;
    },
    getEntryRecoveryStatus() { return recoveryStatus; },
    getPhase() { return phase; },
    emitStop: recoverResult,
  };
  const store = {
    async saveRecording(input) {
      calls.saved.push(input);
      if (saveThrows) throw new Error("save failed");
      const item = { requestId: input.recordingSessionId, localPath: input.tempFilePath,
        recoverable: persisted };
      if (!persisted) pendingItems.push(item);
      return { item, persisted };
    },
    list() { return pendingItems; },
    async remove(id) {
      calls.removed.push(id);
      const index = pendingItems.findIndex((item) => item.requestId === id);
      if (index >= 0) pendingItems.splice(index, 1);
      return index >= 0;
    },
  };
  const parser = (result) => result && result.tempFilePath && result.duration >= 500 && result.fileSize > 0
    ? { ok: true, tempFilePath: result.tempFilePath, durationMs: result.duration, fileSizeBytes: result.fileSize }
    : { ok: false };
  const dependencies = {
    "@/features/listeningPractice/pendingCheckInRuntime": { getPendingCheckInStore: () => store,
      logRecordingDiagnostic: (...values) => calls.diagnostics.push(values) },
    "@/features/listeningPractice/recordingInteraction": { parseNativeRecordingResult: parser },
    "@/features/listeningPractice/recorderCoordinator": { getRecorderCoordinator: () => coordinator },
    "@/features/listeningPractice/recordingSessionJournal": { getRecordingSessionJournal: () => journal },
  };
  const moduleContainer = { exports: {} };
  new Function("require", "module", "exports", "setTimeout", "clearTimeout", compiled)(
    (name) => { assert.ok(dependencies[name], `unexpected dependency ${name}`); return dependencies[name]; },
    moduleContainer, moduleContainer.exports, scheduler.setTimeout, scheduler.clearTimeout,
  );
  if (launch) moduleContainer.exports.resumeUnfinishedRecordingOnLaunch();
  else moduleContainer.exports.scheduleExitedRecordingSettlement(oldSessionId);
  return {
    calls, scheduler, coordinator, pendingItems, existingPending,
    replaceJournal(id, nextStage = "confirmed") { entry = id ? { version: 1, id, stage: nextStage, context, startedAtMs: 2 } : null; },
    readJournal() { return entry; },
  };
};

(async () => {
  const terminal = scenario("terminal");
  await flushPromises();
  assert.equal(terminal.calls.begin.length, 1);
  assert.equal(terminal.calls.retry, 1, "已有 onStop 文件应在冷启动时自动尝试保存");
  assert.equal(terminal.calls.stop, 0, "已有结束结果无需再次 stop");
  assert.deepEqual(terminal.calls.saved[0], { tempFilePath: nativeResult.tempFilePath,
    durationMs: nativeResult.duration, fileSizeBytes: nativeResult.fileSize, context,
    recordingSessionId: oldSessionId });
  assert.deepEqual(terminal.calls.clear, [oldSessionId]);
  assert.equal(terminal.calls.abandon, 0, "已保存的旧录音不得放弃");
  assert.deepEqual(terminal.calls.removed, []);

  const confirmed = scenario("confirmed");
  await flushPromises();
  assert.equal(confirmed.calls.begin.length, 1);
  assert.equal(confirmed.calls.retry, 1, "已确认开始的旧录音应自动请求结束");
  assert.equal(confirmed.calls.stop, 1);
  assert.equal(confirmed.calls.saved.length, 0, "无 onStop 时不能伪造音频文件");
  await confirmed.scheduler.advance(3000);
  assert.equal(confirmed.calls.abandon, 1, "无结束回调时应短时自动放弃，不能一直占用录音器");
  assert.deepEqual(confirmed.calls.clear, [oldSessionId]);
  assert.equal(confirmed.pendingItems[0], confirmed.existingPending, "不能删除已安全保存的其他录音");

  const confirmedWithStop = scenario("confirmed");
  await flushPromises();
  assert.equal(await confirmedWithStop.coordinator.emitStop(nativeResult), true);
  await flushPromises();
  assert.equal(confirmedWithStop.calls.saved.length, 1, "短时内收到结果应保存到原页");
  assert.equal(confirmedWithStop.calls.saved[0].context.practiceId, "page-a");
  assert.equal(confirmedWithStop.calls.recordTerminal.length, 1);
  await confirmedWithStop.scheduler.advance(3000);
  assert.equal(confirmedWithStop.calls.abandon, 0, "已保存的结果不能被超时任务再放弃");

  const starting = scenario("starting");
  await flushPromises();
  await starting.scheduler.advance(3000);
  assert.equal(starting.calls.saved.length, 0, "未收到 onStart 的结果不得归属到原页或新页");
  assert.equal(starting.calls.abandon, 1, "未确认开始的旧会话应自动放弃");
  assert.deepEqual(starting.calls.clear, [oldSessionId]);

  const failed = scenario("terminal", { persisted: false });
  await flushPromises();
  await failed.scheduler.advance(3000);
  assert.equal(failed.calls.saved.length, 1);
  assert.equal(failed.calls.abandon, 1, "本地持久化失败时应放弃旧会话并解锁");
  assert.deepEqual(failed.calls.clear, [oldSessionId]);
  assert.deepEqual(failed.calls.removed, [oldSessionId], "失败的临时录音不应留下待完成项");
  assert.deepEqual(failed.pendingItems, [failed.existingPending], "不能清理已安全保存的录音");

  const rejected = scenario("terminal", { saveThrows: true });
  await flushPromises();
  assert.equal(rejected.calls.saved.length, 1);
  assert.equal(rejected.calls.abandon, 1, "保存 API 抛错后也应自动放弃并解锁");
  assert.deepEqual(rejected.calls.clear, [oldSessionId]);
  assert.deepEqual(rejected.pendingItems, [rejected.existingPending]);

  const abandoned = scenario("abandoned");
  await flushPromises();
  assert.equal(abandoned.calls.begin.length, 0);
  assert.deepEqual(abandoned.calls.clear, [oldSessionId]);
  assert.deepEqual(abandoned.pendingItems, [abandoned.existingPending]);

  const exitedWithoutStop = scenario("confirmed", { launch: false, coordinatorPhase: "draining" });
  await exitedWithoutStop.scheduler.advance(1499);
  assert.equal(exitedWithoutStop.calls.abandon, 0, "结束回调仍有短暂保存机会");
  await exitedWithoutStop.scheduler.advance(1);
  assert.equal(exitedWithoutStop.calls.abandon, 1, "退出后无 onStop 应在 1.5 秒自动放弃");
  assert.deepEqual(exitedWithoutStop.calls.clear, [oldSessionId]);
  assert.equal(exitedWithoutStop.readJournal(), null);

  const exitedWhileSaving = scenario("terminal", { launch: false,
    coordinatorStatus: "saving", coordinatorPhase: "draining" });
  await exitedWhileSaving.scheduler.advance(1500);
  assert.equal(exitedWhileSaving.calls.abandon, 0, "已拿到文件且保存中不能在 1.5 秒时丢弃");
  assert.deepEqual(exitedWhileSaving.calls.clear, []);
  await exitedWhileSaving.scheduler.advance(16999);
  assert.equal(exitedWhileSaving.calls.abandon, 0, "保存上限之前仍应保护临时文件");
  await exitedWhileSaving.scheduler.advance(1);
  assert.equal(exitedWhileSaving.calls.abandon, 1, "保存超过 17 秒也须自动放弃并恢复录音器");
  assert.equal(exitedWhileSaving.calls.abandonArgs[0]?.force, true,
    "保存超时须撤销可能仍挂起的旧回调和保存锁");
  assert.deepEqual(exitedWhileSaving.calls.clear, [oldSessionId]);

  const savedBeforeDeadline = scenario("terminal", { launch: false,
    coordinatorStatus: "saving", coordinatorPhase: "draining" });
  await savedBeforeDeadline.scheduler.advance(1500);
  savedBeforeDeadline.replaceJournal(null);
  await savedBeforeDeadline.scheduler.advance(17000);
  assert.equal(savedBeforeDeadline.calls.abandon, 0, "文件已安全保存后不得被超时任务放弃");

  const oldTimer = scenario("confirmed", { launch: false, coordinatorPhase: "draining" });
  oldTimer.replaceJournal(null);
  await oldTimer.scheduler.advance(1500);
  assert.equal(oldTimer.calls.abandon, 0, "旧 journal 已清理时不能再操作录音器");
  assert.deepEqual(oldTimer.calls.clear, []);

  const newerSession = scenario("confirmed", { launch: false, coordinatorPhase: "draining" });
  const newSessionId = "c".repeat(32);
  newerSession.replaceJournal(newSessionId);
  await newerSession.scheduler.advance(1500);
  assert.equal(newerSession.calls.abandon, 0, "旧退出定时器不能放弃新会话");
  assert.deepEqual(newerSession.calls.clear, []);
  assert.equal(newerSession.readJournal()?.id, newSessionId);

  const practiceSource = fs.readFileSync(path.resolve(__dirname, "../src/pages/Practice/PracticeSession.tsx"), "utf8");
  assert.match(practiceSource, /saveRecording\s*\(\s*\{[\s\S]{0,250}?recordingSessionId:\s*sessionId/,
    "normal stop must save with the same session ID used by cold-start recovery");
  console.log("startup recording auto recovery tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
