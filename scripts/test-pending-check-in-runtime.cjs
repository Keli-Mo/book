/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");

const compile = (relativePath, requireMap, globals = {}) => {
  const sourcePath = path.resolve(root, relativePath);
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
    require: (name) => requireMap[name],
    Promise,
    Map,
    Set,
    Object,
    Array,
    Number,
    String,
    RegExp,
    Error,
    Date,
    Math,
    ...globals,
  });
  return moduleContainer.exports;
};

const storeExports = compile(
  "src/features/listeningPractice/pendingCheckInStore.ts",
  {},
);

const saved = new Map();
const files = new Set(["wxfile://tmp/current.mp3"]);
let saveCount = 0;
const infoPaths = [];
let infoError = null;
let accessError = null;
const removedPaths = [];
const removalMethods = [];
const logs = [];
const diagnosticConsole = {
  info: (...args) => logs.push(args),
  warn: (...args) => logs.push(args),
  error: (...args) => logs.push(args),
};
let removeError = null;
let disappearDuringRemove = false;
let saveError = null;
let storageError = null;
let savedFileListError = null;
let savedFileEntries = [];
const wx = {
  getStorageSync(key) {
    return saved.get(key);
  },
  setStorageSync(key, value) {
    if (storageError) throw storageError;
    saved.set(key, JSON.parse(JSON.stringify(value)));
  },
  saveFile({ tempFilePath, success, fail }) {
    if (saveError) return fail(saveError);
    saveCount += 1;
    const savedFilePath = `wxfile://store/${saveCount}.mp3`;
    files.delete(tempFilePath);
    files.add(savedFilePath);
    success({ savedFilePath });
  },
  removeSavedFile({ filePath, success, fail }) {
    removalMethods.push("removeSavedFile");
    if (disappearDuringRemove) files.delete(filePath);
    if (removeError) return fail(removeError);
    removedPaths.push(filePath);
    if (files.delete(filePath)) success({});
    else fail({ errCode: 1300002, errMsg: "removeSavedFile:fail file not exist" });
  },
  getFileInfo({ filePath, digestAlgorithm, success, fail }) {
    infoPaths.push(filePath);
    assert.equal(files.has(filePath), true, "读取指纹时必须已完成 saveFile");
    assert.equal(digestAlgorithm, "sha1");
    if (infoError) fail(infoError);
    else success({ size: 4107, digest: "A".repeat(40) });
  },
  getFileSystemManager() {
    return {
      getSavedFileList({ success, fail }) {
        if (savedFileListError) fail(savedFileListError);
        else success({ fileList: savedFileEntries });
      },
      access({ path: filePath, success, fail }) {
        if (accessError) fail(accessError);
        else if (files.has(filePath)) success({});
        else fail({ errCode: 1300002, errMsg: `access:fail no such file or directory ${filePath}` });
      },
      unlink({ filePath, success, fail }) {
        removalMethods.push("unlink");
        // 缓存文件与普通临时文件不能再用同一个无条件成功的假文件系统。
        if (filePath.startsWith("wxfile://store/")) return fail({ errCode: 1300013, errMsg: "unlink:fail permission denied" });
        removedPaths.push(filePath);
        if (files.delete(filePath)) success({});
        else fail({ errCode: 1300002, errMsg: `unlink:fail no such file or directory ${filePath}` });
      },
    };
  },
};

const cloudExports = compile("src/services/cloudCheckIn.ts", {}, { wx });
const runtime = compile(
  "src/features/listeningPractice/pendingCheckInRuntime.ts",
  {
    "./pendingCheckInStore": storeExports,
    "../../services/cloudCheckIn": cloudExports,
  },
  { wx, console: diagnosticConsole },
);

