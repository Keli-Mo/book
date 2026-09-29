/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const { jsx } = require("react/jsx-runtime");
const { createPage, byClass, elements, textOf, buildBookPracticeBundle, load } = require("./test-practice-book-route.cjs");
const { buildFullBookPracticeBundle } = load("src/features/listeningPractice/bookPractice.ts");

const key = "haisha:reading-progress:v1";
const storage = new Map();
const pages = [];
const scrolls = [];
const settle = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
const mount = (name, params = {}, options = {}) => {
  const page = createPage(`src/pages/${name}/${name}.tsx`, params, {
    ...options,
    overrides: {
      "taro-ui/lib/components/icon": { __esModule: true, default: () => jsx("View", {}) },
      ...options.overrides,
    },
    taroOverrides: {
      getStorageSync: (storageKey) => storage.get(storageKey),
      setStorageSync: (storageKey, value) => storage.set(storageKey, value),
      getMenuButtonBoundingClientRect: () => ({ left: 278, right: 365, top: 26, bottom: 58, width: 87, height: 32 }),
      pageScrollTo: (args) => scrolls.push(args),
      ...options.taroOverrides,
    },
  });
  pages.push(page);
  page.render();
  return page;
};
const directory = (page) => elements(page.render()).find(node => node.type?.name === "PracticeDirectory");

