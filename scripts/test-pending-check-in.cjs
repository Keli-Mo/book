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
  MAX_PENDING_FILE_BYTES,
  PENDING_RECORDING_BYTES,
  RECORDING_START_USED_BYTES,
  createPendingCheckInStore,
} = moduleContainer.exports;

const MIB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
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
  storageGetBehavior,
  existingPaths,
  removeBehavior,
  usageBehavior,
} = {}) => {
  let savedRecords = JSON.parse(JSON.stringify(records));
  const calls = { save: [], remove: [], set: 0 };
  let savedFileSequence = 1;
  let requestIdSequence = 1;
  const existing = new Set(existingPaths || records.map((item) => item.localPath));
  const adapters = {
    storage: {
      async get() {
        if (storageGetBehavior) await storageGetBehavior();
        return JSON.parse(JSON.stringify(savedRecords));
      },
      async set(_key, nextRecords) {
        calls.set += 1;
        if (storageSetBehavior) await storageSetBehavior(nextRecords, calls.set);
        savedRecords = JSON.parse(JSON.stringify(nextRecords));
      },
    },
    file: {
      async usageBytes() {
        if (usageBehavior) return usageBehavior();
        return savedRecords.reduce((total, item) => total + item.fileSizeBytes, 0);
      },
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
  assert.equal(MAX_PENDING_FILE_BYTES, 100 * MIB, "本地录音库总预算应为 100MiB");
  assert.equal(PENDING_RECORDING_BYTES, 90 * MIB, "固定保留 10MiB，不可被录音侵占");
  assert.equal(RECORDING_START_USED_BYTES, 82 * MIB, "开麦前还须预留一条 8MiB 文件上限");

  const atStartBoundary = createPendingCheckInStore(createAdapters({ usageBehavior: () => 82 * MIB }).adapters);
  const boundaryResult = await atStartBoundary.checkCanStartRecording();
  assert.equal(boundaryResult.allowed, true, "恰好 82MiB 仍可开麦");
  assert.equal(boundaryResult.message, "");
  const overStartBoundary = createPendingCheckInStore(createAdapters({ usageBehavior: () => 82 * MIB + 1 }).adapters);
  assert.equal((await overStartBoundary.checkCanStartRecording()).allowed, false, "超过 82MiB 一字节必须拦截开麦");

  for (const invalidUsage of [() => { throw new Error("stat failed"); }, () => -1, () => 1.5, () => NaN]) {
    const unknown = createPendingCheckInStore(createAdapters({ usageBehavior: invalidUsage }).adapters);
    const result = await unknown.checkCanStartRecording();
    assert.equal(result.allowed, false, "统计失败或大小无效不能按 0 处理");
    assert.match(result.message, /无法检查本地录音空间/);
  }

  const manyRecords = Array.from({ length: 501 }, (_, index) => pending({ requestId: hex(index + 1000), localPath: `/saved/many-${index}.mp3`, fileSizeBytes: 1 }));
  const manyAdapters = createAdapters({ records: manyRecords, usageBehavior: () => 501 });
  const manyStore = createPendingCheckInStore(manyAdapters.adapters);
  assert.equal((await manyStore.saveRecording(recording({ fileSizeBytes: 1 }))).persisted, true, "空间足够时 501 条之后仍可保存");

  const orphanUsage = createPendingCheckInStore(createAdapters({ records: [], usageBehavior: () => 90 * MIB }).adapters);
  const orphanBlocked = await orphanUsage.saveRecording(recording({ fileSizeBytes: 1 }));
  assert.equal(orphanBlocked.persisted, false, "未被索引引用的实际文件仍须计入容量");
  assert.match(orphanBlocked.message, /整理历史录音/);

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

  const actualMetadata = createAdapters({
    saveBehavior: async () => ({ savedFilePath: "/saved/actual.mp3", fileSizeBytes: 4097, contentSha1: "A".repeat(40) }),
    existingPaths: ["/saved/actual.mp3"],
  });
  const actualStore = createPendingCheckInStore(actualMetadata.adapters);
  const actualSaved = await actualStore.saveRecording(recording({ fileSizeBytes: 4096 }));
  assert.equal(actualSaved.item.fileSizeBytes, 4097, "保存后必须采用实际文件大小，不能沿用 onStop 的大小");
  assert.equal(actualSaved.item.contentSha1, "a".repeat(40), "保存实际内容基准并统一小写");
  assert.equal(actualMetadata.getRecords()[0].contentSha1, "a".repeat(40));
  assert.equal(Object.isFrozen(actualSaved.item), true);
  const actualRestarted = createPendingCheckInStore(actualMetadata.adapters);
  await actualRestarted.ready();
  assert.equal(actualRestarted.list()[0].fileSizeBytes, 4097);
  assert.equal(actualRestarted.list()[0].contentSha1, "a".repeat(40));

  let calibrationReads = 0;
  const unknownCalibration = createAdapters({
    existingPaths: ["/tmp/calibration.mp3"],
    usageBehavior: () => {
      calibrationReads += 1;
      if (calibrationReads === 1) return 0;
      throw new Error("post-save stat failed");
    },
    saveBehavior: async () => ({ savedFilePath: "/saved/calibration.mp3", fileSizeBytes: 4097, contentSha1: "e".repeat(40) }),
  });
  const calibrationResult = await createPendingCheckInStore(unknownCalibration.adapters).saveRecording(
    recording({ tempFilePath: "/tmp/calibration.mp3", fileSizeBytes: 4096 }),
  );
  assert.equal(calibrationResult.persisted, true, "保存后统计失败仍必须持久化已落盘恢复路径");
  assert.equal(calibrationResult.item.localPath, "/saved/calibration.mp3");
  assert.match(calibrationResult.message, /无法核实本地录音空间/, "保存后未知容量不得伪装成正常");

  for (const retryCapacity of ["unknown", "over-limit"]) {
    let usageReads = 0;
    const movedRetry = createAdapters({
      existingPaths: [`/tmp/moved-${retryCapacity}.mp3`],
      usageBehavior: () => {
        usageReads += 1;
        if (usageReads <= 2) return usageReads === 1 ? 0 : 20;
        if (retryCapacity === "unknown") throw new Error("retry stat failed");
        return 91 * MIB;
      },
      saveBehavior: async () => ({ savedFilePath: `/saved/moved-${retryCapacity}.mp3`, fileSizeBytes: 20, contentSha1: "f".repeat(40) }),
      storageSetBehavior: async (_records, count) => {
        if (count === 1) throw new Error("first metadata write failed");
      },
    });
    const movedStore = createPendingCheckInStore(movedRetry.adapters);
    const firstAttempt = await movedStore.saveRecording(recording({ tempFilePath: `/tmp/moved-${retryCapacity}.mp3`, fileSizeBytes: 20 }));
    assert.equal(firstAttempt.persisted, false);
    assert.equal(firstAttempt.item.localPath, `/saved/moved-${retryCapacity}.mp3`);
    const retried = await movedStore.retrySave(firstAttempt.item.requestId);
    assert.equal(retried.persisted, true, `已移动路径在容量 ${retryCapacity} 时仍须补写索引`);
    assert.equal(retried.item.localPath, `/saved/moved-${retryCapacity}.mp3`, "补索引必须复用原 savedPath");
    assert.equal(movedRetry.calls.set, 2, "索引失败后的重试必须发生第二次元数据写入");
    assert.equal(movedRetry.calls.save.length, 1, "已移动路径不得再次 saveFile");
    assert.equal(movedRetry.calls.remove.length, 0, "补索引不得为满足容量删除文件");
    assert.match(retried.message, retryCapacity === "unknown" ? /无法核实本地录音空间/ : /空间不足/);
  }

  const legacyMetadata = createAdapters({ records: [pending()] });
  const legacyStore = createPendingCheckInStore(legacyMetadata.adapters);
  await legacyStore.ready();
  assert.equal(legacyStore.list()[0].contentSha1, undefined, "没有指纹的旧版本待上传项仍可恢复");
  const legacySnapshot = legacyStore.list()[0];
  const rebound = await legacyStore.update(hex(99), { fileSizeBytes: MIB + 7, contentSha1: "B".repeat(40) });
  assert.equal(rebound.fileSizeBytes, MIB + 7);
  assert.equal(rebound.contentSha1, "b".repeat(40));
  assert.equal(legacySnapshot.fileSizeBytes, MIB, "建立基准不能修改调用方既有快照");
  assert.equal(legacySnapshot.contentSha1, undefined);
  assert.equal(legacyMetadata.getRecords()[0].contentSha1, "b".repeat(40));
  for (const patch of [{ fileSizeBytes: 0 }, { fileSizeBytes: 1.5 }, { fileSizeBytes: Infinity }, { contentSha1: "" }, { contentSha1: "g".repeat(40) }]) {
    assert.equal(await legacyStore.update(hex(99), patch), null, "无效实测元数据不得写入仓储");
  }
  assert.equal(legacyStore.list()[0].contentSha1, "b".repeat(40));

  const reboundWriteFailure = createAdapters({
    records: [pending()],
    storageSetBehavior: async () => { throw new Error("cannot persist fingerprint"); },
  });
  const reboundFailureStore = createPendingCheckInStore(reboundWriteFailure.adapters);
  assert.equal(await reboundFailureStore.update(hex(99), { fileSizeBytes: MIB + 1, contentSha1: "c".repeat(40) }), null);
  assert.equal(reboundFailureStore.list()[0].fileSizeBytes, MIB, "校准持久化失败不能只修改内存而假装基准已保存");
  assert.equal(reboundFailureStore.list()[0].contentSha1, undefined);

  const correctedCapacity = createAdapters({
    records: [pending({ fileSizeBytes: 89 * MIB })],
    saveBehavior: async () => ({ savedFilePath: "/saved/corrected.mp3", fileSizeBytes: 2 * MIB, contentSha1: "d".repeat(40) }),
    existingPaths: ["/saved/existing.mp3", "/saved/corrected.mp3"],
    usageBehavior: (() => { const values = [89 * MIB, 91 * MIB, 91 * MIB]; return () => values.shift() ?? 91 * MIB; })(),
  });
  const correctedCapacityStore = createPendingCheckInStore(correctedCapacity.adapters);
  const correctedSaved = await correctedCapacityStore.saveRecording(recording({ fileSizeBytes: MIB }));
  assert.equal(correctedSaved.persisted, true, "实测越限也必须保住已保存文件的恢复元数据");
  assert.equal(correctedSaved.item.localPath, "/saved/corrected.mp3");
  assert.equal(correctedSaved.item.fileSizeBytes, 2 * MIB);
  assert.match(correctedSaved.message, /空间不足/);
  const blockedByActualSize = await correctedCapacityStore.saveRecording(recording({ fileSizeBytes: 1 }));
  assert.equal(blockedByActualSize.persisted, false, "后续容量判断必须使用修正后的实际字节数");
  assert.equal(correctedCapacity.calls.save.length, 1);
  assert.deepEqual(correctedCapacity.calls.remove, [], "不得为满足容量限制删除现有录音");

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

  const exactCapacity = createAdapters({
    existingPaths: ["/tmp/exact.mp3"],
    usageBehavior: (() => { const values = [0, 90 * MIB, 90 * MIB]; return () => values.shift() ?? 90 * MIB; })(),
  });
  const exactStore = createPendingCheckInStore(exactCapacity.adapters);
  const exact = await exactStore.saveRecording(
    recording({ tempFilePath: "/tmp/exact.mp3", fileSizeBytes: 90 * MIB }),
  );
  assert.equal(exact.persisted, true, "恰好 90MiB 应允许保存并保留 10MiB 安全余量");
  const over = await exactStore.saveRecording(
    recording({ tempFilePath: "/tmp/over.mp3", fileSizeBytes: 1 }),
  );
  assert.equal(over.persisted, false);
  assert.equal(over.item.recoverable, false);
  assert.match(over.message, /整理历史录音/);
  assert.equal(exactCapacity.calls.save.length, 1, "预判容量超限不得移动临时文件");

  const countBoundary = createAdapters({
    records: Array.from({ length: 500 }, (_, index) => pending({ requestId: hex(index + 1), fileSizeBytes: 1 })),
    existingPaths: ["/saved/existing.mp3"],
  });
  countBoundary.adapters.random.hex = () => hex(501);
  const countStore = createPendingCheckInStore(countBoundary.adapters);
  const countOver = await countStore.saveRecording(recording({ fileSizeBytes: 1 }));
  assert.equal(countOver.persisted, true, "容量足够时第 501 条短录音仍可持久保存");

  const cleanupNow = 1_900_000_000_000;
  const cleanup = createAdapters({
    now: cleanupNow,
    records: [
      pending({ requestId: hex(11), updatedAtMs: cleanupNow - 8 * DAY_MS, localPath: "/saved/eight-days.mp3" }),
      pending({ requestId: hex(12), updatedAtMs: cleanupNow - 365 * DAY_MS, localPath: "/saved/one-year.mp3" }),
      pending({ requestId: hex(13), localPath: "/saved/missing.mp3" }),
    ],
    existingPaths: ["/saved/eight-days.mp3", "/saved/one-year.mp3", "/tmp/clean.mp3"],
  });
  const cleanupStore = createPendingCheckInStore(cleanup.adapters);
  const cleaned = await cleanupStore.saveRecording(recording({ tempFilePath: "/tmp/clean.mp3", fileSizeBytes: 1 }));
  assert.equal(cleaned.persisted, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(cleanupStore.list().map((item) => item.requestId))),
    [hex(11), hex(12), cleaned.item.requestId],
    "8 天和 365 天的待上传录音仍须保留，只清理实际不存在的文件引用",
  );
  assert.deepEqual(cleanup.calls.remove, [], "自动清理不得删除任何仍存在的录音文件");
  const capacityWithOldRecordings = await cleanupStore.saveRecording(recording({ fileSizeBytes: 1 }));
  assert.equal(capacityWithOldRecordings.persisted, true, "未达 100MiB/500 条时旧录音不应阻止继续保存");
  assert.deepEqual(cleanup.calls.remove, [], "容量不足也不能自动删除旧录音");
  assert.equal(await cleanupStore.remove(hex(11)), true, "用户显式删除旧录音仍生效");
  assert.deepEqual(cleanup.calls.remove, ["/saved/eight-days.mp3"]);
  assert.equal(cleanupStore.list().some((item) => item.requestId === hex(12)), true);

  const removeFails = createAdapters({
    now: cleanupNow,
    records: [pending({ requestId: hex(21), updatedAtMs: cleanupNow - 365 * DAY_MS, localPath: "/saved/cannot-remove.mp3" })],
    existingPaths: ["/saved/cannot-remove.mp3", "/tmp/failure.mp3"],
    removeBehavior: async () => {
      throw new Error("remove failed");
    },
  });
  const failureStore = createPendingCheckInStore(removeFails.adapters);
  await failureStore.cleanup();
  assert.deepEqual(removeFails.calls.remove, [], "自动清理不调用删除方法");
  assert.equal(await failureStore.remove(hex(21)), false);
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
  assert.equal(await metadataFailStore.complete(metadataFailure.item.requestId, true), false, "未持久临时项不能假装长期完成");
  assert.deepEqual(metadataFails.calls.remove, []);
  assert.equal((await metadataFailStore.retrySave(metadataFailure.item.requestId)).persisted, false);
  assert.equal(metadataFailStore.list()[0].localPath, "/saved/1.mp3", "持续失败仍保留可回听路径");
  assert.equal(metadataFails.calls.save.length, 1);
  assert.equal((await saveFailStore.retrySave(temporary.item.requestId)).persisted, false);
  assert.equal(saveFailStore.list()[0].localPath, temporary.item.localPath);

  const once = createAdapters({ storageSetBehavior: async (_items, count) => { if (count === 1) throw new Error("write failed"); } });
  const onceStore = createPendingCheckInStore(once.adapters);
  const onceFailed = await onceStore.saveRecording(recording());
  const recovered = await onceStore.retrySave(onceFailed.item.requestId);
  assert.equal(recovered.persisted, true);
  assert.equal(recovered.item.requestId, onceFailed.item.requestId);
  assert.equal(recovered.item.createdAtMs, onceFailed.item.createdAtMs);
  assert.equal(once.calls.save.length, 1, "只欠索引时不得重复移动文件");
  const recoveredRestart = createPendingCheckInStore(once.adapters);
  await recoveredRestart.ready();
  assert.equal(recoveredRestart.list()[0].localPath, recovered.item.localPath);
  assert.equal(await onceStore.complete(recovered.item.requestId, true), true);
  assert.ok(await onceStore.beginShare(recovered.item.requestId));

  const stages = createAdapters({
    saveBehavior: async (_path, count) => { if (count === 1) throw new Error("save failed"); return { savedFilePath: "/saved/stages.mp3", fileSizeBytes: 17, contentSha1: "a".repeat(40) }; },
    storageSetBehavior: async (_items, count) => { if (count === 1) throw new Error("write failed"); },
  });
  const stagesStore = createPendingCheckInStore(stages.adapters);
  const stageInitial = await stagesStore.saveRecording(recording());
  const stageMoved = await stagesStore.retrySave(stageInitial.item.requestId);
  assert.equal(stageMoved.persisted, false);
  assert.equal(stageMoved.item.localPath, "/saved/stages.mp3");
  const stageDone = await stagesStore.retrySave(stageInitial.item.requestId);
  assert.equal(stageDone.persisted, true);
  assert.equal(stageDone.item.fileSizeBytes, 17);
  assert.equal(stageDone.item.contentSha1, "a".repeat(40));
  assert.equal(stages.calls.save.length, 2, "第二阶段失败后只补索引");
  assert.equal((await exactStore.retrySave(over.item.requestId)).persisted, false);
  assert.equal(exactCapacity.calls.save.length, 1, "重试仍须容量保护");

  let readAttempts = 0;
  const readFailure = createAdapters({
    records: [pending({ requestId: hex(95) })],
    existingPaths: ["/saved/existing.mp3", "/tmp/read-fail.mp3"],
    storageGetBehavior: () => { readAttempts += 1; if (readAttempts === 1) throw new Error("read failed"); },
  });
  const readFailureStore = createPendingCheckInStore(readFailure.adapters);
  const blockedSave = await readFailureStore.saveRecording(recording({ tempFilePath: "/tmp/read-fail.mp3" }));
  assert.equal(blockedSave.persisted, false, "索引读取失败时必须 fail-closed");
  assert.equal(readFailure.calls.set, 0, "不得用空数组覆盖未读出的旧索引");
  assert.equal(readFailure.calls.save.length, 0, "索引未知时不得移动新录音文件");
  await readFailureStore.ready();
  assert.equal(readFailureStore.list()[0].requestId, hex(95), "后续读取成功可恢复原元数据");
  assert.equal((await readFailureStore.retrySave(blockedSave.item.requestId)).persisted, true);
  assert.equal(readFailure.getRecords().length, 2, "重试保存不得覆盖原索引");
  const unreadable = createAdapters({ storageGetBehavior: () => { throw new Error("read failed"); } });
  const unreadableStore = createPendingCheckInStore(unreadable.adapters);
  const unreadableItem = await unreadableStore.saveRecording(recording());
  assert.equal((await unreadableStore.retrySave(unreadableItem.item.requestId)).persisted, false);
  assert.equal(unreadable.calls.set, 0);
  assert.equal(unreadable.calls.save.length, 0);

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
  assert.equal(restarted.list().length, 1, "完成练习只更新元数据，不能删除本地录音");
  assert.equal(lifecycle.existing.has(lifecycleSaved.item.localPath), true, "完成后文件必须仍可回听");
  assert.equal(restarted.list()[0].completedAtMs, 1_800_000_000_000);
  const completedRestart = createPendingCheckInStore(lifecycle.adapters);
  await completedRestart.ready();
  assert.equal(completedRestart.list()[0].completedAtMs, 1_800_000_000_000, "完成时间重启后仍恢复");

  const shareAdapters = createAdapters({
    now: 1_900_000_000_000,
    records: [pending({ requestId: hex(91), createdAtMs: 1_800_000_000_000 })],
    existingPaths: ["/saved/existing.mp3"],
  });
  shareAdapters.adapters.random.hex = (() => {
    const ids = [hex(191), hex(192)];
    return () => ids.shift();
  })();
  const shareStore = createPendingCheckInStore(shareAdapters.adapters);
  const firstShare = await shareStore.beginShare(hex(91));
  assert.equal(firstShare.shareRequestId, hex(191), "首次分享须持久化独立云 requestId");
  assert.equal((await shareStore.beginShare(hex(91))).shareRequestId, hex(191), "未完成或有效代次必须复用");
  const expiry = 1_900_000_100_000;
  const marked = await shareStore.markShared(hex(91), { id: "cloud-id", shareToken: "token", expiresAtMs: expiry });
  assert.equal(marked.share.expiresAtMs, expiry);
  assert.equal((await shareStore.beginShare(hex(91))).shareRequestId, hex(191), "有效分享不得因再次点击换代");
  shareAdapters.adapters.clock.now = () => expiry;
  const nextShare = await shareStore.beginShare(hex(91));
  assert.equal(nextShare.shareRequestId, hex(192), "到期后下一次主动分享才生成新代");
  assert.equal(nextShare.share, undefined, "新代不能沿用旧链接");
  assert.equal(await shareStore.markUploaded(hex(91), "cloud://stale", hex(191)), null, "旧代迟到上传不得污染新代");
  assert.equal(shareStore.list()[0].cloudFileId, "");
  assert.equal(await shareStore.markShared(hex(91), { id: "stale", shareToken: "stale", expiresAtMs: expiry + 1 }, hex(191)), null, "旧代迟到提交不得污染新代");
  assert.equal(shareStore.list()[0].share, undefined);
  const shareRestart = createPendingCheckInStore(shareAdapters.adapters);
  await shareRestart.ready();
  assert.equal(shareRestart.list()[0].shareRequestId, hex(192), "新代写入成功后重启仍保持");
  assert.equal(await shareRestart.markShareExpired(hex(91), hex(191)), false, "迟到核验不得清掉另一代分享");
  assert.equal(shareRestart.list()[0].shareRequestId, hex(192));
  assert.equal(await shareRestart.markShareExpired(hex(91), hex(192)), true);
  assert.equal(shareRestart.list()[0].shareRequestId, undefined);
  assert.equal(shareAdapters.existing.has("/saved/existing.mp3"), true);
  assert.equal(shareAdapters.calls.remove.length, 0);
  const invalidatedRestart = createPendingCheckInStore(shareAdapters.adapters);
  await invalidatedRestart.ready();
  assert.equal(invalidatedRestart.list()[0].shareRequestId, undefined, "主动失效必须持久化后才报告成功");
  const failingExpiry = createAdapters({
    records: [pending({ requestId: hex(93), shareRequestId: hex(193), cloudFileId: "cloud://original", share: { id: "original", shareToken: "original-token", expiresAtMs: expiry } })],
    storageSetBehavior: async () => { throw new Error("metadata quota exceeded"); },
  });
  const failingExpiryStore = createPendingCheckInStore(failingExpiry.adapters);
  assert.equal(await failingExpiryStore.markShareExpired(hex(93), hex(193)), false);
  assert.equal(failingExpiryStore.list()[0].share.id, "original");
  assert.equal(failingExpiryStore.list()[0].cloudFileId, "cloud://original");
  assert.equal(failingExpiry.calls.remove.length, 0);

  const uppercaseGeneration = createAdapters({
    records: [pending({ requestId: "B".repeat(32), shareRequestId: "A".repeat(32) })],
    existingPaths: ["/saved/existing.mp3"],
  });
  const uppercaseStore = createPendingCheckInStore(uppercaseGeneration.adapters);
  await uppercaseStore.ready();
  assert.equal(uppercaseStore.list()[0].requestId, "B".repeat(32), "旧本地 ID 保持原值，避免记录失联");
  assert.equal(uppercaseStore.list()[0].shareRequestId, "a".repeat(32), "旧大写分享代次在读取时规范为小写");
  const uppercaseMarked = await uppercaseStore.markShared("B".repeat(32), { id: "upper", shareToken: "token", expiresAtMs: expiry }, "a".repeat(32));
  assert.equal(uppercaseMarked.share.id, "upper", "混合大小写代次 guard 仍允许同代回写");
  assert.equal(uppercaseGeneration.getRecords()[0].shareRequestId, "a".repeat(32));

  const generationWriteFailure = createAdapters({
    records: [pending({ requestId: hex(92) })],
    existingPaths: ["/saved/existing.mp3"],
    storageSetBehavior: async () => { throw new Error("cannot persist generation"); },
  });
  const generationStore = createPendingCheckInStore(generationWriteFailure.adapters);
  assert.equal(await generationStore.beginShare(hex(92)), null, "新代元数据未持久化时不得允许上传");

  const completeFails = createAdapters({
    records: [pending({ requestId: hex(41), localPath: "/saved/complete-fail.mp3" })],
    existingPaths: ["/saved/complete-fail.mp3"],
    removeBehavior: async () => {
      throw new Error("remove failed");
    },
  });
  const completeFailStore = createPendingCheckInStore(completeFails.adapters);
  assert.equal(await completeFailStore.complete(hex(41), true), true);
  assert.equal(completeFailStore.list().length, 1, "完成不删除文件，删除适配器异常不应影响完成标记");

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
    records: [pending({ requestId: hex(81), updatedAtMs: cleanupNow - 365 * DAY_MS, localPath: "/saved/cleanup-write-fail.mp3" })],
    existingPaths: ["/tmp/cleanup-retry.mp3"],
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
  assert.equal(completeWriteFailStore.list().length, 1, "完成标记写失败仍须保留文件与原元数据");
  await completeWriteFailStore.saveRecording(
    recording({ tempFilePath: "/tmp/complete-retry.mp3", fileSizeBytes: 1 }),
  );
  assert.equal(completeWriteFails.getRecords().length, 2, "后续保存不能覆盖完成标记失败的原元数据");

  const unreadableDelete = createAdapters({
    existingPaths: ["/tmp/unreadable-delete.mp3"],
    storageGetBehavior: async () => { throw new Error("storage read failed"); },
  });
  const unreadableDeleteStore = createPendingCheckInStore(unreadableDelete.adapters);
  const unreadableTemporary = await unreadableDeleteStore.saveRecording(recording({ tempFilePath: "/tmp/unreadable-delete.mp3" }));
  assert.equal(unreadableTemporary.persisted, false);
  assert.equal(await unreadableDeleteStore.remove(unreadableTemporary.item.requestId), true, "索引读失败也可删除明确持有的会话临时录音");
  assert.equal(unreadableDeleteStore.list().length, 0);
  assert.equal(unreadableDelete.existing.has("/tmp/unreadable-delete.mp3"), false);
  assert.equal(unreadableDelete.calls.set, 0, "索引读失败不能覆盖持久录音列表");
  assert.equal(await unreadableDeleteStore.remove(hex(999)), false, "未知持久录音不能把读取失败当作已删除");

  const corrupted = createAdapters({ records: [{ requestId: "broken" }] });
  const corruptedStore = createPendingCheckInStore(corrupted.adapters);
  await corruptedStore.ready();
  assert.deepEqual(
    JSON.parse(JSON.stringify(corruptedStore.list())),
    [],
    "损坏持久数据不能导致白屏",
  );

  console.log("本地录音仓储测试通过：持久文件、容量、恢复、完成标记与分享代次契约正确。");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
