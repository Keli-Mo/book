/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const test = require("node:test");
const { createPage, byClass, textOf } = require("./test-practice-book-route.cjs");

const routes = [
  { name: "普通教材", file: "src/pages/Practice/Practice.tsx", params: { bookId: "22", page: "9" } },
  { name: "Think 教材", file: "src/pages/ThinkBookReader/ThinkBookReader.tsx", params: { bookId: "28", page: "12" } },
];
const layout = {
  isPad: false, orientation: "portrait", windowWidth: 390, windowHeight: 844,
  isSplit: false, contentMaxWidth: null, statusBarHeight: 20, safeAreaBottom: 0,
};
const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const render = (page) => { page.render(); page.render(); return page.render(); };
const touch = (pageX) => ({ identifier: 1, clientX: pageX, clientY: 140, pageX, pageY: 140 });
const imageSrc = (tree) => byClass(byClass(tree, "practice-book-zoom-view"), "practice-book-page__image")?.props.src;

function fixture(route) {
  return createPage(route.file, route.params, {
    savedFilePath: "/saved/zoom-origin.mp3",
    showModal: async () => ({ confirm: false, cancel: true }),
    overrides: { "@/hooks/useDeviceLayout": { useDeviceLayout: () => layout } },
  });
}

async function edgeTurnNext(page) {
  let tree = render(page);
  const before = imageSrc(tree);
  let view = byClass(tree, "practice-book-zoom-view");
  const area = byClass(tree, "practice-book-zoom-area");
  assert.ok(before && area && view, "应在当前书页原位显示缩放图层");

  const width = parseFloat(area.props.style.width);
  const contentWidth = parseFloat(view.props.style.width);
  const rightEdgeX = width - contentWidth * 2;
  view.props.onScale({ detail: { scale: 2, x: rightEdgeX, y: 0 } });
  tree = render(page);
  view = byClass(tree, "practice-book-zoom-view");
  assert.equal(byClass(tree, "practice-book-swiper").props.disableTouch, true,
    "放大后由书页边缘手势负责翻页");
  view.props.onChange({ detail: { source: "touch", x: rightEdgeX, y: 0 } });
  view.props.onTouchStart({ touches: [touch(180)] });
  view.props.onTouchMove({ touches: [touch(116)] });
  assert.equal(imageSrc(render(page)), before, "边缘拖动时尚未翻页");
  view.props.onTouchEnd({ touches: [], changedTouches: [touch(116)] });
  await settle();
  tree = render(page);
  assert.notEqual(imageSrc(tree), before, "松手后从放大的 A 页翻到 B 页");
  assert.equal(byClass(tree, "practice-book-swiper").props.disableTouch, false,
    "B 页恢复原始倍率和普通翻页");
  return tree;
}

for (const route of routes) {
  test(`${route.name}：A 页保存录音后放大边缘翻到 B 页，保留收尾选择与退出提醒`, async t => {
    const page = fixture(route);
    t.after(() => page.dispose());
    let tree = render(page);
    const originLabel = textOf(byClass(tree, "practice-header__progress"));
    await byClass(tree, "record-button").props.onClick();
    page.recorderHandlers.Start();
    byClass(render(page), "record-button--stop").props.onClick();
    await page.recorderHandlers.Stop({ tempFilePath: "/tmp/zoom-origin.mp3", duration: 2400, fileSize: 5000 });
    await settle();
    tree = render(page);
    assert.ok(byClass(tree, "check-in-button"), "A 页录音已保存，仍未完成练习");
    assert.equal(page.savedRecordings.length, 1);
    const originId = page.savedRecordings[0].context.practiceId;

    tree = await edgeTurnNext(page);
    assert.notEqual(textOf(byClass(tree, "practice-header__progress")), originLabel);
    assert.ok(byClass(tree, "check-in-button"), "B 页仍可完成 A 页录音");
    assert.ok(byClass(tree, "practice-recorder__retry"), "B 页仍可选择回 A 页重录");
    assert.ok(byClass(tree, "practice-recorder__delete"), "B 页仍可删除 A 页录音");
    assert.match(textOf(tree), /请.*完成练习.*重新录制.*删除录音/);
    assert.equal(byClass(tree, "record-button"), undefined, "未处理 A 页录音前不能在 B 页另录");
    assert.equal(byClass(tree, "practice-pending-panel"), undefined, "不出现待完成录音列表");
    assert.equal(page.savedRecordings[0].context.practiceId, originId, "翻页不改录音归属");
    assert.deepEqual(page.completedPending, [], "翻页不自动完成练习");

    byClass(tree, "check-in-navigation__home").props.onClick();
    await settle();
    assert.equal(page.modalCalls.at(-1)?.title, "离开训练？");
    assert.equal(page.navigations.length, 0, "取消离开时保持在 B 页和录音面板");
    assert.ok(byClass(render(page), "check-in-button"));

    await byClass(render(page), "check-in-button").props.onClick();
    assert.deepEqual(page.completedPending, [{ requestId: "0123456789abcdef0123456789abcdef", committed: true }],
      "在 B 页完成的仍是 A 页保存的录音");
    assert.equal(page.savedRecordings[0].context.practiceId, originId);
  });
}
