/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const test = require("node:test");
const { createPage, byClass, elements, textOf } = require("./test-practice-book-route.cjs");

const imageSize = { width: 800, height: 1200 };
const render = (page) => { page.render(); page.render(); return page.render(); };
const cleanup = (page) => { page.unload(); page.dispose(); };
const bookImages = (tree) => elements(tree).filter((node) =>
  node.type === "Image" && /practice-book-page__(?:image|neighbor)/.test(node.props.className || ""));
const imagePageNumbers = (tree) => new Set(bookImages(tree).map((image) =>
  Number(new URL(image.props.src).pathname.match(/_(\d+)\.png$/)?.[1])));
const hasClass = (node, name) => String(node?.props?.className || "").split(/\s+/).includes(name);
const currentImage = (tree) => byClass(tree, "practice-book-page__image");
const imageError = (tree) => byClass(tree, "practice-book-image-error");
const retryButton = (tree) => byClass(tree, "practice-book-image-retry");

function fixture() {
  const imageInfoRequests = [];
  const page = createPage("src/pages/Practice/Practice.tsx", { bookId: "11", page: "94" }, {
    taroOverrides: {
      // The native image callback is controlled by each test. A known aspect ratio
      // may be available locally even while the actual image download is pending.
      getImageInfo(request) { imageInfoRequests.push(request); },
    },
  });
  render(page);
  return { page, imageInfoRequests };
}

test("Our World 1：当前页和下一页立即加载，上一页等当前页成功后再预载", () => {
  const { page, imageInfoRequests } = fixture();
  try {
    const pending = render(page);
    const active = currentImage(pending);
    assert.ok(active, "当前教材页应先挂载");
    const pendingPageNumbers = new Set(bookImages(pending).map((image) =>
      Number(new URL(image.props.src).pathname.match(/_(\d+)\.png$/)?.[1])));
    assert.deepEqual(pendingPageNumbers, new Set([94, 95]),
      "当前图加载时应同时预载下一页，但暂缓请求上一页");
    assert.equal(imageInfoRequests[0]?.src, active.props.src, "首个图片信息请求应属于当前页");

    active.props.onLoad({ detail: imageSize });
    const loaded = render(page);
    const mountedPageNumbers = new Set(bookImages(loaded).map((image) =>
      Number(new URL(image.props.src).pathname.match(/_(\d+)\.png$/)?.[1])));
    assert.deepEqual(mountedPageNumbers, new Set([93, 94, 95]),
      "当前页加载后再预载上一页，仍只请求紧邻页");
  } finally { cleanup(page); }
});

test("Our World 1：连续前翻到已预载页时立即请求再下一页", async () => {
  const { page } = fixture();
  try {
    const initial = render(page);
    const active = currentImage(initial);
    const nextImage = bookImages(initial).find((image) =>
      image.props.src !== active.props.src);
    assert.ok(nextImage, "打开当前页时应已经挂载下一页图片");
    active.props.onLoad({ detail: imageSize });
    nextImage.props.onLoad({ detail: imageSize });

    await byClass(render(page), "practice-navigation__button--primary").props.onClick();
    const turned = render(page);
    const mountedPageNumbers = new Set(bookImages(turned).map((image) =>
      Number(new URL(image.props.src).pathname.match(/_(\d+)\.png$/)?.[1])));
    assert.equal(Number(new URL(currentImage(turned).props.src).pathname.match(/_(\d+)\.png$/)?.[1]), 95);
    assert.ok(mountedPageNumbers.has(96), "翻到已经预载的第 95 页时应立即预载第 96 页");
  } finally { cleanup(page); }
});

test("Our World 1：快速前翻到仍在加载的页，也立即启动它的下一页", async () => {
  const { page } = fixture();
  try {
    const initial = render(page);
    const active = currentImage(initial);
    const nextImage = bookImages(initial).find((image) =>
      image.props.src !== active.props.src);
    assert.ok(nextImage, "打开当前页时应已经挂载下一页图片");
    active.props.onLoad({ detail: imageSize });
    // The preloaded next page has not called onLoad yet when the reader turns.
    await byClass(render(page), "practice-navigation__button--primary").props.onClick();

    const turned = render(page);
    const mountedPageNumbers = new Set(bookImages(turned).map((image) =>
      Number(new URL(image.props.src).pathname.match(/_(\d+)\.png$/)?.[1])));
    assert.equal(Number(new URL(currentImage(turned).props.src).pathname.match(/_(\d+)\.png$/)?.[1]), 95);
    assert.ok(mountedPageNumbers.has(96),
      "即使第 95 页尚未加载完成，也应提前请求第 96 页，避免连续翻页等图");
  } finally { cleanup(page); }
});

