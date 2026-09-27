/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const test = require("node:test");
const { createPage, byClass, elements, textOf } = require("./test-practice-book-route.cjs");

const natural = { width: 600, height: 900 };
const routes = [
  { name: "普通教材", file: "src/pages/Practice/Practice.tsx", params: { bookId: "22", page: "9" } },
  { name: "Think", file: "src/pages/ThinkBookReader/ThinkBookReader.tsx", params: { bookId: "28", page: "12" } },
];
const modes = [
  { name: "手机竖屏", isPad: false, orientation: "portrait", windowWidth: 360, windowHeight: 780, slot: { width: 360, height: 100 } },
  { name: "手机横屏", isPad: false, orientation: "landscape", windowWidth: 844, windowHeight: 390, slot: { width: 500, height: 230 } },
  { name: "Pad 竖屏", isPad: true, orientation: "portrait", windowWidth: 768, windowHeight: 1024, slot: { width: 700, height: 800 } },
  { name: "Pad 横屏", isPad: true, orientation: "landscape", windowWidth: 1180, windowHeight: 820, slot: { width: 700, height: 500 } },
];
const layoutFor = (mode) => ({
  ...mode,
  isSplit: mode.isPad && mode.orientation === "landscape",
  contentMaxWidth: mode.isPad ? (mode.orientation === "landscape" ? 1280 : 820) : null,
  statusBarHeight: 20,
  safeAreaBottom: 0,
});
const render = (page) => { page.render(); page.render(); return page.render(); };
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

function fixture(route, mode, { deferred = false, confirmSwitch = true } = {}) {
  let profile = layoutFor(mode);
  const slot = { ...mode.slot };
  const measurements = [];
  const selectors = [];
  const previews = [];
  const page = createPage(route.file, route.params, {
    savedFilePath: `/saved/fitted-${route.params.bookId}.mp3`,
    showModal: async () => ({ confirm: confirmSwitch }),
    overrides: { "@/hooks/useDeviceLayout": { useDeviceLayout: () => profile } },
    taroOverrides: {
      getImageInfo({ success }) { success(natural); },
      nextTick(callback) { callback(); },
      previewImage(options) { previews.push(options); return Promise.resolve(); },
      createSelectorQuery() {
        const requests = [];
        let selector;
        const query = {
          select(value) { selector = value; selectors.push(value); return query; },
          boundingClientRect(callback) { requests.push({ selector, callback }); return query; },
          exec(callback) {
            const results = requests.map(() => ({ ...slot }));
            const deliver = () => {
              requests.forEach((request, index) => request.callback?.(results[index]));
              callback?.(results);
            };
            if (deferred) measurements.push(deliver);
            else deliver();
          },
        };
        return query;
      },
    },
  });
  render(page);
  return {
    page, slot, measurements, selectors, previews,
    rotate(nextMode) {
      profile = layoutFor(nextMode);
      Object.assign(slot, nextMode.slot);
      return render(page);
    },
  };
}

const hasClass = (node, name) => node.props?.className?.split(/\s+/).includes(name);
const imageContainer = (tree, className, imageUrl) => elements(tree).find((node) =>
  hasClass(node, className) && elements(node).some((child) => child.type === "Image" && child.props.src === imageUrl),
);
const activeBookPage = (tree) => imageContainer(tree, "practice-book-page", byClass(tree, "practice-book-page__image")?.props.src);
const activeBookScroll = (tree) => imageContainer(tree, "practice-book-scroll", byClass(tree, "practice-book-page__image")?.props.src);

