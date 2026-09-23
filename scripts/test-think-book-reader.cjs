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
  "Think 1 音频题阅读模型应存在",
);

const { buildThinkBookReader, parseThinkReaderPage, resolveThinkReaderPage } = loadSource(readerPath);
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

const studentContinuationPages = [
  13, 21, 27, 31, 39, 45, 49, 57, 63,
  67, 75, 81, 85, 93, 99, 103, 111, 117,
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
const turnToSource = readerComponent.split("const turnTo =")[1]?.split("const openPractice =")[0];
assert.ok(turnToSource, "阅读页应有翻页处理");
assert.doesNotMatch(turnToSource, /audioController\.current\?\.stop\(\)/,
  "翻页时正在播放的音频应继续");
assert.match(readerComponent, /useDidHide\(\(\) => \{\s*audioController\.current\?\.stop\(\)/,
  "阅读页隐藏后仍应停止播放");
assert.match(readerComponent, /const openPractice = \(\) => \{\s*audioController\.current\?\.stop\(\)/,
  "进入跟读前仍应停止播放");
assert.match(readerComponent, /停止当前音频/, "无本页音轨的续页应能停止跨页播放");
assert.match(readerComponent, /activeTrack\?\.url === track\.url/, "复用同一音源的跨页图标应显示播放态");
assert.match(readerComponent, /&page=\$\{page\.imageIndex\}/, "分享链接应保留原 PDF 图片索引");

console.log("Think 1 音频题阅读模型验证通过：127 页、109 个音频页及跨页/播放契约。");
