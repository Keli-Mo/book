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
const wx = {
  getStorageSync(key) {
    return saved.get(key);
  },
  setStorageSync(key, value) {
    saved.set(key, JSON.parse(JSON.stringify(value)));
  },
  saveFile({ tempFilePath, success }) {
    saveCount += 1;
    const savedFilePath = `wxfile://store/${saveCount}.mp3`;
    files.delete(tempFilePath);
    files.add(savedFilePath);
    success({ savedFilePath });
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
      access({ path: filePath, success, fail }) {
        if (accessError) fail(accessError);
        else if (files.has(filePath)) success({});
        else fail({ errCode: 1300002, errMsg: `access:fail no such file or directory ${filePath}` });
      },
      unlink({ filePath, success, fail }) {
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
  { wx },
);

(async () => {
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
    assert.equal(first.list().length, 1, "权限、IO或未知错误不能当成文件不存在而清掉录音引用");
    assert.equal(saved.get(storeExports.PENDING_CHECK_IN_STORAGE_KEY).length, 1);
    assert.equal(files.has(result.item.localPath), true);
    assert.deepEqual(removedPaths, alreadyRemoved);
  }
  accessError = null;

  assert.equal(await first.remove(result.item.requestId), true);
  assert.equal(files.has(result.item.localPath), false);
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
    assert.equal(first.list().length, 0, "仅明确的文件不存在错误才能清除无效引用");
    assert.equal(saved.get(storeExports.PENDING_CHECK_IN_STORAGE_KEY).length, 0);
    accessError = null;
  }

  console.log("待上传录音运行时测试通过：跨页面单例、saveFile 路径切换与删除正确。");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
