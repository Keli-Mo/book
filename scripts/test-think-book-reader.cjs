/* eslint-disable import/no-commonjs */
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
  "Think 音频题阅读模型应存在",
);

const {
  buildThinkBookReader,
  buildThinkPracticeBundle,
  parseThinkReaderPage,
  resolveThinkReaderPage,
} = loadSource(readerPath);
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
assert.ok(buildThinkBookReader("28"), "Think 2 学生书应进入 Think 阅读器");
assert.ok(buildThinkBookReader("29"), "Think 2 练习册应进入 Think 阅读器");

const studentContinuationPages = [
  13, 21, 27, 31, 39, 45, 49, 57, 63,
  67, 75, 81, 85, 93, 99, 103, 111, 117,
];
const think2StudentContinuationPages = [
  13, 21, 27, 31, 39, 45, 49, 57, 63, 67,
  75, 81, 85, 93, 99, 103, 111, 117,
];

for (const [bookId, pageCount, practiceCount] of [
  ["26", 89, 71],
  ["27", 38, 38],
]) {
  const reader = buildThinkBookReader(bookId);
  const bundle = buildBookPracticeBundle(bookId);
  assert.ok(reader, `教材 ${bookId} 应有阅读模型`);
  assert.equal(reader.book.id, bookId);
  assert.equal(reader.sourcePageCount, concatImages[bookId].length);
  assert.equal(reader.pages.length, pageCount, `教材 ${bookId} 只呈现音频题及跨页内容`);
  assert.equal(bundle.practices.length, practiceCount);
  const expectedImageIndices = [...new Set([
    ...bundle.practices.map((practice) => practice.imageIndex),
    ...(bookId === "26" ? studentContinuationPages : []),
  ])].sort((left, right) => left - right);
  assert.deepEqual(
    reader.pages.map((page) => page.imageIndex),
    expectedImageIndices,
    `教材 ${bookId} 应只保留经核验的音频题与续页，且保持原页序`,
  );
  const expectedChapters = catalogLists[bookId].flatMap(({ name, page }, catalogIndex) => {
    const nextSection = catalogLists[bookId][catalogIndex + 1]?.page ?? concatImages[bookId].length;
    const pageIndex = expectedImageIndices.findIndex((imageIndex) =>
      imageIndex >= page && imageIndex < nextSection,
    );
    return pageIndex < 0 ? [] : [{ name, imageIndex: expectedImageIndices[pageIndex], pageIndex }];
  });
  assert.deepEqual(reader.chapters, expectedChapters, `教材 ${bookId} 目录应跳到保留页`);

  const practiceByImageIndex = new Map(
    bundle.practices.map((practice, index) => [practice.imageIndex, { practice, index }]),
  );
  for (const page of reader.pages) {
    const { imageIndex } = page;
    const indexedPractice = practiceByImageIndex.get(imageIndex);
    const relatedPractice = indexedPractice ?? practiceByImageIndex.get(imageIndex - 1);
    const section = [...catalogLists[bookId]].reverse().find((item) => item.page <= imageIndex);
    assert.equal(page.imageUrl, concatImages[bookId][imageIndex]);
    assert.equal(page.pageNumber, Number(page.pageLabel.match(/\d+/)?.[0]), "阅读页应提供印刷页号");
    assert.equal(page.sectionTitle, section?.name || "课程导入");
    assert.equal(page.practiceIndex, relatedPractice?.index, "续页跟读应回到前页音频题");
    assert.deepEqual(page.tracks, indexedPractice?.practice.tracks || []);
  }
  assert.equal(
    reader.pages.filter((page) => page.tracks.length > 0).length,
    practiceCount,
    `教材 ${bookId} 的图标页应与音频训练页一致`,
  );
}

const student = buildThinkBookReader("26");
const workbook = buildThinkBookReader("27");
assert.equal(student.pages[0].pageLabel, "第 4 页");
assert.equal(workbook.pages[0].pageLabel, "第 4 页");
assert.equal(workbook.pages.find((page) => page.imageIndex === 2).pageLabel, "第 5 页");
assert.equal(workbook.pages.find((page) => page.imageIndex === 114).pageLabel, "第 117 页");
assert.equal(student.pages.find((page) => page.imageIndex === 15).tracks.length, 2,
  "学生书同页重复音频图标仍应保留");
assert.equal(student.pages.some((page) => page.imageIndex === 130), false,
  "不涉及音频题的学生书页应隐藏");
assert.equal(workbook.pages.some((page) => page.imageIndex === 125), false,
  "不规则动词表不涉及音频题，应隐藏");
assert.equal(workbook.pages[workbook.chapters.find((chapter) => chapter.name === "Unit 1").pageIndex].sectionTitle,
  "Unit 1");
assert.equal(workbook.pages[workbook.chapters.find((chapter) => chapter.name === "Welcome").pageIndex].sectionTitle,
  "Welcome");

for (const [book, printedPage] of [[student, 4], [workbook, 4]]) {
  const page = book.pages.find((item) => item.pageLabel === `第 ${printedPage} 页`);
  assert.ok(page);
  assert.ok(page.tracks.every((track) => !track.url.endsWith("p004_t00.mp3")),
    "第 4 页非正式的 W.00 音频不应出现");
}
assert.equal(workbook.pages.find((page) => page.pageLabel === "第 5 页").tracks.length, 2,
  "练习册第 5 页两处 W.01 均应可点击");
assert.ok(workbook.pages.find((page) => page.pageLabel === "第 117 页").tracks[0].url.endsWith("p116_t05.mp3"),
  "练习册 12.05 文件名虽写 p116，实际应放在第 117 页");
