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
const touch = (identifier, pageX = 120, pageY = 140) => ({ identifier, clientX: pageX, clientY: pageY, pageX, pageY });
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
    elements(node).some((child) => hasClass(child, "practice-book-static--covered")));
  assert.ok(activeSlide, "活动书页中保留被缩放层覆盖的预载图");
  const area = byClass(tree, "practice-book-zoom-area");
  const view = byClass(tree, "practice-book-zoom-view");
  assert.equal(area?.type, "MovableArea", "活动书页应有原位双指缩放区域");
  assert.equal(view?.type, "MovableView", "活动书页应有可移动的缩放图层");
  const areaChildren = Array.isArray(area.props.children) ? area.props.children : [area.props.children];
  assert.ok(areaChildren.some((child) => hasClass(child, "practice-book-zoom-view")),
    "MovableView 必须是 MovableArea 的直接子节点");
  return { swiper, activeSlide, area, view };
}

function ancestorPath(node, target, ancestors = []) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const result = ancestorPath(child, target, ancestors);
      if (result) return result;
    }
  } else if (node && typeof node === "object") {
    if (node === target) return ancestors;
    return ancestorPath(node.props?.children, target, [...ancestors, node]);
  }
  return undefined;
}

function scaleTo(page, scale) {
  const { area, view } = activeZoom(render(page));
  assert.equal(typeof view.props.onScale, "function", "倍率变化应由原生缩放事件同步到页面状态");
  view.props.onScale({ detail: {
    scale,
    x: -parseFloat(area.props.style.width) * (scale - 1) / 2,
    y: -parseFloat(area.props.style.height) * (scale - 1) / 2,
  } });
  return render(page);
}

function assertDisplayScale(tree, scale, message) {
  const { view } = activeZoom(tree);
  assert.equal(Object.hasOwn(view.props, "scaleValue"), false, "不能向微信原生视图回写固定倍率");
  const hotspot = byClass(view, "audio-hotspot");
  if (hotspot) {
    assert.equal(hotspot.props.style.transform, "translate(-50%, -50%)",
      message || "热点随原生书页同比缩放");
  } else {
    assert.equal(scale, 1, "没有音频点位的相邻测试页仅用于验证翻页后的倍率重置");
    assert.equal(view.props.direction, "all", message || "原始倍率仍预先启用原生双向拖动");
  }
}

function horizontalBounds(tree, scale = 2) {
  const { area, view } = activeZoom(tree);
  return {
    minX: parseFloat(area.props.style.width) - parseFloat(view.props.style.width) * scale,
    maxX: 0,
  };
}

function moveView(view, identifier, pageX, nativeX, pageY = 140) {
  view.props.onChange({ detail: { source: "touch", x: nativeX, y: 0 } });
  view.props.onTouchMove({ touches: [touch(identifier, pageX, pageY)] });
}

function bookSrc(tree) {
  return byClass(activeZoom(tree).view, "practice-book-page__image").props.src;
}

test("微信原生捏合不绑定固定倍率，父组件重绘也不把书页重置为 1 倍", () => {
  const { page } = fixture(routes[0], phonePortrait);
  try {
    let tree = render(page);
    assert.equal(Object.hasOwn(activeZoom(tree).view.props, "scaleValue"), false,
      "默认 1 倍由微信原生组件负责，不能持续向它下发固定值");
    activeZoom(tree).view.props.onTouchStart({ touches: [touch(1), touch(2)] });
    tree = render(page);
    assert.equal(Object.hasOwn(activeZoom(tree).view.props, "scaleValue"), false,
      "双指触摸引起父组件重绘后，仍不得下发固定倍率");
  } finally { page.unload(); page.dispose(); }
});

