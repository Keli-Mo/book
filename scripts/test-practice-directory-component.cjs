/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const test = require("node:test");
const { createPage, byClass, elements, textOf, load } = require("./test-practice-book-route.cjs");
const { buildFullBookPracticeBundle } = load("src/features/listeningPractice/bookPractice.ts");
const { readBookImageSize } = load("src/features/listeningPractice/bookImageSizes.ts");
const { buildPracticeDirectoryGroups } = load("src/features/listeningPractice/practiceDirectory.ts");

const routes = [
  { name: "普通教材 Unit 2", file: "src/pages/Practice/Practice.tsx", params: { bookId: "22", page: "23" } },
  { name: "Think Unit 2", file: "src/pages/ThinkBookReader/ThinkBookReader.tsx", params: { bookId: "28", page: "20" } },
];
const render = (page) => { page.render(); page.render(); return page.render(); };
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const hasClass = (node, name) => node.props?.className?.split(/\s+/).includes(name);
const items = (tree) => elements(tree).filter((node) => hasClass(node, "practice-directory-item"));
const groupNode = (tree, groupId) => elements(tree).find((node) =>
  hasClass(node, "practice-directory-group") && node.props.id === groupId);
const itemNode = (tree, practiceIndex) => items(tree).find((node) => node.props.id === `practice-directory-page-${practiceIndex}`);
const currentImage = (page) => byClass(render(page), "practice-book-page__image").props.src;
const cleanup = (page) => { page.unload(); page.dispose(); };

function fixture(route) {
  const bundle = buildFullBookPracticeBundle(route.params.bookId);
  const currentIndex = bundle.practices.findIndex((practice) => practice.imageIndex === Number(route.params.page));
  const groups = buildPracticeDirectoryGroups(bundle.practices);
  const groupIndex = groups.findIndex((group) => group.items.some((item) => item.practiceIndex === currentIndex));
  assert.ok(groupIndex > 0, "测试必须从非第一章进入，避免首章掩盖定位错误");
  const nextTicks = [];
  const practicesByImageUrl = new Map(bundle.practices.map((practice) => [practice.imageUrl, practice]));
  let confirmSelection = false;
  const page = createPage(route.file, route.params, {
    showModal: async () => ({ confirm: confirmSelection }),
    taroOverrides: {
      nextTick(callback) { nextTicks.push(callback); },
      getImageInfo({ src, success }) {
        const imageIndex = practicesByImageUrl.get(src)?.imageIndex;
        const size = readBookImageSize(route.params.bookId, imageIndex);
        if (size) success(size);
      },
      createSelectorQuery() {
        let callback;
        const query = {
          select() { return query; },
          boundingClientRect(next) { callback = next; return query; },
          exec() { callback?.({ width: 374, height: 560 }); return query; },
        };
        return query;
      },
    },
  });
  const flush = () => {
    let tree = render(page);
    for (let count = 0; nextTicks.length > 0; count++) {
      assert.ok(count < 10, "目录定位不应产生 nextTick 循环");
      nextTicks.splice(0).forEach((callback) => callback());
      tree = render(page);
    }
    return tree;
  };
  flush();
  return {
    page, bundle, groups, currentIndex, currentGroup: groups[groupIndex], otherGroup: groups[groupIndex + 1],
    nextTicks, flush,
    setConfirmSelection(value) { confirmSelection = value; },
    open() {
      byClass(page.render(), "practice-header__directory").props.onClick();
      return flush();
    },
  };
}

function assertExpandedGroup(tree, groups, expectedGroup) {
  const renderedGroups = elements(tree).filter((node) => hasClass(node, "practice-directory-group"));
  assert.equal(renderedGroups.length, groups.length, "折叠后仍保留所有章节入口");
  for (const group of groups) {
    const node = groupNode(tree, group.id);
    assert.ok(byClass(node, "practice-directory-group__header"), "章节标题必须是独立折叠入口");
    assert.deepEqual(items(node).map((item) => item.props.id),
      group.id === expectedGroup?.id ? group.items.map((item) => `practice-directory-page-${item.practiceIndex}`) : [],
      `仅目标章节展开：${group.title}`);
  }
}

