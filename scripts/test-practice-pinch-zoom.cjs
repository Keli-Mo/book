/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const test = require("node:test");
const { createPage, byClass, elements } = require("./test-practice-book-route.cjs");

const routes = [
  { name: "普通教材", file: "src/pages/Practice/Practice.tsx", params: { bookId: "22", page: "9" } },
  { name: "Think 教材", file: "src/pages/ThinkBookReader/ThinkBookReader.tsx", params: { bookId: "28", page: "12" } },
];
const phonePortrait = { isPad: false, orientation: "portrait", windowWidth: 390, windowHeight: 844, slot: { width: 374, height: 560 } };
const phoneLandscape = { isPad: false, orientation: "landscape", windowWidth: 844, windowHeight: 390, slot: { width: 500, height: 230 } };
const portrait = { isPad: true, orientation: "portrait", windowWidth: 820, windowHeight: 1180, slot: { width: 760, height: 830 } };
const landscape = { isPad: true, orientation: "landscape", windowWidth: 1180, windowHeight: 820, slot: { width: 700, height: 500 } };
const modes = [
  { name: "手机竖屏", layout: phonePortrait },
  { name: "手机横屏", layout: phoneLandscape },
  { name: "Pad 竖屏", layout: portrait },
  { name: "Pad 横屏", layout: landscape },
];
const render = (page) => { page.render(); page.render(); return page.render(); };
const settle = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };
const hasClass = (node, name) => String(node?.props?.className || "").split(/\s+/).includes(name);
const touch = (identifier) => ({ identifier, clientX: 120, clientY: 140, pageX: 120, pageY: 140 });
const playCount = (page) => page.audios.flatMap((audio) => audio.events).filter((event) => event === "play").length;

function fixture(route, initialMode = portrait) {
  let mode = initialMode;
  const page = createPage(route.file, route.params, {
    overrides: {
      "@/hooks/useDeviceLayout": { useDeviceLayout: () => ({
        ...mode,
        isSplit: mode.isPad && mode.orientation === "landscape",
        contentMaxWidth: mode.isPad ? (mode.orientation === "landscape" ? 1280 : 820) : null,
        statusBarHeight: 20,
        safeAreaBottom: 0,
      }) },
    },
    taroOverrides: {
      createSelectorQuery() {
        let callback;
        const query = {
          select() { return query; },
          boundingClientRect(next) { callback = next; return query; },
          exec() { callback?.({ ...mode.slot }); return query; },
        };
        return query;
      },
    },
  });
  render(page);
  return { page, rotate(nextMode) { mode = nextMode; return render(page); } };
}

function activeZoom(tree) {
  const swiper = byClass(tree, "practice-book-swiper");
  assert.ok(swiper, "教材仍应有原位翻页 Swiper");
  const activeSlide = elements(swiper).find((node) =>
    hasClass(node, "practice-book-slide") &&
    elements(node).some((child) => hasClass(child, "practice-book-page__image")));
  assert.ok(activeSlide, "当前教材图应位于 Swiper 的活动书页中");
  const area = byClass(activeSlide, "practice-book-zoom-area");
  const view = byClass(activeSlide, "practice-book-zoom-view");
  assert.equal(area?.type, "MovableArea", "活动书页应有原位双指缩放区域");
  assert.equal(view?.type, "MovableView", "活动书页应有可移动的缩放图层");
  const areaChildren = Array.isArray(area.props.children) ? area.props.children : [area.props.children];
  assert.ok(areaChildren.some((child) => hasClass(child, "practice-book-zoom-view")),
    "MovableView 必须是 MovableArea 的直接子节点");
  return { swiper, activeSlide, area, view };
}

function scaleTo(page, scale) {
  const { view } = activeZoom(render(page));
  assert.equal(typeof view.props.onScale, "function", "倍率变化应由原生缩放事件同步到页面状态");
  view.props.onScale({ detail: { scale } });
  return render(page);
}

