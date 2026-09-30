/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const test = require("node:test");
const { createPage, byClass, elements } = require("./test-practice-book-route.cjs");

const PHONE = {
  isPad: false,
  orientation: "portrait",
  isSplit: false,
  windowWidth: 390,
  windowHeight: 844,
  contentMaxWidth: null,
  statusBarHeight: 20,
  safeAreaBottom: 0,
};
const SLOT = { width: 374, height: 560 };
const PAD = {
  ...PHONE,
  isPad: true,
  windowWidth: 768,
  windowHeight: 1024,
  contentMaxWidth: 820,
};
const PAD_SLOT = { width: 700, height: 800 };
const STANDARD_PAGE = { width: 1040, height: 1411 };
const TALL_PAGE = { width: 1029, height: 1469 };

const render = (page) => {
  page.render();
  page.render();
  return page.render();
};
const settle = async () => {
  for (let index = 0; index < 16; index++) await Promise.resolve();
};
const hasClass = (node, name) => node?.props?.className?.split(/\s+/).includes(name);
const activeBookPage = (tree) => {
  const activeImage = byClass(tree, "practice-book-page__image");
  return elements(tree).find((node) =>
    hasClass(node, "practice-book-page") &&
    elements(node).some((child) => child === activeImage),
  );
};
const sizeOf = (node) => ({
  width: Number.parseFloat(node?.props?.style?.width),
  height: Number.parseFloat(node?.props?.style?.height),
});

function fixture(bookId, getImageSize, initialPage = "95", {
  layout = PHONE,
  slot = SLOT,
  deferMeasurement = false,
} = {}) {
  const requests = [];
  const measurements = [];
  const page = createPage(
    "src/pages/ThinkBookReader/ThinkBookReader.tsx",
    { bookId, page: initialPage },
    {
      overrides: {
        "@/hooks/useDeviceLayout": { useDeviceLayout: () => layout },
      },
      taroOverrides: {
        getImageInfo(request) {
          requests.push(request);
          const size = getImageSize?.(request.src);
          if (size) request.success(size);
        },
        createSelectorQuery() {
          let callback;
          const query = {
            select() { return query; },
            boundingClientRect(next) { callback = next; return query; },
            exec() {
              const deliver = () => callback?.({ ...slot });
              if (deferMeasurement) measurements.push(deliver);
              else deliver();
            },
          };
          return query;
        },
      },
    },
  );
  render(page);
  return { page, requests, measurements };
}

function od6Fixture(bookId, getImageSize, initialPage = "0", {
  layout = PHONE,
  slot = SLOT,
  deferMeasurement = false,
} = {}) {
  const requests = [];
  const measurements = [];
  const prefix = bookId === "30" ? "student-book/pages/od6-sb" : "workbook/pages/od6-wb";
  const practices = [0, 1].map((pageNumber) => ({
    id: `${bookId}-page-${pageNumber}`,
    bookId,
    imageIndex: pageNumber,
    pageNumber,
    ...(pageNumber === 0 ? { pageLabel: "封面" } : {}),
    imageUrl: `https://example.com/oxford-discover-2e-l6/${prefix}_${pageNumber}.jpg`,
    sectionTitle: "课程导入",
    tracks: [],
  }));
  const bundle = {
    book: {
      id: bookId,
      seriesId: "oxford-discover",
      title: bookId === "30" ? "Oxford Discover 6" : "Oxford Discover 6 · 练习册",
      level: "Level 6",
      kind: bookId === "30" ? "学生用书" : "练习册",
      cover: practices[0].imageUrl,
      available: true,
    },
    coverUrl: practices[0].imageUrl,
    practices,
  };
  const page = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId, page: initialPage },
    {
      overrides: {
        "@/features/listeningPractice/bookPractice": {
          buildFullBookPracticeBundle: (requestedId) => requestedId === bookId ? bundle : null,
          buildBookPracticeBundle: () => ({ ...bundle, practices: [] }),
        },
        "@/hooks/useDeviceLayout": { useDeviceLayout: () => layout },
      },
      taroOverrides: {
        getImageInfo(request) {
          requests.push(request);
          const size = getImageSize?.(request.src);
          if (size) request.success(size);
        },
        createSelectorQuery() {
          let callback;
          const query = {
            select() { return query; },
            boundingClientRect(next) { callback = next; return query; },
            exec() {
              const deliver = () => callback?.({ ...slot });
              if (deferMeasurement) measurements.push(deliver);
              else deliver();
            },
          };
          return query;
        },
      },
    },
  );
  render(page);
  return { page, requests, measurements };
}