for (const route of routes) {
  test(`${route.name}：打开目录展开当前章，但不滚动到选中页`, () => {
    const context = fixture(route);
    const { page, groups, currentGroup, currentIndex } = context;
    try {
      assert.match(byClass(render(page), "practice-directory-mask").props.className, /practice-directory-mask--hidden/);
      const tree = context.open();
      assertExpandedGroup(tree, groups, currentGroup);
      const current = itemNode(tree, currentIndex);
      assert.ok(current);
      assert.equal(hasClass(current, "practice-directory-item--active"), true);
      assert.equal(byClass(tree, "practice-directory-scroll").props.scrollIntoView, "");
      assert.match(textOf(groupNode(tree, currentGroup.id)), /当前章节/);
    } finally { cleanup(page); }
  });

  test(`${route.name}：展开收起与定位当前页只操作目录，重开停在顶部`, async () => {
    const context = fixture(route);
    const { page, groups, currentGroup, otherGroup, currentIndex } = context;
    try {
      await byClass(page.render(), "record-button").props.onClick();
      page.recorderHandlers.Start();
      byClass(render(page), "audio-hotspot").props.onClick();
      const playingAudio = page.audios.at(-1);
      assert.ok(playingAudio.events.includes("play"));
      const originalImage = currentImage(page);
      const recorderActions = [...page.recorderActions];
      const audioEvents = [...playingAudio.events];

      let tree = context.open();
      byClass(groupNode(tree, otherGroup.id), "practice-directory-group__header").props.onClick();
      tree = context.flush();
      assertExpandedGroup(tree, groups, otherGroup);
      assert.equal(currentImage(page), originalImage, "点击章节标题不能跳练习");
      assert.deepEqual(page.recorderActions, recorderActions, "展开章节不能停止或重启录音");
      assert.deepEqual(playingAudio.events, audioEvents, "展开章节不能停止示范音频");
      assert.equal(page.modalCalls.length, 0, "浏览目录不能触发放弃录音确认");

      byClass(groupNode(tree, otherGroup.id), "practice-directory-group__header").props.onClick();
      tree = context.flush();
      assertExpandedGroup(tree, groups, undefined);
      assert.equal(items(tree).length, 0, "再次点击展开章后收起全部页项");

      byClass(tree, "practice-directory-locate").props.onClick();
      tree = context.flush();
      assertExpandedGroup(tree, groups, currentGroup);
      const currentAnchor = `practice-directory-page-${currentIndex}`;
      assert.equal(byClass(tree, "practice-directory-scroll").props.scrollIntoView, currentAnchor);

      // 用户手动滚离当前页后重复定位，必须先清空再下个 tick 设回同一锚点。
      byClass(tree, "practice-directory-locate").props.onClick();
      tree = render(page);
      assert.notEqual(byClass(tree, "practice-directory-scroll").props.scrollIntoView, currentAnchor,
        "重复定位需复位旧锚点，否则原生 ScrollView 不会再次滚动");
      assert.ok(context.nextTicks.length > 0);
      tree = context.flush();
      assert.equal(byClass(tree, "practice-directory-scroll").props.scrollIntoView, currentAnchor);

      byClass(groupNode(tree, otherGroup.id), "practice-directory-group__header").props.onClick();
      tree = context.flush();
      assertExpandedGroup(tree, groups, otherGroup);
      byClass(tree, "practice-directory-close").props.onClick();
      assert.match(byClass(context.flush(), "practice-directory-mask").props.className, /practice-directory-mask--hidden/);
      tree = context.open();
      assertExpandedGroup(tree, groups, otherGroup);
      assert.equal(byClass(tree, "practice-directory-scroll").props.scrollIntoView, "",
        "关闭再打开保留刚才浏览的章节，但不滚到当前选中页");
      assert.equal(currentImage(page), originalImage);
      assert.deepEqual(page.recorderActions, recorderActions);
      assert.deepEqual(playingAudio.events, audioEvents);
      assert.ok(byClass(tree, "record-button--pause"), "浏览目录后继续处于录音中");
    } finally { cleanup(page); }
  });

  test(`${route.name}：录音中选其它章页面，取消保留目录，确认沿原切页流程停止并丢弃旧录音`, async () => {
    const context = fixture(route);
    const { page, bundle, groups, currentGroup, otherGroup } = context;
    try {
      await byClass(page.render(), "record-button").props.onClick();
      page.recorderHandlers.Start();
      const originalImage = currentImage(page);
      const recorderActions = [...page.recorderActions];
      const targetIndex = otherGroup.items[0].practiceIndex;
      const target = bundle.practices[targetIndex];
      assert.notEqual(otherGroup.id, currentGroup.id);
      let tree = context.open();
      byClass(groupNode(tree, otherGroup.id), "practice-directory-group__header").props.onClick();
      tree = context.flush();
      const targetItem = itemNode(tree, targetIndex);
      assert.ok(targetItem);
      await targetItem.props.onClick();
      await settle();
      tree = context.flush();
      assert.equal(page.modalCalls.length, 0, "目录翻页不提示放弃录音");
      assert.equal(currentImage(page), target.imageUrl);
      assert.match(byClass(tree, "practice-directory-mask").props.className, /practice-directory-mask--hidden/, "翻页后目录隐藏");
      assert.deepEqual(page.recorderActions, recorderActions, "跨页录音不能停止当前录音");
      assert.ok(byClass(tree, "record-button--pause"));
      tree = context.open();
      assertExpandedGroup(tree, groups, otherGroup);
      assert.equal(byClass(tree, "practice-directory-scroll").props.scrollIntoView, "",
        "选中新页后重新打开，展开新章节，但不滚到该页");
    } finally { cleanup(page); }
  });
}

