const assert = require("assert/strict");
const { spawnSync } = require("child_process");
const path = require("path");
const { validateBookData } = require("./validate-book-audio-map.cjs");

const projectRoot = path.resolve(__dirname, "..");
const report = validateBookData({ log: false });

assert.equal(report.mappingVersion, "audio-key-minus-2/v1");
assert.equal(report.books.length, 27, "应覆盖教材 3–29");
assert.equal(report.imageCount, 4572, "教材图片总数应为 4,572");
assert.equal(report.practicePageCount, 1601, "接入 Think 2 后训练页总数应为 1,601");
assert.equal(report.audioSegmentCount, 2510, "接入 Think 2 后应有 2,510 个热点");
assert.equal(report.mappings.length, 2510, "每个音频热点都应保留一条可追踪映射");
assert.deepEqual(
  report.books.slice(-4).map(({ bookId, imageCount, audioPageCount, audioSegmentCount }) =>
    ({ bookId, imageCount, audioPageCount, audioSegmentCount })),
  [
    { bookId: "26", imageCount: 132, audioPageCount: 71, audioSegmentCount: 131 },
    { bookId: "27", imageCount: 126, audioPageCount: 38, audioSegmentCount: 98 },
    { bookId: "28", imageCount: 132, audioPageCount: 63, audioSegmentCount: 105 },
    { bookId: "29", imageCount: 126, audioPageCount: 36, audioSegmentCount: 95 },
  ],
  "Think 1/2 四书应保留所有来源图片及逐页音频热点",
);

const thinkRepeatedTrack = report.mappings.filter(({ bookId, audioFilename }) =>
  bookId === "26" && audioFilename === "Thk2e_BrE_L1_SB_Unit_1_p15_t04.mp3");
assert.deepEqual(
  thinkRepeatedTrack.map(({ imageIndex, imagePageNumber, leftPercent, topPercent }) =>
    ({ imageIndex, imagePageNumber, leftPercent, topPercent })),
  [
    { imageIndex: 15, imagePageNumber: 15, leftPercent: 13.859, topPercent: 9.422 },
    { imageIndex: 15, imagePageNumber: 15, leftPercent: 13.859, topPercent: 39.603 },
  ],
  "学生书 p15 同一段音频的两处印刷标签都应有热点",
);
const workbookP16 = report.mappings.filter(({ bookId, imagePageNumber }) =>
  bookId === "27" && imagePageNumber === 16);
assert.deepEqual(
  workbookP16.map(({ imageIndex, audioFilename, leftPercent, topPercent }) =>
    ({ imageIndex, audioFilename, leftPercent, topPercent })),
  [
    { imageIndex: 13, audioFilename: "Thk2e_BrE_L1_WB_Unit_01_p016_t03.mp3", leftPercent: 13.859, topPercent: 9.422 },
    { imageIndex: 13, audioFilename: "Thk2e_BrE_L1_WB_Unit_01_p016_t04.mp3", leftPercent: 13.859, topPercent: 44.043 },
    { imageIndex: 13, audioFilename: "Thk2e_BrE_L1_WB_Unit_01_p016_t05.mp3", leftPercent: 58.129, topPercent: 53.971 },
  ],
  "练习册 p16 的三个音轨应映射到正确的 PDF 页和印刷标签",
);
const workbookP5 = report.mappings.filter(({ bookId, imagePageNumber }) =>
  bookId === "27" && imagePageNumber === 5);
assert.deepEqual(
  workbookP5.map(({ imageIndex, audioFilename, leftPercent, topPercent }) =>
    ({ imageIndex, audioFilename, leftPercent, topPercent })),
  [
    { imageIndex: 2, audioFilename: "Thk2e_BrE_L1_WB_Welcome_Unit_p004_t01.mp3", leftPercent: 13.859, topPercent: 6.662 },
    { imageIndex: 2, audioFilename: "Thk2e_BrE_L1_WB_Welcome_Unit_p004_t01.mp3", leftPercent: 13.859, topPercent: 30.333 },
  ],
  "练习册 p5 的两道 Listen again 都应复用 p4 的 W.01 音频",
);
const workbookP116And117 = report.mappings
  .filter(({ bookId, imagePageNumber }) =>
    bookId === "27" && (imagePageNumber === 116 || imagePageNumber === 117))
  .map(({ imageIndex, imagePageNumber, audioFilename, leftPercent, topPercent }) =>
    ({ imageIndex, imagePageNumber, audioFilename, leftPercent, topPercent }));