for (const route of routes) {
  for (const mode of modes) {
    test(`${route.name}·${mode.name}：教材图与音频点位同层缩放，录音区留在书页外`, () => {
      const { page } = fixture(route, mode.layout);
      try {
        const tree = render(page);
        const { area, view, activeSlide } = activeZoom(tree);
        assert.equal(area.props.scaleArea, true);
        assert.equal(view.props.scale, true);
        assert.equal(view.props.scaleMin, 1);
        assert.equal(view.props.scaleMax, 4);
        assert.equal(view.props.scaleValue, 1);
        assert.ok(byClass(view, "practice-book-page__image"), "当前图片要随书页移动");
        assert.ok(byClass(view, "audio-hotspot"), "热点要随图片保持同一坐标系");
        const cachedPage = byClass(activeSlide, "practice-book-static--covered");
        assert.ok(byClass(cachedPage, "practice-book-page__neighbor"),
          "预载图片节点应留在原书页中，切回时无需重新加载");
        assert.equal(byClass(view, "practice-recorder"), undefined, "录音区不得被放大或拖离屏幕");
        assert.ok(byClass(tree, "practice-recorder"), "录音区仍显示在教材之外");
        assert.equal(byClass(tree, "practice-book-expand"), undefined, "直接手势缩放后不应保留额外入口");
        assert.equal(byClass(tree, "practice-book-preview"), undefined, "原位缩放不应打开独立预览层");
      } finally { page.unload(); page.dispose(); }
    });
  }

  test(`${route.name}：缩放 1→2→1 时锁定并恢复单指翻页，书内纵滚按倍率仲裁`, () => {
    const { page } = fixture(route, landscape);
    try {
      let tree = render(page);
      let { swiper, view } = activeZoom(tree);
      assert.equal(view.props.scaleValue, 1);
      assert.equal(swiper.props.disableTouch, false, "原始倍率允许滑动翻页");
      const initialScroll = byClass(view, "practice-book-scroll");
      if (initialScroll) assert.equal(initialScroll.props.scrollY, true, "原始倍率允许横屏纵向阅读");
      else assert.equal(view.props.direction, "vertical", "无 ScrollView 时原始倍率仍须能纵向阅读");

      tree = scaleTo(page, 2);
      ({ swiper, view } = activeZoom(tree));
      assert.equal(view.props.scaleValue, 2);
      assert.equal(swiper.props.disableTouch, true, "放大后横向拖动不能翻页");
      assert.equal(view.props.direction, "all", "放大后单指可在书页内平移");
      const zoomedScroll = byClass(view, "practice-book-scroll");
      if (zoomedScroll) assert.equal(zoomedScroll.props.scrollY, false, "放大后书内纵向手势交给缩放图层");

      tree = scaleTo(page, 1);
      ({ swiper, view } = activeZoom(tree));
      assert.equal(view.props.scaleValue, 1);
      assert.equal(swiper.props.disableTouch, false, "缩回原始倍率恢复滑动翻页");
      const restoredScroll = byClass(view, "practice-book-scroll");
      if (restoredScroll) assert.equal(restoredScroll.props.scrollY, true, "缩回原始倍率恢复纵向阅读");
      else assert.equal(view.props.direction, "vertical", "缩回后恢复横屏纵向阅读");
    } finally { page.unload(); page.dispose(); }
  });

  test(`${route.name}：放大时仍可播放点位音频并开始跟读录音`, async () => {
    const { page } = fixture(route);
    try {
      let tree = scaleTo(page, 2);
      const { area } = activeZoom(tree);
      // 前一次双指操作已经结束；新的一次单指按下代表有意点击热点。
      area.props.onTouchEnd({ touches: [], changedTouches: [touch(1), touch(2)] });
      area.props.onTouchStart({ touches: [touch(3)], changedTouches: [touch(3)] });
      area.props.onTouchEnd({ touches: [], changedTouches: [touch(3)] });
      tree = render(page);
      const hotspot = byClass(activeZoom(tree).view, "audio-hotspot");
      assert.ok(hotspot, "测试页需要一个可点击的示范音频点位");
      const beforePlay = playCount(page);
      hotspot.props.onClick();
      assert.equal(playCount(page), beforePlay + 1, "放大后新的一次点按仍可播放示范音频");
      assert.equal(activeZoom(render(page)).view.props.scaleValue, 2, "播放音频不改变倍率");

      tree = render(page);
      const start = byClass(tree, "record-button");
      assert.ok(start, "放大时仍能找到书页外的录音入口");
      await start.props.onClick();
      page.recorderHandlers.Start();
      tree = render(page);
      assert.ok(byClass(tree, "practice-recorder--recording"), "录音应真正进入录制状态");
      assert.equal(activeZoom(tree).view.props.scaleValue, 2, "开始录音不重置书页倍率");
      assert.ok(byClass(tree, "record-button--stop"), "放大时仍可操作结束录音");
    } finally { page.unload(); page.dispose(); }
  });

  test(`${route.name}：手机竖屏放大后录音主操作固定可达`, async () => {
    const { page } = fixture(route, phonePortrait);
    try {
      let tree = scaleTo(page, 2);
      const dock = byClass(tree, "practice-zoom-recorder");
      assert.ok(dock, "长教材放大时应有屏幕内的录音操作条");
      assert.equal(byClass(activeZoom(tree).view, "practice-zoom-recorder"), undefined,
        "录音操作条不能随教材一起放大");
      await byClass(dock, "practice-zoom-recorder__start").props.onClick();
      page.recorderHandlers.Start();
      tree = render(page);
      assert.ok(byClass(tree, "practice-recorder--recording"));
      assert.ok(byClass(tree, "practice-zoom-recorder__stop"),
        "录音中仍可在当前屏幕结束录音");
      assert.equal(activeZoom(tree).view.props.scaleValue, 2);
      byClass(tree, "practice-zoom-recorder__pause").props.onClick();
      page.recorderHandlers.Pause();
      tree = render(page);
      assert.ok(byClass(tree, "practice-zoom-recorder__resume"),
        "暂停后仍可在当前屏幕继续录音");
      byClass(tree, "practice-zoom-recorder__resume").props.onClick();
      page.recorderHandlers.Resume();
      tree = render(page);
      assert.ok(byClass(tree, "practice-zoom-recorder__stop"));
      assert.equal(activeZoom(tree).view.props.scaleValue, 2);
      tree = scaleTo(page, 1);
      assert.equal(byClass(tree, "practice-zoom-recorder"), undefined,
        "缩回原始倍率后恢复原页面布局");
    } finally { page.unload(); page.dispose(); }
  });

  test(`${route.name}：双指缩放结束产生的尾随点击不会误播音频`, () => {
    const { page } = fixture(route);
    try {
      let tree = render(page);
      const area = activeZoom(tree).area;
      assert.equal(typeof area.props.onTouchStart, "function", "书页需识别双指触摸以拦截尾随点击");
      area.props.onTouchStart({ touches: [touch(1), touch(2)], changedTouches: [touch(1), touch(2)] });
      tree = scaleTo(page, 2);
      const pinched = activeZoom(tree);
      pinched.area.props.onTouchEnd({ touches: [], changedTouches: [touch(1), touch(2)] });
      const beforePlay = playCount(page);
      byClass(pinched.view, "audio-hotspot").props.onClick();
      assert.equal(playCount(page), beforePlay, "同一次缩放动作尾随的原生 click 不得触发热点");
    } finally { page.unload(); page.dispose(); }
  });

  test(`${route.name}：原生微小位移仍可点音频，实际拖动不误播`, () => {
    const { page } = fixture(route, landscape);
    try {
      let tree = scaleTo(page, 2);
      let { area, view } = activeZoom(tree);
      area.props.onTouchStart({ touches: [touch(1)], changedTouches: [touch(1)] });
      view.props.onChange({ detail: { source: "touch", x: 1, y: 2 } });
      area.props.onTouchMove({ touches: [{ ...touch(1), pageX: 123, pageY: 142 }] });
      area.props.onTouchEnd({ touches: [], changedTouches: [touch(1)] });
      tree = render(page);
      const beforeTap = playCount(page);
      byClass(activeZoom(tree).view, "audio-hotspot").props.onClick();
      assert.equal(playCount(page), beforeTap + 1, "小于拖动阈值的点按仍可播放音频");

      ({ area, view } = activeZoom(render(page)));
      area.props.onTouchStart({ touches: [touch(2)], changedTouches: [touch(2)] });
      view.props.onChange({ detail: { source: "touch", x: 15, y: 12 } });
      area.props.onTouchMove({ touches: [{ ...touch(2), pageX: 130, pageY: 140 }] });
      area.props.onTouchEnd({ touches: [], changedTouches: [touch(2)] });
      tree = render(page);
      const beforeDragClick = playCount(page);
      byClass(activeZoom(tree).view, "audio-hotspot").props.onClick();
      assert.equal(playCount(page), beforeDragClick, "明确拖动后的尾随点击不能误播音频");
    } finally { page.unload(); page.dispose(); }
  });

  test(`${route.name}：双指手势剩一指时仍锁定翻页，全部松开后才恢复`, () => {
    const { page } = fixture(route);
    try {
      let tree = render(page);
      activeZoom(tree).area.props.onTouchStart({ touches: [touch(1), touch(2)], changedTouches: [touch(1), touch(2)] });
      tree = render(page);
      assert.equal(activeZoom(tree).swiper.props.disableTouch, true);
      activeZoom(tree).area.props.onTouchEnd({ touches: [touch(1)], changedTouches: [touch(2)] });
      tree = render(page);
      assert.equal(activeZoom(tree).swiper.props.disableTouch, true,
        "第二根手指先离开时不能立即恢复 Swiper 手势");
      activeZoom(tree).area.props.onTouchEnd({ touches: [], changedTouches: [touch(1)] });
      tree = render(page);
      assert.equal(activeZoom(tree).swiper.props.disableTouch, false);
    } finally { page.unload(); page.dispose(); }
  });

  test(`${route.name}：切页被录音状态阻止时保持倍率，成功切页才恢复原始倍率`, async () => {
    const { page } = fixture(route);
    try {
      let tree = scaleTo(page, 2);
      const originalSrc = byClass(tree, "practice-book-page__image").props.src;
      await byClass(tree, "record-button").props.onClick();
      tree = render(page);
      assert.ok(byClass(tree, "practice-recorder--starting"), "测试需要等待原生录音启动确认");
      await byClass(tree, "practice-navigation__button--primary").props.onClick();
      tree = render(page);
      assert.equal(byClass(tree, "practice-book-page__image").props.src, originalSrc);
      assert.equal(activeZoom(tree).view.props.scaleValue, 2, "被阻止的切页不能重置放大状态");

      page.recorderHandlers.Start();
      tree = render(page);
      await byClass(tree, "practice-navigation__button--primary").props.onClick();
      await settle();
      tree = render(page);
      assert.notEqual(byClass(tree, "practice-book-page__image").props.src, originalSrc,
        "录音已启动后按钮应能提交下一页");
      assert.equal(activeZoom(tree).view.props.scaleValue, 1, "成功切页重置书页倍率");
      assert.equal(activeZoom(tree).swiper.props.disableTouch, false, "成功切页恢复手势翻页");
    } finally { page.unload(); page.dispose(); }
  });
}