test("Our World 1：手势切页动画结束前就预载新视觉页的下一页", () => {
  const { page } = fixture();
  try {
    const initial = render(page);
    const originalSrc = currentImage(initial).props.src;
    const swiper = byClass(initial, "practice-book-swiper");
    swiper.props.onChange({ detail: { current: swiper.props.current + 1, source: "touch" } });

    const animating = render(page);
    assert.equal(currentImage(animating)?.props.src, originalSrc,
      "动画期间业务页仍指向原教材页");
    assert.ok(imagePageNumbers(animating).has(96),
      "视觉上滑向第 95 页时，应在动画完成前启动第 96 页预载");
  } finally { cleanup(page); }
});

test("Our World 1：当前页成功后保留已加载旧页，不批量请求未加载的历史页", async () => {
  const { page } = fixture();
  try {
    currentImage(render(page)).props.onLoad({ detail: imageSize });
    for (let turn = 0; turn < 3; turn += 1) {
      await byClass(render(page), "practice-navigation__button--primary").props.onClick();
      render(page);
    }
    const pending = render(page);
    assert.equal(Number(new URL(currentImage(pending).props.src).pathname.match(/_(\d+)\.png$/)?.[1]), 97);
    currentImage(pending).props.onLoad({ detail: imageSize });

    const loaded = render(page);
    assert.deepEqual(imagePageNumbers(loaded), new Set([94, 96, 97, 98]),
      "第 94 页已加载应保留；第 96 页是邻页；第 93、95 页未加载不应重启请求");
  } finally { cleanup(page); }
});

test("Our World 1：已预载静态图翻为当前页后先显示它，缩放图加载完再覆盖", async () => {
  const { page } = fixture();
  try {
    const initial = render(page);
    const active = currentImage(initial);
    const nextImage = bookImages(initial).find((image) => image.props.src !== active.props.src);
    assert.ok(nextImage, "下一页静态图应提前挂载");
    nextImage.props.onLoad({ detail: imageSize });
    await byClass(render(page), "practice-navigation__button--primary").props.onClick();

    const turned = render(page);
    const staticFrame = elements(turned).find((node) =>
      hasClass(node, "practice-book-static") &&
      elements(node).some((image) => image.type === "Image" && image.props.src === nextImage.props.src));
    assert.ok(staticFrame && !hasClass(staticFrame, "practice-book-static--covered"),
      "预载完成的静态图应保持可见，避免新建的缩放层尚未加载时空白");
    assert.ok(byClass(turned, "practice-book-zoom-area--pending"),
      "缩放图未加载时应隐藏缩放层并放行静态页触摸");

    const zoomImage = currentImage(turned);
    assert.equal(zoomImage?.props.src, nextImage.props.src, "缩放层仍应加载同一书页");
    zoomImage.props.onLoad({ detail: imageSize });
    const loadedZoom = render(page);
    const coveredStaticFrame = elements(loadedZoom).find((node) =>
      hasClass(node, "practice-book-static") &&
      elements(node).some((image) => image.type === "Image" && image.props.src === nextImage.props.src));
    assert.ok(coveredStaticFrame && hasClass(coveredStaticFrame, "practice-book-static--covered"),
      "缩放图加载完成后再覆盖静态图");
    assert.equal(byClass(loadedZoom, "practice-book-zoom-area--pending"), undefined,
      "缩放图加载完成后应恢复缩放层交互");
  } finally { cleanup(page); }
});

