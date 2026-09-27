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

const { buildBookPracticeBundle, buildFullBookPracticeBundle } = load("src/features/listeningPractice/bookPractice.ts");
assert.equal(typeof api(createStore(null)).saveFullReadingProgress, "function", "全页进度应使用独立的稳定图片索引 API");

for (let id = 3; id <= 29; id += 1) {
  const bookId = String(id);
  const legacy = buildBookPracticeBundle(bookId);
  const full = buildFullBookPracticeBundle(bookId);
  for (const practiceIndex of [0, Math.floor(legacy.practices.length / 2), legacy.practices.length - 1]) {
    const stored = { version: 1, bookId, practiceIndex };
    const store = createStore(stored);
    const progress = api(store);
    const practice = legacy.practices[practiceIndex];
    assert.deepEqual(progress.readReadingProgress(), stored, "读取旧进度不能改写或升级存储");
    assert.equal(store.value, stored);
    assert.deepEqual(progress.resolveReadingProgressPractice(stored), practice, "旧索引必须保持原音频教材页");
    assert.equal(progress.resolveReadingProgressUrl(stored), legacy.book.seriesId === "think"
      ? `/pages/ThinkBookReader/ThinkBookReader?bookId=${bookId}&page=${practice.imageIndex}`
      : `/pages/Practice/Practice?bookId=${bookId}&practice=${practiceIndex}`);
  }
  const silentPage = full.practices.find((practice) => practice.tracks.length === 0);
  const imageIndices = new Set([0, silentPage?.imageIndex ?? 0, full.practices.at(-1).imageIndex]);
  for (const imageIndex of imageIndices) {
    const store = createStore(null);
    const progress = api(store);
    const stored = { version: 2, bookId, imageIndex };
    assert.equal(progress.saveFullReadingProgress(bookId, imageIndex), true);
    assert.deepEqual(store.value, stored, "新增页也应按原图片位置保存进度");
    assert.deepEqual(progress.readReadingProgress(), stored);
    assert.deepEqual(progress.resolveReadingProgressPractice(stored), full.practices.find((practice) => practice.imageIndex === imageIndex));
    assert.equal(progress.resolveReadingProgressUrl(stored), full.book.seriesId === "think"
      ? `/pages/ThinkBookReader/ThinkBookReader?bookId=${bookId}&page=${imageIndex}`
      : `/pages/Practice/Practice?bookId=${bookId}&page=${imageIndex}`);
  }
}

for (const invalid of [
  { version: 2, bookId: "3", imageIndex: -1 },
  { version: 2, bookId: "3", imageIndex: 1.5 },
  { version: 2, bookId: "3", imageIndex: "0" },
  { version: 2, bookId: "3", imageIndex: NaN },
  { version: 2, bookId: "3", imageIndex: Infinity },
  { version: 2, bookId: "3", imageIndex: 999999 },
  { version: 2, bookId: "missing", imageIndex: 0 },
  { version: 3, bookId: "3", imageIndex: 0 },
]) {
  const progress = api(createStore(invalid));
  assert.equal(progress.readReadingProgress(), null);
  assert.equal(progress.resolveReadingProgressPractice(invalid), null);
  assert.equal(progress.resolveReadingProgressUrl(invalid), null);
}
assert.equal(api(createStore(null, { writeThrows: true })).saveFullReadingProgress("3", 0), false);
assert.equal(api(createStore(null)).saveFullReadingProgress("missing", 0), false);
assert.equal(api(createStore(null)).saveFullReadingProgress("3", -1), false);
assert.equal(api(createStore(null)).saveFullReadingProgress("3", 999999), false);

console.log("阅读进度测试通过：27 册旧音频进度保持原页，全页稳定索引、无音频页及损坏/Storage 故障均正确。");
