/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const { createPage, elements, textOf, byClass, load } = require("./test-practice-book-route.cjs");

const { BOOKS } = load("src/features/bookLibrary/bookCatalog.ts");
const { concatImages } = load("src/pages/BookDetail/Components/BookPreview/constants/images.ts");
const { buildBookPracticeBundle } = load("src/features/listeningPractice/bookPractice.ts");
const {
  clampHotspotCenter,
  resolveHotspotAnchorOffset,
} = load("src/features/listeningPractice/hotspotLayout.ts");
const centerAnchoredHotspotIds = new Set(["3-84-0", "4-140-0", "4-164-0", "5-134-0"]);
const opened = [];
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const open = (bookId, params, options) => {
  const file = BOOKS.find((book) => book.id === bookId)?.seriesId === "think"
    ? "src/pages/ThinkBookReader/ThinkBookReader.tsx" : "src/pages/Practice/Practice.tsx";
  const page = createPage(file, { bookId, ...params }, bookId === "30" || bookId === "31" ? {
    ...options,
    taroOverrides: {
      getImageInfo(request) { request.success({ width: 1536, height: bookId === "30" ? 1987 : 1984 }); },
      createSelectorQuery() {
        let callback;
        const query = {
          select() { return query; },
          boundingClientRect(next) { callback = next; return query; },
          exec() { callback?.({ width: 374, height: 560 }); return query; },
        };
        return query;
      },
      ...options?.taroOverrides,
    },
  } : options);
  opened.push(page);
  return page;
};
const imageOf = (tree) => byClass(tree, "practice-book-page__image")?.props.src;
const directoryOf = (tree) => elements(tree).find((node) => node.type?.name === "PracticeDirectory");

