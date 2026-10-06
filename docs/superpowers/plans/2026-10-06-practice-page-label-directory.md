# 教材真实页码与目录细分 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 跟读页只显示教材真实页标签，并把剑桥 KET 综合教程学生用书的训练目录按教材目录细分，分组标题采用“第 4 页 · Map of the units”格式。

**Architecture:** 保留 `pageNumber`、`imageIndex`、练习 ID、图片 URL 和音频映射作为稳定资源身份，新增集中式 `pageLabel` 解析器只负责展示。`buildFullBookPracticeBundle` 为有音频页和无音频页统一附加展示标签；目录继续使用现有扁平分组模型，通过准确的 `catalogLists["9"]` 起始节点产生更细分组。

**Tech Stack:** TypeScript、React 18、Taro 4、Node.js `node:test` 与现有自定义源码加载测试工具。

## Global Constraints

- 本阶段只完整处理 book ID `9`；其他教材没有可靠目录依据时不得猜测标题或页码偏移。
- `pageNumber`、`imageIndex`、练习 ID、图片 URL、音频键、热点坐标和训练顺序必须保持不变。
- book ID `9` 的标签规则固定为：索引 0=`封面`、1=`扉页`、2=`空白页`、索引大于等于 3=`第 ${imageIndex} 页`。
- 顶部只显示当前 `pageLabel`；无已核验标签时回退为 `第 ${pageNumber} 页`，不得显示“跟读训练”或当前位置/总页数。
- 目录分组标题统一为“分组首项真实页标签 · 教材目录标题”，例如 `第 4 页 · Map of the units`。
- 保留目录折叠、逐页卡片、当前页标记、“定位当前页”和历史回跳行为。
- 所有生产代码改动都先有会按预期失败的测试，再写最小实现。
- 仅本地提交，不推送远程。

---

### Task 1: 为整本练习模型提供稳定的教材页标签

**Files:**
- Create: `src/features/listeningPractice/bookPageLabel.ts`
- Modify: `src/features/listeningPractice/bookPractice.ts:328-359`
- Test: `scripts/test-full-book-practice.cjs`

**Interfaces:**
- Produces: `resolveBookPageLabel(bookId: string, imageIndex: number, pageNumber: number): string | undefined`
- Consumes: `buildFullBookPracticeBundle(bookId)` 和现有 `ListeningPractice.pageLabel`

- [ ] **Step 1: Write the failing model test**

在 `scripts/test-full-book-practice.cjs` 增加对 book `9` 的定点断言，明确资源身份与展示标签分离：

```js
const ketStudentBook = buildFullBookPracticeBundle("9");
assert.equal(ketStudentBook.practices[0].pageLabel, "封面");
assert.equal(ketStudentBook.practices[1].pageLabel, "扉页");
assert.equal(ketStudentBook.practices[2].pageLabel, "空白页");
assert.equal(ketStudentBook.practices[3].pageLabel, "第 3 页");

const printedPage7 = ketStudentBook.practices[7];
assert.equal(printedPage7.pageNumber, 8);
assert.equal(printedPage7.id, "9-page-8");
assert.match(printedPage7.imageUrl, /_8\.png(?:\?|$)/);
assert.equal(printedPage7.pageLabel, "第 7 页");

const audioPage = ketStudentBook.practices.find((page) => page.tracks.length > 0);
const silentPage = ketStudentBook.practices.find((page) => page.imageIndex >= 3 && page.tracks.length === 0);
assert.equal(audioPage.pageLabel, `第 ${audioPage.imageIndex} 页`);
assert.equal(silentPage.pageLabel, `第 ${silentPage.imageIndex} 页`);
```

- [ ] **Step 2: Run the model test and verify RED**

Run: `node scripts/test-full-book-practice.cjs`

Expected: FAIL because book `9` audio pages and ordinary body pages do not yet have the verified `pageLabel` values.

