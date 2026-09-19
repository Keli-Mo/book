/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const folder = fs.mkdtempSync(path.join(os.tmpdir(), "haisha-recording-test-"));
const files = [];
const metadata = new Map();
const modules = new Map();
const network = [];
const awaitingFingerprint = new Set();
const sha1 = bytes => crypto.createHash("sha1").update(bytes).digest("hex");
let sequence = 0;
let uploadedBytes;
const listSavedFiles = () => fs.readdirSync(folder).filter(name => /^saved-\d+\.mp3$/.test(name)).map(name => {
  const filePath = path.join(folder, name);
  return { filePath, size: fs.statSync(filePath).size };
});
const wx = {
  getStorageSync: key => metadata.get(key),
  setStorageSync: (key, value) => metadata.set(key, JSON.parse(JSON.stringify(value))),
  saveFile({ tempFilePath, success, fail }) {
    try {
      const savedFilePath = path.join(folder, `saved-${++sequence}.mp3`);
      fs.renameSync(tempFilePath, savedFilePath);
      files.push(savedFilePath);
      awaitingFingerprint.add(savedFilePath);
      success({ savedFilePath });
    } catch (error) { fail(error); }
  },
  getFileInfo({ filePath, digestAlgorithm, success, fail }) {
    try {
      assert.equal(digestAlgorithm, "sha1");
      if (awaitingFingerprint.has(filePath)) {
        const journal = metadata.get('pending-check-ins-v1-save-journal');
        assert.ok(journal?.entries.some(entry => entry.item.localPath === filePath), '原生保存成功后、读取指纹前必须已记录实际路径');
        awaitingFingerprint.delete(filePath);
      }
      const bytes = fs.readFileSync(filePath);
      success({ size: bytes.length, digest: sha1(bytes) });
    } catch (error) { fail(error); }
  },
  getFileSystemManager: () => ({
    getSavedFileList({ success, fail }) {
      try { success({ fileList: listSavedFiles() }); } catch (error) { fail(error); }
    },
    access({ path: filePath, success, fail }) { fs.existsSync(filePath) ? success({}) : fail({}); },
    unlink({ filePath, success, fail }) {
      try { fs.unlinkSync(filePath); success({}); } catch (error) { fail(error); }
    },
  }),
};

// 运行真实保存/文件信息/提交模块；仅原生 API 边界用 Node 文件系统替代。
const load = relative => {
  const sourcePath = path.resolve(root, relative);
  if (modules.has(sourcePath)) return modules.get(sourcePath).exports;
  const mod = { exports: {} };
  modules.set(sourcePath, mod);
  const source = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(source, {
    module: mod, exports: mod.exports, wx, console, setTimeout, clearTimeout,
    require: name => load(path.relative(root, path.resolve(path.dirname(sourcePath), `${name}.ts`))),
  });
  return mod.exports;
};