test("Our World 1：图片失败可重试，更新图片 src 后成功恢复且录音会话保留", async () => {
  const { page } = fixture();
  try {
    await byClass(render(page), "record-button").props.onClick();
    page.recorderHandlers.Start();
    assert.ok(byClass(render(page), "record-button--pause"), "录音开始后应保持录音中状态");

    const active = currentImage(render(page));
    const originalSrc = active.props.src;
    assert.equal(typeof active.props.onError, "function", "当前图片必须接收原生加载失败事件");
    active.props.onError({ detail: { errMsg: "request:fail timeout" } });

    const failed = render(page);
    assert.ok(imageError(failed), "当前页图片失败时应有可见提示");
    assert.match(textOf(imageError(failed)), /图片|书页|网络|加载/, "提示应说明教材图片未加载");
    const retry = retryButton(failed);
    assert.ok(retry, "当前页图片失败时应提供重试按钮");
    retry.props.onClick();

    const retrying = render(page);
    const retriedImage = currentImage(retrying);
    assert.notEqual(retriedImage.props.src, originalSrc, "重试必须改变原生 Image 的 src，触发重新请求");
    assert.equal(new URL(retriedImage.props.src).pathname, new URL(originalSrc).pathname,
      "重试应请求同一张教材图，不改变教材页");
    assert.ok(byClass(retrying, "record-button--pause"), "图片重试不得重建或结束正在录音的会话");

    retriedImage.props.onLoad({ detail: imageSize });
    assert.equal(imageError(render(page)), undefined, "图片成功加载后应清除失败提示");
  } finally { cleanup(page); }
});

test("Our World 1：后台预载失败不会在翻到该页时立即显示旧错误", async () => {
  const { page } = fixture();
  try {
    const initial = render(page);
    const firstSrc = currentImage(initial).props.src;
    const preloadedNext = bookImages(initial).find((image) => image.props.src !== firstSrc);
    assert.ok(preloadedNext, "下一页应在后台预载");
    preloadedNext.props.onError({ detail: { errMsg: "request:fail timeout" } });
    assert.equal(imageError(render(page)), undefined, "下一页预载失败不应污染仍可见的当前页");

    await byClass(render(page), "practice-navigation__button--primary").props.onClick();
    const visible = render(page);
    const visibleImage = currentImage(visible);
    assert.equal(visibleImage?.props.src, preloadedNext.props.src, "应翻到曾预载失败的书页");
    assert.equal(imageError(visible), undefined,
      "刚切页时可见图片会重新加载，不应立即显示后台预载的旧错误");

    visibleImage.props.onLoad({ detail: imageSize });
    assert.equal(imageError(render(page)), undefined, "可见图片成功后应保持没有失败提示");
  } finally { cleanup(page); }
});

test("Our World 1：后台预载失败后，仅当前页可见图片再次失败才显示提示", async () => {
  const { page } = fixture();
  try {
    const initial = render(page);
    const firstSrc = currentImage(initial).props.src;
    const preloadedNext = bookImages(initial).find((image) => image.props.src !== firstSrc);
    assert.ok(preloadedNext, "下一页应在后台预载");
    preloadedNext.props.onError({ detail: { errMsg: "request:fail timeout" } });

    await byClass(render(page), "practice-navigation__button--primary").props.onClick();
    const visible = render(page);
    const visibleImage = currentImage(visible);
    assert.equal(visibleImage?.props.src, preloadedNext.props.src);
    assert.equal(imageError(visible), undefined, "后台失败不能当成当前可见图片失败");

    visibleImage.props.onError({ detail: { errMsg: "request:fail timeout" } });
    assert.ok(imageError(render(page)), "当前页可见图片再次失败后才显示重试提示");
  } finally { cleanup(page); }
});

test("Our World 1：切到新页后旧图片迟到的失败回调不污染当前页", async () => {
  const { page } = fixture();
  try {
    const oldImage = currentImage(render(page));
    assert.equal(typeof oldImage.props.onError, "function", "旧页图片必须接收原生失败事件");
    const oldSrc = oldImage.props.src;
    oldImage.props.onLoad({ detail: imageSize });

    await byClass(render(page), "practice-navigation__button--primary").props.onClick();
    const next = render(page);
    const nextSrc = currentImage(next)?.props.src;
    assert.ok(nextSrc && nextSrc !== oldSrc, "测试应真正切换到下一张教材图");

    oldImage.props.onError({ detail: { errMsg: "request:fail timeout" } });
    const afterLateError = render(page);
    assert.equal(currentImage(afterLateError)?.props.src, nextSrc, "旧回调不得切换当前图片");
    assert.equal(imageError(afterLateError), undefined, "旧页失败不得显示为当前页错误");
  } finally { cleanup(page); }
});