async function run() {
  assert.equal(typeof resolveHotspotAnchorOffset, "function", "热点锚点分类必须由可测试的纯函数统一维护");
  const anchorCounts = { legacyTopLeft: 0, confirmedCenter: 0, thinkCenter: 0, od6Center: 0 };
  for (const book of BOOKS) {
    const bundle = buildBookPracticeBundle(book.id);
    for (const practice of bundle.practices) {
      for (const track of practice.tracks) {
        const numericBookId = Number.parseInt(book.id, 10);
        let expected;
        if (centerAnchoredHotspotIds.has(track.id)) {
          anchorCounts.confirmedCenter += 1;
          expected = { offsetXPx: 0, offsetYPx: 0 };
        } else if (numericBookId >= 3 && numericBookId <= 25) {
          anchorCounts.legacyTopLeft += 1;
          expected = { offsetXPx: 13, offsetYPx: 13 };
        } else if (book.seriesId === "think") {
          anchorCounts.thinkCenter += 1;
          expected = { offsetXPx: book.id === "26" ? -22 : -8, offsetYPx: 0 };
        } else {
          anchorCounts.od6Center += 1;
          expected = { offsetXPx: 0, offsetYPx: 0 };
        }
        assert.deepEqual(
          resolveHotspotAnchorOffset(book.id, book.seriesId, track.id),
          expected,
          `教材 ${book.id} 热点 ${track.id} 的锚点类型必须与数据来源一致`,
        );
      }
    }
  }
  assert.deepEqual(anchorCounts, {
    legacyTopLeft: 2077,
    confirmedCenter: 4,
    thinkCenter: 429,
    od6Center: 130,
  }, "全部 2,640 个热点都必须且只能归入一种坐标锚点类型");

  for (const book of BOOKS) {
    const images = concatImages[book.id];
    const page = open(book.id, { page: "0" });
    let tree = page.render();
    assert.equal(imageOf(tree), images[0], `${book.id} 从真实第一页开始，不能跳过无音频页`);
    const items = directoryOf(tree).props.groups.flatMap((group) => group.items);
    assert.equal(items.length, images.length, `${book.id} 目录覆盖全部登记图片`);
    assert.equal(new Set(items.map((item) => item.practiceIndex)).size, images.length);
    for (const index of [0, Math.floor(images.length / 2), images.length - 1]) {
      await directoryOf(tree).props.onSelect(index);
      page.render();
      tree = page.render();
      assert.equal(imageOf(tree), images[index], `${book.id} 第 ${index + 1} 张可访问`);
      assert.equal(textOf(byClass(tree, "practice-header__progress")).trim(), `跟读训练 ${index + 1} / ${images.length}`);
    }
    assert.match(byClass(tree, "practice-navigation__button--primary").props.className, /--disabled/);
    page.dispose();
  }

  for (const bookId of ["3", "11", "22", "25", "30"]) {
    const legacy = buildBookPracticeBundle(bookId);
    for (const index of [0, legacy.practices.length - 1]) {
      const practice = legacy.practices[index];
      const oldPage = open(bookId, { practice: String(index) });
      oldPage.render();
      const tree = oldPage.render();
      assert.equal(imageOf(tree), practice.imageUrl, "旧链接仍打开原教材页");
      assert.equal(textOf(byClass(tree, "practice-header__progress")).trim(), `跟读训练 ${practice.imageIndex + 1} / ${concatImages[bookId].length}`);
      const hotspots = elements(tree).filter((node) => String(node.props?.className || "").split(" ").includes("audio-hotspot"));
      assert.equal(hotspots.length, practice.tracks.length);
      const actualLeft = Number.parseFloat(hotspots[0].props.style.left);
      const actualTop = Number.parseFloat(hotspots[0].props.style.top);
      const hotspotLayer = byClass(tree, "practice-book-page__hotspots--fitted");
      const imageSize = {
        width: Number.parseFloat(hotspotLayer.props.style.width),
        height: Number.parseFloat(hotspotLayer.props.style.height),
      };
      const numericBookId = Number.parseInt(bookId, 10);
      const usesLegacyAnchor = numericBookId >= 3 && numericBookId <= 25 &&
        !centerAnchoredHotspotIds.has(practice.tracks[0].id);
      const expectedCenter = clampHotspotCenter({
        left: Number.parseFloat(practice.tracks[0].left),
        top: Number.parseFloat(practice.tracks[0].top),
      }, imageSize, undefined, usesLegacyAnchor ? 13 : 0, usesLegacyAnchor ? 13 : 0);
      assert.ok(Math.abs(actualLeft - expectedCenter.left) < 0.001,
        "旧教材热点应按左上角锚点转换，中心坐标热点保持原位");
      assert.ok(Math.abs(actualTop - expectedCenter.top) < 0.001,
        "热点纵坐标应遵循本书的数据锚点类型");
      hotspots[0].props.onClick();
      assert.equal(oldPage.audios.at(-1).src, practice.tracks[0].url, "补全页面不改变原点读坐标和音源");
      oldPage.dispose();
    }
  }

  const oldPractice = buildBookPracticeBundle("22").practices[0];
  assert.notEqual(oldPractice.imageIndex, 0, "使用补页后索引变化的旧录音测试");
  const pending = {
    requestId: "abcdef0123456789abcdef0123456789", localPath: "/saved/old-draft.mp3", recoverable: true,
    context: { bookId: "22", bookTitle: "Reading Explorer 1", practiceId: oldPractice.id, practiceIndex: 0,
      pageNumber: oldPractice.pageNumber, sectionTitle: oldPractice.sectionTitle, imageUrl: oldPractice.imageUrl },
    durationMs: 1200, fileSizeBytes: 4096, status: "local", cloudFileId: "", updatedAtMs: 1,
  };
  const contextBefore = JSON.stringify(pending.context);
  const restored = open("22", { page: String(oldPractice.imageIndex) }, { pendingItems: [pending] });
  restored.render(); restored.render(); await settle();
  assert.ok(byClass(restored.render(), "check-in-button"), "补页后按稳定页 ID 恢复普通书旧录音草稿");
  assert.equal(JSON.stringify(pending.context), contextBefore, "恢复不能修改原始录音上下文或请求摘要");
  restored.dispose();

  for (const bookId of ["11", "27", "30", "31"]) {
    const page = open(bookId, { page: "0" }, { savedFilePath: "/saved/cover-recording.mp3" });
    let tree = page.render(); await settle(); tree = page.render();
    assert.equal(byClass(tree, "audio-hotspot"), undefined, "封面不虚构示范音频");
    await byClass(tree, "record-button").props.onClick();
    page.recorderHandlers.Start();
    byClass(page.render(), "record-button--stop").props.onClick();
    await page.recorderHandlers.Stop({ tempFilePath: "/tmp/cover.mp3", duration: 1500, fileSize: 4096 });
    await settle(); tree = page.render();
    assert.equal(page.savedRecordings[0].context.pageNumber, 0, "保留真实封面页号");
    assert.equal(page.savedRecordings[0].context.practiceIndex, 0);
    assert.equal(page.savedRecordings[0].context.imageUrl, concatImages[bookId][0]);
    const playback = elements(tree).find((node) => node.type === "Button" && textOf(node) === "回听录音");
    assert.ok(playback, "无示范音频页的录音可回听");
    playback.props.onClick();
    assert.equal(page.audios.at(-1).src, "/saved/cover-recording.mp3");
    await byClass(page.render(), "check-in-button").props.onClick();
    assert.equal(page.completedPending.length, 1, "无示范音频页可完成练习");
    assert.equal(page.submittedPending.length, 0);
    page.dispose();
  }

  for (const raw of ["-1", "1.2", " 1", "01", "1e2", "Infinity", "999999999999999999", String(concatImages["22"].length)]) {
    const page = open("22", { page: raw });
    assert.match(textOf(page.render()), /暂时无法打开训练/, `拒绝非法页索引 ${raw}`);
    page.dispose();
  }
  console.log("全部 29 本教材全页路由、旧链接/草稿兼容、OD6 无音频练习册录音、封面回听和完成练习通过");
}
run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => opened.forEach((page) => page.dispose()));
