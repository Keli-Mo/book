/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const { load } = require("./test-practice-book-route.cjs");
const moduleCache = new Map();
const loadModel = (file) => load(file, {}, moduleCache);
const { BOOKS } = loadModel("src/features/bookLibrary/bookCatalog.ts");
const { concatImages } = loadModel("src/pages/BookDetail/Components/BookPreview/constants/images.ts");
const { allAudioList } = loadModel("src/pages/BookDetail/Components/BookPreview/constants/audioList.ts");
const { catalogLists } = loadModel("src/pages/BookDetail/Components/BookPreview/constants/catalogList.ts");
const { buildBookPracticeBundle, buildFullBookPracticeBundle } = loadModel("src/features/listeningPractice/bookPractice.ts");
const expectedCounts = [
  191, 191, 193, 195, 210, 80, 189, 77, 193, 128, 113, 66, 193, 193,
  194, 194, 202, 177, 177, 193, 209, 225, 273, 132, 126, 132, 126,
];
const sourceBefore = JSON.stringify({ concatImages, allAudioList, catalogLists });

assert.equal(typeof buildFullBookPracticeBundle, "function", "必须提供独立的全页构建器，同时保留旧音频索引模型");
for (const id of ["missing", "1", "2"]) {
  assert.equal(buildFullBookPracticeBundle(id), null, "未知教材和广告图片不得进入全页训练");
}
let totalPages = 0;
let totalAudioPages = 0;
let totalTracks = 0;
for (const [bookIndex, book] of BOOKS.entries()) {
  const original = buildBookPracticeBundle(book.id);
  const legacySnapshot = JSON.stringify(original);
  const full = buildFullBookPracticeBundle(book.id);
  const images = concatImages[book.id];
  assert.equal(full.practices.length, expectedCounts[bookIndex], `${book.title} 必须包含全部登记图片`);
  assert.deepEqual(full.practices.map((page) => page.imageUrl), images, "全页顺序必须严格对应图片清单");
  assert.deepEqual(full.practices.map((page) => page.imageIndex), images.map((_, index) => index));
  assert.deepEqual(full.practices.filter((page) => page.tracks.length > 0), original.practices,
    "旧音频页的 ID、页号、章节、音轨及热点坐标必须原样保留");
  assert.equal(JSON.stringify(buildBookPracticeBundle(book.id)), legacySnapshot, "全页构建不得改变旧音频列表或索引");
  assert.equal(new Set(full.practices.map((page) => page.id)).size, images.length, "包括封面在内，页 ID 必须唯一");
  assert.equal(full.practices.at(-1).imageUrl, images.at(-1), "无音频末页必须可达");
  for (const page of full.practices) {
    const filename = decodeURIComponent(page.imageUrl.split("?")[0]).split("/").at(-1);
    const pageMatch = filename.match(/_(\d+)\.(?:png|jpe?g|webp)$/i);
    const expectedPageNumber = pageMatch ? Number(pageMatch[1]) : 0;
    assert.equal(page.pageNumber, expectedPageNumber, "数字页号必须来自实际文件，不能用数组索引代替");
    assert.equal(page.id, `${book.id}-page-${expectedPageNumber}`);
    assert.equal(page.bookId, book.id);
    const section = [...catalogLists[book.id]].reverse().find((entry) => entry.page <= page.imageIndex);
    assert.equal(page.sectionTitle, section?.name ?? "课程导入");
    assert.ok(Object.isFrozen(page) && Object.isFrozen(page.tracks), "新增页面也必须保持不可变");
    if (page.pageNumber === 0) assert.equal(page.pageLabel, "封面", "第零页和非数字封面应明确标记为封面");
  }
  assert.ok(Object.isFrozen(full) && Object.isFrozen(full.book) && Object.isFrozen(full.practices));
  totalPages += full.practices.length;
  totalAudioPages += original.practices.length;
  totalTracks += full.practices.reduce((sum, page) => sum + page.tracks.length, 0);
}
assert.equal(totalPages, 4572);
assert.equal(totalAudioPages, 1601);
assert.equal(totalTracks, 2510);
assert.equal(JSON.stringify({ concatImages, allAudioList, catalogLists }), sourceBefore, "不得改写或补造源图片、音频、目录");
for (const id of ["3", "4", "5", "6"]) {
  assert.equal(buildFullBookPracticeBundle(id).practices.some((page) => page.pageNumber === 2), false,
    "CASA 原清单已删除的 _2 图片不得重新插入或改变音频偏移");
}
for (const id of ["11", "12", "13", "14", "26", "27", "28", "29"]) {
  const cover = buildFullBookPracticeBundle(id).practices[0];
  assert.equal(cover.pageNumber, 0);
  assert.equal(cover.pageLabel, "封面");
  assert.deepEqual(cover.tracks, []);
}
console.log("全页模型验证通过：27 册、4,572 页，旧 1,601 个音频页和 2,510 段音轨保持不变。");
