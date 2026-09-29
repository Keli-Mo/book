/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createPage, byClass, textOf, load } = require("./test-practice-book-route.cjs");
const { BOOKS } = load("src/features/bookLibrary/bookCatalog.ts");
const { buildBookPracticeBundle, buildFullBookPracticeBundle } = load("src/features/listeningPractice/bookPractice.ts");

const settle = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
const fromPractice = (bundle, practice, practiceIndex) => ({
  bookId: bundle.book.id, bookTitle: bundle.book.title, practiceId: practice.id,
  practiceIndex, pageNumber: practice.pageNumber, imageUrl: practice.imageUrl,
  sectionTitle: practice.sectionTitle,
});
const expectedUrl = (bookId, imageIndex) =>
  `/pages/${BOOKS.find((book) => book.id === bookId)?.seriesId === "think" ? "ThinkBookReader/ThinkBookReader" : "Practice/Practice"}?bookId=${bookId}&page=${imageIndex}`;
async function readAndReturn(context, source = "local") {
  const original = JSON.stringify(context);
  const pending = {
    requestId: "detail-page-route", localPath: "wxfile://recording.mp3", recoverable: true,
    context, durationMs: 1800, fileSizeBytes: 4000, cloudFileId: "",
    status: "local", updatedAtMs: 1, completedAtMs: 2,
  };
  const cloud = { ...context, id: "cloud", shareToken: "token", recordingUrl: "https://example.com/recording.mp3", durationMs: 1800, createdAt: 2, isOwner: true };
  const page = createPage("src/pages/CheckInDetail/CheckInDetail.tsx",
    source === "local" ? { localId: pending.requestId } : { id: cloud.id }, {
      detail: cloud,
      overrides: {
        "@/features/listeningPractice/pendingCheckInRuntime": {
          getPendingCheckInStore: () => ({ ready: async () => {}, list: () => [pending] }),
          getActivePendingRecovery: () => undefined, logRecordingDiagnostic() {}, diagnoseLocalRecordingFailure() {},
        },
      },
    });
  try {
    page.render(); await settle(); const tree = page.render();
    const label = textOf(byClass(tree, "check-in-course-card__meta"));
    await byClass(tree, "check-in-actions__practice").props.onClick();
    assert.equal(JSON.stringify(context), original, "展示与回跳不能改写旧录音 context/digest 输入");
    return { url: page.navigations.at(-1), label };
  } finally { page.dispose(); }
}

for (const source of ["local", "cloud"]) {
  test(`${source}: 旧音频录音按稳定 ID 回原图页，不能把旧索引解释为全页索引`, async () => {
    const bundle = buildBookPracticeBundle("22");
    const practiceIndex = bundle.practices.findIndex((p, i) => p.imageIndex !== i && i > 0);
    const practice = bundle.practices[practiceIndex];
    assert.ok(practice);
    const result = await readAndReturn(fromPractice(bundle, practice, practiceIndex), source);
    assert.equal(result.url, expectedUrl("22", practice.imageIndex));
  });
  test(`${source}: 新增无音频页按稳定 ID 回原页，不落入旧音频索引`, async () => {
    const bundle = buildFullBookPracticeBundle("22");
    const practice = bundle.practices.find((p, i) => p.tracks.length === 0 && i > 0);
    assert.ok(practice);
    const result = await readAndReturn(fromPractice(bundle, practice, practice.imageIndex), source);
    assert.equal(result.url, expectedUrl("22", practice.imageIndex));
  });
}

test("稳定 ID 优先于不同版本留下的练习索引和页号", async () => {
  const bundle = buildBookPracticeBundle("3");
  const practice = bundle.practices[5];
  const result = await readAndReturn({ ...fromPractice(bundle, practice, 0), pageNumber: bundle.practices[0].pageNumber });
  assert.equal(result.url, expectedUrl("3", practice.imageIndex));
});

test("缺 ID 的记录可按原图 URL 定位，并保持全页索引不被误当旧索引", async () => {
  const bundle = buildFullBookPracticeBundle("22");
  const practice = bundle.practices.find((p) => p.tracks.length === 0 && p.imageIndex > 0);
  const context = fromPractice(bundle, practice, practice.imageIndex);
  delete context.practiceId; delete context.pageNumber;
  assert.equal((await readAndReturn(context, "cloud")).url, expectedUrl("22", practice.imageIndex));
});