test("Our World 1：旧页静态图迟到成功不触发旧页回退或重置新页缩放", async () => {
  const { page } = fixture();
  try {
    const initial = render(page);
    const oldZoom = currentImage(initial);
    const oldStatic = bookImages(initial).find((image) =>
      image !== oldZoom && image.props.src === oldZoom.props.src);
    assert.ok(oldStatic, "旧页应保留尚未加载完成的静态图片节点");
    oldZoom.props.onError({ detail: { errMsg: "request:fail timeout" } });

    await byClass(render(page), "practice-navigation__button--primary").props.onClick();
    const next = render(page);
    const nextZoom = currentImage(next);
    assert.ok(nextZoom && nextZoom.props.src !== oldZoom.props.src, "应已进入新书页");
    nextZoom.props.onLoad({ detail: imageSize });
    const nextZoomView = byClass(render(page), "practice-book-zoom-view");
    assert.ok(nextZoomView, "新页应有可用的缩放层");
    nextZoomView.props.onScale({ detail: { scale: 2, x: 0, y: 0 } });
    assert.equal(byClass(render(page), "practice-book-swiper").props.disableTouch, true,
      "新页放大后应锁定翻页手势");

    oldStatic.props.onLoad({ detail: imageSize });
    const afterLateLoad = render(page);
    assert.equal(currentImage(afterLateLoad)?.props.src, nextZoom.props.src,
      "旧静态图迟到不应改变当前书页");
    assert.equal(byClass(afterLateLoad, "practice-book-swiper").props.disableTouch, true,
      "旧静态图迟到不应重置新页的缩放状态");

    byClass(afterLateLoad, "practice-book-zoom-view").props.onScale({
      detail: { scale: 1, x: 0, y: 0 },
    });
    const previous = elements(render(page)).find((node) =>
      hasClass(node, "practice-navigation__button") &&
      !hasClass(node, "practice-navigation__button--primary"));
    assert.ok(previous, "应能从新页返回旧页验证回退状态");
    await previous.props.onClick();
    const returned = render(page);
    assert.equal(currentImage(returned)?.props.src, oldZoom.props.src);
    assert.ok(byClass(returned, "practice-book-zoom-area"),
      "旧页静态图迟到不应启用静态回退并永久关闭其缩放层");
  } finally { cleanup(page); }
});

test("Our World 1：已加载的页被保留窗口淘汰后，目录返回时重新优先加载当前图", async () => {
  const { page } = fixture();
  try {
    const first = currentImage(render(page));
    const firstSrc = first.props.src;
    first.props.onLoad({ detail: imageSize });
    render(page);

    // Retained Swiper nodes are capped at 24. Walk far enough that the first
    // page leaves that window, while keeping the same PracticeSession mounted.
    for (let turn = 0; turn < 30; turn += 1) {
      await byClass(render(page), "practice-navigation__button--primary").props.onClick();
      render(page);
    }
    const farPage = render(page);
    assert.notEqual(currentImage(farPage)?.props.src, firstSrc);
    assert.ok(!bookImages(farPage).some((image) => image.props.src === firstSrc),
      "首张已加载图片确实离开保留窗口，测试才覆盖重新进入场景");

    byClass(farPage, "practice-header__directory").props.onClick();
    let directory = render(page);
    const originalGroup = elements(directory).find((node) =>
      hasClass(node, "practice-directory-group") &&
      textOf(byClass(node, "practice-directory-group__title")) === "Unit 6 My Toys");
    assert.ok(originalGroup, "目录中应能找到原始 Unit 6 章节");
    byClass(originalGroup, "practice-directory-group__header").props.onClick();
    directory = render(page);
    const originalItem = elements(directory).find((node) =>
      node.props?.id === "practice-directory-page-94");
    assert.ok(originalItem, "目录中应能选择原始训练页");
    await originalItem.props.onClick();

    const revisited = render(page);
    const revisitedCurrent = currentImage(revisited);
    assert.equal(revisitedCurrent?.props.src, firstSrc, "目录应返回原始教材页");
    const revisitedPageNumbers = new Set(bookImages(revisited).map((image) =>
      Number(new URL(image.props.src).pathname.match(/_(\d+)\.png$/)?.[1])));
    assert.deepEqual(revisitedPageNumbers, new Set([94, 95]),
      "重新进入已淘汰页时，应先加载目标页和下一页，不因旧记录提前加载上一页");

    revisitedCurrent.props.onLoad({ detail: imageSize });
    const afterLoad = render(page);
    const afterLoadPageNumbers = new Set(bookImages(afterLoad).map((image) =>
      Number(new URL(image.props.src).pathname.match(/_(\d+)\.png$/)?.[1])));
    assert.ok(afterLoadPageNumbers.has(93), "目标页 onLoad 后才恢复上一页预载");
  } finally { cleanup(page); }
});