(async () => {
  // 实际 Home 和实际 readingProgress 模块共享本机存储边界，不用伪造的读写进度函数。
  const home = mount("Home");
  let tree = home.render();
  assert.equal(byClass(tree, "library-home__heading"), undefined);
  assert.equal(textOf(byClass(tree, "continue-card__title")), "开始跟读练习");
  assert.equal(textOf(byClass(tree, "continue-card__progress")), "还没有跟读记录，先去书库选择教材");
  assert.equal(textOf(byClass(tree, "continue-card__button")), "选择教材");
  assert.equal(byClass(tree, "continue-card__cover"), undefined);
  assert.doesNotMatch(textOf(tree), /上次练到|可跟读|册可练/);
  await byClass(tree, "continue-card__button").props.onClick();
  assert.equal(home.navigations.at(-1), "/pages/BookLibrary/BookLibrary?series=all");
  home.hide();

  const practice = mount("Practice", { bookId: "22", practice: "0" });
  practice.show(); await settle();
  assert.deepEqual(storage.get(key), { version: 2, bookId: "22", imageIndex: buildBookPracticeBundle("22").practices[0].imageIndex },
    "打开旧音频链接后，应以同一原图片位置保存新版进度");
  await directory(practice).props.onSelect(4);
  practice.render();
  assert.equal(storage.get(key).imageIndex, 4, "目录切页应保存真实生效的原图片位置，不是原始入口 URL");
  home.show(); tree = home.render();
  const bundle = buildFullBookPracticeBundle("22");
  assert.equal(byClass(tree, "library-home__heading"), undefined);
  assert.equal(textOf(byClass(tree, "continue-card__title")), bundle.book.title);
  assert.equal(byClass(tree, "continue-card__cover").props.src, bundle.book.cover);
  assert.equal(textOf(byClass(tree, "continue-card__progress")), `${bundle.practices[4].sectionTitle} · 教材第 ${bundle.practices[4].pageNumber} 页`);
  assert.equal(textOf(byClass(tree, "continue-card__button")), "继续跟读");
  await byClass(tree, "continue-card__button").props.onClick();
  assert.equal(home.navigations.at(-1), "/pages/Practice/Practice?bookId=22&page=4");

  practice.hide(); storage.set(key, { version: 1, bookId: "3", practiceIndex: 2 });
  practice.render(); await settle();
  assert.equal(storage.get(key).bookId, "3", "隐藏教材页的重新渲染不得覆盖当前阅读位置");
  practice.show(); practice.render();
  assert.equal(storage.get(key).bookId, "22", "重新显示原教材页时应将它作为最近阅读位置");
  assert.equal(storage.get(key).imageIndex, 4);
  practice.hide();

  for (let id = 3; id <= 30; id += 1) {
    const bookId = String(id);
    const sourceBundle = buildBookPracticeBundle(bookId);
    const practiceIndex = Math.min(7, sourceBundle.practices.length - 1);
    const sourcePractice = sourceBundle.practices[practiceIndex];
    storage.set(key, { version: 1, bookId, practiceIndex });
    home.show(); tree = home.render();
    assert.equal(textOf(byClass(tree, "continue-card__progress")),
      `${sourcePractice.sectionTitle} · 教材第 ${sourcePractice.pageNumber} 页`,
      "旧进度应继续显示原音频题的真实页码");
    await byClass(tree, "continue-card__button").props.onClick();
    assert.equal(home.navigations.at(-1),
      sourceBundle.book.seriesId === "think"
        ? `/pages/ThinkBookReader/ThinkBookReader?bookId=${bookId}&page=${sourcePractice.imageIndex}`
        : `/pages/Practice/Practice?bookId=${bookId}&practice=${practiceIndex}`,
      "旧进度继续阅读不能把音频索引重新解释为全页索引");
    assert.deepEqual(storage.get(key), { version: 1, bookId, practiceIndex }, "首页显示旧进度不能改写存储");
  }

  for (const bookId of ["11", "22", "26", "27", "28", "29", "30", "31"]) {
    const full = buildFullBookPracticeBundle(bookId);
    const silentPage = full.practices.find((item) => item.tracks.length === 0);
    assert.ok(silentPage, "测试教材必须包含新增无音频页");
    for (const page of [silentPage, full.practices.at(-1)]) {
      storage.set(key, { version: 2, bookId, imageIndex: page.imageIndex });
      home.show(); tree = home.render();
      assert.equal(textOf(byClass(tree, "continue-card__title")), full.book.title);
      assert.equal(textOf(byClass(tree, "continue-card__progress")), `${page.sectionTitle} · ${page.pageLabel || `教材第 ${page.pageNumber} 页`}`);
      await byClass(tree, "continue-card__button").props.onClick();
      assert.equal(home.navigations.at(-1), full.book.seriesId === "think"
        ? `/pages/ThinkBookReader/ThinkBookReader?bookId=${bookId}&page=${page.imageIndex}`
        : `/pages/Practice/Practice?bookId=${bookId}&page=${page.imageIndex}`);
    }
  }

  const think = mount("ThinkBookReader", { bookId: "28", page: "0" });
  think.show(); await settle();
  assert.deepEqual(storage.get(key), { version: 2, bookId: "28", imageIndex: 0 }, "Think 新增页也必须保存稳定阅读位置");
  const thinkLast = buildFullBookPracticeBundle("28").practices.at(-1);
  await directory(think).props.onSelect(thinkLast.imageIndex);
  think.render();
  assert.deepEqual(storage.get(key), { version: 2, bookId: "28", imageIndex: thinkLast.imageIndex });
  think.hide();

  for (const bookId of ["30", "31"]) {
    const od6 = mount("Practice", { bookId, page: "0" });
    od6.show(); await settle();
    assert.deepEqual(storage.get(key), { version: 2, bookId, imageIndex: 0 }, "OD6 应沿用通用训练页并保存稳定位置");
    const last = buildFullBookPracticeBundle(bookId).practices.at(-1);
    await directory(od6).props.onSelect(last.imageIndex);
    od6.render();
    assert.deepEqual(storage.get(key), { version: 2, bookId, imageIndex: last.imageIndex });
    assert.equal(byClass(od6.render(), "practice-book-page__image").props.src, last.imageUrl);
    home.show(); tree = home.render();
    await byClass(tree, "continue-card__button").props.onClick();
    assert.equal(home.navigations.at(-1), `/pages/Practice/Practice?bookId=${bookId}&page=${last.imageIndex}`);
    od6.hide();
  }

  const cancelled = mount("Practice", { bookId: "3", practice: "1" }, { taroOverrides: { showModal: async () => ({ confirm: false }) } });
  cancelled.show();
  await byClass(cancelled.render(), "record-button").props.onClick();
  cancelled.recorderHandlers.Start(); cancelled.render();
  await directory(cancelled).props.onSelect(5);
  assert.equal(storage.get(key).imageIndex, buildBookPracticeBundle("3").practices[1].imageIndex, "取消放弃录音时不能把阅读进度提前写成目标页");
  assert.equal(storage.get(key).bookId, "3");

  storage.set(key, { version: 2, bookId: "22", practiceIndex: 4 });
  home.show(); tree = home.render();
  assert.equal(textOf(byClass(tree, "continue-card__button")), "选择教材", "缺少稳定图片位置的 v2 进度应移除虚假历史显示");
  const unavailable = mount("Home", {}, { taroOverrides: { getStorageSync: () => { throw new Error("storage unavailable"); } } });
  assert.equal(textOf(byClass(unavailable.render(), "continue-card__button")), "选择教材");
  const failure = mount("Practice", { bookId: "22", practice: "2" }, { taroOverrides: { setStorageSync: () => { throw new Error("storage full"); } } });
  failure.show(); await directory(failure).props.onSelect(3);
  failure.render(); await settle();
  assert.equal(byClass(failure.render(), "practice-book-page__image").props.src, bundle.practices[3].imageUrl, "进度保存失败不能阻断教材切页");

  const library = mount("BookLibrary", { series: "casa" });
  tree = library.render();
  assert.equal(textOf(byClass(tree, "book-row__title")), "第 1 册");
  byClass(tree, "book-search__input").props.onInput({ detail: { value: "2" } });
  tree = library.render();
  const filters = elements(tree).filter(node => String(node.props?.className || "").split(" ").includes("series-filter"));
  filters.find(node => textOf(node) === "全部").props.onClick();
  tree = library.render();
  const rows = () => elements(library.render()).filter(node => node.props?.className === "book-row").map(textOf);
  const beforeRows = rows(); const beforeScrolls = scrolls.length;
  assert.ok(beforeRows.length > 1);
  await byClass(tree, "book-row").props.onClick();
  assert.equal(library.navigationMethods.at(-1), "navigateTo", "书库进入教材必须保留页面栈");
  assert.match(library.navigations.at(-1), /&page=0$/, "书库新入口应从完整教材首页开始");
  library.hide(); library.show(); tree = library.render();
  assert.equal(byClass(tree, "book-search__input").props.value, "2");
  assert.equal(textOf(elements(tree).find(node => /series-filter .*is-selected/.test(node.props?.className || ""))), "全部");
  assert.deepEqual(rows(), beforeRows, "返回书库后筛选结果必须保持");
  assert.equal(scrolls.length, beforeScrolls, "书库重显不应主动将页面滚回顶部");
  assert.doesNotMatch(textOf(tree), /可跟读/);
  console.log("阅读进度页面测试通过：实际 Home/Practice/BookLibrary 路由、重显刷新、取消切页、存储失败及筛选保持。");
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => pages.forEach(page => page.dispose()));
