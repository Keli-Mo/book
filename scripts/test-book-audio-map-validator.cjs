const assert = require("assert/strict");
const { spawnSync } = require("child_process");
const path = require("path");
const { validateBookData } = require("./validate-book-audio-map.cjs");

const projectRoot = path.resolve(__dirname, "..");
const report = validateBookData({ log: false });

assert.equal(report.mappingVersion, "audio-key-minus-2/v1");
assert.equal(report.books.length, 23, "应覆盖教材 3–25");
assert.equal(report.imageCount, 4056, "教材图片总数应保持 4,056");
assert.equal(report.practicePageCount, 1393, "训练页总数应保持 1,393");
assert.equal(report.audioSegmentCount, 2081, "音频段总数应保持 2,081");
assert.equal(report.mappings.length, 2081, "每段音频都应保留一条可追踪映射");

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

assert.equal(report.coordinateWarnings.length, 6, "六个轻微越界热点应作为警告保留");
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
    { bookId: "3", rawAudioKey: 84, trackNumber: 1, rawOffset: [673, 784] },
    { bookId: "4", rawAudioKey: 140, trackNumber: 1, rawOffset: [959, 781] },
    { bookId: "4", rawAudioKey: 164, trackNumber: 1, rawOffset: [949, 799] },
    { bookId: "5", rawAudioKey: 134, trackNumber: 1, rawOffset: [694, 782] },
    { bookId: "6", rawAudioKey: 88, trackNumber: 1, rawOffset: [694, 775] },
    { bookId: "24", rawAudioKey: 214, trackNumber: 1, rawOffset: ["-1%", "54%"] },
  ],
  "坐标警告必须保留教材、原音频键、轨号与原坐标",
);

const cli = spawnSync(process.execPath, ["scripts/validate-book-audio-map.cjs"], {
  cwd: projectRoot,
  encoding: "utf8",
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
assert.match(cli.stdout, /坐标轻微越界 6 处（仅警告）/);

console.log(
  "教材音频映射校验器测试通过：23 本、4,056 图、1,393 页、2,081 段，6 个轻微越界仅警告。",
);