test("缺 ID/原图的旧记录可用有效印刷页号定位", async () => {
  const bundle = buildBookPracticeBundle("22");
  const practice = bundle.practices[4];
  const context = fromPractice(bundle, practice, 0);
  delete context.practiceId; delete context.imageUrl;
  assert.equal((await readAndReturn(context, "cloud")).url, expectedUrl("22", practice.imageIndex));
});

test("只剩旧音频索引的历史记录按旧列表转换", async () => {
  const bundle = buildBookPracticeBundle("22");
  const result = await readAndReturn({ bookId: "22", bookTitle: bundle.book.title, practiceIndex: 4, sectionTitle: "旧记录" }, "cloud");
  assert.equal(result.url, expectedUrl("22", bundle.practices[4].imageIndex));
});

test("旧索引无效或越界时不能回到默认页", async () => {
  for (const practiceIndex of [-1, 0.5, Number.POSITIVE_INFINITY, 999999]) {
    const result = await readAndReturn({ bookId: "22", bookTitle: "旧教材", practiceIndex, sectionTitle: "旧记录" }, "cloud");
    assert.equal(result.url, "/pages/BookLibrary/BookLibrary");
  }
});

test("未知旧 ID 仍可通过互相吻合的真实图片和页号返回", async () => {
  const bundle = buildBookPracticeBundle("22");
  const practice = bundle.practices[4];
  const result = await readAndReturn({ ...fromPractice(bundle, practice, 0), practiceId: "legacy-unknown-format" });
  assert.equal(result.url, expectedUrl("22", practice.imageIndex));
});

test("存在无效稳定坐标时，合法整数索引不能使其误跳其他页", async () => {
  const result = await readAndReturn({ bookId: "22", bookTitle: "测试", practiceId: "not-a-real-page", practiceIndex: 0, pageNumber: 999999, imageUrl: "not-a-real-image", sectionTitle: "无效记录" });
  assert.equal(result.url, "/pages/BookLibrary/BookLibrary");
});

test("页号与原图分别指向不同真实页时不猜测目标", async () => {
  const bundle = buildBookPracticeBundle("22");
  const context = fromPractice(bundle, bundle.practices[4], 0);
  delete context.practiceId;
  context.pageNumber = bundle.practices[0].pageNumber;
  assert.equal((await readAndReturn(context, "cloud")).url, "/pages/BookLibrary/BookLibrary");
});

test("封面录音可回原图，详情不会显示教材第 0 页", async () => {
  const bundle = buildFullBookPracticeBundle("11");
  const cover = bundle.practices.find((p) => p.pageNumber === 0);
  assert.ok(cover);
  const result = await readAndReturn(fromPractice(bundle, cover, cover.imageIndex));
  assert.equal(result.url, expectedUrl("11", cover.imageIndex));
  assert.match(result.label, /封面/);
  assert.doesNotMatch(result.label, /教材页\s*0|第\s*0\s*页/);
});

for (const bookId of ["26", "27", "28", "29"]) {
  test(`Think ${bookId}: 新放开的非音频页回跳仍使用原图索引`, async () => {
    const bundle = buildFullBookPracticeBundle(bookId);
    const practice = bundle.practices.find((p) => p.tracks.length === 0);
    assert.ok(practice);
    const result = await readAndReturn(fromPractice(bundle, practice, practice.imageIndex));
    assert.equal(result.url, expectedUrl(bookId, practice.imageIndex));
  });
}

for (const bookId of ["30", "31"]) {
  for (const source of ["local", "cloud"]) {
    test(`OD6 ${bookId} ${source}: 无音频页录音回到通用训练的原图片索引`, async () => {
      const bundle = buildFullBookPracticeBundle(bookId);
      const practice = bundle.practices.find((p) => p.tracks.length === 0 && p.imageIndex > 0);
      assert.ok(practice);
      const result = await readAndReturn(fromPractice(bundle, practice, practice.imageIndex), source);
      assert.equal(result.url, `/pages/Practice/Practice?bookId=${bookId}&page=${practice.imageIndex}`);
    });
  }
}

test("Think 旧练习册录音仍按印刷页和稳定 ID 回到原 PDF 图片索引", async () => {
  for (const bookId of ["27", "29"]) {
    const bundle = buildBookPracticeBundle(bookId);
    const practice = bundle.practices[0];
    assert.notEqual(practice.pageNumber, practice.imageIndex);
    for (const source of ["local", "cloud"]) {
      const result = await readAndReturn(fromPractice(bundle, practice, 0), source);
      assert.equal(result.url, expectedUrl(bookId, practice.imageIndex));
    }
  }
});