- [ ] **Step 3: Add the label resolver and apply it uniformly**

Create `src/features/listeningPractice/bookPageLabel.ts`:

```ts
const VERIFIED_PAGE_LABELS: Readonly<Record<string, (imageIndex: number) => string | undefined>> = {
  "9": (imageIndex) => {
    if (imageIndex === 0) return "封面";
    if (imageIndex === 1) return "扉页";
    if (imageIndex === 2) return "空白页";
    if (imageIndex >= 3) return `第 ${imageIndex} 页`;
    return undefined;
  },
};

export const resolveBookPageLabel = (
  bookId: string,
  imageIndex: number,
  pageNumber: number,
): string | undefined => {
  const verified = VERIFIED_PAGE_LABELS[bookId]?.(imageIndex);
  if (verified) return verified;
  return pageNumber === 0 ? "封面" : undefined;
};
```

在 `buildFullBookPracticeBundle` 中先解析文件 `pageNumber`，再计算 `pageLabel`。有音频页返回冻结副本，只覆盖 `pageLabel`；无音频页创建时写入相同标签。不要修改旧 `buildBookPracticeBundle` 的返回值：

```ts
const pageNumber = parseImagePageNumber(imageUrl) ?? 0;
const pageLabel = resolveBookPageLabel(bookId, imageIndex, pageNumber);
const audioPractice = originalByImageIndex.get(imageIndex);
if (audioPractice) {
  return pageLabel
    ? { ...audioPractice, pageLabel }
    : audioPractice;
}
```

新对象仍交给现有 `freezeBundle` 深冻结。

- [ ] **Step 4: Run the model test and verify GREEN**

Run: `node scripts/test-full-book-practice.cjs`

Expected: PASS，仍报告 29 册、4,958 页、1,694 个音频页和 2,640 段音轨。

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- src/features/listeningPractice/bookPageLabel.ts src/features/listeningPractice/bookPractice.ts scripts/test-full-book-practice.cjs
git commit -m "feat: 增加教材真实页标签"
```

---

### Task 2: 跟读页顶部只显示当前教材页标签

**Files:**
- Modify: `src/pages/Practice/PracticeSession.tsx:2054-2059`
- Modify: `src/pages/CheckInDetail/CheckInDetail.tsx:68-103`
- Test: `scripts/test-full-practice-route.cjs`
- Test: `scripts/test-practice-book-route.cjs`
- Test: `scripts/test-check-in-return-navigation.cjs`

**Interfaces:**
- Consumes: Task 1 写入的 `practice.pageLabel`
- Produces: `.practice-header__progress` 的唯一文案为 `practice.pageLabel || 第 ${practice.pageNumber} 页`
- Produces: 缺少稳定坐标的旧录音按原音频索引定位后，重新取得全页模型中的同 ID 练习，从而复用同一个 `pageLabel`

- [ ] **Step 1: Replace sequence assertions with true page label assertions**

把相关测试中的 `跟读训练 ${index + 1} / ${total}` 断言改为以当前练习为准：

```js
const expectedPageLabel = practice.pageLabel || `第 ${practice.pageNumber} 页`;
assert.equal(
  textOf(byClass(tree, "practice-header__progress")).trim(),
  expectedPageLabel,
);
assert.doesNotMatch(textOf(byClass(tree, "practice-header__progress")), /跟读训练|\d+\s*\/\s*\d+/);
```

在 `scripts/test-practice-book-route.cjs` 增加 book `9`、路由 `page=7` 的断言，期望顶部严格等于 `第 7 页`。同步切页/恢复场景的辅助匹配函数，让它根据当前 `practice.pageLabel` 或 `pageNumber` 计算文案。

在 `scripts/test-check-in-return-navigation.cjs` 增加只含旧 `practiceIndex` 的 book `9` 录音记录。使用旧音频列表索引 `0`，断言详情元信息包含 `第 8 页`、不包含 `教材页 9`，并且“我也来跟读”仍跳到全页索引 `page=8`：

```js
const legacyRecord = {
  id: "ket-legacy-index", shareToken: "token", bookId: "9", bookTitle: "KET",
  practiceIndex: 0, sectionTitle: "Unit 1", durationMs: 1800,
  createdAt: 1, recordingUrl: "record.mp3", isOwner: true,
};
const legacyDetail = page("src/pages/CheckInDetail/CheckInDetail.tsx", { id: legacyRecord.id }, { detail: legacyRecord });
legacyDetail.render(); await settle();
const legacyTree = legacyDetail.render();
assert.match(textOf(byClass(legacyTree, "check-in-course-card__meta")), /第 8 页/);
assert.doesNotMatch(textOf(byClass(legacyTree, "check-in-course-card__meta")), /教材页 9/);
await byClass(legacyTree, "check-in-actions__practice").props.onClick();
assert.equal(legacyDetail.navigations.at(-1), "/pages/Practice/Practice?bookId=9&page=8");
```

- [ ] **Step 2: Run the route tests and verify RED**

Run:

```powershell
node scripts/test-full-practice-route.cjs
node scripts/test-practice-book-route.cjs
node scripts/test-check-in-return-navigation.cjs
```

Expected: FAIL because `PracticeSession` still renders “跟读训练 N / 总数”。

- [ ] **Step 3: Render only the current page label**

Replace the progress contents in `PracticeSession.tsx` with:

```tsx
<Text className='practice-header__progress'>
  {practice.pageLabel || `第 ${practice.pageNumber} 页`}
