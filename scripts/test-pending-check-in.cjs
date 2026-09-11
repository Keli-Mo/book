const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const sourcePath = path.resolve(
  __dirname,
  "../src/features/listeningPractice/pendingCheckInStore.ts",
);
assert.equal(fs.existsSync(sourcePath), true, "待上传录音仓储模块应存在");

const compiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
});
const moduleContainer = { exports: {} };
vm.runInNewContext(compiled.outputText, {
  module: moduleContainer,
  exports: moduleContainer.exports,
  Promise,
  Set,
  Map,
  Object,
  Array,
  Number,
  String,
  RegExp,
});

const {
  DAY_MS,
  MAX_PENDING_FILE_BYTES,
  RETENTION_MS,
  createPendingCheckInStore,
} = moduleContainer.exports;

const MIB = 1024 * 1024;
const hex = (value) => value.toString(16).padStart(32, "0");
const context = {
  bookId: "3",
  bookTitle: "CASA 阅读与自然拼读 1",
  practiceId: "3-page-5",
  practiceIndex: 4,
  pageNumber: 5,
  imageUrl: "https://example.com/book_5.png",
  sectionTitle: "Unit 1",
};

const createAdapters = ({
  now = 1_800_000_000_000,
  records = [],
  saveBehavior,
  storageSetBehavior,
  existingPaths,
  removeBehavior,
} = {}) => {
  let savedRecords = JSON.parse(JSON.stringify(records));
  const calls = { save: [], remove: [], set: 0 };
  let savedFileSequence = 1;
  let requestIdSequence = 1;
  const existing = new Set(existingPaths || records.map((item) => item.localPath));
  const adapters = {
    storage: {
      async get() {
        return JSON.parse(JSON.stringify(savedRecords));
      },
      async set(_key, nextRecords) {
        calls.set += 1;
        if (storageSetBehavior) await storageSetBehavior(nextRecords, calls.set);
        savedRecords = JSON.parse(JSON.stringify(nextRecords));
      },
    },
    file: {
      async save(tempPath) {
        calls.save.push(tempPath);
        if (saveBehavior) return saveBehavior(tempPath, calls.save.length);
        const savedFilePath = `/saved/${savedFileSequence}.mp3`;
        savedFileSequence += 1;
        existing.delete(tempPath);
        existing.add(savedFilePath);
        return { savedFilePath };
      },
      async exists(filePath) {
        return existing.has(filePath);
      },
      async remove(filePath) {
        calls.remove.push(filePath);
        if (removeBehavior) await removeBehavior(filePath, calls.remove.length);
        existing.delete(filePath);
      },
    },
    clock: { now: () => now },
    random: { hex: () => hex(requestIdSequence++) },
  };
  return { adapters, calls, getRecords: () => savedRecords, existing };
};

const recording = (overrides = {}) => ({
  tempFilePath: "/tmp/current.mp3",
  context,
  durationMs: 300_000,
  fileSizeBytes: 2 * MIB,
  ...overrides,
});

const pending = (overrides = {}) => ({
  requestId: hex(99),
  localPath: "/saved/existing.mp3",
  recoverable: true,
  context,
  durationMs: 300_000,
  fileSizeBytes: MIB,
  cloudFileId: "",
  status: "local",
  updatedAtMs: 1_800_000_000_000,
  ...overrides,
});

const createBarrier = () => {
  let release;
  let entered;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const enteredPromise = new Promise((resolve) => {
    entered = resolve;
  });
  return { wait, release, entered, enteredPromise };
};

