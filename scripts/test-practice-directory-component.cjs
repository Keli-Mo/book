/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const test = require("node:test");
const { createPage, byClass, elements, textOf, load } = require("./test-practice-book-route.cjs");
const { buildFullBookPracticeBundle } = load("src/features/listeningPractice/bookPractice.ts");
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
  let confirmSelection = false;
  const page = createPage(route.file, route.params, {
    showModal: async () => ({ confirm: confirmSelection }),
    taroOverrides: { nextTick(callback) { nextTicks.push(callback); } },
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
  test(`${route.name}：打开目录只展开当前章，并定位唯一的当前页锚点`, () => {
    const context = fixture(route);
    const { page, groups, currentGroup, currentIndex } = context;
    try {
      assert.equal(byClass(render(page), "practice-directory-mask"), undefined);
      const tree = context.open();
      assertExpandedGroup(tree, groups, currentGroup);
      const current = itemNode(tree, currentIndex);
      assert.ok(current);
      assert.equal(hasClass(current, "practice-directory-item--active"), true);
      const pageIds = items(tree).map((item) => item.props.id);
      assert.equal(new Set(pageIds).size, pageIds.length, "展开页的定位 ID 必须唯一");
      assert.equal(byClass(tree, "practice-directory-scroll").props.scrollIntoView, current.props.id,
        "打开目录直接定位当前页，不能只定位章标题");
      const expectedItem = currentGroup.items.find((item) => item.practiceIndex === currentIndex);
      assert.match(textOf(current), new RegExp(`第 ${expectedItem.pageNumber} 页`));
      assert.match(textOf(current), new RegExp(`${expectedItem.trackCount} 段音频`));
      assert.ok(currentGroup.items.some((item) => item.trackCount === 0));
      assert.match(textOf(groupNode(tree, currentGroup.id)), /自主跟读/);
    } finally { cleanup(page); }
  });

  test(`${route.name}：展开收起与定位当前页只操作目录，重开回到当前章`, async () => {
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
      assert.equal(byClass(context.flush(), "practice-directory-mask"), undefined);
      tree = context.open();
      assertExpandedGroup(tree, groups, currentGroup);
      assert.equal(byClass(tree, "practice-directory-scroll").props.scrollIntoView, currentAnchor,
        "关闭再打开不能停在用户上次浏览的其它章节");
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
      assert.equal(page.modalCalls.length, 1);
      assert.equal(page.modalCalls[0].title, "切换训练？");
      assert.equal(currentImage(page), originalImage);
      assert.ok(byClass(tree, "practice-directory-mask"), "取消放弃录音后目录保持打开");
      assertExpandedGroup(tree, groups, otherGroup);
      assert.deepEqual(page.recorderActions, recorderActions, "取消不能停止当前录音");
      assert.ok(byClass(tree, "record-button--pause"));

      context.setConfirmSelection(true);
      await itemNode(tree, targetIndex).props.onClick();
      await settle();
      tree = context.flush();
      assert.equal(page.modalCalls.length, 2);
      assert.equal(currentImage(page), target.imageUrl);
      assert.equal(byClass(tree, "practice-directory-mask"), undefined, "确认切页成功后目录关闭");
      assert.equal(page.recorderActions.filter(({ action }) => action === "stop").length,
        recorderActions.filter(({ action }) => action === "stop").length + 1, "只向录音协调器发出一次原有 stop");
      await page.recorderHandlers.Stop({ tempFilePath: "/tmp/directory-discard.mp3", duration: 1800, fileSize: 4096 });
      await settle();
      context.flush();
      assert.equal(page.savedRecordings.length, 0, "确认放弃的旧页录音不能存到新页");
      assert.ok(byClass(page.render(), "record-button"), "旧录音结束后新页仍可正常开始录音");
      tree = context.open();
      assertExpandedGroup(tree, groups, otherGroup);
      assert.equal(byClass(tree, "practice-directory-scroll").props.scrollIntoView, `practice-directory-page-${targetIndex}`,
        "切页后重新打开目录，按新当前页定位");
    } finally { cleanup(page); }
  });
}

test("快速切章或收起后，迟到的旧 nextTick 不能覆盖当前目录定位", () => {
  const context = fixture(routes[0]);
  const { page, groups, otherGroup } = context;
  const latestGroup = groups[groups.indexOf(otherGroup) + 1];
  assert.ok(latestGroup);
  try {
    let tree = context.open();
    byClass(groupNode(tree, otherGroup.id), "practice-directory-group__header").props.onClick();
    tree = render(page);
    const oldLocates = context.nextTicks.splice(0);
    assert.ok(oldLocates.length > 0, "先保留 A 章尚未返回的定位请求");

    byClass(groupNode(tree, latestGroup.id), "practice-directory-group__header").props.onClick();
    tree = context.flush();
    assertExpandedGroup(tree, groups, latestGroup);
    assert.equal(byClass(tree, "practice-directory-scroll").props.scrollIntoView, latestGroup.id);
    const latestState = page.stateValues();
    oldLocates.forEach((callback) => callback());
    assert.deepEqual(page.stateValues(), latestState, "A 章旧定位不能在 B 章已展开后继续写入状态");
    tree = render(page);
    assert.equal(byClass(tree, "practice-directory-scroll").props.scrollIntoView, latestGroup.id);

    byClass(groupNode(tree, otherGroup.id), "practice-directory-group__header").props.onClick();
    tree = render(page);
    const cancelledLocates = context.nextTicks.splice(0);
    assert.ok(cancelledLocates.length > 0);
    byClass(groupNode(tree, otherGroup.id), "practice-directory-group__header").props.onClick();
    tree = render(page);
    assertExpandedGroup(tree, groups, undefined);
    assert.equal(byClass(tree, "practice-directory-scroll").props.scrollIntoView, "");
    const collapsedState = page.stateValues();
    cancelledLocates.forEach((callback) => callback());
    assert.deepEqual(page.stateValues(), collapsedState, "收起后旧定位不能恢复已失效锚点");
    assert.equal(byClass(render(page), "practice-directory-scroll").props.scrollIntoView, "");
    assert.equal(context.nextTicks.length, 0);
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
    assert.equal(byClass(render(page), "practice-directory-mask"), undefined, "旧 DirectoryContents 已卸载");

    tree = context.open();
    byClass(groupNode(tree, otherGroup.id), "practice-directory-group__header").props.onClick();
    tree = context.flush();
    assertExpandedGroup(tree, groups, otherGroup);
    assert.equal(byClass(tree, "practice-directory-scroll").props.scrollIntoView, otherGroup.id);
    const reopenedState = page.stateValues();
    unmountedLocates.forEach((callback) => callback());
    assert.deepEqual(page.stateValues(), reopenedState, "已卸载目录的请求不能改写当前已挂载状态");
    tree = render(page);
    assertExpandedGroup(tree, groups, otherGroup);
    assert.equal(byClass(tree, "practice-directory-scroll").props.scrollIntoView, otherGroup.id);
    assert.equal(currentImage(page), originalImage);
    assert.equal(context.nextTicks.length, 0);
  } finally { cleanup(page); }
});
