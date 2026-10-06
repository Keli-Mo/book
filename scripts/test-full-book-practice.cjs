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
  191, 191, 193, 195, 210, 80, 187, 77, 193, 128, 113, 66, 193, 193,
  194, 194, 202, 177, 177, 193, 209, 225, 273, 132, 126, 132, 126, 201, 185,
];
const sourceBefore = JSON.stringify({ concatImages, allAudioList, catalogLists });

const ketStudentBook = buildFullBookPracticeBundle("9");
assert.equal(ketStudentBook.practices[0].pageLabel, "封面");
assert.equal(ketStudentBook.practices[1].pageLabel, "扉页");
assert.equal(ketStudentBook.practices.some((page) => page.imageIndex === 2), false,
  "前置空白页不能进入用户可见教材流程");
assert.equal(ketStudentBook.practices.some((page) => page.imageIndex === 188), false,
  "末尾空白页不能进入用户可见教材流程");
assert.equal(ketStudentBook.practices[2].pageLabel, "第 3 页");
const printedPage7 = ketStudentBook.practices.find((page) => page.imageIndex === 7);
assert.equal(printedPage7.pageNumber, 8);
assert.equal(printedPage7.id, "9-page-8");
assert.match(printedPage7.imageUrl, /_8\.png(?:\?|$)/);
assert.equal(printedPage7.pageLabel, "第 7 页");
const audioPage = ketStudentBook.practices.find((page) => page.tracks.length > 0);
const silentPage = ketStudentBook.practices.find((page) => page.imageIndex >= 3 && page.tracks.length === 0);
assert.equal(audioPage.pageLabel, `第 ${audioPage.imageIndex} 页`);
assert.equal(silentPage.pageLabel, `第 ${silentPage.imageIndex} 页`);
const ketPage = (imageIndex) => ketStudentBook.practices.find((page) => page.imageIndex === imageIndex);
assert.equal(ketPage(22).pageTitle, "Dinner time");
assert.equal(ketPage(23).pageTitle, "Young chef / Vocabulary: School lunches");
assert.equal(ketPage(24).pageTitle, "Grammar: Countable and uncountable nouns");
assert.equal(ketPage(25).pageTitle, "Listening Part 2 / Grammar: How much/many; a few, a little, a lot of");
assert.equal(ketPage(26).pageTitle, "Vocabulary: Food phrases / Reading Part 5");
assert.equal(ketPage(27).pageTitle, "Speaking Part 2");
assert.equal(ketPage(5).pageTitle, undefined,
  "没有核验到独立小标题的页面不能自动复制章节标题");
assert.equal(ketPage(52).pageTitle, undefined);
assert.equal(ketPage(86).pageTitle, undefined);
assert.equal(ketPage(118).pageTitle, undefined);
assert.equal(ketPage(186).pageTitle, "Acknowledgements");
assert.equal(ketPage(187).pageTitle, undefined, "附录续页没有新标题时只显示页码");
assert.equal(ketStudentBook.practices.filter((page) => page.pageTitle).length, 171,
  "逐页核验的小标题数量必须稳定，不能自动从章节名补齐");
assert.equal(buildBookPracticeBundle("9").practices.every((page) => page.pageTitle === undefined), true,
  "旧音频索引模型不得新增页面小标题字段");

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
  const visibleImages = book.id === "9"
    ? images.filter((_, imageIndex) => imageIndex !== 2 && imageIndex !== 188)
    : images;
  assert.equal(full.practices.length, expectedCounts[bookIndex], `${book.title} 必须包含全部登记图片`);
  assert.deepEqual(full.practices.map((page) => page.imageUrl), visibleImages, "全页顺序必须严格对应非空图片清单");
  assert.deepEqual(
    full.practices.map((page) => page.imageIndex),
    images.map((_, index) => index).filter((imageIndex) => book.id !== "9" || (imageIndex !== 2 && imageIndex !== 188)),
  );
  assert.deepEqual(full.practices.filter((page) => page.tracks.length > 0).map(({ pageLabel, pageTitle, ...page }) => page), original.practices,
    "旧音频页的 ID、页号、章节、音轨及热点坐标必须原样保留");
  assert.equal(JSON.stringify(buildBookPracticeBundle(book.id)), legacySnapshot, "全页构建不得改变旧音频列表或索引");
  assert.equal(new Set(full.practices.map((page) => page.id)).size, visibleImages.length, "包括封面在内，可见页 ID 必须唯一");
  assert.equal(full.practices.at(-1).imageUrl, visibleImages.at(-1), "最后一个非空页面必须可达");
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
assert.equal(BOOKS.length, 29);
assert.equal(totalPages, 4956);
assert.equal(totalAudioPages, 1694);
assert.equal(totalTracks, 2640);
assert.equal(JSON.stringify({ concatImages, allAudioList, catalogLists }), sourceBefore, "不得改写或补造源图片、音频、目录");
for (const id of ["3", "4", "5", "6"]) {
  assert.equal(buildFullBookPracticeBundle(id).practices.some((page) => page.pageNumber === 2), false,
    "CASA 原清单已删除的 _2 图片不得重新插入或改变音频偏移");
}
for (const id of ["11", "12", "13", "14", "26", "27", "28", "29", "30", "31"]) {
  const cover = buildFullBookPracticeBundle(id).practices[0];
  assert.equal(cover.pageNumber, 0);
  assert.equal(cover.pageLabel, "封面");
  assert.deepEqual(cover.tracks, []);
}
assert.deepEqual(buildBookPracticeBundle("31").practices, [], "OD6 练习册明确没有示范音频");
assert.equal(buildFullBookPracticeBundle("31").practices.every((page) => page.tracks.length === 0), true,
  "无音频练习册的185页均可翻页和录音，不能补造学生书热点");
console.log("全页模型验证通过：29 册、4,956 个可见页、1,694 个音频页和 2,640 段音轨，旧映射保持不变。");
