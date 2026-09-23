/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const {
  createPage,
  elements,
  textOf,
  byClass,
  load,
} = require("./test-practice-book-route.cjs");

const { buildThinkBookReader } = load("src/features/bookLibrary/thinkBookReader.ts");
const { buildBookPracticeBundle } = load("src/features/listeningPractice/bookPractice.ts");
const readerFile = "src/pages/ThinkBookReader/ThinkBookReader.tsx";
const livePages = [];
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

const openReader = (bookId, imageIndex, options) => {
  const page = createPage(readerFile, { bookId, page: String(imageIndex) }, options);
  livePages.push(page);
  return page;
};

const requireClass = (tree, className, bookId) => {
  const node = byClass(tree, className);
  assert.ok(node, `Think ${bookId} 应沿用现有练习页的 .${className}`);
  return node;
};

const hotspotsOf = (tree) => elements(tree).filter((node) =>
  String(node.props?.className || "").split(" ").includes("audio-hotspot"),
);

const stopControlOf = (tree) => elements(tree).find((node) =>
  typeof node.props?.onClick === "function" && textOf(node).trim() === "停止当前音频",
);

async function run() {
  for (const bookId of ["26", "27", "28", "29"]) {
    const reader = buildThinkBookReader(bookId);
    assert.ok(reader, `Think ${bookId} 应有筛选后的阅读页`);
    const page = openReader(bookId, 0);
    page.render();
    await settle();
    const tree = page.render();

    requireClass(tree, "practice-screen", bookId);
    assert.equal(
      textOf(requireClass(tree, "check-in-navigation__title", bookId)),
      "听力跟读训练",
      `Think ${bookId} 顶部应沿用练习页导航标题`,
    );
    requireClass(tree, "practice-page", bookId);
    requireClass(tree, "practice-header", bookId);
    requireClass(tree, "practice-header__progress", bookId);
    const image = requireClass(tree, "practice-book-page__image", bookId);
    assert.equal(image.props.src, reader.pages[0].imageUrl);
    assert.equal(hotspotsOf(tree).length, reader.pages[0].tracks.length);
    requireClass(tree, "audio-hotspot__visual", bookId);
    requireClass(tree, "practice-recorder", bookId);
    assert.equal(textOf(requireClass(tree, "practice-recorder__title", bookId)), "我的跟读");
    assert.match(textOf(requireClass(tree, "record-button", bookId)), /开始跟读录音/);
    requireClass(tree, "practice-navigation", bookId);
    requireClass(tree, "practice-navigation__button--primary", bookId);
    assert.ok(
      elements(tree).some((node) => node.type?.name === "PracticeDirectory"),
      `Think ${bookId} 应复用现有 PracticeDirectory`,
    );
  }

  const legacyBundle = buildBookPracticeBundle("28");
  const legacyIndex = legacyBundle.practices.findIndex((item) => item.imageIndex === 20);
  const legacyPractice = legacyBundle.practices[legacyIndex];
  const filteredReader = buildThinkBookReader("28");
  const filteredIndex = filteredReader.pages.findIndex((item) => item.imageIndex === 20);
  assert.ok(legacyPractice && filteredIndex > legacyIndex,
    "加入 p13 跨页续页后，后续页的旧练习索引应与新阅读索引不同");
  const oldPendingPath = "/saved/think-old-index.mp3";
  const pendingPage = openReader("28", 20, { pendingItems: [{
    requestId: "thinkoldindex0123456789abcdef01234",
    localPath: oldPendingPath,
    recoverable: true,
    context: {
      bookId: "28",
      bookTitle: legacyBundle.book.title,
      practiceId: legacyPractice.id,
      practiceIndex: legacyIndex,
      pageNumber: legacyPractice.pageNumber,
      sectionTitle: legacyPractice.sectionTitle,
      imageUrl: legacyPractice.imageUrl,
    },
    durationMs: 900,
    fileSizeBytes: 3000,
    cloudFileId: "",
    status: "local",
    updatedAtMs: 1,
  }] });
  pendingPage.render();
  pendingPage.render();
  await settle();
  pendingPage.render();
  assert.ok(pendingPage.stateValues().some((value) => value?.localPath === oldPendingPath),
    "旧版 Think 草稿应按稳定教材页 ID 在原页恢复");

  const reader = buildThinkBookReader("28");
  const audioPage = reader.pages.find((item) => item.imageIndex === 12);
  const continuationPage = reader.pages.find((item) => item.imageIndex === 13);
  assert.ok(audioPage?.tracks.length > 0, "Think 2 学生书 p12 应有音频题");
  assert.ok(continuationPage && continuationPage.tracks.length === 0,
    "Think 2 学生书 p13 应保留为无音频图标的跨页续页");

  const page = openReader("28", 12);
  page.render();
  await settle();
  let tree = page.render();
  assert.equal(requireClass(tree, "practice-book-page__image", "28").props.src, audioPage.imageUrl);
  hotspotsOf(tree)[0].props.onClick();
  const audio = page.audios.at(-1);
  assert.ok(audio?.events.includes("play"), "点击 p12 图标应播放真实示范音频");

  await requireClass(page.render(), "practice-navigation__button--primary", "28").props.onClick();
  tree = page.render();
  assert.equal(requireClass(tree, "practice-book-page__image", "28").props.src,
    continuationPage.imageUrl, "下一页应显示 p13 跨页续页");
  assert.equal(hotspotsOf(tree).length, 0, "跨页续页不应虚构音频图标");
  assert.equal(audio.events.includes("destroy"), false, "翻到跨页续页时音频应继续播放");
  const stop = stopControlOf(tree);
  assert.ok(stop, "无图标续页应有明确的停止当前音频控件");
  stop.props.onClick();
  assert.ok(audio.events.includes("destroy"), "显式停止应销毁播放实例");

  const hidePage = openReader("28", 12);
  hidePage.render();
  await settle();
  tree = hidePage.render();
  hotspotsOf(tree)[0].props.onClick();
  const hiddenAudio = hidePage.audios.at(-1);
  assert.ok(hiddenAudio?.events.includes("play"));
  hidePage.hide();
  assert.ok(hiddenAudio.events.includes("destroy"), "页面隐藏应停止并销毁播放实例");

  console.log("Think 四册 UI 与跨页播放测试通过：沿用听力跟读训练框架，p12→p13 继续播放。");
}

run()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => livePages.forEach((page) => page.dispose()));