assert.ok(workbook.pages.find((page) => page.pageLabel === "第 116 页").tracks.every((track) =>
  track.url.endsWith("p116_t04.mp3")), "练习册第 116 页两处 12.04 均复用同一音频");

const think2Student = buildThinkBookReader("28");
const think2Workbook = buildThinkBookReader("29");
assert.deepEqual(
  think2Student.pages.filter((page) => page.tracks.length === 0).map((page) => page.imageIndex),
  think2StudentContinuationPages,
  "Think 2 学生书应保留逐页核验的 18 张跨页听读/理解续页",
);
assert.equal(think2Student.pages.length, 81, "Think 2 学生书应保留 63 张音频题页和 18 张续页");
assert.equal(think2Workbook.pages.length, 36, "Think 2 练习册应只保留 36 张音频题页");
assert.equal(think2Student.pages[0].pageLabel, "第 5 页", "Think 2 学生书应从首张正式音频题开始");
assert.equal(think2Workbook.pages[0].pageLabel, "第 5 页", "Think 2 练习册应从首张正式音频题开始");
assert.equal(think2Workbook.pages.find((page) => page.imageIndex === 114).pageLabel, "第 117 页");
assert.ok(think2Student.pages.some((page) => page.imageIndex === 120),
  "Think 2 学生书后附发音题 p120 必须保留");
assert.ok(think2Student.pages.some((page) => page.imageIndex === 121),
  "Think 2 学生书后附发音题 p121 必须保留");

for (const [bookId, expectedCount] of [["26", 89], ["27", 38], ["28", 81], ["29", 36]]) {
  const reader = buildThinkBookReader(bookId);
  const originalBundle = buildBookPracticeBundle(bookId);
  const bundle = buildThinkPracticeBundle(reader);
  assert.equal(bundle.book.id, bookId);
  assert.equal(bundle.coverUrl, reader.book.cover);
  assert.equal(bundle.practices.length, expectedCount, `Think ${bookId} 应将每张保留页变成训练页`);
  assert.deepEqual(bundle.practices.map((practice) => practice.imageIndex),
    reader.pages.map((page) => page.imageIndex), "训练顺序应与筛选后的阅读页一致");
  const originalByImageIndex = new Map(originalBundle.practices.map((practice) => [practice.imageIndex, practice]));
  for (const [index, page] of reader.pages.entries()) {
    const practice = bundle.practices[index];
    assert.equal(practice.id, `${bookId}-page-${page.pageNumber}`, "训练页 ID 应稳定且唯一");
    assert.equal(practice.bookId, bookId);
    assert.equal(practice.imageUrl, page.imageUrl);
    assert.equal(practice.pageNumber, page.pageNumber, "训练页应使用 PDF 印刷页号");
    assert.equal(practice.sectionTitle, page.sectionTitle);
    const original = originalByImageIndex.get(page.imageIndex);
    if (original) {
      assert.deepEqual(practice, original, "正式音频页应保留原有 ID 和音轨数据");
    } else {
      assert.deepEqual(practice.tracks, [], "跨页续页应不显示音频图标");
    }
  }
  assert.equal(new Set(bundle.practices.map((practice) => practice.id)).size, expectedCount,
    "每张训练页的 ID 应唯一");
  assert.deepEqual(buildThinkPracticeBundle(reader).practices.map((practice) => practice.id),
    bundle.practices.map((practice) => practice.id), "相同阅读模型再次适配应得到稳定 ID");
}

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
assert.equal(resolveThinkReaderPage("0", student), 0, "书架入口仍从首张音频页进入");
for (const [reader, originalImageIndex] of [
  [student, 4], [student, 13], [student, 15], [workbook, 2], [workbook, 114],
]) {
  const resolved = resolveThinkReaderPage(String(originalImageIndex), reader);
  assert.equal(reader.pages[resolved].imageIndex, originalImageIndex,
    "旧分享链接和新分享链接都应指向原 PDF 的同一张保留页");
}
assert.equal(resolveThinkReaderPage("130", student), student.pages.length - 1,
  "旧分享链接指向已隐藏的末尾页面时回到最后保留页");
assert.equal(workbook.pages[resolveThinkReaderPage("3", workbook)].imageIndex, 3,
  "旧分享链接指向练习册第 4 页时仍打开第 4 页");
assert.equal(resolveThinkReaderPage("132", student), null, "原 PDF 越界页号应拒绝");

const readerComponent = fs.readFileSync(path.join(projectRoot, "src/pages/ThinkBookReader/ThinkBookReader.tsx"), "utf8");
assert.match(readerComponent, /title='听力跟读训练'/, "Think 阅读页应使用现有跟读导航标题");
assert.match(readerComponent, /import \{ PracticeSession \} from "\.\.\/Practice\/Practice"/,
  "Think 阅读页应复用现有跟读页面组件");
assert.match(readerComponent, /import "\.\.\/Practice\/Practice\.scss"/,
  "Think 阅读页应沿用现有跟读样式");
assert.match(readerComponent, /bundle=\{bundle\}/, "Think 阅读页应将保留页适配为跟读数据");
assert.match(readerComponent, /keepModelAudioOnTurn/, "Think 翻页时示范音频应继续播放");
assert.match(readerComponent, /persistReadingProgress=\{false\}/,
  "Think 筛选页索引不能写入旧训练进度空间");
assert.match(readerComponent, /&page=\$\{page\.imageIndex\}/, "分享链接应保留原 PDF 图片索引");

console.log("Think 1/2 音频题阅读模型验证通过：244 页、208 个音频页及跨页/播放契约。");