test("Our World 1：被保留窗口淘汰的旧静态邻页迟到成功不能伪造缓存", async () => {
  const { page } = fixture();
  try {
    const initial = render(page);
    const currentSrc = currentImage(initial).props.src;
    const oldNeighbor = bookImages(initial).find((image) => image.props.src !== currentSrc);
    assert.ok(oldNeighbor, "第 95 页静态邻页应已提前挂载");
    const oldSrc = oldNeighbor.props.src;
    for (let turn = 0; turn < 30; turn += 1) {
      await byClass(render(page), "practice-navigation__button--primary").props.onClick();
      render(page);
    }
    const farPage = render(page);
    assert.ok(!bookImages(farPage).some((image) => image.props.src === oldSrc),
      "旧图片必须已离开 24 页保留窗口，才能检验迟到回调");

    oldNeighbor.props.onLoad({ detail: imageSize });
    byClass(render(page), "practice-header__directory").props.onClick();
    let directory = render(page);
    const originalGroup = elements(directory).find((node) =>
      hasClass(node, "practice-directory-group") &&
      textOf(byClass(node, "practice-directory-group__title")) === "Unit 6 My Toys");
    assert.ok(originalGroup);
    byClass(originalGroup, "practice-directory-group__header").props.onClick();
    directory = render(page);
    const originalItem = elements(directory).find((node) =>
      node.props?.id === "practice-directory-page-95");
    assert.ok(originalItem);
    await originalItem.props.onClick();

    const revisited = render(page);
    assert.equal(currentImage(revisited)?.props.src, oldSrc);
    assert.deepEqual(imagePageNumbers(revisited), new Set([95, 96]),
      "旧静态邻页迟到 onLoad 不代表图片仍在缓存；返回时上一页要等新当前页加载成功");
    currentImage(revisited).props.onLoad({ detail: imageSize });
    assert.ok(imagePageNumbers(render(page)).has(94),
      "新当前页本次加载成功后再预载上一页");
  } finally { cleanup(page); }
});

test("Our World 1：静态图已加载时，可见缩放图失败应退回静态图", async () => {
  const { page } = fixture();
  try {
    const initial = render(page);
    const zoomImage = currentImage(initial);
    const staticImage = bookImages(initial).find((image) =>
      image !== zoomImage && image.props.src === zoomImage.props.src);
    assert.ok(staticImage, "可缩放页应有同一书页的静态图片节点");
    const staticFrame = elements(initial).find((node) =>
      hasClass(node, "practice-book-static") && elements(node).includes(staticImage));
    assert.ok(hasClass(staticFrame, "practice-book-static--covered"),
      "缩放图正常时，静态图应被缩放层覆盖");

    staticImage.props.onLoad({ detail: imageSize });
    const visibleZoomImage = currentImage(render(page));
    visibleZoomImage.props.onError({ detail: { errMsg: "request:fail timeout" } });
    const fallback = render(page);
    const fallbackStaticFrame = elements(fallback).find((node) =>
      hasClass(node, "practice-book-static") &&
      elements(node).some((image) => image.type === "Image" && image.props.src === zoomImage.props.src));
    assert.ok(fallbackStaticFrame && !hasClass(fallbackStaticFrame, "practice-book-static--covered"),
      "可见缩放图失败后应展示已经成功加载的静态图");
    assert.equal(imageError(fallback), undefined, "静态图可用时不应显示整页加载失败");

    byClass(fallback, "practice-header__directory").props.onClick();
    const withDirectory = render(page);
    assert.equal(byClass(withDirectory, "practice-directory-mask").props.hidden, false,
      "图片回退后目录仍可使用");
    byClass(withDirectory, "practice-directory-close").props.onClick();
    await byClass(render(page), "record-button").props.onClick();
    page.recorderHandlers.Start();
    assert.ok(byClass(render(page), "record-button--pause"), "图片回退后录音仍可使用");
  } finally { cleanup(page); }
});