(async () => {
  savedFileEntries = [
    { filePath: "wxfile://store/orphan.mp3", size: 80 * 1024 * 1024, createTime: 1 },
    { filePath: "wxfile://store/orphan.mp3", size: 80 * 1024 * 1024, createTime: 1 },
    { filePath: "wxfile://store/indexed.mp3", size: 2 * 1024 * 1024, createTime: 2 },
  ];
  assert.equal(await runtime.getLocalRecordingUsageBytes(), 82 * 1024 * 1024, "未索引 saveFile 也计入且重复路径只统计一次");
  savedFileEntries = [];

  const first = runtime.getPendingCheckInStore();
  assert.strictEqual(
    first,
    runtime.getPendingCheckInStore(),
    "跨页面必须共用同一待上传仓储",
  );
  await first.ready();
  const input = {
    tempFilePath: "wxfile://tmp/current.mp3",
    durationMs: 1234.5,
    fileSizeBytes: 4096,
    context: {
      bookId: "3",
      bookTitle: "CASA 阅读启蒙 1",
      practiceId: "3-page-4",
      practiceIndex: 0,
      pageNumber: 4,
      imageUrl: "https://example.test/page-4.png",
      sectionTitle: "Unit 1 课文",
    },
  };
  const result = await first.saveRecording(input);

  assert.equal(result.persisted, true);
  assert.equal(result.item.localPath, "wxfile://store/1.mp3");
  assert.match(result.item.requestId, /^[0-9a-f]{32}$/);
  assert.equal(files.has("wxfile://tmp/current.mp3"), false);
  assert.equal(files.has(result.item.localPath), true);
  assert.equal(saved.get(storeExports.PENDING_CHECK_IN_STORAGE_KEY).length, 1);
  assert.equal(result.item.fileSizeBytes, 4107, "采用最终保存文件字节数，而非 onStop 的 4096");
  assert.equal(result.item.contentSha1, "a".repeat(40));
  assert.deepEqual(infoPaths, ["wxfile://store/1.mp3"]);

  // 保存已经移动临时文件，后续读取失败也必须保留可恢复的 saved 路径。
  infoError = { errMsg: "getFileInfo:fail temporary read failure" };
  files.add("wxfile://tmp/info-failure.mp3");
  const fallback = await first.saveRecording({ ...input, tempFilePath: "wxfile://tmp/info-failure.mp3" });
  assert.equal(fallback.persisted, true);
  assert.equal(fallback.item.localPath, "wxfile://store/2.mp3");
  assert.equal(fallback.item.fileSizeBytes, 4096);
  assert.equal(fallback.item.contentSha1, undefined);
  assert.equal(files.has("wxfile://tmp/info-failure.mp3"), false);
  assert.equal(saved.get(storeExports.PENDING_CHECK_IN_STORAGE_KEY)[1].localPath, "wxfile://store/2.mp3");
  assert.equal(await first.remove(fallback.item.requestId), true);
  assert.equal(removalMethods.at(-1), "removeSavedFile", "saveFile 保存的录音应使用配套缓存删除接口");

  const alreadyRemoved = [...removedPaths];
  for (const error of [
    { errCode: 1300013, errMsg: "access:fail permission denied" },
    { errno: 1300005, errMsg: "access:fail Input/output error" },
    { errMsg: "access:fail permission denied" },
    { errMsg: "access:fail Input/output error" },
    { errMsg: "plugin not found" },
    { errCode: 1300013, errMsg: "access:fail file not exist" },
  ]) {
    accessError = error;
    await first.cleanup();
    assert.equal(await first.remove(result.item.requestId), false, "无法确认文件状态时不能删除引用");
    assert.equal(first.list().length, 1, "权限、IO或未知错误不能当成文件不存在而清掉录音引用");
    assert.equal(saved.get(storeExports.PENDING_CHECK_IN_STORAGE_KEY).length, 1);
    assert.equal(files.has(result.item.localPath), true);
    assert.deepEqual(removedPaths, alreadyRemoved);
  }

  savedFileEntries = [{ filePath: "wxfile://store/bad.mp3", size: -1, createTime: 1 }];
  await assert.rejects(() => runtime.getLocalRecordingUsageBytes(), /invalid/i, "无效原生大小不能按 0 统计");
  savedFileListError = { errMsg: "getSavedFileList:fail unsupported" };
  await assert.rejects(() => runtime.getLocalRecordingUsageBytes(), "统计 API 失败必须向容量门闩报告未知");
  savedFileListError = null;
  savedFileEntries = [];
  accessError = null;

  assert.equal(await first.remove(result.item.requestId), true);
  assert.equal(files.has(result.item.localPath), false);
  assert.equal(saved.get(storeExports.PENDING_CHECK_IN_STORAGE_KEY).length, 0);

  // 重启后只有索引，没有本次会话的 savedTemporaryIds，仍必须识别为已保存文件。
  files.add(input.tempFilePath);
  const restartRecord = await first.saveRecording(input);
  const restartedRuntime = compile("src/features/listeningPractice/pendingCheckInRuntime.ts", {
    "./pendingCheckInStore": storeExports, "../../services/cloudCheckIn": cloudExports,
  }, { wx, console: diagnosticConsole });
  assert.equal(await restartedRuntime.getPendingCheckInStore().remove(restartRecord.item.requestId), true);
  assert.equal(removalMethods.at(-1), "removeSavedFile");
  assert.equal(files.has(restartRecord.item.localPath), false);
  await first.cleanup();
  assert.equal(first.list().find(item => item.requestId === restartRecord.item.requestId).fileAvailability, "missing");
  assert.equal(await first.remove(restartRecord.item.requestId), true);

  // 日志不能把错误对象内的路径/URL/凭证原样输出，也不能因 console 异常破坏流程。
  const logStart = logs.length;
  runtime.logRecordingDiagnostic("delete.unexpected.failed", { requestId: "b".repeat(32), error: {
    code: "EACCES", message: "permission denied https://private.test/audio?token=secret", filePath: "private-file", shareToken: "secret",
  } });
  assert.equal(logs[logStart][1].recording, "b".repeat(8));
  assert.equal(logs[logStart][1].reason, "permission_denied");
  assert.equal(logs[logStart][1].code, "EACCES");
  assert.equal(JSON.stringify(logs.slice(logStart)).includes("secret"), false);
  const originalWarn = diagnosticConsole.warn;
  diagnosticConsole.warn = () => { throw new Error("console unavailable"); };
  assert.doesNotThrow(() => runtime.logRecordingDiagnostic("delete.unexpected.failed", { error: new Error("test") }));
  diagnosticConsole.warn = originalWarn;

  // 未保存的临时录音与“文件已保存但索引未写入”的录音要走不同接口。
  for (const failure of ["file", "metadata"]) {
    files.add(input.tempFilePath);
    saveError = failure === "file" ? { errMsg: "saveFile:fail quota exceeded" } : null;
    storageError = failure === "metadata" ? new Error("setStorageSync:fail") : null;
    const temporary = await first.saveRecording(input);
    assert.equal(temporary.persisted, false);
    saveError = null;
    storageError = null;
    assert.equal(await first.remove(temporary.item.requestId), true);
    assert.equal(removalMethods.at(-1), failure === "file" ? "unlink" : "removeSavedFile");
    assert.equal(files.has(temporary.item.localPath), false);
  }

  files.add(input.tempFilePath);
  const denied = await first.saveRecording(input);
  removeError = { errCode: 1300013, errMsg: `removeSavedFile:fail permission denied ${denied.item.localPath}`, shareToken: "private-share-token" };
  assert.equal(await first.remove(denied.item.requestId), false);
  assert.equal(first.list().length, 1, "删除确实失败时保留文件引用供重试");
  assert.equal(files.has(denied.item.localPath), true);
  assert.equal(removalMethods.at(-1), "removeSavedFile", "权限错误不能盲目改用另一接口强删");
  assert.ok(logs.some(args => args[0] === "[recording] delete.file.saved.failed" && args[1].code === 1300013), "控制台必须包含失败阶段和原生错误码");
  assert.ok(logs.some(args => args[0] === "[recording] delete.file.failed"), "仓储必须记录删除失败");
  assert.equal(JSON.stringify(logs).includes("private-share-token"), false);
  assert.equal(JSON.stringify(logs).includes(denied.item.localPath), false, "日志不泄露完整录音路径");
  removeError = { errCode: 1300002, errMsg: "removeSavedFile:fail file not exist" };
  disappearDuringRemove = true;
  assert.equal(await first.remove(denied.item.requestId), true, "检查后文件恰好消失应视作删除已完成");
  assert.equal(first.list().length, 0);
  disappearDuringRemove = false;
  removeError = null;

  files.add(input.tempFilePath);
  const metadataDelete = await first.saveRecording(input);
  storageError = new Error("setStorageSync:fail quota exceeded");
  assert.equal(await first.remove(metadataDelete.item.requestId), true, "文件已删除，索引待补写不能误报文件删除失败");
  assert.equal(files.has(metadataDelete.item.localPath), false);
  assert.equal(first.list().length, 0);
  assert.ok(logs.some(args => args[0] === "[recording] delete.metadata.pending"));
  storageError = null;
  assert.equal(await first.remove(metadataDelete.item.requestId), true, "重复删除应幂等，并补写待同步索引");
  assert.equal(saved.get(storeExports.PENDING_CHECK_IN_STORAGE_KEY).length, 0);

  infoError = null;
  for (const error of [
    { errCode: 1300002, errMsg: "access:fail" },
    { errno: 1300002, errMsg: "access:fail" },
    { code: "ENOENT", errMsg: "access:fail" },
    { errMsg: "access:fail no such file or directory wxfile://missing.mp3" },
    { errMsg: "access:fail file wxfile://missing.mp3 not exist" },
  ]) {
    files.add(input.tempFilePath);
    const missing = await first.saveRecording(input);
    files.delete(missing.item.localPath);
    accessError = error;
    await first.cleanup();
    assert.equal(first.list().length, 1, "明确的文件不存在错误也必须保留恢复引用");
    assert.equal(first.list()[0].fileAvailability, "missing");
    assert.equal(saved.get(storeExports.PENDING_CHECK_IN_STORAGE_KEY).length, 1);
    assert.equal(await first.remove(missing.item.requestId), true, "用户仍可显式删除缺失引用");
    assert.equal(saved.get(storeExports.PENDING_CHECK_IN_STORAGE_KEY).length, 0);
    accessError = null;
  }

  console.log("待上传录音运行时测试通过：跨页面单例、saveFile 路径切换与删除正确。");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
