/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const { load } = require("./test-practice-book-route.cjs");

const moduleCache = new Map();
const loadModel = (file) => load(file, {}, moduleCache);
const { concatImages } = loadModel("src/pages/BookDetail/Components/BookPreview/constants/images.ts");
const {
  buildBookPracticeBundle,
  buildFullBookPracticeBundle,
} = loadModel("src/features/listeningPractice/bookPractice.ts");
const { findVisibleBookPageIndex } = loadModel(
  "src/features/listeningPractice/bookPageVisibility.ts",
);

const hiddenIndexes = {
  "9": [2, 188],
  "10": [76],
  "11": [168, 170, 172, 174, 176, 180, 182, 188, 190, 192],
  "12": [118, 120, 122, 124, 126],
  "13": [2, 106, 108, 110],
  "14": [58, 60, 62, 64],
};

const bundles = Object.fromEntries(
  ["7", "8", "9", "10", "11", "12", "13", "14"].map((bookId) => [
    bookId,
    buildFullBookPracticeBundle(bookId),
  ]),
);
const page = (bookId, imageIndex) => bundles[bookId].practices.find(
  (candidate) => candidate.imageIndex === imageIndex,
);
const expectLabel = (bookId, imageIndex, expected) => assert.equal(
  page(bookId, imageIndex)?.pageLabel,
  expected,
  `教材 ${bookId} 图片索引 ${imageIndex} 的显示页码/语义必须来自实页核验`,
);

expectLabel("7", 0, "封面");
for (let imageIndex = 1; imageIndex <= 209; imageIndex += 1) {
  expectLabel("7", imageIndex, `第 ${imageIndex + 2} 页`);
}

expectLabel("8", 0, "封面");
expectLabel("8", 1, "扉页");
expectLabel("8", 2, "版权页");
for (let imageIndex = 3; imageIndex <= 79; imageIndex += 1) {
  expectLabel("8", imageIndex, `第 ${imageIndex} 页`);
}

expectLabel("9", 0, "封面");
expectLabel("9", 1, "扉页");
for (let imageIndex = 3; imageIndex <= 187; imageIndex += 1) {
  expectLabel("9", imageIndex, `第 ${imageIndex} 页`);
}

expectLabel("10", 0, "封面");
expectLabel("10", 1, "扉页");
expectLabel("10", 2, "版权页");
for (let imageIndex = 3; imageIndex <= 75; imageIndex += 1) {
  expectLabel("10", imageIndex, `第 ${imageIndex} 页`);
}

expectLabel("11", 0, "封面");
expectLabel("11", 1, "目录");
for (let imageIndex = 2; imageIndex <= 183; imageIndex += 1) {
  if (!hiddenIndexes["11"].includes(imageIndex)) {
    expectLabel("11", imageIndex, `第 ${imageIndex} 页`);
  }
}
for (const imageIndex of [184, 185, 186, 187, 189, 191]) {
  expectLabel("11", imageIndex, "贴纸");
}

expectLabel("12", 0, "封面");
expectLabel("12", 1, "扉页");
expectLabel("12", 2, "目录");
for (let imageIndex = 3; imageIndex <= 5; imageIndex += 1) {
  expectLabel("12", imageIndex, `第 ${imageIndex} 页`);
}
for (let imageIndex = 6; imageIndex <= 79; imageIndex += 1) {
  expectLabel("12", imageIndex, `第 ${imageIndex - 2} 页`);
}
for (let imageIndex = 80; imageIndex <= 126; imageIndex += 1) {
  if (!hiddenIndexes["12"].includes(imageIndex)) {
    expectLabel("12", imageIndex, `第 ${imageIndex} 页`);
  }
}
expectLabel("12", 127, "致谢");

expectLabel("13", 0, "封面");
expectLabel("13", 1, "扉页");
expectLabel("13", 3, "目录");
for (let imageIndex = 4; imageIndex <= 103; imageIndex += 1) {
  expectLabel("13", imageIndex, `第 ${imageIndex} 页`);
}
for (const imageIndex of [104, 105, 107, 109, 111]) {
  expectLabel("13", imageIndex, "贴纸");
}
expectLabel("13", 112, "致谢");

expectLabel("14", 0, "封面");
expectLabel("14", 1, "目录");
for (let imageIndex = 2; imageIndex <= 63; imageIndex += 1) {
  if (!hiddenIndexes["14"].includes(imageIndex)) {
    expectLabel("14", imageIndex, `第 ${imageIndex} 页`);
  }
}
expectLabel("14", 65, "致谢");

const unitZeroTitles = {
  "11": [4, "Welcome to Our World!"],
  "12": [3, "Welcome to Our World!"],
  "13": [6, "Greetings and Introductions"],
  "14": [2, "Language in Use"],
};
for (const [bookId, [imageIndex, title]] of Object.entries(unitZeroTitles)) {
  assert.equal(page(bookId, imageIndex)?.pageTitle, title,
    `教材 ${bookId} 的 Unit 0 起始页必须显示已核验标题`);
}

for (const [bookId, indexes] of Object.entries(hiddenIndexes)) {
  const legacy = buildBookPracticeBundle(bookId);
  const full = bundles[bookId];
  for (const imageIndex of indexes) {
    assert.ok(imageIndex < concatImages[bookId].length, "空白页索引必须存在于源图片清单");
    assert.equal(
      legacy.practices.some((candidate) => candidate.imageIndex === imageIndex),
      false,
      `教材 ${bookId} 图片索引 ${imageIndex} 有音频时不得过滤`,
    );
    assert.equal(page(bookId, imageIndex), undefined,
      `教材 ${bookId} 图片索引 ${imageIndex} 已核验为空白且无音频，应从翻页流过滤`);

    const resolvedIndex = findVisibleBookPageIndex(bookId, full.practices, imageIndex);
    assert.notEqual(resolvedIndex, -1, "旧进度指向被过滤空白页时必须仍能恢复到内容页");
    const resolvedImageIndex = full.practices[resolvedIndex].imageIndex;
    const nextVisible = full.practices.find((candidate) => candidate.imageIndex > imageIndex);
    assert.equal(
      resolvedImageIndex,
      nextVisible?.imageIndex ?? full.practices.at(-1).imageIndex,
      "被过滤页应优先跳到下一内容页，末页空白则回到上一内容页",
    );
  }
}

assert.deepEqual(
  Object.fromEntries(Object.entries(bundles).map(([bookId, bundle]) => [bookId, bundle.practices.length])),
  { "7": 210, "8": 80, "9": 187, "10": 76, "11": 183, "12": 123, "13": 109, "14": 62 },
  "PET、KET、Our World 的可见页总数必须随已核验空白页保持稳定",
);

console.log("PET、KET、Our World 实页标签、Unit 0 标题及空白页过滤验证通过。");