assert.deepEqual(workbookP116And117, [
  { imageIndex: 113, imagePageNumber: 116, audioFilename: "Thk2e_BrE_L1_WB_Unit_12_p116_t04.mp3", leftPercent: 13.859, topPercent: 12.455 },
  { imageIndex: 113, imagePageNumber: 116, audioFilename: "Thk2e_BrE_L1_WB_Unit_12_p116_t04.mp3", leftPercent: 13.859, topPercent: 37.581 },
  { imageIndex: 114, imagePageNumber: 117, audioFilename: "Thk2e_BrE_L1_WB_Unit_12_p116_t05.mp3", leftPercent: 13.859, topPercent: 50.319 },
], "练习册 p116 重复的 12.04 应播同一音频，独立 12.05 题在 p117");
assert.equal(
  report.mappings.some(({ audioFilename }) => audioFilename === "Thk2e_BrE_L1_WB_Wordlist.mp3"),
  false,
  "没有对应印刷页的 Wordlist 音频不能被随意放到教材页上",
);
for (const filename of [
  "Thk2e_BrE_L1_SB_Welcome_Unit_p004_t00.mp3",
  "Thk2e_BrE_L1_WB_Welcome_Unit_p004_t00.mp3",
  "Thk2e_BrE_L1_WB_Irregular_Verbs_List.mp3",
]) {
  assert.equal(
    report.mappings.some(({ audioFilename }) => audioFilename === filename),
    false,
    `${filename} 没有对应音频题目，不应显示播放图标`,
  );
}

const pronunciationUnits = [
  [1, 19, 6, 120], [2, 25, 5, 120], [3, 32, 2, 120],
  [4, 44, 5, 120], [5, 50, 3, 120], [6, 63, 7, 120],
  [7, 71, 4, 121], [8, 77, 3, 121], [9, 86, 2, 121],
  [10, 97, 4, 121], [11, 107, 4, 121], [12, 115, 4, 121],
];
for (const printedPage of [120, 121]) {
  const expected = pronunciationUnits
    .filter(([, , , page]) => page === printedPage)
    .flatMap(([unit, sourcePage, firstTrack]) =>
      [firstTrack, firstTrack + 1].map((track) =>
        `Thk2e_BE_L2_SB_Unit_${unit}_p${sourcePage}_t${String(track).padStart(2, "0")}.mp3`))
    .sort();
  const actual = report.mappings
    .filter(({ bookId, imagePageNumber }) => bookId === "28" && imagePageNumber === printedPage)
    .map(({ audioFilename }) => audioFilename)
    .sort();
  assert.deepEqual(actual, expected, `Think 2 学生书 p${printedPage} 的 12 个发音标签应按音轨号复用原单元文件`);
}
const pronunciationFirst = report.mappings.find(({ bookId, imagePageNumber, audioFilename }) =>
  bookId === "28" && imagePageNumber === 120 && audioFilename === "Thk2e_BE_L2_SB_Unit_1_p19_t06.mp3");
assert.deepEqual(
  pronunciationFirst && {
    imageIndex: pronunciationFirst.imageIndex,
    leftPercent: pronunciationFirst.leftPercent,
    topPercent: pronunciationFirst.topPercent,
  },
  { imageIndex: 120, leftPercent: 13.785, topPercent: 18.833 },
  "学生书 p120 的 1.06 应放在印刷发音题的实际位置",
);
const think2WorkbookP5 = report.mappings.filter(({ bookId, imagePageNumber }) =>
  bookId === "29" && imagePageNumber === 5);
assert.deepEqual(
  think2WorkbookP5.map(({ imageIndex, audioFilename, leftPercent, topPercent }) =>
    ({ imageIndex, audioFilename, leftPercent, topPercent })),
  [{ imageIndex: 2, audioFilename: "Thk2e_BE_L2_WB_Welcome_Unit_p005_t01.mp3", leftPercent: 13.785, topPercent: 33.032 }],
  "Think 2 练习册 W.01 应放在印刷 p5 的正式音频题上",
);
const think2WorkbookP116And117 = report.mappings
  .filter(({ bookId, imagePageNumber }) =>
    bookId === "29" && (imagePageNumber === 116 || imagePageNumber === 117))
  .map(({ imageIndex, imagePageNumber, audioFilename, leftPercent, topPercent }) =>
    ({ imageIndex, imagePageNumber, audioFilename, leftPercent, topPercent }));
assert.deepEqual(think2WorkbookP116And117, [
  { imageIndex: 113, imagePageNumber: 116, audioFilename: "Thk2e_BE_L2_WB_Unit_12_p116_t04.mp3", leftPercent: 13.866, topPercent: 12.455 },
  { imageIndex: 113, imagePageNumber: 116, audioFilename: "Thk2e_BE_L2_WB_Unit_12_p116_t04.mp3", leftPercent: 13.866, topPercent: 37.605 },
  { imageIndex: 114, imagePageNumber: 117, audioFilename: "Thk2e_BE_L2_WB_Unit_12_p116_t05.mp3", leftPercent: 13.866, topPercent: 12.455 },
], "Think 2 练习册 p116 的两处 12.04 共用音频，p117 的 12.05 使用文件名写 p116 的音频");
for (const filename of [
  "Thk2e_BE_L2_SB_Welcome_Unit_p004_t00.mp3",
  "Thk2e_BE_L2_WB_Welcome_Unit_p004_t00.mp3",
]) {
  assert.equal(
    report.mappings.some(({ audioFilename }) => audioFilename === filename),
    false,
    `${filename} 没有正式音频题目，不应显示播放图标`,
  );
}
assert.equal(
  new Set(report.mappings.filter(({ bookId }) => bookId === "28" || bookId === "29")
    .map(({ bookId, audioFilename }) => `${bookId}/${audioFilename}`)).size,
  156,
  "Think 2 的 158 个源音频中，除两册 p4 的 t00 外，156 个正式音频均被引用",
);

