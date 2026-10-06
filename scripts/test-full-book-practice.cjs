/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const { load } = require("./test-practice-book-route.cjs");
const moduleCache = new Map();
const loadModel = (file) => load(file, {}, moduleCache);
const { BOOKS } = loadModel("src/features/bookLibrary/bookCatalog.ts");
const { concatImages } = loadModel("src/pages/BookDetail/Components/BookPreview/constants/images.ts");
const { allAudioList } = loadModel("src/pages/BookDetail/Components/BookPreview/constants/audioList.ts");
const { catalogLists } = loadModel("src/pages/BookDetail/Components/BookPreview/constants/catalogList.ts");
const { isBookPageVisible } = loadModel("src/features/listeningPractice/bookPageVisibility.ts");
const {
  resolveBookPageTitle,
  resolveCatalogPageTitle,
} = loadModel("src/features/listeningPractice/bookPageTitle.ts");
const { buildBookPracticeBundle, buildFullBookPracticeBundle } = loadModel("src/features/listeningPractice/bookPractice.ts");
const expectedCounts = [
  191, 191, 193, 195, 210, 80, 187, 76, 183, 123, 109, 62, 193, 193,
  194, 194, 202, 177, 177, 193, 209, 225, 273, 132, 126, 132, 126, 201, 185,
];
const sourceBefore = JSON.stringify({ concatImages, allAudioList, catalogLists });

assert.equal(resolveCatalogPageTitle("Unit 1 课文"), "课文");
assert.equal(resolveCatalogPageTitle("Unit 1: Families and Friends"), "Families and Friends");
assert.equal(resolveCatalogPageTitle("Unit 12 Technology"), "Technology");
assert.equal(resolveCatalogPageTitle("Unit 1"), undefined, "纯 Unit 标题不能在页面卡片重复显示");
assert.equal(resolveCatalogPageTitle("Vocabulary extra"), "Vocabulary extra");

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

const oxfordDiscoverLastCopyrightIndex = {
  "15": 192,
  "16": 192,
  "17": 193,
  "18": 193,
  "19": 201,
};
for (const [id, copyrightIndex] of Object.entries(oxfordDiscoverLastCopyrightIndex)) {
  const bundle = buildFullBookPracticeBundle(id);
  assert.equal(bundle.practices[0].pageLabel, "封面");
  assert.equal(bundle.practices[1].pageLabel, "扉页");
  for (let imageIndex = 2; imageIndex < copyrightIndex; imageIndex += 1) {
    assert.equal(bundle.practices[imageIndex].pageLabel, `第 ${imageIndex} 页`);
  }
  assert.equal(bundle.practices[copyrightIndex].pageLabel, "版权页");
}

for (const id of ["20", "21", "22", "23", "24", "25"]) {
  const bundle = buildFullBookPracticeBundle(id);
  assert.equal(bundle.practices[0].pageLabel, "封面");
  assert.equal(bundle.practices[1].pageLabel, "扉页");
  assert.equal(bundle.practices[2].pageLabel, "版权页");
  assert.equal(bundle.practices[3].pageLabel, "目录");
  for (let imageIndex = 4; imageIndex < bundle.practices.length; imageIndex += 1) {
    assert.equal(bundle.practices[imageIndex].pageLabel, `第 ${imageIndex} 页`);
  }
}

const thinkUnitTitles = {
  "26": [
    "Having a good time", "Spending money", "We are what we eat", "All in the family",
    "No place like home", "Friends forever", "Smart life", "A question of sport",
    "Wild and wonderful", "Out and about", "Future bodies", "Travel the world",
  ],
  "27": [
    "Having a good time", "Spending money", "We are what we eat", "All in the family",
    "No place like home", "Friends forever", "Smart life", "A question of sport",
    "Wild and wonderful", "Out and about", "Future bodies", "Travel the world",
  ],
  "28": [
    "Incredible people", "A good education", "On the screen", "Online life",
    "Music to my ears", "No planet B", "The future is now", "Science and us",
    "Working week", "Mind and body", "Breaking news", "Rules and regulations",
  ],
  "29": [
    "Incredible people", "A good education", "On the screen", "Online life",
    "Music to my ears", "No planet B", "The future is now", "Science and us",
    "Working week", "Mind and body", "Breaking news", "Rules and regulations",
  ],
};
for (const [id, titles] of Object.entries(thinkUnitTitles)) {
  const bundle = buildFullBookPracticeBundle(id);
  const unitEntries = catalogLists[id].filter((entry) => /^Unit \d+$/.test(entry.name));
  assert.equal(unitEntries.length, 12);
  for (const [unitIndex, entry] of unitEntries.entries()) {
    const page = bundle.practices.find((item) => item.imageIndex === entry.page);
    assert.equal(page.sectionTitle, `Unit ${unitIndex + 1}`, "目录分组标题应继续保留 Unit 编号");
    assert.equal(page.pageTitle, titles[unitIndex], "Unit 起始页应显示源 PDF 目录中的主题标题");
  }
}