for (const route of routes) {
  for (const mode of modes) {
    test(`${route.name}·${mode.name}：初次挂载即启用双向拖动，缩放前后不更改原生方向`, () => {
      const { page } = fixture(route, mode.layout);
      try {
        const initial = activeZoom(render(page)).view;
        assert.equal(initial.props.direction, "all", "移动方向必须在原生节点挂载时启用");
        const zoomed = activeZoom(scaleTo(page, 2)).view;
        assert.equal(zoomed.props.direction, "all", "捏合后仍使用同一个移动方向");
        const restored = activeZoom(scaleTo(page, 1)).view;
        assert.equal(restored.props.direction, "all", "缩回后也保留移动方向，由尺寸边界限制位移");
      } finally { page.unload(); page.dispose(); }
    });

    test(`${route.name}·${mode.name}：教材图与音频点位同层缩放，录音区留在书页外`, () => {
      const { page } = fixture(route, mode.layout);
      try {
        const tree = render(page);
        const { area, view, activeSlide } = activeZoom(tree);
        assert.equal(area.props.scaleArea, true);
        assert.equal(view.props.scale, true);
        assert.equal(view.props.scaleMin, 1);
        assert.equal(view.props.scaleMax, 4);
        assert.equal(Object.hasOwn(view.props, "scaleValue"), false);
        assert.equal(area.props.onTouchStart, undefined, "触摸识别应直接绑定原生 MovableView");
        assert.equal(typeof view.props.onTouchStart, "function", "直接监听移动图层上的触摸");
        const ancestors = ancestorPath(tree, view);
        assert.ok(ancestors, "缩放层存在于页面树中");
        assert.equal(ancestors.some((node) => node.type === "Swiper" || node.type === "SwiperItem"), false,
          "缩放层不得被会抢夺拖动手势的 Swiper 包裹");
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

  for (const mode of [portrait, landscape]) {
    test(`${route.name}·Pad ${mode.orientation}：放大后播放图标跟随书页同比放大且仍可点击`, () => {
      const { page } = fixture(route, mode);
      try {
        const { view } = activeZoom(scaleTo(page, 2));
        const hotspot = byClass(view, "audio-hotspot");
        assert.ok(hotspot, "测试页需要书页上的播放热点");
        assert.ok(byClass(hotspot, "audio-hotspot__visual"), "播放图标仍留在可缩放书页里");
        assert.equal(hotspot.props.style.transform, "translate(-50%, -50%)",
          "热点不能再逆向抵消原生书页的放大倍率");
        const beforePlay = playCount(page);
        hotspot.props.onClick();
        assert.equal(playCount(page), beforePlay + 1, "放大后播放热点仍可点击");
      } finally { page.unload(); page.dispose(); }
    });
  }

  test(`${route.name}：缩放 1→2→1 时锁定并恢复单指翻页，书内纵滚按倍率仲裁`, () => {
    const { page } = fixture(route, landscape);
    try {
      let tree = render(page);
      let { swiper, view } = activeZoom(tree);
      assert.equal(Object.hasOwn(view.props, "scaleValue"), false);
      assert.equal(swiper.props.disableTouch, false, "原始倍率允许滑动翻页");
      const initialScroll = byClass(view, "practice-book-scroll");
      if (initialScroll) assert.equal(initialScroll.props.scrollY, true, "原始倍率允许横屏纵向阅读");
      else assert.equal(view.props.direction, "all", "无 ScrollView 时原始倍率仍须能纵向阅读");

      tree = scaleTo(page, 2);
      ({ swiper, view } = activeZoom(tree));
      assertDisplayScale(tree, 2);
      assert.equal(swiper.props.disableTouch, true, "放大后横向拖动不能翻页");
      assert.equal(view.props.direction, "all", "放大后单指可在书页内平移");
      const zoomedScroll = byClass(view, "practice-book-scroll");
      if (zoomedScroll) assert.equal(zoomedScroll.props.scrollY, false, "放大后书内纵向手势交给缩放图层");

      tree = scaleTo(page, 1);
      ({ swiper, view } = activeZoom(tree));
      assert.equal(Object.hasOwn(view.props, "scaleValue"), false);
      assert.equal(swiper.props.disableTouch, false, "缩回原始倍率恢复滑动翻页");
      const restoredScroll = byClass(view, "practice-book-scroll");
      if (restoredScroll) assert.equal(restoredScroll.props.scrollY, true, "缩回原始倍率恢复纵向阅读");
      else assert.equal(view.props.direction, "all", "缩回后仍由原生边界支持横屏纵向阅读");
    } finally { page.unload(); page.dispose(); }
  });

  test(`${route.name}：放大时仍可播放点位音频并开始跟读录音`, async () => {
    const { page } = fixture(route, phonePortrait);
    try {
      let tree = render(page);
      activeZoom(tree).view.props.onTouchStart({ touches: [touch(1), touch(2)] });
      tree = scaleTo(page, 2);
      const { view } = activeZoom(tree);
      // 前一次双指操作已经结束；新的一次单指按下代表有意点击热点。
      view.props.onTouchEnd({ touches: [touch(1)], changedTouches: [touch(2)] });
      view.props.onTouchEnd({ touches: [], changedTouches: [touch(1), touch(2)] });
      view.props.onTouchStart({ touches: [touch(3)], changedTouches: [touch(3)] });
      view.props.onTouchEnd({ touches: [], changedTouches: [touch(3)] });
      tree = render(page);
      const hotspot = byClass(activeZoom(tree).view, "audio-hotspot");
      assert.ok(hotspot, "测试页需要一个可点击的示范音频点位");
      const beforePlay = playCount(page);
      hotspot.props.onClick();
      assert.equal(playCount(page), beforePlay + 1, "放大后新的一次点按仍可播放示范音频");
      assertDisplayScale(render(page), 2, "播放音频不改变倍率");

      tree = render(page);
      const start = byClass(tree, "record-button");
      assert.ok(start, "放大时仍能找到书页外的录音入口");
      await start.props.onClick();
      page.recorderHandlers.Start();
      tree = render(page);
      assert.ok(byClass(tree, "practice-recorder--recording"), "录音应真正进入录制状态");
      assertDisplayScale(tree, 2, "开始录音不重置书页倍率");
      assert.ok(byClass(tree, "record-button--stop"), "放大时仍可操作结束录音");
    } finally { page.unload(); page.dispose(); }
  });

  test(`${route.name}：手机放大后在书页中部单指平移，不触发翻页或音频`, async () => {
    const { page } = fixture(route, phonePortrait);
    try {
      const tree = scaleTo(page, 2);
      const originalSrc = bookSrc(tree);
      const { view } = activeZoom(tree);
      const { minX } = horizontalBounds(tree);
      assert.equal(view.props.direction, "all", "放大后原生图层允许单指平移");
      view.props.onTouchStart({ touches: [touch(1, 180)] });
      moveView(view, 1, 160, minX / 2 - 20);
      view.props.onTouchEnd({ touches: [], changedTouches: [touch(1, 160)] });
      const beforePlay = playCount(page);
      byClass(view, "audio-hotspot").props.onClick();
      await settle();
      const updated = render(page);
      assert.equal(bookSrc(updated), originalSrc, "中部拖动由书页平移处理");
      assert.equal(playCount(page), beforePlay, "平移结束的尾随点击不播放音频");
      assertDisplayScale(updated, 2, "平移保持放大倍率");
    } finally { page.unload(); page.dispose(); }
  });

  test(`${route.name}：手机拖到右边缘后再向左拖 64px，松手翻下一页`, async () => {
    const { page } = fixture(route, phonePortrait);
    try {
      const tree = scaleTo(page, 2);
      const originalSrc = bookSrc(tree);
      const { view } = activeZoom(tree);
      const { minX } = horizontalBounds(tree);
      view.props.onChange({ detail: { source: "touch", x: minX, y: 0 } });
      view.props.onTouchStart({ touches: [touch(1, 180)] });
      moveView(view, 1, 116, minX);
      assert.equal(bookSrc(render(page)), originalSrc, "手指未松开时保持当前页");
      view.props.onTouchEnd({ touches: [], changedTouches: [touch(1, 116)] });
      await settle();
      const updated = render(page);
      assert.notEqual(bookSrc(updated), originalSrc, "到达右边缘后继续左拖才翻页");
      assertDisplayScale(updated, 1, "成功翻页后新书页恢复原始倍率");
    } finally { page.unload(); page.dispose(); }
  });

  test(`${route.name}：手机到达左边缘后继续右拖，松手翻上一页`, async () => {
    const { page } = fixture(route, phonePortrait);
    try {
      const tree = scaleTo(page, 2);
      const originalSrc = bookSrc(tree);
      const { view } = activeZoom(tree);
      view.props.onChange({ detail: { source: "touch", x: 0, y: 0 } });
      view.props.onTouchStart({ touches: [touch(1, 100)] });
      moveView(view, 1, 164, 0);
      view.props.onTouchEnd({ touches: [], changedTouches: [touch(1, 164)] });
      await settle();
      const updated = render(page);
      assert.notEqual(bookSrc(updated), originalSrc, "左边缘的反向拖动翻上一页");
      assertDisplayScale(updated, 1);
    } finally { page.unload(); page.dispose(); }
  });

  test(`${route.name}：手机在边缘拖动不足 64px，松手不翻页`, async () => {
    const { page } = fixture(route, phonePortrait);
    try {
      const tree = scaleTo(page, 2);
      const originalSrc = bookSrc(tree);
      const { view } = activeZoom(tree);
      const { minX } = horizontalBounds(tree);
      view.props.onChange({ detail: { source: "touch", x: minX, y: 0 } });
      view.props.onTouchStart({ touches: [touch(1, 180)] });
      moveView(view, 1, 117, minX);
      view.props.onTouchEnd({ touches: [], changedTouches: [touch(1, 117)] });
      await settle();
      const updated = render(page);
      assert.equal(bookSrc(updated), originalSrc, "不到边缘继续拖动阈值时仍停在当前页");
      assertDisplayScale(updated, 2);
    } finally { page.unload(); page.dispose(); }
  });

  test(`${route.name}：手机原始倍率拖够距离后回拉，松手最终位置不应翻页`, async () => {
    const { page } = fixture(route, phonePortrait);
    try {
      const tree = render(page);
      const originalSrc = bookSrc(tree);
      const { view } = activeZoom(tree);
      view.props.onTouchStart({ touches: [touch(1, 180)] });
      moveView(view, 1, 100, 0);
      // 最后一段回拉只有原生 touchend 的 changedTouches，没有 touchmove。
      view.props.onTouchEnd({ touches: [], changedTouches: [touch(1, 180)] });
      await settle();
      assert.equal(bookSrc(render(page)), originalSrc, "翻页必须依据松手时的最终位移");
    } finally { page.unload(); page.dispose(); }
  });

  test(`${route.name}：手机放大后在边缘拖够 64px 再回拉到 63px，松手不翻页`, async () => {
    const { page } = fixture(route, phonePortrait);
    try {
      const tree = scaleTo(page, 2);
      const originalSrc = bookSrc(tree);
      const { view } = activeZoom(tree);
      const { minX } = horizontalBounds(tree);
      view.props.onChange({ detail: { source: "touch", x: minX, y: 0 } });
      view.props.onTouchStart({ touches: [touch(1, 180)] });
      moveView(view, 1, 116, minX);
      view.props.onTouchEnd({ touches: [], changedTouches: [touch(1, 117)] });
      await settle();
      const updated = render(page);
      assert.equal(bookSrc(updated), originalSrc, "最终边缘位移不足阈值时不能沿用上次触摸移动结果");
      assertDisplayScale(updated, 2);
    } finally { page.unload(); page.dispose(); }
  });

  test(`${route.name}：手机单指只有松手事件报告大位移时，尾随点击不能误播音频`, () => {
    const { page } = fixture(route, phonePortrait);
    try {
      const tree = scaleTo(page, 2);
      const { view } = activeZoom(tree);
      const beforePlay = playCount(page);
      view.props.onTouchStart({ touches: [touch(1, 180)] });
      view.props.onTouchEnd({ touches: [], changedTouches: [touch(1, 100)] });
      byClass(activeZoom(render(page)).view, "audio-hotspot").props.onClick();
      assert.equal(playCount(page), beforePlay, "touchmove 缺帧时仍需根据松手最终坐标识别拖动");
    } finally { page.unload(); page.dispose(); }
  });

  test(`${route.name}：手机从中部一次大拖动抵达边缘，不能把此前距离算成翻页`, async () => {
    const { page } = fixture(route, phonePortrait);
    try {
      const tree = scaleTo(page, 2);
      const originalSrc = bookSrc(tree);
      const { view } = activeZoom(tree);
      const { minX } = horizontalBounds(tree);
      view.props.onTouchStart({ touches: [touch(1, 300)] });
      moveView(view, 1, 50, minX);
      view.props.onTouchEnd({ touches: [], changedTouches: [touch(1, 50)] });
      await settle();
      const updated = render(page);
      assert.equal(bookSrc(updated), originalSrc, "到边缘前的移动只用于浏览放大内容");
      assertDisplayScale(updated, 2);
    } finally { page.unload(); page.dispose(); }
  });

  test(`${route.name}：手机中部拖到边缘，再多拖 64px 后才能翻页`, async () => {
    const { page } = fixture(route, phonePortrait);
    try {
      const tree = scaleTo(page, 2);
      const originalSrc = bookSrc(tree);
      const { view } = activeZoom(tree);
      const { minX } = horizontalBounds(tree);
      view.props.onTouchStart({ touches: [touch(1, 300)] });
      moveView(view, 1, 150, minX);
      moveView(view, 1, 86, minX);
      view.props.onTouchEnd({ touches: [], changedTouches: [touch(1, 86)] });
      await settle();
      assert.notEqual(bookSrc(render(page)), originalSrc, "边缘外的额外拖动达到阈值后翻页");
    } finally { page.unload(); page.dispose(); }
  });

  test(`${route.name}：手机捏合剩余一指在边缘移动，不能变成翻页手势`, async () => {
    const { page } = fixture(route, phonePortrait);
    try {
      let tree = render(page);
      activeZoom(tree).view.props.onTouchStart({ touches: [touch(1, 180), touch(2, 240)] });
      tree = scaleTo(page, 2);
      const originalSrc = bookSrc(tree);
      const { view } = activeZoom(tree);
      const { minX } = horizontalBounds(tree);
      view.props.onTouchEnd({ touches: [touch(1, 180)], changedTouches: [touch(2, 240)] });
      moveView(view, 1, 80, minX);
      view.props.onTouchEnd({ touches: [], changedTouches: [touch(1, 80)] });
      await settle();
      const updated = render(page);
      assert.equal(bookSrc(updated), originalSrc, "同一次双指手势不能在剩一指时转成边缘翻页");
      assertDisplayScale(updated, 2);
    } finally { page.unload(); page.dispose(); }
  });

  test(`${route.name}：手机边缘拖动被系统取消时，不触发翻页`, async () => {
    const { page } = fixture(route, phonePortrait);
    try {
      const tree = scaleTo(page, 2);
      const originalSrc = bookSrc(tree);
      const { view } = activeZoom(tree);
      const { minX } = horizontalBounds(tree);
      view.props.onChange({ detail: { source: "touch", x: minX, y: 0 } });
      view.props.onTouchStart({ touches: [touch(1, 180)] });
      moveView(view, 1, 100, minX);
      view.props.onTouchCancel({ touches: [], changedTouches: [touch(1, 100)] });
      await settle();
      const updated = render(page);
      assert.equal(bookSrc(updated), originalSrc, "touchcancel 只能取消本次动作");
      assertDisplayScale(updated, 2);
    } finally { page.unload(); page.dispose(); }
  });

  test(`${route.name}：手机录音启动中边缘翻页被阻止，并保持缩放位置`, async () => {
    const { page } = fixture(route, phonePortrait);
    try {
      let tree = scaleTo(page, 2);
      const originalSrc = bookSrc(tree);
      await byClass(tree, "record-button").props.onClick();
      tree = render(page);
      assert.ok(byClass(tree, "practice-recorder--starting"));
      const { view } = activeZoom(tree);
      const { minX } = horizontalBounds(tree);
      view.props.onChange({ detail: { source: "touch", x: minX, y: 0 } });
      view.props.onTouchStart({ touches: [touch(1, 180)] });
      moveView(view, 1, 100, minX);
      view.props.onTouchEnd({ touches: [], changedTouches: [touch(1, 100)] });
      await settle();
      const updated = render(page);
      assert.equal(bookSrc(updated), originalSrc, "边缘翻页必须遵守原来的录音状态保护");
      assertDisplayScale(updated, 2, "未成功翻页不能重置倍率");
    } finally { page.unload(); page.dispose(); }
  });

  test(`${route.name}：手机双指触摸与放大不弹出重复录音按钮，原录音区仍可操作`, async () => {
    const { page } = fixture(route, phonePortrait);
    try {
      let tree = render(page);
      activeZoom(tree).view.props.onTouchStart({ touches: [touch(1), touch(2)] });
      tree = render(page);
      assert.equal(byClass(tree, "practice-zoom-recorder"), undefined, "双指刚接触也不应弹出按钮");
      tree = scaleTo(page, 2);
      activeZoom(tree).view.props.onTouchEnd({ touches: [] });
      tree = render(page);
      assert.equal(byClass(tree, "practice-zoom-recorder"), undefined, "放大不添加浮动操作条");
      assert.equal(elements(tree).filter((node) => hasClass(node, "record-button")).length, 1,
        "开始录音按钮只留在原跟读区域");
      await byClass(tree, "record-button").props.onClick();
      page.recorderHandlers.Start();
      tree = render(page);
      assert.ok(byClass(tree, "practice-recorder--recording"));
      assert.ok(byClass(tree, "record-button--stop"), "原录音区仍可结束录音");
      assertDisplayScale(tree, 2);
      byClass(tree, "record-button--pause").props.onClick();
      page.recorderHandlers.Pause();
      tree = render(page);
      assert.ok(byClass(tree, "record-button--resume"), "原录音区仍可继续录音");
      byClass(tree, "record-button--resume").props.onClick();
      page.recorderHandlers.Resume();
      tree = render(page);
      assert.ok(byClass(tree, "record-button--stop"));
      assertDisplayScale(tree, 2);
    } finally { page.unload(); page.dispose(); }
  });

  test(`${route.name}：连续捏合不把旧倍率回写原生组件，也始终保持可拖动方向`, () => {
    const { page } = fixture(route, phonePortrait);
    try {
      let tree = render(page);
      const initialDirection = activeZoom(tree).view.props.direction;
      activeZoom(tree).view.props.onTouchStart({ touches: [touch(1), touch(2)] });
      for (const scale of [1.03, 1.4, 1.8, 2.3, 2]) {
        tree = scaleTo(page, scale);
        const { view } = activeZoom(tree);
        assert.equal(Object.hasOwn(view.props, "scaleValue"), false, "旧事件不能回写倍率打断原生捏合");
        assert.equal(view.props.animation, false, "关闭程序参数变更引起的补间动画");
        assert.equal(view.props.direction, initialDirection, "同次捏合期间移动方向稳定");
        assertDisplayScale(tree, 1, "手势中热点保持随书页缩放");
      }
      activeZoom(tree).view.props.onTouchEnd({ touches: [touch(1)] });
      tree = render(page);
      assert.equal(activeZoom(tree).view.props.direction, initialDirection, "剩一根手指时不提交方向");
      activeZoom(tree).view.props.onTouchEnd({ touches: [] });
      tree = render(page);
      assert.equal(activeZoom(tree).view.props.direction, "all");
      assertDisplayScale(tree, 2, "全部松开后热点仍随书页缩放");
      tree = scaleTo(page, 2.05);
      assertDisplayScale(tree, 2.05, "晚到的原生最终倍率不会反向缩小热点");
    } finally { page.unload(); page.dispose(); }
  });

  test(`${route.name}：捏合尾帧晚到新单指手势时，等全部松开再更新显示`, () => {
    const { page } = fixture(route, phonePortrait);
    try {
      let tree = render(page);
      activeZoom(tree).view.props.onTouchStart({ touches: [touch(1), touch(2)] });
      tree = scaleTo(page, 1);
      activeZoom(tree).view.props.onTouchEnd({ touches: [] });
      tree = render(page);
      activeZoom(tree).view.props.onTouchStart({ touches: [touch(3)] });
      tree = scaleTo(page, 2);
      assert.equal(activeZoom(tree).view.props.direction, "all", "晚到的倍率不能改变原生拖动方向");
      assertDisplayScale(tree, 1);
      activeZoom(tree).view.props.onTouchEnd({ touches: [] });
      tree = render(page);
      assert.equal(activeZoom(tree).view.props.direction, "all");
      assertDisplayScale(tree, 2);
    } finally { page.unload(); page.dispose(); }
  });

  test(`${route.name}：双指缩放结束产生的尾随点击不会误播音频`, () => {
    const { page } = fixture(route);
    try {
      let tree = render(page);
      const view = activeZoom(tree).view;
      assert.equal(typeof view.props.onTouchStart, "function", "书页需识别双指触摸以拦截尾随点击");
      view.props.onTouchStart({ touches: [touch(1), touch(2)], changedTouches: [touch(1), touch(2)] });
      tree = scaleTo(page, 2);
      const pinched = activeZoom(tree);
      pinched.view.props.onTouchEnd({ touches: [], changedTouches: [touch(1), touch(2)] });
      const beforePlay = playCount(page);
      byClass(pinched.view, "audio-hotspot").props.onClick();
      assert.equal(playCount(page), beforePlay, "同一次缩放动作尾随的原生 click 不得触发热点");
    } finally { page.unload(); page.dispose(); }
  });

  test(`${route.name}：原生微小位移仍可点音频，实际拖动不误播`, () => {
    const { page } = fixture(route, landscape);
    try {
      let tree = scaleTo(page, 2);
      let { view } = activeZoom(tree);
      view.props.onTouchStart({ touches: [touch(1)], changedTouches: [touch(1)] });
      view.props.onChange({ detail: { source: "touch", x: 1, y: 2 } });
      view.props.onTouchMove({ touches: [touch(1, 123, 142)] });
      view.props.onTouchEnd({ touches: [], changedTouches: [touch(1, 123, 142)] });
      tree = render(page);
      const beforeTap = playCount(page);
      byClass(activeZoom(tree).view, "audio-hotspot").props.onClick();
      assert.equal(playCount(page), beforeTap + 1, "小于拖动阈值的点按仍可播放音频");

      ({ view } = activeZoom(render(page)));
      view.props.onTouchStart({ touches: [touch(2)], changedTouches: [touch(2)] });
      view.props.onChange({ detail: { source: "touch", x: 15, y: 12 } });
      view.props.onTouchMove({ touches: [touch(2, 130, 140)] });
      view.props.onTouchEnd({ touches: [], changedTouches: [touch(2, 130, 140)] });
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
      activeZoom(tree).view.props.onTouchStart({ touches: [touch(1), touch(2)], changedTouches: [touch(1), touch(2)] });
      tree = render(page);
      assert.equal(activeZoom(tree).swiper.props.disableTouch, true);
      activeZoom(tree).view.props.onTouchEnd({ touches: [touch(1)], changedTouches: [touch(2)] });
      tree = render(page);
      assert.equal(activeZoom(tree).swiper.props.disableTouch, true,
        "第二根手指先离开时不能立即恢复 Swiper 手势");
      activeZoom(tree).view.props.onTouchEnd({ touches: [], changedTouches: [touch(1)] });
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
      assertDisplayScale(tree, 2, "被阻止的切页不能重置放大状态");

      page.recorderHandlers.Start();
      tree = render(page);
      await byClass(tree, "practice-navigation__button--primary").props.onClick();
      await settle();
      tree = render(page);
      assert.notEqual(byClass(tree, "practice-book-page__image").props.src, originalSrc,
        "录音已启动后按钮应能提交下一页");
      assert.equal(Object.hasOwn(activeZoom(tree).view.props, "scaleValue"), false, "新页不得继承受控倍率");
      assert.equal(activeZoom(tree).swiper.props.disableTouch, false, "成功切页恢复手势翻页");
    } finally { page.unload(); page.dispose(); }
  });
}

test("设备旋转只重置教材倍率，保留当前页及音频播放", () => {
  const { page, rotate } = fixture(routes[0]);
  try {
    let tree = scaleTo(page, 2);
    const originalSrc = byClass(tree, "practice-book-page__image").props.src;
    const { view } = activeZoom(tree);
    view.props.onTouchEnd({ touches: [], changedTouches: [touch(1), touch(2)] });
    view.props.onTouchStart({ touches: [touch(3)], changedTouches: [touch(3)] });
    view.props.onTouchEnd({ touches: [], changedTouches: [touch(3)] });
    tree = render(page);
    byClass(activeZoom(tree).view, "audio-hotspot").props.onClick();
    const playingAudio = page.audios.at(-1);
    assert.ok(playingAudio?.events.includes("play"), "旋转前的新单指点按应真正播放示范音频");
    const audioEvents = [...playingAudio.events];

    tree = rotate(landscape);
    assert.equal(byClass(tree, "practice-book-page__image").props.src, originalSrc);
    assert.equal(Object.hasOwn(activeZoom(tree).view.props, "scaleValue"), false, "旋转后仍使用原生默认倍率");
    assert.equal(activeZoom(tree).swiper.props.disableTouch, false);
    assert.deepEqual(playingAudio.events, audioEvents, "旋转不能停止或重启示范音频");
  } finally { page.unload(); page.dispose(); }
});
