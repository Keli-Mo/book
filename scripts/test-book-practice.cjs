const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");
const { validateBookData } = require("./validate-book-audio-map.cjs");

const projectRoot = path.resolve(__dirname, "..");
const constantsRoot = path.join(
  projectRoot,
  "src/pages/BookDetail/Components/BookPreview/constants",
);
const BOOK_IDS = Array.from({ length: 23 }, (_, index) => String(index + 3));
const EXPECTED_PRACTICE_COUNTS = [
  100, 96, 96, 96, 54, 12, 67, 14, 85, 64, 56, 39, 99, 99, 90, 90, 93, 24,
  24, 24, 24, 24, 24,
];
const COVER_WHITELIST = {
  11: "OW_2E_L1_Studentbook.png",
  12: "OW_L1_Workbook.png",
  13: "OW_Starter_Studentbook.png",
  14: "OW_Starter_Workbook-1.png",
};

const loadTypeScriptConstants = (filename) => {
  const source = fs.readFileSync(path.join(constantsRoot, filename), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const loadedModule = { exports: {} };
  new Function("module", "exports", "require", output)(
    loadedModule,
    loadedModule.exports,
    require,
  );
  return loadedModule.exports;
};

const parseImagePageNumber = (imageUrl) => {
  const decodedUrl = decodeURIComponent(imageUrl.split("?")[0]);
  const match = decodedUrl.match(/_(\d+)\.(?:png|jpe?g|webp)$/i);
  return match ? Number(match[1]) : null;
};

const assertHttpsUrl = (url, message) => {
  const parsedUrl = new URL(url);
  assert.equal(parsedUrl.protocol, "https:", message);
};

const { concatImages } = loadTypeScriptConstants("images.ts");
const { allAudioList } = loadTypeScriptConstants("audioList.ts");
const { catalogLists } = loadTypeScriptConstants("catalogList.ts");

assert.equal(
  EXPECTED_PRACTICE_COUNTS.reduce((sum, count) => sum + count, 0),
  1394,
  "23 本教材的训练页总数应为 1,394",
);
assert.deepEqual(
  Object.keys(concatImages).filter((bookId) => Number(bookId) >= 3),
  BOOK_IDS,
  "图片常量应覆盖 ID 3–25",
);
assert.deepEqual(
  Object.keys(allAudioList).filter((bookId) => Number(bookId) >= 3),
  BOOK_IDS,
  "音频常量应覆盖 ID 3–25",
);
assert.deepEqual(
  Object.keys(catalogLists).filter((bookId) => Number(bookId) >= 3),
  BOOK_IDS,
  "目录常量应覆盖 ID 3–25",
);

const coordinateCounts = { pixel: 0, Cambridge: 0, Percentage: 0 };
let practiceCount = 0;
let audioSegmentCount = 0;

for (const [index, bookId] of BOOK_IDS.entries()) {
  const images = concatImages[bookId];
  const audioByPage = allAudioList[bookId];
  const catalog = catalogLists[bookId];

  assert.ok(Array.isArray(images) && images.length > 0, `教材 ${bookId} 应有图片`);
  assert.ok(audioByPage && typeof audioByPage === "object", `教材 ${bookId} 应有音频映射`);
  assert.ok(Array.isArray(catalog) && catalog.length > 0, `教材 ${bookId} 应有目录`);

  const pageNumbers = new Set();
  for (const [imageIndex, imageUrl] of images.entries()) {
    assertHttpsUrl(imageUrl, `教材 ${bookId} 图片 ${imageIndex} 应使用 HTTPS URL`);
    const pageNumber = parseImagePageNumber(imageUrl);
    if (pageNumber === null) {
      assert.equal(imageIndex, 0, `教材 ${bookId} 只有封面可以不带真实页号`);
      assert.equal(
        COVER_WHITELIST[bookId],
        path.basename(decodeURIComponent(imageUrl.split("?")[0])),
        `教材 ${bookId} 封面必须在白名单中`,
      );
      continue;
    }
    assert.equal(pageNumbers.has(pageNumber), false, `教材 ${bookId} 图片页号不能重复：${pageNumber}`);
    pageNumbers.add(pageNumber);
  }

  for (const [catalogIndex, entry] of catalog.entries()) {
    assert.ok(Number.isInteger(entry.page), `教材 ${bookId} 目录 ${catalogIndex} 的 page 应为图片零基索引`);
    assert.ok(
      entry.page >= 0 && entry.page < images.length,
      `教材 ${bookId} 目录 ${catalogIndex} 的 page 应指向现有图片`,
    );
    if (catalogIndex > 0) {
      assert.ok(
        entry.page > catalog[catalogIndex - 1].page,
        `教材 ${bookId} 目录索引必须递增`,
      );
    }
  }

  let bookPracticeCount = 0;
  for (const [pageKey, tracks] of Object.entries(audioByPage)) {
    assert.ok(Number.isInteger(Number(pageKey)), `教材 ${bookId} 音频页号应为整数：${pageKey}`);
    if (!Array.isArray(tracks) || tracks.length === 0) continue;
    const pageNumber = Number(pageKey);
    assert.ok(pageNumbers.has(pageNumber), `教材 ${bookId} 音频页 ${pageNumber} 应有对应图片`);
    bookPracticeCount += 1;

    for (const [trackIndex, track] of tracks.entries()) {
      assertHttpsUrl(track.url, `教材 ${bookId} 第 ${pageNumber} 页音频 ${trackIndex + 1} 应使用 HTTPS URL`);
      assert.equal(track.offset.length, 2, `教材 ${bookId} 音频坐标必须含 X/Y 两项`);
      if (track.flag === "Percentage") {
        coordinateCounts.Percentage += 1;
        assert.ok(track.offset.every((value) => /^-?\d+%$/.test(value)), `教材 ${bookId} 百分比坐标格式错误`);
      } else if (track.flag === "Cambridge") {
        coordinateCounts.Cambridge += 1;
        assert.ok(track.offset.every(Number.isFinite), `教材 ${bookId} Cambridge 坐标必须为数字`);
      } else {
        coordinateCounts.pixel += 1;
        assert.equal(track.flag, undefined, `教材 ${bookId} 像素坐标不应携带未知类型`);
        assert.ok(track.offset.every(Number.isFinite), `教材 ${bookId} 像素坐标必须为数字`);
      }
      audioSegmentCount += 1;
    }
  }

  assert.equal(bookPracticeCount, EXPECTED_PRACTICE_COUNTS[index], `教材 ${bookId} 训练页数应保持不变`);
  practiceCount += bookPracticeCount;
}

assert.equal(practiceCount, 1394, "全教材训练页数应为 1,394");
assert.equal(audioSegmentCount, 2082, "全教材音频段数应为 2,082");
assert.deepEqual(
  coordinateCounts,
  { pixel: 594, Cambridge: 258, Percentage: 1230 },
  "三类热点坐标的数量应保持不变",
);

const validationReport = validateBookData({ log: false });
assert.equal(validationReport.books.length, 23, "校验器应逐书输出 23 本教材报告");
assert.equal(validationReport.imageCount, 4056, "校验器应汇总 4,056 张图片");
assert.equal(validationReport.audioSegmentCount, 2082, "校验器应汇总 2,082 段音频");
assert.equal(validationReport.practicePageCount, 1394, "校验器应汇总 1,394 个训练页");

console.log("教材训练数据契约测试通过：23 本教材、1,394 个训练页、2,082 段音频和三类坐标均正确。");
