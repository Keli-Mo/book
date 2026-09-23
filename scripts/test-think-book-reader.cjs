const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const projectRoot = path.resolve(__dirname, "..");
const readerPath = "src/features/bookLibrary/thinkBookReader.ts";
const aliasPaths = {
  "@/features/bookLibrary/bookCatalog": "src/features/bookLibrary/bookCatalog.ts",
  "@/features/listeningPractice/bookPractice": "src/features/listeningPractice/bookPractice.ts",
  "@/pages/BookDetail/Components/BookPreview/constants/images": "src/pages/BookDetail/Components/BookPreview/constants/images.ts",
  "@/pages/BookDetail/Components/BookPreview/constants/audioList": "src/pages/BookDetail/Components/BookPreview/constants/audioList.ts",
  "@/pages/BookDetail/Components/BookPreview/constants/catalogList": "src/pages/BookDetail/Components/BookPreview/constants/catalogList.ts",
};
const loaded = new Map();

const loadSource = (relativePath) => {
  if (loaded.has(relativePath)) return loaded.get(relativePath);
  const source = fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const loadedModule = { exports: {} };
  loaded.set(relativePath, loadedModule.exports);
  new Function("module", "exports", "require", compiled)(
    loadedModule,
    loadedModule.exports,
    (request) => {
      const dependencyPath = aliasPaths[request];
      if (!dependencyPath) throw new Error(`未支持的模块依赖：${request}`);
      return loadSource(dependencyPath);
    },
  );
  return loadedModule.exports;
};

assert.equal(
  fs.existsSync(path.join(projectRoot, readerPath)),
  true,
  "Think 1 完整阅读模型应存在",
);

const { buildThinkBookReader, parseThinkReaderPage } = loadSource(readerPath);
const { buildBookPracticeBundle } = loadSource(
  "src/features/listeningPractice/bookPractice.ts",
);
const { concatImages } = loadSource(
  "src/pages/BookDetail/Components/BookPreview/constants/images.ts",
);
const { catalogLists } = loadSource(
  "src/pages/BookDetail/Components/BookPreview/constants/catalogList.ts",
);

assert.equal(buildThinkBookReader("3"), null, "旧教材不进入 Think 专用阅读器");
assert.equal(buildThinkBookReader("missing"), null, "未知教材不进入阅读器");

for (const [bookId, pageCount, practiceCount] of [
  ["26", 132, 71],
  ["27", 126, 37],
]) {
  const reader = buildThinkBookReader(bookId);
  const bundle = buildBookPracticeBundle(bookId);
  assert.ok(reader, `教材 ${bookId} 应有阅读模型`);
  assert.equal(reader.book.id, bookId);
  assert.equal(reader.pages.length, pageCount, `教材 ${bookId} 应呈现所有 PDF 页面`);
  assert.equal(bundle.practices.length, practiceCount);
  assert.deepEqual(
    reader.chapters,
    catalogLists[bookId].map(({ name, page }) => ({ name, imageIndex: page })),
    `教材 ${bookId} 的章节应指向图片索引`,
  );

  const practiceByImageIndex = new Map(
    bundle.practices.map((practice, index) => [practice.imageIndex, { practice, index }]),
  );
  for (const [imageIndex, page] of reader.pages.entries()) {
    const indexedPractice = practiceByImageIndex.get(imageIndex);
    const section = [...reader.chapters].reverse().find((item) => item.imageIndex <= imageIndex);
    assert.equal(page.imageIndex, imageIndex);
    assert.equal(page.imageUrl, concatImages[bookId][imageIndex]);
    assert.equal(page.sectionTitle, section?.name || "课程导入");
    assert.equal(page.practiceIndex, indexedPractice?.index ?? null);
    assert.deepEqual(page.tracks, indexedPractice?.practice.tracks || []);
  }
  assert.equal(
    reader.pages.filter((page) => page.practiceIndex !== null).length,
    practiceCount,
    `教材 ${bookId} 的训练索引只对应有音频的页面`,
  );
}

const student = buildThinkBookReader("26");
const workbook = buildThinkBookReader("27");
assert.equal(student.pages[0].pageLabel, "封面");
assert.deepEqual(
  student.pages.slice(1, 4).map((page) => page.pageLabel),
  ["前置页 1", "前置页 2", "前置页 3"],
  "学生书前置页不应误写成印刷页号",
);
assert.equal(student.pages[4].pageLabel, "第 4 页");
assert.equal(student.pages[131].pageLabel, "第 131 页");
assert.equal(student.pages[15].tracks.length, 2, "学生书同页重复音频图标仍应保留");
assert.equal(workbook.pages[0].pageLabel, "封面");
assert.equal(workbook.pages[1].pageLabel, "第 4 页", "练习册印刷页码比图片索引多 3");
assert.equal(workbook.pages[125].pageLabel, "第 128 页");
assert.equal(workbook.pages[7].sectionTitle, "Unit 1");
assert.equal(workbook.pages[6].sectionTitle, "Welcome");

for (const [raw, count, expected] of [
  ["0", 132, 0],
  ["15", 132, 15],
  [125, 126, 125],
  ["131", 132, 131],
  [undefined, 132, null],
  [null, 132, null],
  ["", 132, null],
  ["01", 132, null],
  ["1.5", 132, null],
  ["-1", 132, null],
  ["132", 132, null],
  [Infinity, 132, null],
  [["2"], 132, null],
  ["2", 0, null],
]) {
  assert.equal(parseThinkReaderPage(raw, count), expected, `页码 ${String(raw)} 应安全解析`);
}

console.log("Think 1 完整阅读模型验证通过：258 页、108 个音频页及页码边界。");
