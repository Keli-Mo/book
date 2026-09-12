/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const compiled = new Map();
const load = (file, overrides = {}, cache = new Map()) => {
  if (cache.has(file)) return cache.get(file);
  if (!compiled.has(file)) {
    compiled.set(file, ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText);
  }
  const module = { exports: {} };
  cache.set(file, module.exports);
  new Function("module", "exports", "require", compiled.get(file))(module, module.exports, (request) => {
    if (Object.hasOwn(overrides, request)) return overrides[request];
    if (request.startsWith("@/") || request.startsWith(".")) {
      const base = request.startsWith("@/") ? `src/${request.slice(2)}` : path.join(path.dirname(file), request);
      const target = [base, `${base}.ts`, `${base}.tsx`].find((candidate) => fs.existsSync(path.join(root, candidate)));
      assert.ok(target, `依赖必须存在：${request}`);
      return load(target, overrides, cache);
    }
    return require(request);
  });
  return module.exports;
};

const createStore = (initial, options = {}) => {
  let value = initial;
  const taro = {
    getStorageSync(key) {
      assert.equal(key, "haisha:reading-progress:v1");
      if (options.readThrows) throw new Error("storage unavailable");
      return value;
    },
    setStorageSync(key, next) {
      assert.equal(key, "haisha:reading-progress:v1");
      if (options.writeThrows) throw new Error("storage full");
      value = next;
    },
  };
  return { taro, get value() { return value; } };
};
const api = (store) => load("src/features/bookLibrary/readingProgress.ts", { "@tarojs/taro": { default: store.taro } }, new Map());

{
  const store = createStore(undefined);
  const progress = api(store);
  assert.equal(progress.readReadingProgress(), null, "空历史必须返回 null");
  assert.equal(progress.saveReadingProgress("3", 1), true, "合法教材页应保存成功");
  assert.deepEqual(store.value, { version: 1, bookId: "3", practiceIndex: 1 });
  assert.deepEqual(progress.readReadingProgress(), store.value, "保存后应读回同一本书和真实训练页");
}

for (const invalid of [
  "broken", {}, { version: 2, bookId: "3", practiceIndex: 0 },
  { version: 1, bookId: "missing", practiceIndex: 0 },
  { version: 1, bookId: "3", practiceIndex: 1.5 },
  { version: 1, bookId: "3", practiceIndex: -1 },
  { version: 1, bookId: "3", practiceIndex: 999999 },
]) {
  assert.equal(api(createStore(invalid)).readReadingProgress(), null, `损坏进度必须忽略：${JSON.stringify(invalid)}`);
}

assert.equal(api(createStore(null, { readThrows: true })).readReadingProgress(), null, "读取异常不得阻断页面");
assert.equal(api(createStore(null, { writeThrows: true })).saveReadingProgress("3", 0), false, "写入异常不得阻断切页");
assert.equal(api(createStore(null)).saveReadingProgress("missing", 0), false, "未知教材不得写入");
assert.equal(api(createStore(null)).saveReadingProgress("3", 999999), false, "越界页码不得写入");

console.log("阅读进度测试通过：合法位置可读写，损坏、越界及 Storage 故障均安全降级。");