function assertImageSize(page, slot, mode, message = "教材尺寸", imageNatural = natural) {
  const tree = render(page);
  const scrollable = mode.orientation === "landscape";
  const outerStyle = byClass(tree, "practice-book-viewport")?.props.style;
  if (scrollable) {
    assert.equal(Number.parseFloat(outerStyle?.width), slot.width, "Pad 与横屏外层保持固定书区宽度");
    assert.equal(Number.parseFloat(outerStyle?.height), slot.height, "Pad 与横屏外层保持固定书区高度");
  }
  const style = scrollable ? activeBookPage(tree)?.props.style : outerStyle;
  assert.ok(style, "教材必须有明确图面尺寸");
  const width = Number.parseFloat(style.width);
  const height = Number.parseFloat(style.height);
  const scale = mode.isPad && !scrollable
    ? Math.min(slot.width / imageNatural.width, slot.height / imageNatural.height)
    : slot.width / imageNatural.width;
  assert.ok(Math.abs(width - imageNatural.width * scale) <= 1, `${message}：宽度 ${width}，期望 ${imageNatural.width * scale}`);
  assert.ok(Math.abs(height - imageNatural.height * scale) <= 1, `${message}：高度 ${height}，期望 ${imageNatural.height * scale}`);
  assert.ok(Math.abs(width - height * imageNatural.width / imageNatural.height) <= 1, `${message}必须保持原图比例`);
  if (mode.isPad && !scrollable) {
    assert.ok(width <= slot.width && height <= slot.height, "Pad 竖屏整页不能超出阅读区");
    assert.equal(byClass(tree, "practice-book-page__image").props.mode, "scaleToFill", "等比定框后图像与热点共用相同尺寸");
    assert.equal(byClass(tree, "practice-book-scroll-hint"), undefined);
  }
  return { width, height, outerStyle };
}

function assertControls(page, mode) {
  const tree = render(page);
  const fitted = mode.isPad || mode.orientation === "landscape";
  const controls = byClass(tree, "practice-workspace__controls");
  assert.equal(controls?.type, fitted ? "ScrollView" : "View");
  assert.equal(Boolean(controls?.props.scrollY), fitted);
  assert.equal(Boolean(byClass(tree, "practice-screen--fitted")), fitted);
  assert.equal(Boolean(byClass(tree, "practice-page--fitted")), fitted);
  assert.equal(Boolean(byClass(tree, "practice-page--landscape")), mode.orientation === "landscape");
  assert.equal(Boolean(byClass(tree, "practice-book-expand")), mode.isPad && mode.orientation === "portrait");
  const scroll = activeBookScroll(tree);
  if (mode.orientation === "landscape") {
    assert.equal(scroll?.type, "ScrollView", "横屏书页使用原生纵向滚动");
    assert.equal(scroll.props.scrollY, true);
    assert.ok(scroll.key !== undefined && scroll.key !== null, "滚动节点需要显式 key 以便翻页复位");
  } else {
    assert.equal(byClass(tree, "practice-book-scroll"), undefined, "竖屏不增加书内滚动容器");
  }
}

const begin = async (page) => {
  await byClass(page.render(), "record-button").props.onClick();
  page.recorderHandlers.Start();
  return render(page);
};
const pause = (page) => {
  byClass(page.render(), "record-button--pause").props.onClick();
  page.recorderHandlers.Pause();
  return render(page);
};
const finish = async (page) => {
  byClass(page.render(), "record-button--stop").props.onClick();
  await page.recorderHandlers.Stop({ tempFilePath: "/tmp/fitted-recording.mp3", duration: 2200, fileSize: 8192 });
  await settle();
  return render(page);
};
const loadAgain = (page) => {
  byClass(page.render(), "practice-book-page__image").props.onLoad({ detail: natural });
  return render(page);
};
const cleanup = (page) => { page.unload(); page.dispose(); };
const progress = (page) => {
  const label = textOf(byClass(render(page), "practice-header__progress"));
  const pageNumbers = label.match(/\d+\s*\/\s*\d+/)?.[0];
  assert.ok(pageNumbers, `必须显示当前页码与总页数：${label}`);
  return pageNumbers;
};

