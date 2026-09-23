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
const BOOK_IDS = Array.from({ length: 25 }, (_, index) => String(index + 3));
const EXPECTED_PRACTICE_COUNTS = [
  100, 96, 96, 96, 54, 12, 67, 14, 84, 64, 56, 39, 99, 99, 90, 90, 93, 24,
  24, 24, 24, 24, 24, 71, 38,
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

// 聚合三处素材断言，确保 RED 同时呈现全部已核实业务错误。
const materialRepairFailures = [];
const materialRepair = (name, check) => {
  try {
    check();
  } catch (error) {
    materialRepairFailures.push(`${name}: ${error.message}`);
  }
};
materialRepair("教材 11 第 10 页使用真实 0.10 文件名", () => {
  const url = allAudioList["11"][10][4].url;
  assert.equal(url.endsWith("/ow2e_sb1_ame_0.10.mp3"), true);
  assert.equal(url.includes("/ow2e_sb1_ame_1.0.mp3"), false);
});
materialRepair("教材 12 第 34 页第 2 段保留文件名空格编码", () => {
  const url = allAudioList["12"][34][1].url;
  assert.equal(url.endsWith("/ow2e_wb1_ame_3.3%20.mp3"), true);
  assert.equal(new URL(url).pathname.endsWith("/ow2e_wb1_ame_3.3%20.mp3"), true);
});
materialRepair("教材 11 移除官方不存在的伪轨 5.15", () => {
  assert.equal(Object.hasOwn(allAudioList["11"], "91"), false, "第 91 页错误热点必须完整删除");
  assert.deepEqual(
    allAudioList["11"][89].map(({ url }) => path.basename(new URL(url).pathname)),
    ["ow2e_sb1_ame_5.11.mp3", "ow2e_sb1_ame_5.12.mp3"],
    "第 89 页只能保留官方存在的 5.11、5.12，不得偷移 5.15",
  );
  const allAudioUrls = Object.values(allAudioList).flatMap((audioByPage) =>
    Object.values(audioByPage).flatMap((tracks) => tracks.map(({ url }) => url)),
  );
  assert.equal(
    allAudioUrls.some((url) =>
      new URL(url).pathname.endsWith("/ow2e_sb1_ame_5.15.mp3"),
    ),
    false,
    "全部教材不得通过查询串或片段掩盖官方不存在的伪轨 5.15",
  );
});
materialRepair("教材 6 第 11 页使用连续的 Track17", () => {
  assert.equal(
    path.basename(new URL(allAudioList["6"][11][0].url).pathname),
    "Track17.mp3",
    "第 10 页已使用 Track16，第 11 页必须衔接 Track17，不能重复播放上一页",
  );
});
materialRepair("教材 12 第 17 页使用连续的 1.11", () => {
  assert.equal(
    path.basename(new URL(allAudioList["12"][17][0].url).pathname),
    "ow2e_wb1_ame_1.11.mp3",
    "第 16 页已使用 1.10，第 17 页必须衔接 1.11，不能重复播放上一页",
  );
});
assert.equal(
  materialRepairFailures.length,
  0,
  `${materialRepairFailures.length}/5 项教材素材修正未满足：\n${materialRepairFailures.join("\n")}`,
);

const expectedEmptyAudioKeys = {
  3: [0, 1], 4: [0, 1], 5: [0, 1], 6: [0, 1],
  7: [0], 8: [0], 9: [0], 10: [0],
  11: [0, 1], 12: [0, 1], 13: [0, 1], 14: [0, 1],
  15: [0, 1], 16: [0, 1], 17: [0, 1],
  18: [1], 19: [1], 20: [1], 21: [1],
  22: [1], 23: [1], 24: [1], 25: [1],
};
const emptyPagePlaceholders = BOOK_IDS.flatMap((bookId) => {
  const imageCount = concatImages[bookId].length;
  return Object.entries(allAudioList[bookId])
    .filter(([page, tracks]) => {
      const imageIndex = Number(page) - 2;
      return tracks.length === 0 && (imageIndex < 0 || imageIndex >= imageCount);
    })
    .map(([page, tracks]) => [bookId, Number(page), tracks.length]);
});
assert.deepEqual(
  emptyPagePlaceholders,
  Object.entries(expectedEmptyAudioKeys).flatMap(([bookId, keys]) =>
    keys.map((key) => [bookId, key, 0]),
  ),
  "仅既有负索引空音频键允许没有对应图片",
);

assert.equal(
  EXPECTED_PRACTICE_COUNTS.reduce((sum, count) => sum + count, 0),
  1502,
  "25 本教材的训练页总数应为 1,502",
);
assert.deepEqual(
  Object.keys(concatImages).filter((bookId) => Number(bookId) >= 3),
  BOOK_IDS,
  "图片常量应覆盖 ID 3–27",
);
assert.deepEqual(
  Object.keys(allAudioList).filter((bookId) => Number(bookId) >= 3),
  BOOK_IDS,
  "音频常量应覆盖 ID 3–27",
);
assert.deepEqual(
  Object.keys(catalogLists).filter((bookId) => Number(bookId) >= 3),
  BOOK_IDS,
  "目录常量应覆盖 ID 3–27",
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
    const audioKey = Number(pageKey);
    const imageIndex = audioKey - 2;
    const pageNumber = parseImagePageNumber(images[imageIndex] || "");
    assert.ok(Number.isInteger(pageNumber), `教材 ${bookId} 音频键 ${audioKey} 应映射有真实页号的图片`);
    bookPracticeCount += 1;

    for (const [trackIndex, track] of tracks.entries()) {
      assertHttpsUrl(track.url, `教材 ${bookId} 第 ${pageNumber} 页音频 ${trackIndex + 1} 应使用 HTTPS URL`);
      assert.equal(track.offset.length, 2, `教材 ${bookId} 音频坐标必须含 X/Y 两项`);
      if (track.flag === "Percentage") {
        coordinateCounts.Percentage += 1;
        assert.ok(
          track.offset.every((value) => /^-?(?:\d+(?:\.\d+)?|\.\d+)%$/.test(value)),
          `教材 ${bookId} 百分比坐标格式错误`,
        );
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

  assert.equal(bookPracticeCount, EXPECTED_PRACTICE_COUNTS[index], `教材 ${bookId} 训练页数应符合修正后契约`);
  practiceCount += bookPracticeCount;
}

assert.equal(practiceCount, 1502, "全教材训练页数应为 1,502");
assert.equal(audioSegmentCount, 2310, "全教材音频热点数应为 2,310");
assert.deepEqual(
  coordinateCounts,
  { pixel: 590, Cambridge: 258, Percentage: 1462 },
  "新增 Think 1 后，三类热点坐标数量应符合来源统计",
);

const validationReport = validateBookData({ log: false });
assert.equal(validationReport.books.length, 25, "校验器应逐书输出 25 本教材报告");
assert.equal(validationReport.imageCount, 4314, "校验器应汇总 4,314 张图片");
assert.equal(validationReport.audioSegmentCount, 2310, "校验器应汇总 2,310 个音频热点");
assert.equal(validationReport.practicePageCount, 1502, "校验器应汇总 1,502 个训练页");

const {
  DEFAULT_BOOK_ID,
  buildBookPracticeBundle,
  parseTrackCoordinate,
} = loadBookPracticeModule();

assert.equal(DEFAULT_BOOK_ID, "3", "默认教材应保持为 CASA 第一册");
assert.equal(buildBookPracticeBundle("not-a-book"), null, "未知教材应返回 null");

const expectedBundles = [
  ["3", 100],
  ["11", 84],
  ["22", 24],
  ["25", 24],
  ["26", 71],
  ["27", 38],
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

for (const [bookId, audioKey, expectedImageIndex, expectedPageNumber] of [
  ["3", 4, 2, 4],
  ["8", 37, 35, 36],
  ["11", 6, 4, 4],
  ["12", 5, 3, 3],
  ["15", 10, 8, 9],
  ["20", 11, 9, 10],
  ["26", 17, 15, 15],
  ["27", 4, 2, 5],
  ["27", 15, 13, 16],
  ["27", 116, 114, 117],
]) {
  const sourceTrackUrl = allAudioList[bookId][audioKey][0].url;
  const practice = buildBookPracticeBundle(bookId).practices.find((item) =>
    item.imageIndex === expectedImageIndex &&
    item.tracks.some(({ url }) => url === sourceTrackUrl),
  );
  assert.ok(practice, `教材 ${bookId} 音频键 ${audioKey} 应生成训练页`);
  assert.equal(practice.imageIndex, expectedImageIndex, "历史音频键必须按 imageIndex + 2 解释");
  assert.equal(practice.pageNumber, expectedPageNumber, "展示页码必须来自实际教材图片文件名");
  assert.equal(practice.imageUrl, concatImages[bookId][expectedImageIndex]);
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
const mappedFixtureImages = Array.from(
  { length: 7 },
  (_, index) => `https://example.com/book_${index + 2}.jpg`,
);
const fixtureBundle = (changes = {}, bookId = "3") => {
  const fixture = {
    images: ["https://example.com/book_2.png", "https://example.com/book_8.jpg"],
    audio: { 2: [validTrack] },
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
      images: mappedFixtureImages,
      audio: { [pageNumber]: [], 8: [validTrack] },
    }, bookId).practices.length, 1);
  }
});
regression("空占位白名单不能泛化到其他教材或页号", () => {
  for (const [bookId, pageNumber] of [["18", 0], ["7", 1], ["3", 99]]) {
    assert.throws(() => fixtureBundle({
      images: mappedFixtureImages,
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
  ["无非空音频页", { audio: { 2: [] } }, /音频/],
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
      bundle.practices.map((practice) => practice.imageIndex),
      audioPages.map(([audioKey]) => Number(audioKey) - 2),
      "每个非空音频键 K 必须严格映射到 images[K - 2]，且不遗漏或重复",
    );
    let previousImageIndex = -1;
    for (const practice of bundle.practices) {
      const imageIndex = practice.imageIndex;
      assert.ok(imageIndex > previousImageIndex, "训练页应按图片数组顺序排列");
      previousImageIndex = imageIndex;
      assert.equal(practice.bookId, bookId);
      assert.equal(practice.imageIndex, imageIndex);
      assert.equal(practice.imageUrl, concatImages[bookId][imageIndex]);
      assert.equal(practice.pageNumber, parseImagePageNumber(practice.imageUrl));
      const precedingSections = catalogLists[bookId].filter((section) => section.page <= imageIndex);
      assert.equal(practice.sectionTitle, precedingSections.at(-1)?.name ?? "课程导入");
      const originalTracks = allAudioList[bookId][imageIndex + 2];
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
assert.equal(builtPracticeCount, 1502, "构建器应生成 1,502 个训练页");
assert.equal(builtTrackCount, 2310, "生产构建结果必须包含 2,310 个音频热点");
assert.equal(regressionFailures.length, 0, `${regressionFailures.length}/${regressionCount} 项回归失败：\n${regressionFailures.join("\n")}`);

console.log(`教材训练数据契约测试通过：25 本教材、1,502 个训练页、2,310 个音频热点逐项匹配；${regressionCount} 项回归通过（含 ${invalidDataCases.length} 类坏数据与必填 bookId 类型契约）。`);