test("设备旋转只重置教材倍率，保留当前页及音频播放", () => {
  const { page, rotate } = fixture(routes[0]);
  try {
    let tree = scaleTo(page, 2);
    const originalSrc = byClass(tree, "practice-book-page__image").props.src;
    const { area } = activeZoom(tree);
    area.props.onTouchEnd({ touches: [], changedTouches: [touch(1), touch(2)] });
    area.props.onTouchStart({ touches: [touch(3)], changedTouches: [touch(3)] });
    area.props.onTouchEnd({ touches: [], changedTouches: [touch(3)] });
    tree = render(page);
    byClass(activeZoom(tree).view, "audio-hotspot").props.onClick();
    const playingAudio = page.audios.at(-1);
    assert.ok(playingAudio?.events.includes("play"), "旋转前的新单指点按应真正播放示范音频");
    const audioEvents = [...playingAudio.events];

    tree = rotate(landscape);
    assert.equal(byClass(tree, "practice-book-page__image").props.src, originalSrc);
    assert.equal(activeZoom(tree).view.props.scaleValue, 1, "旋转后倍率恢复原始值");
    assert.equal(activeZoom(tree).swiper.props.disableTouch, false);
    assert.deepEqual(playingAudio.events, audioEvents, "旋转不能停止或重启示范音频");
  } finally { page.unload(); page.dispose(); }
});
