/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const sourcePath = path.resolve(
  __dirname,
  "../src/features/listeningPractice/practiceDirectory.ts"
);

assert.equal(fs.existsSync(sourcePath), true, "训练目录模型文件应存在");

const compiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2017,
  },
});
const moduleContainer = { exports: {} };

vm.runInNewContext(compiled.outputText, {
  module: moduleContainer,
  exports: moduleContainer.exports,
});

const {
  buildPracticeDirectoryGroups,
  findPracticeDirectoryGroupId,
} = moduleContainer.exports;

const practices = [
  {
    id: "p1",
    pageNumber: 4,
    sectionTitle: "Unit 1 课文",
    tracks: [{}, {}],
  },
  {
    id: "p2",
    pageNumber: 5,
    sectionTitle: "Unit 1 课文",
    tracks: [{}],
  },
  {
    id: "p3",
    pageNumber: 12,
    sectionTitle: "Unit 1 练习",
    tracks: [{}],
  },
  {
    id: "p4",
    pageNumber: 25,
    sectionTitle: "Unit 2 课文",
    tracks: [{}, {}, {}],
  },
];

const groups = buildPracticeDirectoryGroups(practices);

assert.deepEqual(JSON.parse(JSON.stringify(groups)), [
  {
    id: "practice-directory-group-0",
    title: "Unit 1 课文",
    items: [
      { id: "p1", practiceIndex: 0, pageNumber: 4, trackCount: 2 },
      { id: "p2", practiceIndex: 1, pageNumber: 5, trackCount: 1 },
    ],
  },
  {
    id: "practice-directory-group-1",
    title: "Unit 1 练习",
    items: [
      { id: "p3", practiceIndex: 2, pageNumber: 12, trackCount: 1 },
    ],
  },
  {
    id: "practice-directory-group-2",
    title: "Unit 2 课文",
    items: [
      { id: "p4", practiceIndex: 3, pageNumber: 25, trackCount: 3 },
    ],
  },
]);
assert.equal(
  findPracticeDirectoryGroupId(groups, 2),
  "practice-directory-group-1"
);
assert.equal(findPracticeDirectoryGroupId(groups, 999), "");

const { buildBookPracticeBundle } = require("./test-practice-book-route.cjs");
for (const bookId of ["3", "22", "25"]) {
  const bundle = buildBookPracticeBundle(bookId);
  const bookGroups = buildPracticeDirectoryGroups(bundle.practices);
  const items = bookGroups.flatMap((group) => group.items);
  assert.equal(items.length, bundle.practices.length, "目录应包含当前教材的全部训练");
  for (const [index, practice] of bundle.practices.entries()) {
    const item = items.find((candidate) => candidate.practiceIndex === index);
    assert.equal(item.id, practice.id);
    assert.equal(item.pageNumber, practice.pageNumber);
    assert.equal(item.trackCount, practice.tracks.length);
    const groupId = findPracticeDirectoryGroupId(bookGroups, index);
    assert.equal(bookGroups.find((group) => group.id === groupId).title, practice.sectionTitle);
  }
  assert.equal(findPracticeDirectoryGroupId(bookGroups, bundle.practices.length), "");
}

console.log("训练目录测试通过：章节分组、页码、音频数与当前分组定位正确。");