(async () => {
  assert.equal(MAX_PENDING_FILE_BYTES, 8 * MIB, "持久队列容量应为 8MiB");
  assert.equal(RETENTION_MS, 7 * DAY_MS, "待上传录音应保留 7 天");

  const pathSwitch = createAdapters({ existingPaths: ["/tmp/current.mp3"] });
  const store = createPendingCheckInStore(pathSwitch.adapters);
  const saved = await store.saveRecording(recording());
  assert.equal(saved.persisted, true);
  assert.equal(saved.item.recoverable, true);
  assert.equal(saved.item.localPath, "/saved/1.mp3", "保存后只能使用 savedFilePath");
  assert.equal(pathSwitch.calls.save[0], "/tmp/current.mp3");
  assert.equal(pathSwitch.existing.has("/tmp/current.mp3"), false, "临时路径已移动失效");
  assert.match(saved.item.requestId, /^[0-9a-f]{32}$/i);
  assert.equal(saved.item.durationMs, 300_000, "时长应沿用原生值");
  assert.equal(saved.item.fileSizeBytes, 2 * MIB, "文件大小应沿用原生值");
  assert.equal(Object.isFrozen(saved.item), true, "返回项应不可变");
  assert.equal(Object.isFrozen(store.list()), true, "列表应不可变");
  assert.throws(
    () => store.list().push(saved.item),
    /object is not extensible|read only|readonly/i,
    "调用方不得修改列表",
  );

  const decimalDuration = createAdapters({ existingPaths: ["/tmp/decimal.mp3"] });
  const decimalStore = createPendingCheckInStore(decimalDuration.adapters);
  const decimalSaved = await decimalStore.saveRecording(
    recording({ tempFilePath: "/tmp/decimal.mp3", durationMs: 3200.4 }),
  );
  assert.equal(decimalSaved.persisted, true);
  assert.equal(decimalSaved.item.durationMs, 3200.4, "原生小数时长必须原样保留");

  await assert.rejects(
    () => store.saveRecording(recording({ durationMs: 0 })),
    /durationMs/,
    "无效原生时长不得以 JS 估算替代",
  );
  await assert.rejects(
    () => store.saveRecording(recording({ fileSizeBytes: Number.POSITIVE_INFINITY })),
    /fileSizeBytes/,
    "非有限原生文件大小必须拒绝",
  );

  const exactCapacity = createAdapters({ existingPaths: ["/tmp/exact.mp3"] });
  const exactStore = createPendingCheckInStore(exactCapacity.adapters);
  const exact = await exactStore.saveRecording(
    recording({ tempFilePath: "/tmp/exact.mp3", fileSizeBytes: 8 * MIB }),
  );
  assert.equal(exact.persisted, true, "恰好 8MiB 应允许保存");
  const over = await exactStore.saveRecording(
    recording({ tempFilePath: "/tmp/over.mp3", fileSizeBytes: 1 }),
  );
  assert.equal(over.persisted, false);
  assert.equal(over.item.recoverable, false);
  assert.match(over.message, /清理历史录音或联网提交/);
  assert.equal(exactCapacity.calls.save.length, 1, "预判容量超限不得移动临时文件");

  const countBoundary = createAdapters({
    records: [pending({ requestId: hex(1) }), pending({ requestId: hex(2) }), pending({ requestId: hex(3) })],
    existingPaths: ["/saved/existing.mp3"],
  });
  countBoundary.adapters.random.hex = () => hex(4);
  const countStore = createPendingCheckInStore(countBoundary.adapters);
  const countOver = await countStore.saveRecording(recording({ fileSizeBytes: 1 }));
  assert.equal(countOver.persisted, false, "第三条之后不得再持久保存");
  assert.match(countOver.message, /最多 3 条/);

  const cleanupNow = 1_900_000_000_000;
  const cleanup = createAdapters({
    now: cleanupNow,
    records: [
      pending({ requestId: hex(11), updatedAtMs: cleanupNow - RETENTION_MS, localPath: "/saved/expired.mp3" }),
      pending({ requestId: hex(12), updatedAtMs: cleanupNow - RETENTION_MS + 1, localPath: "/saved/fresh.mp3" }),
      pending({ requestId: hex(13), localPath: "/saved/missing.mp3" }),
    ],
    existingPaths: ["/saved/expired.mp3", "/saved/fresh.mp3", "/tmp/clean.mp3"],
  });
  const cleanupStore = createPendingCheckInStore(cleanup.adapters);
  const cleaned = await cleanupStore.saveRecording(recording({ tempFilePath: "/tmp/clean.mp3", fileSizeBytes: 1 }));
  assert.equal(cleaned.persisted, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(cleanupStore.list().map((item) => item.requestId))),
    [hex(12), cleaned.item.requestId],
    "满 7 天与丢失文件项应清理，差 1ms 的项应保留",
  );

  const removeFails = createAdapters({
    now: cleanupNow,
    records: [pending({ requestId: hex(21), updatedAtMs: cleanupNow - RETENTION_MS, localPath: "/saved/cannot-remove.mp3" })],
    existingPaths: ["/saved/cannot-remove.mp3", "/tmp/failure.mp3"],
    removeBehavior: async () => {
      throw new Error("remove failed");
    },
  });
  const failureStore = createPendingCheckInStore(removeFails.adapters);
  await failureStore.cleanup();
  assert.equal(failureStore.list().length, 1, "删除失败必须保留记录供后续重试");

  const saveFails = createAdapters({
    saveBehavior: async () => {
      throw new Error("save failed");
    },
  });
  const saveFailStore = createPendingCheckInStore(saveFails.adapters);
  const temporary = await saveFailStore.saveRecording(recording());
  assert.equal(temporary.persisted, false);
  assert.equal(temporary.item.recoverable, false);
  assert.equal(temporary.item.localPath, "/tmp/current.mp3");

  const metadataFails = createAdapters({
    existingPaths: ["/tmp/metadata-fail.mp3"],
    storageSetBehavior: async () => {
      throw new Error("storage write failed");
    },
  });
  const metadataFailStore = createPendingCheckInStore(metadataFails.adapters);
  const metadataFailure = await metadataFailStore.saveRecording(
    recording({ tempFilePath: "/tmp/metadata-fail.mp3" }),
  );
  assert.equal(metadataFailure.persisted, false);
  assert.equal(
    metadataFailure.item.localPath,
    "/saved/1.mp3",
    "saveFile 已成功时，即使元数据写入失败也不得回退到临时路径",
  );
  assert.equal(
    metadataFailure.item.requestId,
    hex(1),
    "元数据失败的会话项必须保留已生成的同一 requestId",
  );
  assert.equal(metadataFailure.item.recoverable, false);
  assert.equal(await metadataFailStore.complete(metadataFailure.item.requestId, true), true);
  assert.deepEqual(metadataFails.calls.remove, ["/saved/1.mp3"]);

  const duplicatePersisted = createAdapters({
    records: [pending({ requestId: hex(1) })],
    existingPaths: ["/saved/existing.mp3", "/tmp/duplicate-persisted.mp3"],
  });
  duplicatePersisted.adapters.random.hex = (() => {
    const values = [hex(1), hex(2)];
    return () => values.shift();
  })();
  const duplicatePersistedStore = createPendingCheckInStore(duplicatePersisted.adapters);
  const persistedDuplicateSaved = await duplicatePersistedStore.saveRecording(
    recording({ tempFilePath: "/tmp/duplicate-persisted.mp3", fileSizeBytes: 1 }),
  );
  assert.equal(persistedDuplicateSaved.item.requestId, hex(2), "持久项重复 ID 应有限重试");

  let temporarySaveCount = 0;
  const duplicateTemporary = createAdapters({
    saveBehavior: async () => {
      temporarySaveCount += 1;
      if (temporarySaveCount === 1) throw new Error("save failed");
      return { savedFilePath: "/saved/duplicate-temporary.mp3" };
    },
  });
  duplicateTemporary.adapters.random.hex = (() => {
    const values = [hex(31), hex(31), hex(32)];
    return () => values.shift();
  })();
  const duplicateTemporaryStore = createPendingCheckInStore(duplicateTemporary.adapters);
  const temporaryDuplicate = await duplicateTemporaryStore.saveRecording(recording());
  assert.equal(temporaryDuplicate.item.requestId, hex(31));
  const temporaryDuplicateSaved = await duplicateTemporaryStore.saveRecording(
    recording({ tempFilePath: "/tmp/duplicate-temporary-2.mp3" }),
  );
  assert.equal(temporaryDuplicateSaved.item.requestId, hex(32), "会话项重复 ID 应有限重试");

  let quotaSaves = 0;
  const quotaRetry = createAdapters({
    saveBehavior: async () => {
      quotaSaves += 1;
      if (quotaSaves === 1) {
        const error = new Error("storage quota full");
        error.code = "QUOTA_EXCEEDED";
        throw error;
      }
      return { savedFilePath: "/saved/retry.mp3" };
    },
  });
  const quotaStore = createPendingCheckInStore(quotaRetry.adapters);
  const quotaSaved = await quotaStore.saveRecording(recording());
  assert.equal(quotaSaved.persisted, true, "配额失败清理后只能重试一次且可成功");
  assert.equal(quotaSaves, 2);

  const lifecycle = createAdapters({ existingPaths: ["/tmp/lifecycle.mp3"] });
  const lifecycleStore = createPendingCheckInStore(lifecycle.adapters);
  const lifecycleSaved = await lifecycleStore.saveRecording(recording({ tempFilePath: "/tmp/lifecycle.mp3" }));
  const uploaded = await lifecycleStore.markUploaded(lifecycleSaved.item.requestId, "cloud://recording.mp3");
  assert.equal(uploaded.status, "uploaded");
  assert.equal(uploaded.cloudFileId, "cloud://recording.mp3");
  const failed = await lifecycleStore.markFailed(lifecycleSaved.item.requestId);
  assert.equal(failed.status, "failed");
  const restarted = createPendingCheckInStore(lifecycle.adapters);
  await restarted.ready();
  assert.equal(restarted.list()[0].status, "failed", "重启后应恢复持久状态");
  assert.equal(await restarted.complete(lifecycleSaved.item.requestId, false), false, "未明确打卡成功不得删除");
  assert.equal(await restarted.complete(lifecycleSaved.item.requestId, true), true);
  assert.equal(restarted.list().length, 0, "明确打卡成功后才删除文件和元数据");

  const completeFails = createAdapters({
    records: [pending({ requestId: hex(41), localPath: "/saved/complete-fail.mp3" })],
    existingPaths: ["/saved/complete-fail.mp3"],
    removeBehavior: async () => {
      throw new Error("remove failed");
    },
  });
  const completeFailStore = createPendingCheckInStore(completeFails.adapters);
  assert.equal(await completeFailStore.complete(hex(41), true), false);
  assert.equal(completeFailStore.list().length, 1, "完成时删除失败必须保留可重试元数据");

  const invalidSaveResult = createAdapters({
    saveBehavior: async () => ({ savedFilePath: "" }),
  });
  const invalidSaveStore = createPendingCheckInStore(invalidSaveResult.adapters);
  const invalidSave = await invalidSaveStore.saveRecording(recording());
  assert.equal(invalidSave.persisted, false);
  assert.equal(invalidSave.item.recoverable, false);
  assert.equal(invalidSave.item.status, "failed", "无效保存结果应明确标记为失败会话");
  assert.match(invalidSave.message, /保存路径无效/);
  assert.equal(invalidSaveStore.list().length, 1, "无效保存结果必须保留可诊断会话项");

  const concurrentBarrier = createBarrier();
  const concurrent = createAdapters({
    existingPaths: ["/tmp/concurrent-a.mp3", "/tmp/concurrent-b.mp3"],
    storageSetBehavior: async (_records, count) => {
      if (count === 1) {
        concurrentBarrier.entered();
        await concurrentBarrier.wait;
      }
    },
  });
  const concurrentStore = createPendingCheckInStore(concurrent.adapters);
  const concurrentFirst = concurrentStore.saveRecording(
    recording({ tempFilePath: "/tmp/concurrent-a.mp3", fileSizeBytes: 1 }),
  );
  await concurrentBarrier.enteredPromise;
  const concurrentSecond = concurrentStore.saveRecording(
    recording({ tempFilePath: "/tmp/concurrent-b.mp3", fileSizeBytes: 1 }),
  );
  concurrentBarrier.release();
  const [concurrentA, concurrentB] = await Promise.all([concurrentFirst, concurrentSecond]);
  assert.equal(concurrentA.persisted, true);
  assert.equal(concurrentB.persisted, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(concurrentStore.list().map((item) => item.requestId).sort())),
    [concurrentA.item.requestId, concurrentB.item.requestId].sort(),
    "并发不同 ID 保存不得丢写",
  );
  assert.equal(concurrent.getRecords().length, 2, "并发持久化最终必须保留两个记录");

  const duplicateBarrier = createBarrier();
  const concurrentDuplicate = createAdapters({
    existingPaths: ["/tmp/duplicate-a.mp3", "/tmp/duplicate-b.mp3"],
    storageSetBehavior: async (_records, count) => {
      if (count === 1) {
        duplicateBarrier.entered();
        await duplicateBarrier.wait;
      }
    },
  });
  concurrentDuplicate.adapters.random.hex = (() => {
    const values = [hex(71), hex(71), hex(72)];
    return () => values.shift();
  })();
  const duplicateStore = createPendingCheckInStore(concurrentDuplicate.adapters);
  const duplicateFirst = duplicateStore.saveRecording(
    recording({ tempFilePath: "/tmp/duplicate-a.mp3", fileSizeBytes: 1 }),
  );
  await duplicateBarrier.enteredPromise;
  const duplicateSecond = duplicateStore.saveRecording(
    recording({ tempFilePath: "/tmp/duplicate-b.mp3", fileSizeBytes: 1 }),
  );
  duplicateBarrier.release();
  const [duplicateA, duplicateB] = await Promise.all([duplicateFirst, duplicateSecond]);
  assert.notEqual(duplicateA.item.requestId, duplicateB.item.requestId, "并发候选 ID 不得重复返回");

  const cleanupWriteFails = createAdapters({
    now: cleanupNow,
    records: [pending({ requestId: hex(81), updatedAtMs: cleanupNow - RETENTION_MS, localPath: "/saved/cleanup-write-fail.mp3" })],
    existingPaths: ["/saved/cleanup-write-fail.mp3", "/tmp/cleanup-retry.mp3"],
    storageSetBehavior: async (_records, count) => {
      if (count === 1) throw new Error("metadata write failed");
    },
  });
  const cleanupWriteFailStore = createPendingCheckInStore(cleanupWriteFails.adapters);
  await cleanupWriteFailStore.cleanup();
  assert.equal(cleanupWriteFailStore.list().length, 0, "文件已删除后 list 不得暴露失效路径");
  await cleanupWriteFailStore.saveRecording(
    recording({ tempFilePath: "/tmp/cleanup-retry.mp3", fileSizeBytes: 1 }),
  );
  assert.deepEqual(
    cleanupWriteFails.getRecords().map((item) => item.requestId),
    JSON.parse(JSON.stringify(cleanupWriteFailStore.list().map((item) => item.requestId))),
    "后续 mutation 必须重试脏元数据写入",
  );

  const completeWriteFails = createAdapters({
    records: [pending({ requestId: hex(82), localPath: "/saved/complete-write-fail.mp3" })],
    existingPaths: ["/saved/complete-write-fail.mp3", "/tmp/complete-retry.mp3"],
    storageSetBehavior: async (_records, count) => {
      if (count === 1) throw new Error("metadata write failed");
    },
  });
  const completeWriteFailStore = createPendingCheckInStore(completeWriteFails.adapters);
  assert.equal(await completeWriteFailStore.complete(hex(82), true), false);
  assert.equal(completeWriteFailStore.list().length, 0, "complete 删除文件后不得暴露失效路径");
  await completeWriteFailStore.saveRecording(
    recording({ tempFilePath: "/tmp/complete-retry.mp3", fileSizeBytes: 1 }),
  );
  assert.equal(completeWriteFails.getRecords().length, 1, "后续 mutation 应补写完成删除元数据");

  const corrupted = createAdapters({ records: [{ requestId: "broken" }] });
  const corruptedStore = createPendingCheckInStore(corrupted.adapters);
  await corruptedStore.ready();
  assert.deepEqual(
    JSON.parse(JSON.stringify(corruptedStore.list())),
    [],
    "损坏持久数据不能导致白屏",
  );

  console.log("待上传录音仓储测试通过：保存路径、容量、清理、恢复与完成删除契约正确。");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