async function swipeForward(page) {
  const tree = render(page);
  const swiper = byClass(tree, "practice-book-swiper");
  swiper.props.onChange({ detail: { current: swiper.props.current + 1, source: "touch" } });
  await settle();
  return render(page);
}

test("Think 1 学生书首帧使用固定画布，尺寸返回后热点位于真实图面内", () => {
  const { page, requests, measurements } = fixture("26", undefined, "95", { deferMeasurement: true });
  try {
    const waiting = render(page);
    const waitingStyle = byClass(waiting, "practice-book-viewport").props.style;
    assert.ok(waitingStyle, "测宽返回前固定画布也必须预留空间");
    assert.equal(waitingStyle.width, "100%", "测宽返回前先占满可用宽度");
    assert.equal(waitingStyle.aspectRatio, `${STANDARD_PAGE.width} / ${STANDARD_PAGE.height}`,
      "测宽返回前按固定比例预留高度");
    const waitingImage = byClass(waiting, "practice-book-page__image");
    assert.equal(waitingImage.props.mode, "aspectFit");
    assert.equal(waitingImage.props.style?.height, "100%",
      "Think 1 固定画布图片也必须有确定高度");
    assert.equal(byClass(waiting, "practice-book-page__hotspots"), undefined,
      "真实图面尺寸返回前不能把热点放在固定画布上");

    measurements.splice(0).forEach((deliver) => deliver());
    const measured = render(page);
    const waitingViewport = sizeOf(byClass(measured, "practice-book-viewport"));
    assert.equal(waitingViewport.width, SLOT.width);
    assert.equal(waitingViewport.height,
      Math.round(SLOT.width * STANDARD_PAGE.height / STANDARD_PAGE.width));
    assert.ok(requests[0], "当前页应请求原图尺寸");
    requests[0].success(TALL_PAGE);
    const loaded = render(page);
    const viewport = sizeOf(byClass(loaded, "practice-book-viewport"));
    const imagePage = activeBookPage(loaded);
    const imageSize = sizeOf(imagePage);
    assert.deepEqual(viewport, waitingViewport, "图片尺寸返回后外层画布不能变化");
    assert.ok(imageSize.width < viewport.width, "偏长页面应等比缩小并产生少量左右留白");
    assert.ok(Math.abs(imageSize.height - viewport.height) <= 1, "偏长页面应完整占满画布高度");
    assert.ok(Math.abs(imageSize.width / imageSize.height - TALL_PAGE.width / TALL_PAGE.height) < 0.001,
      "页面必须保持原图比例");
    const hotspotLayer = byClass(imagePage, "practice-book-page__hotspots");
    assert.ok(hotspotLayer, "热点层应放在真实图面容器内");
    assert.equal(elements(hotspotLayer).filter((node) => hasClass(node, "audio-hotspot")).length, 2,
      "真实异常页的两个音频热点都应保留");
    assert.ok(hasClass(byClass(loaded, "practice-book-slide"), "practice-book-slide--stable-canvas"),
      "试点书页应在固定画布中居中");
  } finally {
    page.unload();
    page.dispose();
  }
});

