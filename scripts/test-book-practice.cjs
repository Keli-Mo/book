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

const loadBookPracticeModule = (overrides = {}) => {
  const sourcePath = path.join(
    projectRoot,
    "src/features/listeningPractice/bookPractice.ts",
  );
  assert.equal(
    fs.existsSync(sourcePath),
    true,
    "通用教材训练构建器应存在",
  );

  const output = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const loadedModule = { exports: {} };
  const loadModule = (request) => {
    if (Object.hasOwn(overrides, request)) return overrides[request];
    const filenameByRequest = {
      "@/features/bookLibrary/bookCatalog": "src/features/bookLibrary/bookCatalog.ts",
      "@/pages/BookDetail/Components/BookPreview/constants/images": "src/pages/BookDetail/Components/BookPreview/constants/images.ts",
      "@/pages/BookDetail/Components/BookPreview/constants/audioList": "src/pages/BookDetail/Components/BookPreview/constants/audioList.ts",
      "@/pages/BookDetail/Components/BookPreview/constants/catalogList": "src/pages/BookDetail/Components/BookPreview/constants/catalogList.ts",
    };
    const filename = filenameByRequest[request];
    if (!filename) throw new Error(`未支持的构建器依赖：${request}`);

    const source = fs.readFileSync(path.join(projectRoot, filename), "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    }).outputText;
    const dependency = { exports: {} };
    new Function("module", "exports", "require", compiled)(
      dependency,
      dependency.exports,
      require,
    );
    return dependency.exports;
  };
  new Function("module", "exports", "require", output)(
    loadedModule,
    loadedModule.exports,
    loadModule,
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
const emptyPagePlaceholders = BOOK_IDS.flatMap((bookId) => {
  const imagePages = new Set(concatImages[bookId].map(parseImagePageNumber));
  return Object.entries(allAudioList[bookId])
    .filter(([page]) => !imagePages.has(Number(page)))
    .map(([page, tracks]) => [bookId, Number(page), tracks.length]);
});
assert.deepEqual(emptyPagePlaceholders, [
  ["3", 0, 0], ["4", 0, 0], ["4", 2, 0], ["5", 0, 0], ["5", 2, 0],
  ["6", 0, 0], ["6", 2, 0], ["7", 0, 0], ["8", 0, 0], ["9", 0, 0],
  ["10", 0, 0], ["11", 0, 0], ["12", 0, 0], ["13", 0, 0],
  ["14", 0, 0], ["15", 0, 0], ["16", 0, 0], ["17", 0, 0],
], "仅这 18 个既有空占位键允许没有对应图片");

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

const {
  DEFAULT_BOOK_ID,
  buildBookPracticeBundle,
  parseTrackCoordinate,
} = loadBookPracticeModule();

assert.equal(DEFAULT_BOOK_ID, "3", "默认教材应保持为 CASA 第一册");
assert.equal(buildBookPracticeBundle("not-a-book"), null, "未知教材应返回 null");

const expectedBundles = [
  ["3", 100],
  ["11", 85],
  ["22", 24],
  ["25", 24],
];
for (const [bookId, expectedPracticeCount] of expectedBundles) {
  const bundle = buildBookPracticeBundle(bookId);
  assert.ok(bundle, `教材 ${bookId} 应能构建训练包`);
  assert.equal(bundle.book.id, bookId, `教材 ${bookId} 应保留书籍信息`);
  assert.equal(bundle.coverUrl, bundle.book.cover, `教材 ${bookId} 应使用书架封面`);
  assert.equal(bundle.practices.length, expectedPracticeCount, `教材 ${bookId} 训练页数应正确`);
  assert.ok(
    bundle.practices.every((practice) => practice.bookId === bookId),
    `教材 ${bookId} 的训练页应保留教材 ID`,
  );
}

const immutableBundle = buildBookPracticeBundle("3");
assert.ok(immutableBundle, "默认教材应能构建训练包");
assert.equal(Object.isFrozen(immutableBundle), true, "训练包应不可变");
assert.equal(Object.isFrozen(immutableBundle.book), true, "训练包书籍信息应不可变");
assert.equal(Object.isFrozen(immutableBundle.practices), true, "训练页列表应不可变");
assert.equal(Object.isFrozen(immutableBundle.practices[0]), true, "训练页应不可变");
assert.equal(Object.isFrozen(immutableBundle.practices[0].tracks), true, "热点列表应不可变");
assert.equal(Object.isFrozen(immutableBundle.practices[0].tracks[0]), true, "单个热点应不可变");

const percentageTrack = allAudioList["11"][6][0];
assert.deepEqual(
  parseTrackCoordinate(percentageTrack),
  { leftPercent: 42, topPercent: 87, positionAdjusted: false },
  '百分比坐标 ["42%", "87%"] 应原样换算',
);
assert.throws(
  () =>
    parseTrackCoordinate({
      flag: "Percentage",
      offset: ["42px", "87%"],
      url: "https://example.com/invalid.mp3",
    }),
  /百分比坐标/,
  "百分比坐标应拒绝脏字符串",
);
assert.throws(
  () =>
    parseTrackCoordinate({
      offset: [Number.POSITIVE_INFINITY, 0],
      url: "https://example.com/invalid.mp3",
    }),
  /有限数值/,
  "像素坐标应拒绝非有限数值",
);

// 收集独立回归失败，避免首个坐标失败遮住坏数据校验与类型契约。
const regressionFailures = [];
let regressionCount = 0;
const regression = (name, check) => {
  regressionCount += 1;
  try {
    check();
  } catch (error) {
    regressionFailures.push(`${name}: ${error.message}`);
  }
};

regression("通用训练项的 bookId 必填 string 类型契约", () => {
  const sourcePath = path.join(projectRoot, "src/features/listeningPractice/bookPractice.ts");
  const program = ts.createProgram([sourcePath], { strictNullChecks: true, skipLibCheck: true });
  const checker = program.getTypeChecker();
  const declaration = program.getSourceFile(sourcePath).statements.find(
    (node) => ts.isTypeAliasDeclaration(node) && node.name.text === "ListeningPractice",
  );
  const bookId = checker.getTypeAtLocation(declaration).getProperty("bookId");
  assert.ok(bookId, "必须声明 bookId");
  assert.equal(bookId.flags & ts.SymbolFlags.Optional, 0, "bookId 不得为可选字段");
  assert.equal(checker.typeToString(checker.getTypeOfSymbolAtLocation(bookId, declaration)), "string");
});

const coordinateCases = [
  ["像素起点", { offset: [653, 167] }, [0, 0]],
  ["像素中点", { offset: [887.5, 470] }, [50, 50]],
  ["像素越界", { offset: [184, 1379] }, [-100, 200]],
  ["Cambridge 起点", { flag: "Cambridge", offset: [3576, 202] }, [0, 0]],
  ["Cambridge 中点", { flag: "Cambridge", offset: [3988.5, 732.5] }, [50, 50]],
  ["Cambridge 越界", { flag: "Cambridge", offset: [2751, 2324] }, [-100, 200]],
  ["Percentage 数值", { flag: "Percentage", offset: [0, 100] }, [0, 100]],
  ["Percentage 小数", { flag: "Percentage", offset: [".5%", "87.25%"] }, [0.5, 87.25]],
  ["Percentage 越界", { flag: "Percentage", offset: ["-12.5%", "125%"] }, [-12.5, 125]],
];
for (const [name, track, [leftPercent, topPercent]] of coordinateCases) {
  regression(`${name}保留原始转换坐标`, () => {
    assert.deepEqual(parseTrackCoordinate({ ...track, url: "https://example.com/a.mp3" }), {
      leftPercent, topPercent, positionAdjusted: false,
    });
  });
}

const validTrack = { flag: "Percentage", offset: ["42%", "87%"], url: "https://example.com/a.mp3" };
const fixtureBundle = (changes = {}, bookId = "3") => {
  const fixture = {
    images: ["https://example.com/book_2.png", "https://example.com/book_8.jpg"],
    audio: { 2: [validTrack], 8: [] },
    catalog: [{ name: "第一单元", page: 0 }],
    ...changes,
  };
  const { buildBookPracticeBundle: buildFixture } = loadBookPracticeModule({
    "@/pages/BookDetail/Components/BookPreview/constants/images": { concatImages: { [bookId]: fixture.images } },
    "@/pages/BookDetail/Components/BookPreview/constants/audioList": { allAudioList: { [bookId]: fixture.audio } },
    "@/pages/BookDetail/Components/BookPreview/constants/catalogList": { catalogLists: { [bookId]: fixture.catalog } },
  });
  return buildFixture(bookId);
};

regression("精确白名单中的缺图空占位页允许保留", () => {
  for (const [bookId, pageNumber] of emptyPagePlaceholders) {
    assert.equal(fixtureBundle({
      images: ["https://example.com/book_8.jpg"],
      audio: { [pageNumber]: [], 8: [validTrack] },
    }, bookId).practices.length, 1);
  }
});
regression("空占位白名单不能泛化到其他教材或页号", () => {
  for (const [bookId, pageNumber] of [["18", 0], ["3", 2], ["3", 99]]) {
    assert.throws(() => fixtureBundle({
      images: ["https://example.com/book_8.jpg"],
      audio: { [pageNumber]: [], 8: [validTrack] },
    }, bookId), new RegExp(`教材 ${bookId} 第 ${pageNumber} 页`));
  }
});
regression("白名单页含音频也必须有图片", () => {
  assert.throws(() => fixtureBundle({ audio: { 0: [validTrack] } }), /教材 3 第 0 页/);
});

const invalidDataCases = [
  ["空图片", { images: [] }, /图片/],
  ["缺失图片", { images: undefined }, /图片/],
  ["图片数组缺项", { images: ["https://example.com/book_2.png", ,] }, /图片索引 1/],
  ["音频映射为数组", { audio: [] }, /音频/],
  ["音频映射为空", { audio: {} }, /音频/],
  ["无非空音频页", { audio: { 2: [], 8: [] } }, /音频/],
  ["缺失音频", { audio: null }, /音频/],
  ["空目录", { catalog: [] }, /目录/],
  ["缺失目录", { catalog: null }, /目录/],
  ["目录数组缺项", { catalog: new Array(1) }, /目录 0/],
  ["空目录名", { catalog: [{ name: "", page: 0 }] }, /目录 0/],
  ["空白目录名", { catalog: [{ name: "  ", page: 0 }] }, /目录 0/],
  ["非法目录页", { catalog: [{ name: "单元", page: -1 }] }, /目录 0/],
  ["重复目录页", { catalog: [{ name: "甲", page: 0 }, { name: "乙", page: 0 }] }, /目录 1/],
  ["图片页号重复", { images: ["https://example.com/a_2.png", "https://example.com/b_2.jpg"] }, /第 2 页/],
  ["非法图片文件名", { images: ["https://example.com/book2.png"] }, /图片索引 0/],
  ["非白名单封面", { images: ["https://example.com/OW_2E_L1_Studentbook.png"] }, /图片索引 0/],
  ["非安全整数图片页号", { images: ["https://example.com/book_9007199254740992.png"] }, /图片索引 0/],
  ["音频页无图片", { audio: { 99: [validTrack] } }, /第 99 页/],
  ["空音频页无图片", { audio: { 2: [validTrack], 99: [] } }, /第 99 页/],
  ["轨道非数组", { audio: { 2: {} } }, /第 2 页/],
  ["轨道数组缺项", { audio: { 2: [validTrack, ,] } }, /第 2 页第 2 段/],
];
for (const key of ["-1", "02", "+2", "2.0", "2e0", " 2", "", "NaN", "9007199254740992"]) {
  invalidDataCases.push([`非法音频页键 ${JSON.stringify(key)}`, { audio: { 2: [validTrack], [key]: [] } }, /音频页/]);
}
for (const url of ["", "ttps://example.com/a_2.png", "file:///a_2.png", "https:///a_2.png", "https://bad host/a_2.png", "https://example.com:bad/a_2.png"]) {
  invalidDataCases.push([`非法图片 URL ${url}`, { images: [url] }, /图片索引 0/]);
}
for (const url of ["", "not-a-url", "javascript:alert(1)", "ftp://example.com/a.mp3", "https://", "https://bad host/a.mp3", "https://example.com:99999/a.mp3"]) {
  invalidDataCases.push([`非法音频 URL ${url}`, { audio: { 2: [{ ...validTrack, url }] } }, /第 2 页第 1 段/]);
}
const invalidTracks = [
  null, [], {}, { ...validTrack, flag: "unknown" },
  { ...validTrack, offset: undefined }, { ...validTrack, offset: [1] },
  { ...validTrack, offset: ["42px", "87%"] },
  { ...validTrack, offset: [" 42%", "87%"] },
  { ...validTrack, offset: [Infinity, 0] }, { ...validTrack, offset: [NaN, 0] },
  { url: validTrack.url, offset: [Infinity, 0] },
  { url: validTrack.url, offset: ["653", 167] },
  { url: validTrack.url, flag: "Cambridge", offset: [3576, NaN] },
  { url: validTrack.url, flag: "Cambridge", offset: ["3576x", 202] },
];
for (const [index, track] of invalidTracks.entries()) {
  invalidDataCases.push([`非法第 2 段字段/坐标 ${index}`, { audio: { 2: [validTrack, track] } }, /第 2 页第 2 段/]);
}
for (const [name, changes, context] of invalidDataCases) {
  regression(`坏数据明确失败：${name}`, () => {
    assert.throws(() => fixtureBundle(changes), (error) => {
      assert.match(error.message, /教材 3 /, "错误必须保留教材 ID");
      assert.match(error.message, context, "错误必须保留局部页/段/数据语境");
      return true;
    }, "已知教材坏数据不能退化为空训练包或课程导入");
  });
}
regression("没有前置目录的合法页面才使用课程导入", () => {
  assert.equal(fixtureBundle({ catalog: [{ name: "后续单元", page: 1 }] }).practices[0].sectionTitle, "课程导入");
});
regression("合法 HTTP URL 与编码后的真实页号保留", () => {
  const bundle = fixtureBundle({
    images: ["http://example.com/%E6%95%99%E6%9D%90_2.webp?token=123"],
    audio: { 2: [{ ...validTrack, url: "http://example.com/a.mp3" }] },
  });
  assert.equal(bundle.practices[0].pageNumber, 2);
  assert.equal(bundle.practices[0].tracks[0].url, "http://example.com/a.mp3");
});

let builtPracticeCount = 0;
let builtTrackCount = 0;
for (const [index, bookId] of BOOK_IDS.entries()) {
  const bundle = buildBookPracticeBundle(bookId);
  assert.ok(bundle, `教材 ${bookId} 应能构建训练包`);
  assert.equal(
    bundle.practices.length,
    EXPECTED_PRACTICE_COUNTS[index],
    `教材 ${bookId} 的构建训练页数应匹配数据契约`,
  );
  builtPracticeCount += bundle.practices.length;
  builtTrackCount += bundle.practices.reduce((count, practice) => count + practice.tracks.length, 0);
  regression(`教材 ${bookId} 全部生产训练项逐一匹配原始数据`, () => {
    const audioPages = Object.entries(allAudioList[bookId]).filter(([, tracks]) => tracks.length > 0);
    assert.deepEqual(
      bundle.practices.map((practice) => practice.pageNumber).sort((a, b) => a - b),
      audioPages.map(([page]) => Number(page)).sort((a, b) => a - b),
      "训练页应恰好对应所有非空音频页，且不遗漏或重复",
    );
    let previousImageIndex = -1;
    for (const practice of bundle.practices) {
      const imageIndex = concatImages[bookId].findIndex((url) => parseImagePageNumber(url) === practice.pageNumber);
      assert.ok(imageIndex > previousImageIndex, "训练页应按图片数组顺序排列");
      previousImageIndex = imageIndex;
      assert.equal(practice.bookId, bookId);
      assert.equal(practice.imageIndex, imageIndex);
      assert.equal(practice.imageUrl, concatImages[bookId][imageIndex]);
      const precedingSections = catalogLists[bookId].filter((section) => section.page <= imageIndex);
      assert.equal(practice.sectionTitle, precedingSections.at(-1)?.name ?? "课程导入");
      const originalTracks = allAudioList[bookId][practice.pageNumber];
      assert.equal(practice.tracks.length, originalTracks.length, `第 ${practice.pageNumber} 页轨道数`);
      for (const [trackIndex, track] of practice.tracks.entries()) {
        const original = originalTracks[trackIndex];
        assert.equal(track.url, original.url, `第 ${practice.pageNumber} 页第 ${trackIndex + 1} 段 URL 与顺序`);
        // 直接用历史坐标系的原点和宽高反向核对输出，不调用生产解析器作预期值。
        const frame = original.flag === "Cambridge" ? [3576, 202, 825, 1061] : [653, 167, 469, 606];
        const expected = original.offset.map((value, axis) => original.flag === "Percentage"
          ? Number(String(value).replace(/%$/, ""))
          : (value - frame[axis]) / frame[axis + 2] * 100);
        assert.equal(track.left, `${expected[0].toFixed(2)}%`, `第 ${practice.pageNumber} 页第 ${trackIndex + 1} 段 X`);
        assert.equal(track.top, `${expected[1].toFixed(2)}%`, `第 ${practice.pageNumber} 页第 ${trackIndex + 1} 段 Y`);
        assert.equal(track.positionAdjusted, false, "模型层不得进行视觉收敛");
        assert.ok(Object.isFrozen(track), "单个热点应冻结");
      }
    }
  });
}
assert.equal(builtPracticeCount, 1394, "构建器应生成 1,394 个训练页");
assert.equal(builtTrackCount, 2082, "生产构建结果必须包含 2,082 段音频");
assert.equal(regressionFailures.length, 0, `${regressionFailures.length}/${regressionCount} 项回归失败：\n${regressionFailures.join("\n")}`);

console.log(`教材训练数据契约测试通过：23 本教材、1,394 个训练页、2,082 段音频逐项匹配；${regressionCount} 项回归通过（含 ${invalidDataCases.length} 类坏数据与必填 bookId 类型契约）。`);