</Text>
```

Remove the nested `practice-header__progress-prefix` rendering only; keep the existing row, audio player, directory button, and layout classes.

在 `CheckInDetail.tsx` 的旧索引兼容分支中，先按原逻辑从旧音频模型解释 `practiceIndex`，然后用稳定 ID 在已经构建好的全页模型中重取页面：

```ts
const legacyPractice = buildBookPracticeBundle(values.bookId)?.practices[values.practiceIndex];
practice = legacyPractice
  ? bundle.practices.find((candidate) => candidate.id === legacyPractice.id)
  : undefined;
```

不要改变旧索引的含义，也不要用同一个数字直接当作全页索引。

- [ ] **Step 4: Run the route tests and verify GREEN**

Run the three commands from Step 2.

Expected: all three scripts PASS, including direct routes, directory navigation, restored history, and book `9` page 7.

- [ ] **Step 5: Commit Task 2**

```powershell
git add -- src/pages/Practice/PracticeSession.tsx src/pages/CheckInDetail/CheckInDetail.tsx scripts/test-full-practice-route.cjs scripts/test-practice-book-route.cjs scripts/test-check-in-return-navigation.cjs
git commit -m "feat: 顶部显示教材真实页码"
```

---

### Task 3: 按教材目录细分 KET 学生书分组

**Files:**
- Modify: `src/pages/BookDetail/Components/BookPreview/constants/catalogList.ts:589-700`
- Test: `scripts/test-full-book-directory.cjs`

**Interfaces:**
- Consumes: `catalogLists["9"]` 的零基图片起始索引
- Produces: `buildPracticeDirectoryGroups` 按完整教材目录生成连续、准确的分组

- [ ] **Step 1: Add exact catalog boundary tests**

在 `scripts/test-full-book-directory.cjs` 增加 book `9` 断言：

```js
const ketBundle = buildFullBookPracticeBundle("9");
const ketGroups = buildPracticeDirectoryGroups(ketBundle.practices);
const expectedStarts = [
  ["课程导入", 0],
  ["Map of the units", 4],
  ["Introduction", 6],
  ["A2 Key for Schools content and overview", 7],
  ["Unit 1: Hi, how are you?", 8],
  ["Unit 2: We're going home", 14],
  ["Vocabulary and grammar review 1", 20],
  ["Vocabulary and grammar review 2", 21],
  ["Vocabulary and grammar review 3", 34],
  ["Vocabulary and grammar review 4", 35],
  ["Vocabulary and grammar review 5", 48],
  ["Vocabulary and grammar review 6", 49],
  ["Vocabulary and grammar review 7", 62],
  ["Vocabulary and grammar review 8", 63],
  ["Vocabulary and grammar review 9", 76],
  ["Vocabulary and grammar review 10", 77],
  ["Vocabulary and grammar review 11", 90],
  ["Vocabulary and grammar review 12", 91],
  ["Vocabulary and grammar review 13", 104],
  ["Vocabulary and grammar review 14", 105],
];
for (const [title, imageIndex] of expectedStarts) {
  const group = ketGroups.find((item) => item.title === title);
  assert.ok(group, title);
  assert.equal(group.items[0].practiceIndex, imageIndex, title);
}
assert.equal(ketGroups.flatMap((group) => group.items).length, 189);
assert.deepEqual(
  ketGroups.flatMap((group) => group.items).map((item) => item.id),
  ketBundle.practices.map((page) => page.id),
);
```

另断言现有 Unit 1–14 和附录标题起始索引没有变化。

- [ ] **Step 2: Run the directory model test and verify RED**

Run: `node --test scripts/test-full-book-directory.cjs`

Expected: FAIL with missing `Map of the units` or the first missing review group.

- [ ] **Step 3: Add the verified catalog nodes in ascending order**

在 `catalogLists["9"]` 中按 `page` 升序加入：

```ts
{ name: "Map of the units", page: 4 },
{ name: "Introduction", page: 6 },
{ name: "A2 Key for Schools content and overview", page: 7 },
{ name: "Vocabulary and grammar review 1", page: 20 },
{ name: "Vocabulary and grammar review 2", page: 21 },
{ name: "Vocabulary and grammar review 3", page: 34 },
{ name: "Vocabulary and grammar review 4", page: 35 },
{ name: "Vocabulary and grammar review 5", page: 48 },
{ name: "Vocabulary and grammar review 6", page: 49 },
{ name: "Vocabulary and grammar review 7", page: 62 },
{ name: "Vocabulary and grammar review 8", page: 63 },
{ name: "Vocabulary and grammar review 9", page: 76 },
{ name: "Vocabulary and grammar review 10", page: 77 },
{ name: "Vocabulary and grammar review 11", page: 90 },
{ name: "Vocabulary and grammar review 12", page: 91 },
{ name: "Vocabulary and grammar review 13", page: 104 },
{ name: "Vocabulary and grammar review 14", page: 105 },
```

每个 review 节点放在对应 Unit 内容之后、下一个既有节点之前；不要更改任何既有起始索引。

- [ ] **Step 4: Run the directory model test and verify GREEN**

Run: `node --test scripts/test-full-book-directory.cjs`

Expected: PASS，book `9` 仍有 189 页且逐页 ID 顺序完全一致。

- [ ] **Step 5: Commit Task 3**

```powershell
git add -- src/pages/BookDetail/Components/BookPreview/constants/catalogList.ts scripts/test-full-book-directory.cjs
git commit -m "feat: 细分 KET 学生书目录"
```

---

### Task 4: 目录分组标题显示真实起始页

**Files:**
- Modify: `src/pages/Practice/PracticeDirectory.tsx:145-170`
- Test: `scripts/test-practice-directory-component.cjs`

**Interfaces:**
- Consumes: `PracticeDirectoryGroup.items[0].pageLabel` 和既有 `group.title`
- Produces: 分组标题 `${startPageLabel} · ${group.title}`

- [ ] **Step 1: Add the exact heading format test**

在 `scripts/test-practice-directory-component.cjs` 增加 book `9`、当前页索引 `4` 的渲染断言：

```js
const context = fixture({
  name: "KET Map of the units",
  file: "src/pages/Practice/Practice.tsx",
  params: { bookId: "9", page: "4" },
});
try {
  const tree = context.open();
  const mapGroup = context.groups.find((group) => group.title === "Map of the units");
  assert.ok(mapGroup);
  assert.equal(
    textOf(byClass(groupNode(tree, mapGroup.id), "practice-directory-group__title")),
    "第 4 页 · Map of the units",
  );
} finally {
  cleanup(context.page);
}
```

同时遍历现有 route fixture 的所有分组，按首项计算预期标题，覆盖没有 `pageLabel` 时的回退：

```js
for (const group of context.groups) {
  const firstItem = group.items[0];
  const startLabel = firstItem.pageLabel || `第 ${firstItem.pageNumber} 页`;
  assert.equal(
    textOf(byClass(groupNode(tree, group.id), "practice-directory-group__title")),
    `${startLabel} · ${group.title}`,
  );
}
```

- [ ] **Step 2: Run the component test and verify RED**

Run: `node scripts/test-practice-directory-component.cjs`

Expected: FAIL because the group heading currently renders only `group.title`.

- [ ] **Step 3: Prefix every group title with its first item page label**

在 `PracticeDirectory.tsx` 计算分组起始标签：

```tsx
const firstItem = group.items[0];
const startPageLabel = firstItem?.pageLabel || `第 ${firstItem?.pageNumber} 页`;
```

把标题节点改成：

```tsx
<Text className='practice-directory-group__title'>
  {startPageLabel} · {group.title}
