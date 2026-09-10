/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const sourcePath = path.resolve(
  __dirname,
  "../src/features/bookLibrary/bookCatalog.ts",
);

assert.equal(fs.existsSync(sourcePath), true, "教材目录模型文件应存在");

const compiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2017,
  },
});
const moduleContainer = { exports: {} };

vm.runInNewContext(compiled.outputText, {
  module: moduleContainer,
  exports: moduleContainer.exports,
});

const { BOOKS, BOOK_SERIES, filterBooks, resolveBookAction } =
  moduleContainer.exports;

assert.equal(BOOKS.length, 23, "应展示 23 本真实教材，不包含两张课程海报");
assert.deepEqual(
  Array.from(BOOKS, (book) => Number(book.id)),
  Array.from({ length: 23 }, (_, index) => index + 3),
  "教材 ID 应与现有详情页的 3–25 保持一致",
);
assert.ok(
  BOOKS.every((book) => book.cover.startsWith("https://")),
  "教材目录中的封面 URL 应全部使用 HTTPS",
);
assert.deepEqual(
  Array.from(BOOKS.filter((book) => book.available), (book) => book.id),
  Array.from({ length: 23 }, (_, index) => String(index + 3)),
  "ID 3–25 的 23 本教材都应开放跟读",
);
assert.equal(BOOK_SERIES.length, 5, "首页应展示 5 个教材系列");
assert.deepEqual(
  Object.fromEntries(
    Array.from(BOOK_SERIES, (series) => [series.id, series.availableCount]),
  ),
  {
    casa: 4,
    "our-world": 4,
    "oxford-discover": 5,
    "reading-explorer": 6,
    cambridge: 4,
  },
  "五个系列的开放数量应与各自教材数量一致",
);

assert.deepEqual(
  Array.from(filterBooks(BOOKS, "reading-explorer", ""), (book) => book.id),
  ["20", "21", "22", "23", "24", "25"],
  "系列筛选应返回 Reading Explorer 全部 6 册",
);
assert.deepEqual(
  Array.from(filterBooks(BOOKS, "all", "KET"), (book) => book.id),
  ["9", "10"],
  "搜索应忽略大小写，并匹配书名",
);
assert.deepEqual(
  Array.from(filterBooks(BOOKS, "our-world", "练习册"), (book) => book.id),
  ["12", "14"],
  "搜索与系列筛选应能组合使用",
);
assert.deepEqual(
  JSON.parse(JSON.stringify(resolveBookAction(BOOKS[0]))),
  { type: "practice", url: "/pages/Practice/Practice?bookId=3&practice=0" },
  "CASA 第 1 册应显式带上教材 ID 进入跟读页",
);
assert.deepEqual(
  JSON.parse(JSON.stringify(resolveBookAction(BOOKS[22]))),
  { type: "practice", url: "/pages/Practice/Practice?bookId=25&practice=0" },
  "ID 25 应使用其自身教材 ID 进入跟读页",
);
assert.deepEqual(
  Array.from(BOOKS, (book) => resolveBookAction(book).url),
  Array.from(
    BOOKS,
    (book) =>
      `/pages/Practice/Practice?bookId=${encodeURIComponent(book.id)}&practice=0`,
  ),
  "每本教材都应生成带自身编码 ID 的跟读路由",
);

console.log("教材目录测试通过：23 本教材、5 个系列、开放状态、路由和搜索筛选均正确。");
