/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./test-practice-book-route.cjs");
const { BOOKS } = load("src/features/bookLibrary/bookCatalog.ts");
const { buildFullBookPracticeBundle } = load("src/features/listeningPractice/bookPractice.ts");
const { buildPracticeDirectoryGroups, findPracticeDirectoryGroupId } = load("src/features/listeningPractice/practiceDirectory.ts");

test("KET 练习册的重复 Vocabulary extra 必须留在各自章节位置", () => {
  const bundle = buildFullBookPracticeBundle("10");
  const groups = buildPracticeDirectoryGroups(bundle.practices);
  assert.deepEqual(groups.flatMap((group) => group.items.map((item) => item.pageNumber)),
    bundle.practices.map((page) => page.pageNumber), "打开目录应从第 1 页依次到第 77 页，不能把后续词汇页提前到第 8 页后面");
  const vocabularyGroups = groups.filter((group) => group.title === "Vocabulary extra");
  assert.ok(vocabularyGroups.length > 1, "非相邻同名小节必须独立分组");
  const firstIndex = bundle.practices.findIndex((page) => page.pageNumber === 8);
  const secondIndex = bundle.practices.findIndex((page) => page.pageNumber === 12);
  assert.notEqual(findPracticeDirectoryGroupId(groups, firstIndex), findPracticeDirectoryGroupId(groups, secondIndex),
    "翻到后续词汇页再开目录，应定位本页所在小节");
});

test("27 册 4572 页目录展开后与整本翻页顺序完全相同", () => {
  let totalPages = 0;
  for (const book of BOOKS) {
    const bundle = buildFullBookPracticeBundle(book.id);
    const groups = buildPracticeDirectoryGroups(bundle.practices);
    const items = groups.flatMap((group) => group.items);
    assert.deepEqual(items.map((item) => item.id), bundle.practices.map((page) => page.id), book.title);
    assert.deepEqual(items.map((item) => item.practiceIndex), bundle.practices.map((_, index) => index), book.title);
    assert.equal(new Set(groups.map((group) => group.id)).size, groups.length, "同名小节也要有独立定位 ID");
    for (const [index, practice] of bundle.practices.entries()) {
      const group = groups.find((item) => item.id === findPracticeDirectoryGroupId(groups, index));
      assert.equal(group.title, practice.sectionTitle);
      assert.equal(items[index].pageLabel, practice.pageLabel);
      assert.equal(items[index].trackCount, practice.tracks.length);
    }
    totalPages += items.length;
  }
  assert.equal(BOOKS.length, 27);
  assert.equal(totalPages, 4572);
});

test("仅连续同名页面共享分组，隔章重复标题不会倒序合并", () => {
  const titles = ["词汇", "词汇", "第二单元", "词汇", "词汇"];
  const practices = titles.map((sectionTitle, index) => ({ id: `p${index}`, pageNumber: index + 1, sectionTitle, tracks: [] }));
  const groups = buildPracticeDirectoryGroups(practices);
  assert.deepEqual(groups.map((group) => group.items.map((item) => item.practiceIndex)), [[0, 1], [2], [3, 4]]);
});
