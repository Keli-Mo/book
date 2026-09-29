/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const { load } = require("./test-practice-book-route.cjs");

const imagesModule = load(
  "src/pages/BookDetail/Components/BookPreview/constants/images.ts",
);
const catalogModule = load(
  "src/pages/BookDetail/Components/BookPreview/constants/catalogList.ts",
);
const audioModule = load(
  "src/pages/BookDetail/Components/BookPreview/constants/audioList.ts",
);

const { concatImages } = imagesModule;
const { catalogLists } = catalogModule;
const assetRoot =
  "https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/oxford-discover-2e-l6";

assert.ok(Array.isArray(concatImages["30"]), "OD6 学生书页图清单应存在");
assert.equal(concatImages["30"].length, 201, "OD6 学生书应展示 PDF 1–201 页");
assert.equal(concatImages["30"][0], `${assetRoot}/student-book/pages/od6-sb_0.jpg`);
assert.equal(concatImages["30"].at(-1), `${assetRoot}/student-book/pages/od6-sb_200.jpg`);
assert.ok(Array.isArray(concatImages["31"]), "OD6 练习册页图清单应存在");
assert.equal(concatImages["31"].length, 185, "OD6 练习册应展示 PDF 1–185 页");
assert.equal(concatImages["31"][0], `${assetRoot}/workbook/pages/od6-wb_0.jpg`);
assert.equal(concatImages["31"].at(-1), `${assetRoot}/workbook/pages/od6-wb_184.jpg`);

const unitNames = [
  "Unit 1 The Earthworm and the Spider",
  "Unit 2 Overcoming Earth's Obstacles",
  "Unit 3 Inside Our Planet",
  "Unit 4 The Secret of Vesuvius",
  "Unit 5 A Season of Discontent",
  "Unit 6 Uncovering Masks",
  "Unit 7 Summing Up Symmetry",
  "Unit 8 Snowflake Lia",
  "Unit 9 Talking About Language",
  "Unit 10 The Whistlers",
  "Unit 11 View From the Summit and Everest",
  "Unit 12 A Housemaid's Diary",
  "Unit 13 The Poetry of Birds",
  "Unit 14 Bird Brains",
  "Unit 15 Fear on the Brain",
  "Unit 16 Gripped by Fear",
  "Unit 17 The White Giraffe",
  "Unit 18 Why Stories Matter",
];
const expectedCatalog = (pages, finalName, finalPage) => [
  ...unitNames.map((name, index) => ({ name, page: pages[index] })),
  { name: finalName, page: finalPage },
];
assert.deepEqual(
  catalogLists["30"],
  expectedCatalog(
    [6, 16, 26, 36, 46, 56, 68, 78, 88, 98, 108, 118, 130, 140, 150, 160, 170, 180],
    "Dictionary",
    192,
  ),
  "学生书目录应使用零基图片索引并包含 Dictionary",
);
assert.deepEqual(
  catalogLists["31"],
  expectedCatalog(
    [2, 10, 22, 30, 42, 50, 62, 70, 82, 90, 102, 110, 122, 130, 142, 150, 162, 170],
    "Student's Writing Resource",
    182,
  ),
  "练习册目录应使用零基图片索引并包含 Student's Writing Resource",
);

const loadPracticeWithAudio = (allAudioList) =>
  load(
    "src/features/listeningPractice/bookPractice.ts",
    {
      "@/pages/BookDetail/Components/BookPreview/constants/audioList": {
        allAudioList,
      },
    },
    new Map(),
  );

assert.deepEqual(
  audioModule.allAudioList["31"],
  {},
  "OD6 练习册应在生产音频总表中明确注册为空映射",
);
const silentWorkbookApi = loadPracticeWithAudio(audioModule.allAudioList);
const silentLegacyBundle = silentWorkbookApi.buildBookPracticeBundle("31");
assert.equal(silentLegacyBundle.practices.length, 0, "OD6 练习册明确允许没有示范音频页");
const silentFullBundle = silentWorkbookApi.buildFullBookPracticeBundle("31");
assert.equal(silentFullBundle.practices.length, 185, "零示范音频不能阻止练习册整本阅读");
assert.ok(silentFullBundle.practices.every((page) => page.tracks.length === 0));
assert.equal(silentFullBundle.practices[2].sectionTitle, unitNames[0]);
assert.equal(silentFullBundle.practices[182].sectionTitle, "Student's Writing Resource");

const ordinarySilentApi = loadPracticeWithAudio({
  ...audioModule.allAudioList,
  "3": {},
});
assert.throws(
  () => ordinarySilentApi.buildBookPracticeBundle("3"),
  /应至少包含一个非空音频页/,
  "零音频豁免必须只开放给明确登记的练习册",
);

console.log("OD6 页图、目录与零示范音频练习册契约通过。");
