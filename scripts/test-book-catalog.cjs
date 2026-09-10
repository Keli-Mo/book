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
  ["3"],
  "当前只能开放 CASA 第 1 册",
);
assert.equal(BOOK_SERIES.length, 5, "首页应展示 5 个教材系列");

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
  { type: "practice", url: "/pages/Practice/Practice?practice=0" },
  "CASA 第 1 册应进入现有跟读页",
);
assert.deepEqual(
  JSON.parse(JSON.stringify(resolveBookAction(BOOKS[1]))),
  {
    type: "unavailable",
    message: "这本教材正在核对页面与音频，暂未开放",
  },
  "其他教材必须停留在书架并提示未开放",
);

console.log("教材目录测试通过：23 本教材、5 个系列、开放状态和搜索筛选均正确。");