for (const route of routes) {
  test(`${route.name}：Pad 竖屏长页、宽页及翻页均完整显示，无需上下滚动`, async () => {
    const { page, slot } = fixture(route, modes[2]);
    try {
      for (const size of [{ width: 600, height: 1500 }, { width: 1200, height: 600 }]) {
        byClass(render(page), "practice-book-page__image").props.onLoad({ detail: size });
        assertImageSize(page, slot, modes[2], "不同纵横比整页显示", size);
        assertControls(page, modes[2]);
      }
      await byClass(render(page), "practice-navigation__button--primary").props.onClick();
      loadAgain(page);
      assertImageSize(page, slot, modes[2], "切换新页后");
      assertControls(page, modes[2]);
    } finally { cleanup(page); }
  });

  test(`${route.name}：横屏仅为已保留的教材图片创建原生滚动容器`, () => {
    const { page } = fixture(route, modes[1]);
    try {
      const nodes = elements(render(page));
      const scrolls = nodes.filter((node) => hasClass(node, "practice-book-scroll"));
      const images = nodes.filter((node) => node.type === "Image" &&
        (hasClass(node, "practice-book-page__image") || hasClass(node, "practice-book-page__neighbor")));
      assert.ok(images.length > 0 && images.length <= 24);
      assert.equal(scrolls.length, images.length, "不为整本书数百个尚未加载的页创建空 ScrollView");
    } finally { cleanup(page); }
  });

  test(`${route.name}：横屏使用固定视口与按宽显示的书内纵向滚动`, () => {
    const { page, slot } = fixture(route, modes[1]);
    try {
      const tree = render(page);
      const viewport = byClass(tree, "practice-book-viewport");
      assert.deepEqual(viewport.props.style, { width: `${slot.width}px`, height: `${slot.height}px` });
      const scroll = activeBookScroll(tree);
      assert.equal(scroll?.type, "ScrollView");
      assert.equal(scroll.props.scrollY, true);
    } finally { cleanup(page); }
  });

  for (const mode of modes) {
    test(`${route.name}：${mode.name}尺寸与操作容器，并且录音各状态不挤动教材`, async () => {
      const { page, slot, selectors } = fixture(route, mode);
      try {
        const initial = assertImageSize(page, slot, mode);
        assertControls(page, mode);
        const initialScrollKey = activeBookScroll(render(page))?.key;
        await begin(page);
        loadAgain(page);
        assert.deepEqual(assertImageSize(page, slot, mode, "录音中"), initial);
        assert.equal(activeBookScroll(render(page))?.key, initialScrollKey, "录音中保持书内滚动节点");
        pause(page);
        loadAgain(page);
        assert.deepEqual(assertImageSize(page, slot, mode, "暂停后"), initial);
        assert.equal(activeBookScroll(render(page))?.key, initialScrollKey, "暂停不能复位书内滚动");
        await finish(page);
        loadAgain(page);
        assert.deepEqual(assertImageSize(page, slot, mode, "保存后"), initial);
        assert.equal(activeBookScroll(render(page))?.key, initialScrollKey, "保存不能复位书内滚动");
        assert.equal(page.savedRecordings.length, 1);
        assert.ok(selectors.length > 0);
        assert.ok(selectors.every((selector) => selector === ".practice-workspace__book"), "所有尺寸应来自同一个书图区");
      } finally { cleanup(page); }
    });
  }

  for (const mode of [modes[1], modes[2], modes[3]]) {
    test(`${route.name}：${mode.name}图片与音频热点同处图面，录音操作留在外侧`, () => {
      const { page, slot } = fixture(route, mode);
      try {
        const tree = render(page);
        const bookPage = activeBookPage(tree);
        const scroll = activeBookScroll(tree);
        assertImageSize(page, slot, mode);
        if (mode.orientation === "landscape") {
          assert.equal(scroll.type, "ScrollView");
          assert.equal(scroll.props.scrollY, true);
          assert.ok(elements(scroll).includes(bookPage), "整张教材页面在同一个原生滚动容器里");
        } else {
          assert.equal(scroll, undefined, "Pad 竖屏整页显示无需纵向滚动");
        }
        const image = byClass(bookPage, "practice-book-page__image");
        assert.ok(image, "实际教材图片随页面滚动");
        const hotspots = byClass(bookPage, "practice-book-page__hotspots");
        assert.ok(hotspots, "热点层必须在同一教材图面内，不能固定于裁剪视口");
        const audioHotspots = elements(hotspots).filter((node) => hasClass(node, "audio-hotspot"));
        assert.ok(audioHotspots.length > 0, "此测试页必须实际含音频热点");
        assert.equal(audioHotspots.length, elements(tree).filter((node) => hasClass(node, "audio-hotspot")).length);
        assert.equal(byClass(scroll || bookPage, "practice-recorder"), undefined, "书页不包含录音区");
        assert.equal(byClass(scroll || bookPage, "practice-navigation"), undefined, "翻页操作保持在独立控制区");
        const before = page.audios.length;
        audioHotspots[0].props.onClick();
        assert.ok(page.audios.length > before);
        assert.ok(page.audios.at(-1).events.includes("play"), "滚动内的热点仍可播放示范音频");
      } finally { cleanup(page); }
    });
  }

  for (const mode of [modes[1], modes[3]]) {
    test(`${route.name}：${mode.name}成功翻页及返回时更换对应滚动节点，使新当前页从顶部开始`, async () => {
      const { page, slot } = fixture(route, mode);
      try {
        const initialTree = render(page);
        const imageA = byClass(initialTree, "practice-book-page__image").props.src;
        const scrollA = activeBookScroll(initialTree);
        const initialProgress = progress(page);
        const acquireAttempts = page.acquireAttempts;
        await byClass(page.render(), "practice-navigation__button--primary").props.onClick();
        const nextTree = render(page);
        const imageB = byClass(nextTree, "practice-book-page__image").props.src;
        assert.notEqual(imageB, imageA);
        const inactiveA = imageContainer(nextTree, "practice-book-scroll", imageA);
        const activeB = activeBookScroll(nextTree);
        assert.ok(inactiveA, "相邻旧页保留在 Swiper 中，才能验证原生滚动节点复位");
        assert.notEqual(inactiveA.key, scrollA.key, "旧页离开 active 状态时更换其滚动节点");
        assert.notEqual(progress(page), initialProgress);
        await byClass(page.render(), "practice-navigation__button").props.onClick();
        const backTree = render(page);
        assert.equal(byClass(backTree, "practice-book-page__image").props.src, imageA);
        assert.notEqual(activeBookScroll(backTree).key, inactiveA.key, "回到旧页时重建 active 原生节点，从顶部阅读");
        assert.notEqual(imageContainer(backTree, "practice-book-scroll", imageB).key, activeB.key);
        assert.equal(progress(page), initialProgress);
        assert.equal(page.acquireAttempts, acquireAttempts, "只更新书页滚动节点，不重新挂载录音会话");
        assertImageSize(page, slot, mode, "返回旧页后");
      } finally { cleanup(page); }
    });
  }

  test(`${route.name}：横屏录音中取消翻页保留书内滚动节点和录音状态`, async () => {
    const { page, slot } = fixture(route, modes[1], { confirmSwitch: false });
    try {
      await begin(page);
      const initial = render(page);
      const imageUrl = byClass(initial, "practice-book-page__image").props.src;
      const scrollKey = activeBookScroll(initial).key;
      const initialProgress = progress(page);
      const recorderActions = [...page.recorderActions];
      await byClass(page.render(), "practice-navigation__button--primary").props.onClick();
      const tree = render(page);
      assert.equal(progress(page), initialProgress);
      assert.equal(byClass(tree, "practice-book-page__image").props.src, imageUrl);
      assert.equal(activeBookScroll(tree).key, scrollKey, "取消操作不能将正在阅读的图片滚回顶部");
      assert.deepEqual(page.recorderActions, recorderActions, "取消翻页不得停止或重启录音");
      assert.ok(byClass(tree, "record-button--pause"), "继续保留录音中操作");
      assertImageSize(page, slot, modes[1]);
      const swiper = byClass(tree, "practice-book-swiper");
      swiper.props.onChange({ detail: { current: swiper.props.current + 1, source: "touch" } });
      await settle();
      const reverted = render(page);
      assert.equal(byClass(reverted, "practice-book-swiper").props.current, swiper.props.current, "取消滑动翻页应回到原页");
      assert.equal(activeBookScroll(reverted).key, scrollKey, "取消滑动翻页也不重建当前书页滚动节点");
      assert.equal(progress(page), initialProgress);
      assert.deepEqual(page.recorderActions, recorderActions);
    } finally { cleanup(page); }
  });

  for (const [portrait, landscape] of [[modes[0], modes[1]], [modes[2], modes[3]]]) {
    test(`${route.name}：${portrait.isPad ? "Pad" : "手机"}前台横竖屏来回旋转更新宽高，并保留已录草稿`, async () => {
      const context = fixture(route, portrait);
      const { page, slot } = context;
      try {
        await begin(page);
        await finish(page);
        const saved = page.savedRecordings[0];
        const initialProgress = progress(page);
        const acquireAttempts = page.acquireAttempts;
        context.rotate(landscape);
        assertImageSize(page, slot, landscape, "旋转横屏后");
        assertControls(page, landscape);
        context.rotate(portrait);
        assertImageSize(page, slot, portrait, "回到竖屏后");
        assertControls(page, portrait);
        assert.equal(progress(page), initialProgress);
        assert.equal(page.savedRecordings.length, 1);
        assert.equal(page.savedRecordings[0], saved);
        assert.equal(page.acquireAttempts, acquireAttempts, "旋转不能重新挂载录音会话");
        assert.ok(byClass(render(page), "practice-recorder__retry"), "旋转后仍应能回听或重录已有草稿");
      } finally { cleanup(page); }
    });
  }

  test(`${route.name}：旋转的新测量先返回时，旧宽高回调不能覆盖新布局`, () => {
    const context = fixture(route, modes[0], { deferred: true });
    const { page, slot, measurements } = context;
    try {
      measurements.splice(0).forEach((deliver) => deliver());
      assertImageSize(page, slot, modes[0]);
      loadAgain(page);
      const oldMeasurements = measurements.splice(0);
      assert.ok(oldMeasurements.length > 0);
      context.rotate(modes[1]);
      assert.ok(measurements.length > 0, "窗口旋转必须请求新的宽高");
      measurements.splice(0).forEach((deliver) => deliver());
      const latest = assertImageSize(page, slot, modes[1]);
      oldMeasurements.forEach((deliver) => deliver());
      assert.deepEqual(assertImageSize(page, slot, modes[1]), latest);
      assert.equal(measurements.length, 0, "尺寸落地不应触发重复测量循环");
    } finally { cleanup(page); }
  });

  test(`${route.name}：卸载后迟到的横屏测量不得继续写入状态`, () => {
    const { page, slot, measurements } = fixture(route, modes[1], { deferred: true });
    try {
      measurements.splice(0).forEach((deliver) => deliver());
      assertImageSize(page, slot, modes[1]);
      slot.width = 420;
      slot.height = 180;
      loadAgain(page);
      const pending = measurements.splice(0);
      assert.ok(pending.length > 0);
      page.unload();
      const state = page.stateValues();
      pending.forEach((deliver) => deliver());
      assert.deepEqual(page.stateValues(), state, "卸载后不得更新图面状态");
    } finally { page.dispose(); }
  });

  test(`${route.name}：后台旋转遇到零尺寸，回到前台会重新测量且不重挂会话`, async () => {
    const context = fixture(route, modes[0]);
    const { page, slot } = context;
    try {
      await begin(page);
      await finish(page);
      const initialProgress = progress(page);
      const acquireAttempts = page.acquireAttempts;
      page.hide();
      context.rotate({ ...modes[1], slot: { width: 0, height: 0 } });
      Object.assign(slot, modes[1].slot);
      page.show();
      await settle();
      assertImageSize(page, slot, modes[1], "后台旋转恢复后");
      assert.equal(page.acquireAttempts, acquireAttempts);
      assert.equal(progress(page), initialProgress);
      assert.equal(page.savedRecordings.length, 1);
      assert.ok(byClass(render(page), "practice-recorder__retry"), "恢复前台后仍保留已录草稿");
    } finally { cleanup(page); }
  });

  test(`${route.name}：放大只预览当前图片，关闭返回时页码和已录草稿保持不变`, async () => {
    const { page, previews } = fixture(route, modes[2]);
    try {
      const originalImage = byClass(render(page), "practice-book-page__image").props.src;
      await byClass(page.render(), "practice-navigation__button--primary").props.onClick();
      assert.notEqual(byClass(render(page), "practice-book-page__image").props.src, originalImage);
      await begin(page);
      await finish(page);
      const tree = render(page);
      const imageUrl = byClass(tree, "practice-book-page__image").props.src;
      const expand = byClass(tree, "practice-book-expand");
      assert.ok(expand, "Pad 竖屏保留当前页放大入口");
      const initialProgress = progress(page);
      const state = page.stateValues();
      const actions = [...page.recorderActions];
      await expand.props.onClick();
      assert.equal(previews.length, 1);
      assert.equal(previews[0].current, imageUrl);
      assert.deepEqual(previews[0].urls, [imageUrl], "只打开当前教材图片");
      assert.deepEqual(page.stateValues(), state);
      assert.deepEqual(page.recorderActions, actions);
      page.hide();
      page.show();
      await settle();
      assert.equal(progress(page), initialProgress);
      assert.equal(page.savedRecordings.length, 1);
      assert.ok(byClass(render(page), "practice-recorder__retry"));
    } finally { cleanup(page); }
  });
}