const correctedPercentageMappings = [
  ["3", 84, 1, ["6.8%", "95%"], [6.8, 95]],
  ["4", 140, 1, ["60.2%", "93%"], [60.2, 93]],
  ["4", 164, 1, ["57.9%", "95.4%"], [57.9, 95.4]],
  ["5", 134, 1, ["5.1%", "41.5%"], [5.1, 41.5]],
];
for (const [bookId, rawAudioKey, trackNumber, rawOffset, [leftPercent, topPercent]] of correctedPercentageMappings) {
  const mapping = report.mappings.find(
    (item) =>
      item.bookId === bookId
      && item.rawAudioKey === rawAudioKey
      && item.trackNumber === trackNumber,
  );
  assert.ok(mapping, `教材 ${bookId} 音频键 ${rawAudioKey} 轨 ${trackNumber} 应有诊断映射`);
  assert.equal(mapping.coordinateType, "Percentage");
  assert.deepEqual(mapping.rawOffset, rawOffset);
  assert.ok(
    Math.abs(mapping.leftPercent - leftPercent) < 1e-9,
    `教材 ${bookId} 音频键 ${rawAudioKey} 横坐标应为 ${leftPercent}%`,
  );
  assert.ok(
    Math.abs(mapping.topPercent - topPercent) < 1e-9,
    `教材 ${bookId} 音频键 ${rawAudioKey} 纵坐标应为 ${topPercent}%`,
  );
}

const book8Track37 = report.mappings.find(
  ({ bookId, rawAudioKey, trackNumber }) =>
    bookId === "8" && rawAudioKey === 37 && trackNumber === 1,
);
assert.deepEqual(
  book8Track37,
  {
    bookId: "8",
    rawAudioKey: 37,
    imageIndex: 35,
    imagePageNumber: 36,
    section: "Unit 8: Influencers",
    trackNumber: 1,
    audioFilename: "Track 09_Unit 8 Influencers.mp3",
    rawOffset: [3600, 476],
    coordinateType: "Cambridge",
    leftPercent: 2.909090909090909,
    topPercent: 25.82469368520264,
  },
  "历史音频键 37 必须映射 images[35]，真实页号取图片后缀 36",
);

const representativeMappings = [
  ["11", 6, 4, 4, "Unit 0", "ow2e_sb1_ame_0.1.mp3"],
  ["15", 10, 8, 9, "Unit 1 Families and Friends", "1·02.mp3"],
  ["20", 11, 9, 10, "Unit 1 Mysteries", "Foundations Reading 1a.mp3"],
];
for (const [bookId, rawAudioKey, imageIndex, imagePageNumber, section, audioFilename] of representativeMappings) {
  const mapping = report.mappings.find(
    (item) => item.bookId === bookId && item.rawAudioKey === rawAudioKey,
  );
  assert.ok(mapping, `教材 ${bookId} 音频键 ${rawAudioKey} 应有诊断映射`);
  assert.deepEqual(
    {
      imageIndex: mapping.imageIndex,
      imagePageNumber: mapping.imagePageNumber,
      section: mapping.section,
      audioFilename: mapping.audioFilename,
    },
    { imageIndex, imagePageNumber, section, audioFilename },
  );
}

assert.equal(report.coordinateWarnings.length, 2, "两个待语义确认的越界热点应作为警告保留");
assert.deepEqual(
  report.coordinateWarnings.map(
    ({ bookId, rawAudioKey, trackNumber, rawOffset }) => ({
      bookId,
      rawAudioKey,
      trackNumber,
      rawOffset,
    }),
  ),
  [
    { bookId: "6", rawAudioKey: 88, trackNumber: 1, rawOffset: [694, 775] },
    { bookId: "24", rawAudioKey: 214, trackNumber: 1, rawOffset: ["-1%", "54%"] },
  ],
  "坐标警告必须保留教材、原音频键、轨号与原坐标",
);

const cli = spawnSync(process.execPath, ["scripts/validate-book-audio-map.cjs"], {
  cwd: projectRoot,
  encoding: "utf8",
  timeout: 30000,
});
assert.equal(cli.status, 0, cli.stderr);
assert.match(
  cli.stdout,
  /教材 8 音频键 37 -> 图片索引 35 -> 真实页 36 -> Unit 8: Influencers -> Track 09_Unit 8 Influencers\.mp3/,
  "命令行应给出代表性权威映射",
);
assert.match(
  cli.stdout,
  /坐标警告：教材 24，音频键 214，图片索引 212，真实页 213，轨 1，原坐标 \["-1%","54%"\]/,
  "越界警告应能直接定位到书、键、图、页、轨及原坐标",
);
assert.match(cli.stdout, /坐标轻微越界 2 处（仅警告）/);

console.log(
  "教材音频映射校验器测试通过：27 本、4,572 图、1,601 页、2,510 个热点，Think 1/2 页码与复用音轨已核对，2 个历史越界仅警告。",
);
