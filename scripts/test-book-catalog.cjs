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

assert.equal(BOOKS.length, 29, "应展示 29 本真实教材，不包含两张课程海报");
assert.deepEqual(
  Array.from(BOOKS, (book) => Number(book.id)),
  Array.from({ length: 29 }, (_, index) => index + 3),
  "教材 ID 应连续覆盖 3–31",
);
assert.ok(
  BOOKS.every((book) => book.cover.startsWith("https://")),
  "教材目录中的封面 URL 应全部使用 HTTPS",
);
assert.deepEqual(
  Array.from(BOOKS.filter((book) => book.available), (book) => book.id),
  Array.from({ length: 29 }, (_, index) => String(index + 3)),
  "ID 3–31 的 29 本教材都应开放跟读",
);
assert.equal(BOOK_SERIES.length, 6, "首页应展示 6 个教材系列");
assert.deepEqual(
  Object.fromEntries(
    Array.from(BOOK_SERIES, (series) => [series.id, series.availableCount]),
  ),
  {
    casa: 4,
    "our-world": 4,
    "oxford-discover": 7,
    "reading-explorer": 6,
    cambridge: 4,
    think: 4,
  },
  "六个系列的开放数量应与各自教材数量一致",
);
assert.deepEqual(
  Array.from(filterBooks(BOOKS, "oxford-discover", ""), (book) => book.id),
  ["15", "16", "17", "18", "19", "30", "31"],
  "Oxford Discover 1–6 学生书及 Level 6 练习册应归于同一系列",
);
assert.deepEqual(
  Array.from(filterBooks(BOOKS, "oxford-discover", "Level 6"), (book) => book.id),
  ["30", "31"],
  "Oxford Discover 可按 Level 6 找到学生书和练习册",
);
const oxfordSeries = BOOK_SERIES.find((series) => series.id === "oxford-discover");
assert.equal(oxfordSeries.rangeLabel, "Level 1–6");
assert.equal(
  oxfordSeries.cover,
  "https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/oxford-discover-2e-l6/student-book/pages/od6-sb_0.jpg",
  "Oxford Discover 系列卡应使用 Level 6 学生书封面",
);
assert.deepEqual(
  Array.from(filterBooks(BOOKS, "think", ""), (book) => book.id),
  ["26", "27", "28", "29"],
  "Think 1 与 Think 2 的学生书和练习册应归于同一系列",
);
assert.deepEqual(
  Array.from(filterBooks(BOOKS, "all", "美国思维"), (book) => book.id),
  ["26", "27", "28", "29"],
  "中文教材名应能找到四本 Think",
);
assert.deepEqual(
  Array.from(filterBooks(BOOKS, "think", "Level 2"), (book) => book.id),
  ["28", "29"],
  "Think 系列可按 Level 2 搜索新增两书",
);
assert.deepEqual(
  Array.from(BOOKS.filter(({ id }) => id === "28" || id === "29"), ({ id, kind, cover }) => ({ id, kind, cover })),
  [
    {
      id: "28",
      kind: "学生书",
      cover: "https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/think-l2/student-book/pages/think-2-sb_0.jpg",
    },
    {
      id: "29",
      kind: "练习册",
      cover: "https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/think-l2/workbook/pages/think-2-wb_0.jpg",
    },
  ],
  "Think 2 两册应使用各自的云端 PDF 封面",
);
assert.deepEqual(
  Array.from(BOOKS.filter(({ id }) => id === "30" || id === "31"), ({ id, title, level, kind, cover }) => ({
    id, title, level, kind, cover,
  })),
  [
    {
      id: "30",
      title: "Oxford Discover 6",
      level: "Level 6",
      kind: "学生用书",
      cover: "https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/oxford-discover-2e-l6/student-book/pages/od6-sb_0.jpg",
    },
    {
      id: "31",
      title: "Oxford Discover 6 · 练习册",
      level: "Level 6",
      kind: "练习册",
      cover: "https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/oxford-discover-2e-l6/workbook/pages/od6-wb_0.jpg",
    },
  ],
  "Oxford Discover 6 两册应使用各自的云端 PDF 封面",
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
  { type: "practice", url: "/pages/Practice/Practice?bookId=3&page=0" },
  "CASA 第 1 册应显式带上教材 ID 进入跟读页",
);
assert.deepEqual(
  JSON.parse(JSON.stringify(resolveBookAction(BOOKS[22]))),
  { type: "practice", url: "/pages/Practice/Practice?bookId=25&page=0" },
  "ID 25 应使用其自身教材 ID 进入跟读页",
);
assert.deepEqual(
  JSON.parse(JSON.stringify(resolveBookAction(BOOKS.find(({ id }) => id === "26")))),
  { type: "reader", url: "/pages/ThinkBookReader/ThinkBookReader?bookId=26&page=0" },
  "Think 1 学生书应从封面进入完整阅读页",
);
assert.deepEqual(
  JSON.parse(JSON.stringify(resolveBookAction(BOOKS.find(({ id }) => id === "27")))),
  { type: "reader", url: "/pages/ThinkBookReader/ThinkBookReader?bookId=27&page=0" },
  "Think 1 练习册应从封面进入完整阅读页",
);
for (const id of ["28", "29"]) {
  const book = BOOKS.find((item) => item.id === id);
  assert.deepEqual(
    JSON.parse(JSON.stringify(resolveBookAction(book))),
    { type: "reader", url: `/pages/ThinkBookReader/ThinkBookReader?bookId=${id}&page=0` },
    `Think 2 教材 ${id} 应从封面进入阅读页`,
  );
}
assert.deepEqual(
  Array.from(BOOKS.filter((book) => book.seriesId !== "think"), (book) => resolveBookAction(book).url),
  Array.from(
    BOOKS.filter((book) => book.seriesId !== "think"),
    (book) =>
      `/pages/Practice/Practice?bookId=${encodeURIComponent(book.id)}&page=0`,
  ),
  "普通教材应从原图片第 0 张进入完整训练页",
);

console.log("教材目录测试通过：29 本教材、6 个系列、开放状态、路由和搜索筛选均正确。");
