/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load } = require("./test-practice-book-route.cjs");
const { BOOKS } = load("src/features/bookLibrary/bookCatalog.ts");
const { buildFullBookPracticeBundle } = load("src/features/listeningPractice/bookPractice.ts");
const { buildPracticeDirectoryGroups, findPracticeDirectoryGroupId } = load("src/features/listeningPractice/practiceDirectory.ts");

test("KET 学生书的完整目录保持全部 40 个边界和 187 个非空页顺序", () => {
  const bundle = buildFullBookPracticeBundle("9");
  const groups = buildPracticeDirectoryGroups(bundle.practices);
  const expectedStarts = [
    ["课程导入", 0],
    ["Map of the units", 4],
    ["Introduction", 6],
    ["A2 Key for Schools content and overview", 7],
    ["Unit 1: Hi, how are you?", 8],
    ["Unit 2: We're going home", 14],
    ["Vocabulary and grammar review 1", 20],
    ["Vocabulary and grammar review 2", 21],
    ["Unit 3: Dinner time", 22],
    ["Unit 4: I'm shopping!", 28],
    ["Vocabulary and grammar review 3", 34],
    ["Vocabulary and grammar review 4", 35],
    ["Unit 5: It's my favourite sport!", 36],
    ["Unit 6: Have you got any homework?", 42],
    ["Vocabulary and grammar review 5", 48],
    ["Vocabulary and grammar review 6", 49],
    ["Unit 7: Let's go to the museum", 50],
    ["Unit 8: Did you get my message?", 56],
    ["Vocabulary and grammar review 7", 62],
    ["Vocabulary and grammar review 8", 63],
    ["Unit 9: I love that film!", 64],
    ["Unit 10: It's going to be sunny", 70],
    ["Vocabulary and grammar review 9", 76],
    ["Vocabulary and grammar review 10", 77],
    ["Unit 11: I like to keep fit", 78],
    ["Unit 12: Have you ever been on a plane?", 84],
    ["Vocabulary and grammar review 11", 90],
    ["Vocabulary and grammar review 12", 91],
    ["Unit 13: What's your hobby?", 92],
    ["Unit 14: Keep in touch!", 98],
    ["Vocabulary and grammar review 13", 104],
    ["Vocabulary and grammar review 14", 105],
    ["Grammar reference", 106],
    ["Phrasal verb builder", 132],
    ["Irregular verbs", 134],
    ["Writing bank", 135],
    ["Speaking bank", 143],
    ["Extra resources", 149],
    ["Answer key and audio scripts", 151],
    ["Acknowledgements", 186],
  ];
  assert.deepEqual(
    groups.map((group) => [group.title, bundle.practices[group.items[0].practiceIndex].imageIndex]),
    expectedStarts,
  );
  const items = groups.flatMap((group) => group.items);
  assert.equal(items.length, 187);
  assert.deepEqual(items.map((item) => item.id), bundle.practices.map((page) => page.id));
  assert.deepEqual(items.map((item) => item.practiceIndex), bundle.practices.map((_, index) => index));
});

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

test("29 册 4956 个非空页目录展开后与整本翻页顺序完全相同", () => {
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
  assert.equal(BOOKS.length, 29);
  assert.equal(totalPages, 4956);
});

test("仅连续同名页面共享分组，隔章重复标题不会倒序合并", () => {
  const titles = ["词汇", "词汇", "第二单元", "词汇", "词汇"];
  const practices = titles.map((sectionTitle, index) => ({ id: `p${index}`, pageNumber: index + 1, sectionTitle, tracks: [] }));
  const groups = buildPracticeDirectoryGroups(practices);
  assert.deepEqual(groups.map((group) => group.items.map((item) => item.practiceIndex)), [[0, 1], [2], [3, 4]]);
});