(async () => {
  const runtime = load("src/features/listeningPractice/pendingCheckInRuntime.ts");
  const service = load("src/services/cloudCheckIn.ts");
  const { createCheckInSubmissionCoordinator } = load("src/features/listeningPractice/checkInSubmissionCoordinator.ts");
  const store = runtime.getPendingCheckInStore();
  const coordinator = createCheckInSubmissionCoordinator({
    pendingStore: store,
    getRecordingInfo: service.getCheckInRecordingInfo,
    async prepareCheckIn(payload) {
      network.push(["prepare", payload]);
      return { state: "upload-required", id: "checkin", cloudPath: "checkins/fixture.mp3" };
    },
    startPreparedCheckInUpload(filePath) {
      uploadedBytes = fs.readFileSync(filePath);
      network.push(["upload"]);
      return { result: Promise.resolve("cloud://fixture") };
    },
    async commitCheckIn(payload) {
      assert.equal(payload.fileSizeBytes, uploadedBytes.length);
      assert.equal(payload.contentSha1, sha1(uploadedBytes));
      network.push(["commit", payload]);
      return { id: "checkin", shareToken: "share", expiresAtMs: Date.now() + 1000 };
    },
    scheduler: { setTimeout, clearTimeout }, clock: { now: Date.now },
  });
  const context = { bookId: "3", bookTitle: "CASA", practiceId: "3-page-4", practiceIndex: 0,
    pageNumber: 4, sectionTitle: "Unit 1", imageUrl: "https://example.test/4.png" };
  const createFixture = name => {
    const filePath = path.join(folder, name);
    files.push(filePath);
    // 此测试验证字节完整性，不将合成数据当作实际麦克风或音频解码验收。
    fs.writeFileSync(filePath, Buffer.alloc(4097, 71));
    return filePath;
  };

  const tempFilePath = createFixture("native-stop.mp3");
  const saved = await store.saveRecording({ tempFilePath, context, durationMs: 3100, fileSizeBytes: 4096 });
  assert.equal(saved.persisted, true);
  assert.equal(fs.existsSync(tempFilePath), false);
  assert.equal(saved.item.fileSizeBytes, 4097, "保存后的实际文件大小应替代回调大小");
  assert.equal(await runtime.getLocalRecordingUsageBytes(), 4097, "容量来自已保存文件的磁盘实测大小");
  assert.equal(saved.item.contentSha1, sha1(fs.readFileSync(saved.item.localPath)));
  const shareReady = await store.beginShare(saved.item.requestId);
  assert.equal((await coordinator.submit(shareReady).promise).state, "committed");
  assert.equal(fs.existsSync(saved.item.localPath), true, "云端确认后仍保留本地副本");
  assert.deepEqual(network.map(row => row[0]), ["prepare", "upload", "commit"]);

  const another = await store.saveRecording({ tempFilePath: createFixture("changed.mp3"), context, durationMs: 3100, fileSizeBytes: 4096 });
  fs.writeFileSync(another.item.localPath, Buffer.alloc(4097, 72));
  const changed = await coordinator.submit(await store.beginShare(another.item.requestId)).promise;
  assert.equal(changed.state, "failed");
  assert.equal(changed.error.code, "RECORDING_FILE_CHANGED", "相同大小但内容变化也必须识别");
  assert.equal(fs.existsSync(another.item.localPath), true);
  assert.equal(network.length, 3, "内容变化不能发起新的上传");

  // 模拟旧版遗留元数据，在重启仓储后仍能使用原文件校准并提交。
  const { PENDING_CHECK_IN_STORAGE_KEY, createPendingCheckInStore } = load("src/features/listeningPractice/pendingCheckInStore.ts");
  const legacyRecord = { ...another.item, contentSha1: undefined, fileSizeBytes: 4096, status: "failed" };
  metadata.set(PENDING_CHECK_IN_STORAGE_KEY, [legacyRecord]);
  const restoredStore = createPendingCheckInStore({
    storage: { get: key => metadata.get(key), set: (key, value) => metadata.set(key, JSON.parse(JSON.stringify(value))) },
    file: { usageBytes: () => listSavedFiles().reduce((total, file) => total + file.size, 0),
      exists: fs.existsSync, remove: fs.unlinkSync, save: () => { throw new Error("旧文件不应重录或重存"); } },
    clock: { now: Date.now }, random: { hex: () => "c".repeat(32) },
  });
  await restoredStore.ready();
  // coordinator 的适配器要指向重启后的真实仓储。
  const legacyCoordinator = createCheckInSubmissionCoordinator({
    pendingStore: restoredStore, getRecordingInfo: service.getCheckInRecordingInfo,
    prepareCheckIn: async payload => {
      assert.equal(payload.fileSizeBytes, 4097);
      assert.equal(payload.contentSha1, sha1(fs.readFileSync(legacyRecord.localPath)));
      return { state: "upload-required", id: "legacy", cloudPath: "checkins/legacy.mp3" };
    },
    startPreparedCheckInUpload: filePath => {
      uploadedBytes = fs.readFileSync(filePath);
      return { result: Promise.resolve("cloud://legacy") };
    },
    commitCheckIn: async payload => {
      assert.equal(payload.fileSizeBytes, uploadedBytes.length);
      assert.equal(payload.contentSha1, sha1(uploadedBytes));
      return { id: "legacy", shareToken: "share", expiresAtMs: Date.now() + 1000 };
    },
    scheduler: { setTimeout, clearTimeout }, clock: { now: Date.now },
  });
  const legacyShare = await restoredStore.beginShare(legacyRecord.requestId);
  assert.equal((await legacyCoordinator.submit(legacyShare).promise).state, "committed");
  assert.equal(fs.existsSync(legacyRecord.localPath), true);
  console.log("录音真实文件链路通过：保存后字节与指纹、云端确认前保留、同大小内容变化、旧失败录音重启重试。");
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const filePath of files) if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  fs.rmdirSync(folder);
});