test("Think 1 学生书第 24 页音频按钮移入题号左侧留白区", () => {
  const { page } = fixture("26", () => STANDARD_PAGE, "24");
  try {
    const tree = render(page);
    const imagePage = activeBookPage(tree);
    const imageSize = sizeOf(imagePage);
    const hotspotLayer = byClass(imagePage, "practice-book-page__hotspots");
    const hotspots = elements(hotspotLayer).filter((node) => hasClass(node, "audio-hotspot"));
    assert.equal(hotspots.length, 2, "第 24 页的 2.07 和 2.08 应各保留一个按钮");

    for (const [index, hotspot] of hotspots.entries()) {
      const renderedLeft = Number.parseFloat(hotspot.props.style.left);
      const leftShiftPx = (13.859 - renderedLeft) * imageSize.width / 100;
      assert.ok(Math.abs(leftShiftPx - 22) < 0.01,
        `第 ${index + 1} 个按钮应从印刷音轨标记中心向左移动 22px`);
    }
    assert.ok(Math.abs(Number.parseFloat(hotspots[0].props.style.top) - 37.37) < 0.001,
      "左移不能改变 2.07 的纵向题目对应关系");
    assert.ok(Math.abs(Number.parseFloat(hotspots[1].props.style.top) - 81.88) < 0.001,
      "左移不能改变 2.08 的纵向题目对应关系");
  } finally {
    page.unload();
    page.dispose();
  }
});

test("Think 1 学生书其他页面统一左移 22px", () => {
  const scenarios = [
    { pageIndex: "15", sourceLeft: 13.859, hotspotCount: 2 },
    { pageIndex: "84", sourceLeft: 50.979, hotspotCount: 1 },
  ];
  for (const scenario of scenarios) {
    const { page } = fixture("26", () => STANDARD_PAGE, scenario.pageIndex);
    try {
      const tree = render(page);
      const imagePage = activeBookPage(tree);
      const imageSize = sizeOf(imagePage);
      const hotspots = elements(byClass(imagePage, "practice-book-page__hotspots"))
        .filter((node) => hasClass(node, "audio-hotspot"));
      assert.equal(hotspots.length, scenario.hotspotCount);
      for (const hotspot of hotspots) {
        const renderedLeft = Number.parseFloat(hotspot.props.style.left);
        const leftShiftPx = (scenario.sourceLeft - renderedLeft) * imageSize.width / 100;
        assert.ok(Math.abs(leftShiftPx - 22) < 0.01,
          `图片索引 ${scenario.pageIndex} 的按钮应统一左移 22px`);
      }
    } finally {
      page.unload();
      page.dispose();
    }
  }
});

test("未参与本次调整的 Think 2 音频按钮保留原有 8px 左移", () => {
  const { page } = fixture("28", () => STANDARD_PAGE, "5");
  try {
    const tree = render(page);
    const imagePage = activeBookPage(tree);
    const imageSize = sizeOf(byClass(tree, "practice-book-viewport"));
    const hotspots = elements(byClass(imagePage, "practice-book-page__hotspots"))
      .filter((node) => hasClass(node, "audio-hotspot"));
    assert.equal(hotspots.length, 3);
    const renderedLeft = Number.parseFloat(hotspots[0].props.style.left);
    const leftShiftPx = (13.79 - renderedLeft) * imageSize.width / 100;
    assert.ok(Math.abs(leftShiftPx - 8) < 0.01,
      `Think 2 不应跟随 Think 1 改变按钮位置（实际左移 ${leftShiftPx}px）`);
  } finally {
    page.unload();
    page.dispose();
  }
});

test("Think 1 学生书 Pad 首帧和测量后始终占满同一阅读区", () => {
  const { page, measurements } = fixture("26", () => TALL_PAGE, "95", {
    layout: PAD,
    slot: PAD_SLOT,
    deferMeasurement: true,
  });
  try {
    const firstStyle = byClass(render(page), "practice-book-viewport").props.style;
    assert.deepEqual(firstStyle, { width: "100%", height: "100%" },
      "Pad 测量前应直接占满固定阅读区");

    measurements.splice(0).forEach((deliver) => deliver());
    const measured = render(page);
    assert.deepEqual(sizeOf(byClass(measured, "practice-book-viewport")), PAD_SLOT,
      "Pad 测量后外层仍与阅读区一致");
    const imageSize = sizeOf(activeBookPage(measured));
    assert.ok(imageSize.width < PAD_SLOT.width && imageSize.height <= PAD_SLOT.height,
      "真实偏长页面应完整居中在 Pad 阅读区内");
    assert.ok(Math.abs(imageSize.width / imageSize.height - TALL_PAGE.width / TALL_PAGE.height) < 0.001);
  } finally {
    page.unload();
    page.dispose();
  }
});