for (const id of ["26", "28"]) {
  const bundle = buildFullBookPracticeBundle(id);
  assert.equal(bundle.practices[0].pageLabel, "封面");
  assert.equal(bundle.practices[1].pageLabel, "扉页");
  assert.equal(bundle.practices[2].pageLabel, "目录");
  assert.equal(bundle.practices[3].pageLabel, "目录");
  for (let imageIndex = 4; imageIndex <= 128; imageIndex += 1) {
    assert.equal(bundle.practices[imageIndex].pageLabel, `第 ${imageIndex} 页`);
  }
  for (let imageIndex = 129; imageIndex <= 131; imageIndex += 1) {
    assert.equal(bundle.practices[imageIndex].pageLabel, "致谢");
  }
}

for (const id of ["27", "29"]) {
  const bundle = buildFullBookPracticeBundle(id);
  assert.equal(bundle.practices[0].pageLabel, "扉页", "练习册首图是 WORKBOOK 书名扉页");
  for (let imageIndex = 1; imageIndex <= 125; imageIndex += 1) {
    assert.equal(bundle.practices[imageIndex].pageLabel, `第 ${imageIndex + 3} 页`);
  }
}

const od6Student = buildFullBookPracticeBundle("30");
assert.equal(od6Student.practices[0].pageLabel, "封面");
assert.equal(od6Student.practices[1].pageLabel, "扉页");
for (let imageIndex = 2; imageIndex <= 5; imageIndex += 1) {
  assert.equal(od6Student.practices[imageIndex].pageLabel, "Scope and Sequence");
}
for (let imageIndex = 6; imageIndex <= 200; imageIndex += 1) {
  assert.equal(od6Student.practices[imageIndex].pageLabel, `第 ${imageIndex} 页`);
}

const od6Workbook = buildFullBookPracticeBundle("31");
assert.equal(od6Workbook.practices[0].pageLabel, "封面");
assert.equal(od6Workbook.practices[1].pageLabel, "目录");
for (let imageIndex = 2; imageIndex <= 184; imageIndex += 1) {
  assert.equal(od6Workbook.practices[imageIndex].pageLabel, `第 ${imageIndex} 页`);
}

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
  const visibleImages = images.filter((_, imageIndex) => isBookPageVisible(book.id, imageIndex));
  assert.equal(full.practices.length, expectedCounts[bookIndex], `${book.title} 必须包含全部非空登记图片`);
  assert.deepEqual(full.practices.map((page) => page.imageUrl), visibleImages, "全页顺序必须严格对应非空图片清单");
  assert.deepEqual(
    full.practices.map((page) => page.imageIndex),
    images.map((_, index) => index).filter((imageIndex) => isBookPageVisible(book.id, imageIndex)),
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
    const catalogStart = catalogLists[book.id].find((entry) => entry.page === page.imageIndex);
    if (book.id !== "9" && catalogStart) {
      assert.equal(
        page.pageTitle,
        resolveBookPageTitle(book.id, page.imageIndex) ?? resolveCatalogPageTitle(catalogStart.name),
        `${book.title} 的目录起始页必须把教材目录标题带到具体页面卡片`,
      );
    }
    assert.ok(Object.isFrozen(page) && Object.isFrozen(page.tracks), "新增页面也必须保持不可变");
    if (page.pageNumber === 0) {
      const expectedFirstPageLabel = ["27", "29"].includes(book.id) ? "扉页" : "封面";
      assert.equal(page.pageLabel, expectedFirstPageLabel, "第零页必须使用已核验的首图语义");
    }
  }
  assert.ok(Object.isFrozen(full) && Object.isFrozen(full.book) && Object.isFrozen(full.practices));
  totalPages += full.practices.length;
  totalAudioPages += original.practices.length;
  totalTracks += full.practices.reduce((sum, page) => sum + page.tracks.length, 0);
}
assert.equal(BOOKS.length, 29);
assert.equal(totalPages, 4932);
assert.equal(totalAudioPages, 1694);
assert.equal(totalTracks, 2640);
assert.equal(JSON.stringify({ concatImages, allAudioList, catalogLists }), sourceBefore, "不得改写或补造源图片、音频、目录");
for (const id of ["3", "4", "5", "6"]) {
  const casa = buildFullBookPracticeBundle(id);
  assert.equal(casa.practices.some((page) => page.pageNumber === 2), false,
    "CASA 原清单已删除的 _2 图片不得重新插入或改变音频偏移");
  assert.equal(casa.practices[0].pageLabel, "封面");
  assert.equal(casa.practices[1].pageLabel, "目录");
  for (const entry of catalogLists[id]) {
    assert.equal(
      casa.practices.find((page) => page.imageIndex === entry.page).pageLabel,
      `第 ${entry.page - 1} 页`,
      `${id} 的目录印刷页码必须与教材目录一致`,
    );
  }
}
for (const id of ["11", "12", "13", "14", "26", "27", "28", "29", "30", "31"]) {
  const cover = buildFullBookPracticeBundle(id).practices[0];
  assert.equal(cover.pageNumber, 0);
  assert.equal(cover.pageLabel, ["27", "29"].includes(id) ? "扉页" : "封面");
  assert.deepEqual(cover.tracks, []);
}
assert.deepEqual(buildBookPracticeBundle("31").practices, [], "OD6 练习册明确没有示范音频");
assert.equal(buildFullBookPracticeBundle("31").practices.every((page) => page.tracks.length === 0), true,
  "无音频练习册的185页均可翻页和录音，不能补造学生书热点");
console.log("全页模型验证通过：29 册、4,932 个可见页、1,694 个音频页和 2,640 段音轨，旧映射保持不变。");
