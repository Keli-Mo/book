const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const projectRoot = path.resolve(__dirname, "..");
const audioListPath = path.join(
  projectRoot,
  "src/pages/BookDetail/Components/BookPreview/constants/audioList.ts",
);
const source = fs.readFileSync(audioListPath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const loadedModule = { exports: {} };
new Function("module", "exports", "require", compiled)(
  loadedModule,
  loadedModule.exports,
  require,
);

const audioList30 = loadedModule.exports.allAudioList["30"];
assert.ok(audioList30, "ID 30 学生书必须注册 audioList30");

const unitConfigs = [
  [1, 6, 1, 2], [2, 16, 1, 9], [3, 26, 1, 16],
  [4, 36, 1, 23], [5, 46, 1, 30], [6, 56, 2, 2],
  [7, 68, 2, 10], [8, 78, 2, 17], [9, 88, 2, 24],
  [10, 98, 2, 31], [11, 108, 3, 2], [12, 118, 3, 9],
  [13, 130, 3, 18], [14, 140, 3, 25], [15, 150, 3, 32],
  [16, 160, 4, 2], [17, 170, 4, 9], [18, 180, 4, 16],
];
const expectedByPrintedPage = new Map();
const readingSpreads = [];
for (const [unit, unitStart, disc, firstTrack] of unitConfigs) {
  const audioPages = unit % 2 === 1
    ? [unitStart + 2, unitStart + 4, unitStart + 7, unitStart + 8, unitStart + 9]
    : [unitStart, unitStart + 2, unitStart + 5, unitStart + 6, unitStart + 7];
  const tracks = [
    [firstTrack],
    [firstTrack + 1],
    [firstTrack + 2],
    [firstTrack + 3, firstTrack + 4, firstTrack + 5],
    [firstTrack + 6],
  ];
  audioPages.forEach((printedPage, index) => {
    expectedByPrintedPage.set(
      printedPage,
      tracks[index].map((track) => `${disc}.${String(track).padStart(2, "0")}`),
    );
  });
  readingSpreads.push({
    firstPage: audioPages[1],
    continuationPage: audioPages[1] + 1,
    track: `${disc}.${String(firstTrack + 1).padStart(2, "0")}`,
  });
}
expectedByPrintedPage.set(67, ["2.09"]);
expectedByPrintedPage.set(129, ["3.16", "3.17"]);
expectedByPrintedPage.set(191, ["4.23"]);

const nonEmptyEntries = Object.entries(audioList30)
  .filter(([, tracks]) => Array.isArray(tracks) && tracks.length > 0)
  .sort(([left], [right]) => Number(left) - Number(right));
const actualPrintedPages = nonEmptyEntries.map(([rawAudioKey]) => Number(rawAudioKey) - 2);
assert.deepEqual(
  actualPrintedPages,
  [...expectedByPrintedPage.keys()].sort((left, right) => left - right),
  "ID 30 只能在书内 93 个正式音频页显示热点",
);
assert.equal(nonEmptyEntries.length, 93, "ID 30 应有 93 个音频页");

const baseUrl = "https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/oxford-discover-2e-l6/student-book/audio";
const mappedTrackIds = [];
for (const [rawAudioKey, tracks] of nonEmptyEntries) {
  const printedPage = Number(rawAudioKey) - 2;
  const expectedTracks = expectedByPrintedPage.get(printedPage);
  assert.ok(expectedTracks, `印刷 p${printedPage} 不应有额外音频`);
  assert.equal(tracks.length, expectedTracks.length, `印刷 p${printedPage} 热点数量不正确`);

  const actualTracks = tracks.map((track) => {
    assert.equal(track.flag, "Percentage", `印刷 p${printedPage} 必须使用百分比坐标`);
    assert.equal(Array.isArray(track.offset), true);
    assert.equal(track.offset.length, 2);
    const [left, top] = track.offset.map(Number.parseFloat);
    assert.ok(left >= 6 && left <= 94, `印刷 p${printedPage} 横坐标须预留 44px 点击区域，避免渲染时 clamp 推回文字`);
    assert.ok(top >= 4.56 && top <= 95.44, `印刷 p${printedPage} 纵坐标须预留 44px 点击区域`);

    const match = track.url.match(/\/disc-([1-4])\/([1-4])-(\d{2})\.mp3$/);
    assert.ok(match, `印刷 p${printedPage} 音频 URL 格式错误：${track.url}`);
    assert.equal(match[1], match[2], `印刷 p${printedPage} 文件夹和文件碟号必须一致`);
    const trackId = `${match[1]}.${match[3]}`;
    assert.equal(
      track.url,
      `${baseUrl}/disc-${match[1]}/${match[1]}-${match[3]}.mp3`,
      `印刷 p${printedPage} 必须使用 OD6 学生书云路径`,
    );
    mappedTrackIds.push(trackId);
    return trackId;
  });
  assert.deepEqual(actualTracks, expectedTracks, `印刷 p${printedPage} 音轨顺序不正确`);
}

assert.equal(mappedTrackIds.length, 130, "ID 30 应映射 130 个正式热点");
assert.equal(new Set(mappedTrackIds).size, 130, "130 个正式音轨应各映射一次");
for (const excludedTrack of ["1.01", "2.01", "3.01", "4.01"]) {
  assert.equal(mappedTrackIds.includes(excludedTrack), false, `${excludedTrack} 是碟片报幕，不应挂页`);
}
for (let track = 24; track <= 54; track += 1) {
  const excludedTrack = `4.${String(track).padStart(2, "0")}`;
  assert.equal(mappedTrackIds.includes(excludedTrack), false, `${excludedTrack} 没有印刷标记，不应挂页`);
}

for (const { firstPage, continuationPage, track } of readingSpreads) {
  const firstPageTracks = audioList30[firstPage + 2].map(({ url }) => {
    const match = url.match(/\/([1-4])-(\d{2})\.mp3$/);
    return `${match[1]}.${match[2]}`;
  });
  assert.deepEqual(firstPageTracks, [track], `跨页 Reading p${firstPage} 只放本篇音轨`);
  assert.equal(
    audioList30[continuationPage + 2],
    undefined,
    `跨页 Reading 续页 p${continuationPage} 不应重复播放按钮`,
  );
}

const requireBlankRegion = (printedPage, index, bounds) => {
  const [left, top] = audioList30[printedPage + 2][index].offset.map(Number.parseFloat);
  const [minLeft, maxLeft, minTop, maxTop] = bounds;
  assert.ok(
    left >= minLeft && left <= maxLeft && top >= minTop && top <= maxTop,
    `印刷 p${printedPage} 第 ${index + 1} 个按钮须在同题标题附近的留白，避开题干、A/B 字母和答案：${left}/${top}`,
  );
};
requireBlankRegion(14, 0, [61, 70, 17, 20]);
requireBlankRegion(14, 1, [49, 61, 40, 44]);
requireBlankRegion(14, 2, [38, 44, 60, 61]);
requireBlankRegion(104, 0, [48, 58, 19, 22]);
requireBlankRegion(104, 1, [56, 66, 33, 36]);
requireBlankRegion(104, 2, [40, 46, 50, 51]);
requireBlankRegion(186, 2, [63, 67, 46.9, 47.1]);
requireBlankRegion(191, 0, [75, 84, 10, 13]);
for (const { firstPage } of readingSpreads) {
  requireBlankRegion(firstPage, 0, [18, 19, 5, 5.6]);
}

console.log("OD6 学生书音频映射测试通过：93 页、130 个正式热点，跨页 Reading 与排除音轨均符合契约。");