</Text>
```

若分组为空则只显示 `group.title`，避免渲染 `undefined`；正常构建出的分组始终至少包含一项。

- [ ] **Step 4: Run the component test and verify GREEN**

Run: `node scripts/test-practice-directory-component.cjs`

Expected: all component directory interaction tests PASS and the exact heading assertion passes.

- [ ] **Step 5: Commit Task 4**

```powershell
git add -- src/pages/Practice/PracticeDirectory.tsx scripts/test-practice-directory-component.cjs
git commit -m "feat: 目录标题显示教材起始页"
```

---

### Task 5: 回归验证与交付检查

**Files:**
- Modify only if a regression reveals a requirement-related defect.

**Interfaces:**
- Consumes: Tasks 1–4 的完整行为
- Produces: 可本地验收、未推送的分支

- [ ] **Step 1: Run focused tests**

```powershell
node scripts/test-full-book-practice.cjs
node --test scripts/test-full-book-directory.cjs
node scripts/test-practice-directory-component.cjs
node scripts/test-full-practice-route.cjs
node scripts/test-practice-book-route.cjs
node scripts/test-check-in-return-navigation.cjs
node scripts/test-audio-playback.cjs
node scripts/test-check-in-detail-runtime.cjs
```

Expected: every command exits `0`.

- [ ] **Step 2: Run full regression**

Run: `npm run test:regression`

Expected: all tests pass with zero failures.

- [ ] **Step 3: Run type and build verification**

```powershell
npx tsc --noEmit --skipLibCheck
npm run build:weapp
```

Expected: both commands exit `0`; known nonblocking Browserslist, Sass, third-party type and bundle-size warnings may remain unchanged.

- [ ] **Step 4: Check repository hygiene and scope**

```powershell
git diff --check origin/main...HEAD
git status --short --branch
git log --oneline origin/main..HEAD
```

Expected: no whitespace errors, no unrelated source changes, branch remains local and nothing is pushed.

- [ ] **Step 5: Final review**

Review the complete branch diff against `docs/superpowers/specs/2026-10-06-practice-page-label-directory-design.md`, specifically proving:

```text
第 7 页
第 4 页 · Map of the units
第 14 页 · Unit 2: We're going home
第 20 页 · Vocabulary and grammar review 1
```

Confirm `9-page-8`, resource `pageNumber=8`, image URL `_8.png`, all audio tracks, and total page count remain stable.
