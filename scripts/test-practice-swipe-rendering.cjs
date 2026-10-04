/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const test = require("node:test");
const { createPage, byClass, elements } = require("./test-practice-book-route.cjs");

const routes = [
  { name: "普通教材", file: "src/pages/Practice/Practice.tsx", params: { bookId: "22", page: "9" } },
  { name: "Think", file: "src/pages/ThinkBookReader/ThinkBookReader.tsx", params: { bookId: "28", page: "12" } },
];
const modes = [
  { name: "手机竖屏", isPad: false, windowWidth: 390, windowHeight: 844, slot: { width: 374, height: 560 } },
  { name: "Pad 竖屏", isPad: true, windowWidth: 820, windowHeight: 1180, slot: { width: 760, height: 830 } },
];
const natural = { width: 600, height: 900 };
const render = (page) => { page.render(); page.render(); return page.render(); };
const settle = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };
const cleanup = (page) => { page.unload(); page.dispose(); };
const images = (tree) => elements(tree).filter((node) => node.type === "Image" &&
  /practice-book-page__(?:image|neighbor)/.test(node.props.className || ""));
const imageByUrl = (tree, src) => images(tree).find((node) => node.props.src === src);

function fixture(route, mode, deferred = false) {
  const imageRequests = [];
  const page = createPage(route.file, route.params, {
    overrides: {
      "@/hooks/useDeviceLayout": { useDeviceLayout: () => ({
        ...mode, orientation: "portrait", isSplit: false,
        contentMaxWidth: mode.isPad ? 820 : null, statusBarHeight: 20, safeAreaBottom: 0,
      }) },
    },
    taroOverrides: {
      getImageInfo(request) {
        imageRequests.push(request);
        if (!deferred) request.success(natural);
      },
      createSelectorQuery() {
        let callback;
        const query = {
          select() { return query; },
          boundingClientRect(next) { callback = next; return query; },
          exec() { callback?.({ ...mode.slot }); },
        };
        return query;
      },
    },
  });
  render(page);
  return { page, imageRequests };
}

async function swipe(page, current) {
  const before = render(page);
  const originalSrc = byClass(before, "practice-book-page__image").props.src;
  byClass(before, "practice-book-swiper").props.onChange({ detail: { current, source: "touch" } });
  await settle();
  const animating = render(page);
  assert.equal(byClass(animating, "practice-book-page__image").props.src, originalSrc,
    "手势动画完成前应保留当前业务页，避免重排正在滑动的图面");
  await byClass(animating, "practice-book-swiper").props.onAnimationFinish({
    detail: { current, source: "touch" },
  });
  await settle();
  return render(page);
}

function assertVisibleViewport(tree, message) {
  const style = byClass(tree, "practice-book-viewport").props.style;
  assert.ok(Number.parseFloat(style?.width) > 0 && Number.parseFloat(style?.height) > 0, message);
  return style;
}

for (const route of routes) {
  for (const mode of modes) {
    test(`${route.name}：${mode.name}已预加载图片前后翻页不切换原生显示模式`, async () => {
      const { page } = fixture(route, mode);
      try {
        const before = render(page);
        // 原生 Image 的加载回调先于滑动到达，模拟邻页已经预载完成。
        for (const image of images(before)) image.props.onLoad({ detail: natural });
        const tree = render(page);
        const current = byClass(tree, "practice-book-swiper").props.current;
        const originalSrc = byClass(tree, "practice-book-page__image").props.src;
        const preloadModes = new Map(images(tree).map((image) => [image.props.src, image.props.mode]));

        const next = await swipe(page, current + 1);
        const nextSrc = byClass(next, "practice-book-page__image").props.src;
        assert.notEqual(nextSrc, originalSrc, "滑动应真正切换训练页");
        assert.ok(preloadModes.has(nextSrc), "目标页应在滑动前已挂载并预载");
        assert.equal(imageByUrl(next, nextSrc).props.mode, preloadModes.get(nextSrc),
          "预加载邻页成为当前页时不能切换 Image mode，避免重绘图面");
        assert.equal(imageByUrl(next, originalSrc).props.mode, preloadModes.get(originalSrc),
          "滑出屏幕的旧页也应保持原生显示模式");

        const back = await swipe(page, current);
        assert.equal(byClass(back, "practice-book-page__image").props.src, originalSrc);
        for (const src of [originalSrc, nextSrc]) {
          assert.equal(imageByUrl(back, src).props.mode, preloadModes.get(src), "来回翻页复用相同显示模式");
        }
      } finally { cleanup(page); }
    });

    test(`${route.name}：${mode.name}新页尺寸延迟返回时保留可见视口并忽略旧回调`, async () => {
      const { page, imageRequests } = fixture(route, mode, true);
      try {
        const initial = render(page);
        const oldRequest = imageRequests[0];
        assert.ok(oldRequest, "初始页已开始获取固有尺寸");
        byClass(initial, "practice-book-page__image").props.onLoad({ detail: natural });
        const loaded = render(page);
        assertVisibleViewport(loaded, "初始图加载后视口应非零");
        const current = byClass(loaded, "practice-book-swiper").props.current;

        const waiting = await swipe(page, current + 1);
        assertVisibleViewport(waiting, "邻页图片及尺寸尚未加载完成时不能清空视口宽高");
        const newSrc = byClass(waiting, "practice-book-page__image").props.src;
        const newRequest = imageRequests.find((request) => request.src === newSrc);
        assert.ok(newRequest, "新页应独立获取尺寸");
        const nextNatural = { width: 800, height: 1000 };
        newRequest.success(nextNatural);
        const currentStyle = { ...assertVisibleViewport(render(page), "新尺寸返回后视口仍应非零") };
        assert.ok(Math.abs(Number.parseFloat(currentStyle.height) -
          Number.parseFloat(currentStyle.width) * nextNatural.height / nextNatural.width) <= 1,
        "真实尺寸返回后必须恢复新页比例，不能永久保留旧页占位尺寸");

        oldRequest.success({ width: 1200, height: 300 });
        assert.deepEqual(assertVisibleViewport(render(page), "迟到回调不得清空图面"), currentStyle,
          "已切走旧页的 getImageInfo 回调不得覆盖当前尺寸");
      } finally { cleanup(page); }
    });
  }
}
