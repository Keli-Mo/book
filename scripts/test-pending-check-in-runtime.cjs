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
  getFileSystemManager() {
    return {
      access({ path: filePath, success, fail }) {
        if (files.has(filePath)) success({});
        else fail({ errMsg: "not found" });
      },
      unlink({ filePath, success, fail }) {
        if (files.delete(filePath)) success({});
        else fail({ errMsg: "not found" });
      },
    };
  },
};

const runtime = compile(
  "src/features/listeningPractice/pendingCheckInRuntime.ts",
  { "./pendingCheckInStore": storeExports },
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
  const result = await first.saveRecording({
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
  });

  assert.equal(result.persisted, true);
  assert.equal(result.item.localPath, "wxfile://store/1.mp3");
  assert.match(result.item.requestId, /^[0-9a-f]{32}$/);
  assert.equal(files.has("wxfile://tmp/current.mp3"), false);
  assert.equal(files.has(result.item.localPath), true);
  assert.equal(saved.get(storeExports.PENDING_CHECK_IN_STORAGE_KEY).length, 1);

  assert.equal(await first.remove(result.item.requestId), true);
  assert.equal(files.has(result.item.localPath), false);
  assert.equal(saved.get(storeExports.PENDING_CHECK_IN_STORAGE_KEY).length, 0);

  console.log("待上传录音运行时测试通过：跨页面单例、saveFile 路径切换与删除正确。");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