test("关闭再打开还原关闭前的目录滚动位置", () => {
  const context = fixture(routes[0]);
  const { page } = context;
  try {
    let tree = context.open();
    byClass(tree, "practice-directory-scroll").props.onScroll({ detail: { scrollTop: 480 } });
    byClass(tree, "practice-directory-close").props.onClick();
    tree = context.flush();
    assert.equal(byClass(tree, "practice-directory-scroll").props.scrollTop, undefined);
    tree = context.open();
    assert.equal(byClass(tree, "practice-directory-scroll").props.scrollTop, 480,
      "再次打开应回到关闭前看到的页，而不是目录顶部");
  } finally { cleanup(page); }
});

test("展开章节不滚动，只有定位当前页才滚到当前页", () => {
  const context = fixture(routes[0]);
  const { page, groups, currentGroup, otherGroup, currentIndex } = context;
  try {
    let tree = context.open();
    assert.equal(byClass(tree, "practice-directory-scroll").props.scrollIntoView, "");
    byClass(groupNode(tree, otherGroup.id), "practice-directory-group__header").props.onClick();
    tree = context.flush();
    assertExpandedGroup(tree, groups, otherGroup);
    assert.equal(byClass(tree, "practice-directory-scroll").props.scrollIntoView, "",
      "手动展开其它章节不能滚动目录");
    assert.equal(context.nextTicks.length, 0);

    byClass(tree, "practice-directory-locate").props.onClick();
    tree = context.flush();
    assertExpandedGroup(tree, groups, currentGroup);
    assert.equal(
      byClass(tree, "practice-directory-scroll").props.scrollIntoView,
      `practice-directory-page-${currentIndex}`,
      "只有定位当前页才滚动到当前页",
    );
  } finally { cleanup(page); }
});

test("关闭重开后才返回的旧目录定位回调，不影响新目录实例", () => {
  const context = fixture(routes[1]);
  const { page, groups, otherGroup } = context;
  try {
    let tree = context.open();
    const originalImage = currentImage(page);
    byClass(tree, "practice-directory-locate").props.onClick();
    tree = render(page);
    const unmountedLocates = context.nextTicks.splice(0);
    assert.ok(unmountedLocates.length > 0);
    byClass(tree, "practice-directory-close").props.onClick();
    assert.match(byClass(render(page), "practice-directory-mask").props.className, /practice-directory-mask--hidden/, "关闭后目录仍挂着，只是隐藏");

    tree = context.open();
    byClass(groupNode(tree, otherGroup.id), "practice-directory-group__header").props.onClick();
    tree = context.flush();
    assertExpandedGroup(tree, groups, otherGroup);
    assert.equal(byClass(tree, "practice-directory-scroll").props.scrollIntoView, "");
    const reopenedState = page.stateValues();
    unmountedLocates.forEach((callback) => callback());
    assert.deepEqual(page.stateValues(), reopenedState, "已卸载目录的请求不能改写当前已挂载状态");
    tree = render(page);
    assertExpandedGroup(tree, groups, otherGroup);
    assert.equal(byClass(tree, "practice-directory-scroll").props.scrollIntoView, "");
    assert.equal(currentImage(page), originalImage);
    assert.equal(context.nextTicks.length, 0);
  } finally { cleanup(page); }
});