test("Think 1 学生书翻到不同比例页面时外层画布不跳动", async () => {
  const imageSizeForUrl = (src) => /_95\.jpg(?:$|\?)/.test(src) ? TALL_PAGE : STANDARD_PAGE;
  const { page } = fixture("26", imageSizeForUrl, "94");
  try {
    const before = sizeOf(byClass(render(page), "practice-book-viewport"));
    const after = sizeOf(byClass(await swipeForward(page), "practice-book-viewport"));
    assert.deepEqual(after, before, "翻页前后必须使用同一个画布宽高");
  } finally {
    page.unload();
    page.dispose();
  }
});

test("未参与试点的 Think 2 学生书仍按当前图片比例定框", () => {
  const { page } = fixture("28", () => TALL_PAGE);
  try {
    const tree = render(page);
    const viewport = sizeOf(byClass(tree, "practice-book-viewport"));
    assert.equal(viewport.width, SLOT.width);
    assert.equal(viewport.height, Math.round(SLOT.width * TALL_PAGE.height / TALL_PAGE.width));
    assert.equal(hasClass(byClass(tree, "practice-book-slide"), "practice-book-slide--stable-canvas"), false);
  } finally {
    page.unload();
    page.dispose();
  }
});

for (const [bookId, canonical] of Object.entries({
  "30": { width: 1536, height: 1987 },
  "31": { width: 1536, height: 1984 },
})) {
  test(`Oxford Discover 6 教材 ${bookId} 首帧按固定比例预留画布`, () => {
    const { page, measurements } = od6Fixture(bookId, undefined, "0", {
      deferMeasurement: true,
    });
    try {
      const waitingStyle = byClass(render(page), "practice-book-viewport").props.style;
      assert.ok(waitingStyle, "OD6 测宽返回前也必须预留固定画布");
      assert.equal(waitingStyle.width, "100%");
      assert.equal(waitingStyle.aspectRatio, `${canonical.width} / ${canonical.height}`);
      const waitingImage = byClass(render(page), "practice-book-page__image");
      assert.equal(waitingImage.props.mode, "aspectFit");
      assert.equal(waitingImage.props.style?.height, "100%",
        "固定画布的 aspectFit 图片必须有确定高度，不能被手机竖屏的 height:auto 覆盖");
      assert.equal(byClass(render(page), "practice-book-page__hotspots"), undefined,
        "真实图面尺寸返回前不能绘制热点层");
      measurements.splice(0).forEach((deliver) => deliver());
      const measured = sizeOf(byClass(render(page), "practice-book-viewport"));
      assert.equal(measured.width, SLOT.width);
      assert.equal(measured.height, Math.round(SLOT.width * canonical.height / canonical.width));
    } finally {
      page.unload();
      page.dispose();
    }
  });

  test(`Oxford Discover 6 教材 ${bookId} 翻页时保持固定画布`, async () => {
    const { page } = od6Fixture(
      bookId,
      (src) => /_0\.jpg$/.test(src)
        ? { width: canonical.width - 70, height: canonical.height + 90 }
        : { width: canonical.width, height: canonical.height },
    );
    try {
      const before = sizeOf(byClass(render(page), "practice-book-viewport"));
      const after = sizeOf(byClass(await swipeForward(page), "practice-book-viewport"));
      assert.deepEqual(after, before, "相邻页原图比例不同时外层画布也不能跳动");
      assert.ok(hasClass(byClass(render(page), "practice-book-slide"), "practice-book-slide--stable-canvas"));
    } finally {
      page.unload();
      page.dispose();
    }
  });
}
