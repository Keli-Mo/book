/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const test = require("node:test");
const { createPage, byClass, elements, textOf } = require("./test-practice-book-route.cjs");

const natural = { width: 600, height: 900 };
const routes = [
  {
    name: "普通教材",
    file: "src/pages/Practice/Practice.tsx",
    params: { bookId: "22", page: "9" },
    stableCanvas: { width: 1588, height: 2245 },
  },
  {
    name: "Think",
    file: "src/pages/ThinkBookReader/ThinkBookReader.tsx",
    params: { bookId: "28", page: "12" },
    stableCanvas: { width: 1040, height: 1411 },
  },
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
const stableCanvasByPage = new WeakMap();

function fixture(route, mode, {
  deferred = false,
  confirmSwitch = true,
  previewImage,
  timers,
} = {}) {
  let profile = layoutFor(mode);
  const slot = { ...mode.slot };
  const measurements = [];
  const selectors = [];
  const previews = [];
  const appHideHandlers = new Set();
  const page = createPage(route.file, route.params, {
    savedFilePath: `/saved/fitted-${route.params.bookId}.mp3`,
    showModal: async () => ({ confirm: confirmSwitch }),
    setTimeout: timers?.setTimeout,
    clearTimeout: timers?.clearTimeout,
    overrides: { "@/hooks/useDeviceLayout": { useDeviceLayout: () => profile } },
    taroOverrides: {
      getImageInfo({ success }) { success(natural); },
      nextTick(callback) { callback(); },
      previewImage(options) {
        previews.push(options);
        return previewImage ? previewImage(options) : Promise.resolve();
      },
      onAppHide(callback) { appHideHandlers.add(callback); },
      offAppHide(callback) { appHideHandlers.delete(callback); },
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
  stableCanvasByPage.set(page, route.stableCanvas);
  render(page);
  return {
    page, slot, measurements, selectors, previews,
    appHide() { for (const callback of [...appHideHandlers]) callback(); },
    appHideListenerCount() { return appHideHandlers.size; },
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

const fitToBounds = (bounds, imageNatural) => {
  const scale = Math.min(bounds.width / imageNatural.width, bounds.height / imageNatural.height);
  return { width: imageNatural.width * scale, height: imageNatural.height * scale };
};

const assertCloseSize = (actual, expected, message) => {
  assert.ok(Math.abs(actual.width - expected.width) <= 1,
    `${message}：宽度 ${actual.width}，期望 ${expected.width}`);
  assert.ok(Math.abs(actual.height - expected.height) <= 1,
    `${message}：高度 ${actual.height}，期望 ${expected.height}`);
};

function assertImageSize(page, slot, mode, message = "教材尺寸", imageNatural = natural) {
  const tree = render(page);
  const scrollable = mode.orientation === "landscape";
  const outerStyle = byClass(tree, "practice-book-viewport")?.props.style;
  const resolveOuterLength = (value, fallback) => value === "100%"
    ? fallback
    : Number.parseFloat(value);
  const outerSize = {
    width: resolveOuterLength(outerStyle?.width, slot.width),
    height: resolveOuterLength(outerStyle?.height, slot.height),
  };
  const bookPage = activeBookPage(tree);
  const hotspotLayer = byClass(bookPage, "practice-book-page__hotspots--fitted");
  const pageStyle = scrollable ? bookPage?.props.style : hotspotLayer?.props.style;
  const pageSize = {
    width: Number.parseFloat(pageStyle?.width),
    height: Number.parseFloat(pageStyle?.height),
  };
  if (scrollable) {
    assertCloseSize(outerSize, slot, "Pad 与横屏外层保持固定书区");
    const expectedPage = {
      width: slot.width,
      height: slot.width * imageNatural.height / imageNatural.width,
    };
    assertCloseSize(pageSize, expectedPage, message);
  } else {
    const stableCanvas = stableCanvasByPage.get(page);
    assert.ok(stableCanvas, "每本教材都必须提供本书统一的竖屏固定画布");
    const expectedOuter = mode.isPad
      ? { width: slot.width, height: slot.height }
      : { width: slot.width, height: Math.round(slot.width * stableCanvas.height / stableCanvas.width) };
    assertCloseSize(outerSize, expectedOuter, `${message}外层固定画布`);
    assertCloseSize(pageSize, fitToBounds(expectedOuter, imageNatural), `${message}真实页图`);
    assert.ok(pageSize.width <= expectedOuter.width && pageSize.height <= expectedOuter.height,
      "真实页图必须完整放入固定画布");
    assert.equal(byClass(tree, "practice-book-page__image").props.mode, "aspectFit",
      "竖屏图片以真实比例放入固定画布");
    assert.ok(hasClass(byClass(tree, "practice-book-slide"), "practice-book-slide--stable-canvas"),
      "所有教材竖屏都使用稳定画布");
    assert.ok(hotspotLayer, "热点层必须位于按真实比例缩放的页图内");
    assert.equal(
      elements(hotspotLayer).filter((node) => hasClass(node, "audio-hotspot")).length,
      elements(tree).filter((node) => hasClass(node, "audio-hotspot")).length,
      "所有音频热点都应与当前真实页图同处一个容器",
    );
    if (mode.isPad) {
      assert.deepEqual(
        outerStyle,
        { width: "100%", height: "100%" },
        "Pad 竖屏外框应始终使用稳定的百分比尺寸",
      );
      assert.ok(pageSize.width === expectedOuter.width || pageSize.height === expectedOuter.height,
        "Pad 竖屏页图应直接利用完整 bookBounds，至少贴合一条边");
    }
  }
  assert.ok(Math.abs(pageSize.width - pageSize.height * imageNatural.width / imageNatural.height) <= 1,
    `${message}必须保持原图比例`);
  if (mode.isPad && !scrollable) {
    assert.equal(byClass(tree, "practice-book-scroll-hint"), undefined);
  }
  return { outerSize, pageSize, outerStyle };
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
  const headerActions = byClass(tree, "practice-header__actions");
  const directory = byClass(tree, "practice-header__directory");
  assert.ok(headerActions && elements(headerActions).includes(directory), "目录应固定在标题右侧操作组内");
  const expand = byClass(tree, "practice-book-expand");
  if (expand) {
    assert.ok(elements(headerActions).includes(expand), "放大查看应与目录保持在同一个右侧操作组");
  }
  const scroll = activeBookScroll(tree);
  if (mode.orientation === "landscape") {
    assert.equal(scroll?.type, "ScrollView", "横屏书页使用原生纵向滚动");
    assert.equal(scroll.props.scrollY, true);
    assert.equal(scroll.props.scrollTop, undefined, "当前页允许原生滚动，不持续覆盖用户阅读位置");
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
const createTimers = () => {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(callback, delay = 0) {
      const id = nextId++;
      pending.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
    advance(ms) {
      const target = now + ms;
      while (true) {
        const ready = [...pending.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (!ready) break;
        const [id, timer] = ready;
        pending.delete(id);
        now = timer.at;
        timer.callback();
      }
      now = target;
    },
  };
};
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
    test(`${route.name}：${mode.name}成功翻页及返回时保留已加载图片的滚动节点，离开页归零`, async () => {
      const { page, slot } = fixture(route, mode);
      try {
        const initialTree = render(page);
        const imageA = byClass(initialTree, "practice-book-page__image").props.src;
        const scrollA = activeBookScroll(initialTree);
        scrollA.props.onScroll({ detail: { scrollTop: 180 } });
        const initialProgress = progress(page);
        const acquireAttempts = page.acquireAttempts;
        await byClass(page.render(), "practice-navigation__button--primary").props.onClick();
        const nextTree = render(page);
        const imageB = byClass(nextTree, "practice-book-page__image").props.src;
        assert.notEqual(imageB, imageA);
        const inactiveA = imageContainer(nextTree, "practice-book-scroll", imageA);
        const activeB = activeBookScroll(nextTree);
        assert.ok(inactiveA, "相邻旧页保留在 Swiper 中，才能验证原生滚动节点复位");
        assert.equal(inactiveA.key, scrollA.key, "旧页离开时不能卸载已加载的图片子树");
        assert.equal(inactiveA.props.scrollTop, 0, "离开书页后通过滚动属性归零");
        assert.equal(activeB.props.scrollTop, undefined, "新页允许用户继续滚动");
        assert.notEqual(progress(page), initialProgress);
        await byClass(page.render(), "practice-navigation__button").props.onClick();
        const backTree = render(page);
        assert.equal(byClass(backTree, "practice-book-page__image").props.src, imageA);
        assert.equal(activeBookScroll(backTree).key, inactiveA.key, "回到旧页时复用已有原生图片节点");
        assert.equal(activeBookScroll(backTree).props.scrollTop, undefined);
        const inactiveB = imageContainer(backTree, "practice-book-scroll", imageB);
        assert.equal(inactiveB.key, activeB.key);
        assert.equal(inactiveB.props.scrollTop, 0);
        assert.equal(progress(page), initialProgress);
        assert.equal(page.acquireAttempts, acquireAttempts, "翻页不重新挂载录音会话");
        assertImageSize(page, slot, mode, "返回旧页后");
      } finally { cleanup(page); }
    });
  }

  test(`${route.name}：横屏录音中翻页保留录音状态`, async () => {
    const { page, slot } = fixture(route, modes[1]);
    try {
      await begin(page);
      const initialProgress = progress(page);
      const recorderActions = [...page.recorderActions];
      await byClass(page.render(), "practice-navigation__button--primary").props.onClick();
      const tree = render(page);
      assert.notEqual(progress(page), initialProgress, "下一个训练不需要确认");
      assert.equal(page.modalCalls.length, 0, "翻页不弹出放弃录音");
      assert.deepEqual(page.recorderActions, recorderActions, "跨页不得停止或重启录音");
      assert.ok(byClass(tree, "record-button--pause"), "翻页后继续录音");
      assertImageSize(page, slot, modes[1]);
      const swiper = byClass(tree, "practice-book-swiper");
      const beforeSwipe = swiper.props.current;
      const progressBeforeSwipe = progress(page);
      swiper.props.onChange({ detail: { current: beforeSwipe + 1, source: "touch" } });
      await settle();
      assert.equal(progress(page), progressBeforeSwipe, "手势动画结束前应保留当前业务页和录音状态");
      assert.deepEqual(page.recorderActions, recorderActions, "手势动画过程中不能停止或重启录音");
      await byClass(render(page), "practice-book-swiper").props.onAnimationFinish({
        detail: { current: beforeSwipe + 1, source: "touch" },
      });
      await settle();
      const turned = render(page);
      assert.equal(byClass(turned, "practice-book-swiper").props.current, beforeSwipe + 1, "滑动翻页应进入下一页");
      assert.notEqual(progress(page), progressBeforeSwipe, "动画结束后应提交下一训练页");
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

test("旧教材：left/top 左上角锚点转为圆钮中心，已人工确认的中心点保持原位", () => {
  const cases = [
    {
      name: "Our World 1 练习册截图页",
      file: "src/pages/Practice/Practice.tsx",
      params: { bookId: "12", page: "6" },
      stableCanvas: { width: 2550, height: 3263 },
      source: { left: 41, top: 25 },
      expectedOffset: { left: 13, top: 13 },
    },
    {
      name: "剑桥 KET 学生用书截图页",
      file: "src/pages/Practice/Practice.tsx",
      params: { bookId: "9", page: "8" },
      stableCanvas: { width: 825, height: 1061 },
      source: { left: (3993 - 3576) / 825 * 100, top: (1000 - 202) / 1061 * 100 },
      expectedOffset: { left: 13, top: 13 },
    },
    {
      name: "CASA 1 已确认中心点",
      file: "src/pages/Practice/Practice.tsx",
      params: { bookId: "3", page: "82" },
      stableCanvas: { width: 742, height: 1050 },
      source: { left: 6.8, top: 95 },
      expectedOffset: { left: 0, top: 0 },
    },
    {
      name: "CASA 2 第一个已确认中心点",
      file: "src/pages/Practice/Practice.tsx",
      params: { bookId: "4", page: "138" },
      stableCanvas: { width: 742, height: 1050 },
      source: { left: 60.2, top: 93 },
      expectedOffset: { left: 0, top: 0 },
    },
    {
      name: "CASA 2 第二个已确认中心点",
      file: "src/pages/Practice/Practice.tsx",
      params: { bookId: "4", page: "162" },
      stableCanvas: { width: 742, height: 1050 },
      source: { left: 57.9, top: 95.4 },
      expectedOffset: { left: 0, top: 0 },
    },
    {
      name: "CASA 3 已确认中心点",
      file: "src/pages/Practice/Practice.tsx",
      params: { bookId: "5", page: "132" },
      stableCanvas: { width: 742, height: 1050 },
      source: { left: 5.1, top: 41.5 },
      expectedOffset: { left: 0, top: 0 },
    },
  ];

  for (const scenario of cases) {
    const context = fixture(scenario, modes[2]);
    try {
      const tree = render(context.page);
      const hotspotLayer = byClass(activeBookPage(tree), "practice-book-page__hotspots--fitted");
      const hotspot = byClass(hotspotLayer, "audio-hotspot");
      assert.ok(hotspot, `${scenario.name}必须保留示范音频按钮`);
      const imageSize = {
        width: Number.parseFloat(hotspotLayer.props.style.width),
        height: Number.parseFloat(hotspotLayer.props.style.height),
      };
      const rendered = {
        left: Number.parseFloat(hotspot.props.style.left),
        top: Number.parseFloat(hotspot.props.style.top),
      };
      const leftOffsetPx = (rendered.left - scenario.source.left) * imageSize.width / 100;
      const topOffsetPx = (rendered.top - scenario.source.top) * imageSize.height / 100;
      assert.ok(Math.abs(leftOffsetPx - scenario.expectedOffset.left) < 0.1,
        `${scenario.name}的 26px 圆钮中心应从旧左上角向右移半径（实际 ${leftOffsetPx}px）`);
      assert.ok(Math.abs(topOffsetPx - scenario.expectedOffset.top) < 0.1,
        `${scenario.name}的 26px 圆钮中心应从旧左上角向下移半径（实际 ${topOffsetPx}px）`);
    } finally {
      cleanup(context.page);
    }
  }
});

test("Pad 竖屏：放大查看返回前保持示范音频与活动录音", async () => {
  const audioRoute = {
    ...routes[0],
    params: { bookId: "22", practice: "0" },
  };
  const audioContext = fixture(audioRoute, modes[2]);
  try {
    let tree = render(audioContext.page);
    const hotspot = byClass(tree, "audio-hotspot");
    assert.ok(hotspot, "测试页必须包含示范音频热点");
    hotspot.props.onClick();
    tree = render(audioContext.page);
    const modelAudio = audioContext.page.audios.find((audio) => audio.src);
    assert.ok(modelAudio, "点击热点后必须创建示范音频实例");
    const eventsBeforePreview = [...modelAudio.events];

    await byClass(tree, "practice-book-expand").props.onClick();
    audioContext.page.hide();
    assert.deepEqual(
      modelAudio.events,
      eventsBeforePreview,
      "原生图片预览引发的页面隐藏不得停止示范音频",
    );
    audioContext.page.show();
    assert.ok(byClass(render(audioContext.page), "practice-model-player"), "关闭预览后播放器仍须保留");

    audioContext.page.hide();
    assert.ok(["stop", "destroy"].includes(modelAudio.events.at(-1)), "真正隐藏训练页时仍须停止示范音频");
  } finally {
    cleanup(audioContext.page);
  }

  const recordingContext = fixture(audioRoute, modes[2]);
  try {
    await begin(recordingContext.page);
    const actionsBeforePreview = [...recordingContext.page.recorderActions];
    await byClass(render(recordingContext.page), "practice-book-expand").props.onClick();
    recordingContext.page.hide();
    assert.deepEqual(
      recordingContext.page.recorderActions,
      actionsBeforePreview,
      "原生图片预览引发的页面隐藏不得暂停或停止活动录音",
    );
    recordingContext.page.show();
    assert.ok(byClass(render(recordingContext.page), "record-button--pause"), "关闭预览后仍须保持录音中");

    recordingContext.page.hide();
    assert.equal(recordingContext.page.recorderActions.at(-1).action, "pause", "真正隐藏训练页时仍须暂停录音");
  } finally {
    cleanup(recordingContext.page);
  }
});

test("Pad 竖屏：原生预览中真实切后台仍停止音频并暂停录音", async () => {
  const audioRoute = { ...routes[0], params: { bookId: "22", practice: "0" } };
  const audioContext = fixture(audioRoute, modes[2]);
  try {
    let tree = render(audioContext.page);
    byClass(tree, "audio-hotspot").props.onClick();
    tree = render(audioContext.page);
    const modelAudio = audioContext.page.audios.find((audio) => audio.src);
    await byClass(tree, "practice-book-expand").props.onClick();
    const eventsBeforeHide = [...modelAudio.events];
    audioContext.page.hide();
    assert.deepEqual(modelAudio.events, eventsBeforeHide, "原生预览引发的 Page.onHide 应先保留音频");
    audioContext.appHide();
    assert.ok(["stop", "destroy"].includes(modelAudio.events.at(-1)), "App.onHide 必须停止示范音频");
  } finally {
    cleanup(audioContext.page);
  }

  const recordingContext = fixture(audioRoute, modes[2]);
  try {
    await begin(recordingContext.page);
    await byClass(render(recordingContext.page), "practice-book-expand").props.onClick();
    recordingContext.appHide();
    assert.equal(recordingContext.page.recorderActions.at(-1).action, "pause", "App.onHide 必须暂停活动录音");
    const actionCountAfterAppHide = recordingContext.page.recorderActions.length;
    recordingContext.page.hide();
    assert.equal(recordingContext.page.recorderActions.length, actionCountAfterAppHide, "App.onHide 与 Page.onHide 反序到达不得重复暂停");
  } finally {
    cleanup(recordingContext.page);
  }
});

test("Pad 竖屏：旧预览延迟回调不影响新预览会话", async () => {
  const catchHandlers = [];
  const context = fixture(
    { ...routes[0], params: { bookId: "22", practice: "0" } },
    modes[2],
    {
      previewImage() {
        return {
          catch(callback) { catchHandlers.push(callback); return this; },
        };
      },
    },
  );
  try {
    let tree = render(context.page);
    byClass(tree, "audio-hotspot").props.onClick();
    tree = render(context.page);
    const modelAudio = context.page.audios.find((audio) => audio.src);
    const eventsBeforePreview = [...modelAudio.events];
    const expand = byClass(tree, "practice-book-expand");

    await expand.props.onClick();
    await expand.props.onClick();
    assert.equal(context.previews.length, 2, "快速重复点击应建立两次原生预览请求");
    catchHandlers[0]?.(new Error("旧预览 Promise 延迟失败"));
    context.previews[0].fail?.({ errMsg: "previewImage:fail cancelled" });
    context.previews[0].complete?.({ errMsg: "previewImage:fail cancelled" });
    context.page.hide();
    assert.deepEqual(modelAudio.events, eventsBeforePreview, "旧预览回调不得清除新预览标记");
  } finally {
    cleanup(context.page);
  }
});

test("Pad 竖屏：未触发 Page.onHide 的预览请求会自动释放标记", async () => {
  const timers = createTimers();
  const context = fixture(
    { ...routes[0], params: { bookId: "22", practice: "0" } },
    modes[2],
    { timers },
  );
  try {
    let tree = render(context.page);
    byClass(tree, "audio-hotspot").props.onClick();
    tree = render(context.page);
    const modelAudio = context.page.audios.find((audio) => audio.src);
    await byClass(tree, "practice-book-expand").props.onClick();
    context.previews[0].complete?.({ errMsg: "previewImage:ok" });
    timers.advance(1500);
    context.page.hide();
    assert.ok(["stop", "destroy"].includes(modelAudio.events.at(-1)), "超时后的真实页面隐藏必须正常清理音频");
  } finally {
    cleanup(context.page);
  }
});

test("Pad 竖屏：预览标记存在时卸载仍释放录音与 App 监听", async () => {
  const context = fixture({ ...routes[0], params: { bookId: "22", practice: "0" } }, modes[2]);
  await begin(context.page);
  await byClass(render(context.page), "practice-book-expand").props.onClick();
  assert.equal(context.appHideListenerCount(), 1, "训练页应注册一个 App.onHide 监听");
  context.page.unload();
  assert.equal(context.page.recorderActions.at(-1).action, "stop", "卸载时必须结束录音会话");
  context.page.dispose();
  assert.equal(context.appHideListenerCount(), 0, "卸载后必须移除 App.onHide 监听");
});

test("Pad 竖屏：紧凑录音工具栏暴露状态类且状态变化不更换书页外框", async () => {
  const context = fixture(routes[0], modes[2]);
  try {
    const initialTree = render(context.page);
    const initialViewportStyle = byClass(initialTree, "practice-book-viewport").props.style;
    assert.ok(hasClass(byClass(initialTree, "practice-recorder"), "practice-recorder--idle"));

    await begin(context.page);
    let tree = render(context.page);
    assert.ok(hasClass(byClass(tree, "practice-recorder"), "practice-recorder--recording"));
    assert.deepEqual(byClass(tree, "practice-book-viewport").props.style, initialViewportStyle);

    pause(context.page);
    tree = render(context.page);
    assert.ok(hasClass(byClass(tree, "practice-recorder"), "practice-recorder--paused"));
    assert.deepEqual(byClass(tree, "practice-book-viewport").props.style, initialViewportStyle);

    tree = await finish(context.page);
    assert.ok(hasClass(byClass(tree, "practice-recorder"), "practice-recorder--recorded"));
    assert.deepEqual(byClass(tree, "practice-book-viewport").props.style, initialViewportStyle);
  } finally {
    cleanup(context.page);
  }
});
