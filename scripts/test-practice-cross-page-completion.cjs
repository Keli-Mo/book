/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const test = require("node:test");
const { createPage, textOf, byClass, buildBookPracticeBundle, load } = require("./test-practice-book-route.cjs");

const { buildFullBookPracticeBundle } = load("src/features/listeningPractice/bookPractice.ts");
const practices = buildFullBookPracticeBundle("22").practices;
const firstIndex = buildBookPracticeBundle("22").practices[0].imageIndex;
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const makePending = (practiceIndex, id, overrides = {}) => {
  const practice = practices[practiceIndex];
  return {
    requestId: id.repeat(32), localPath: `/saved/${id}.mp3`, recoverable: true,
    context: {
      bookId: "22", bookTitle: "测试教材", practiceId: practice.id, practiceIndex,
      pageNumber: practice.pageNumber, sectionTitle: practice.sectionTitle, imageUrl: practice.imageUrl,
    },
    durationMs: 2400, fileSizeBytes: 5000, cloudFileId: "", status: "local", updatedAtMs: 1,
    ...overrides,
  };
};
const assertNoPendingList = (tree) => {
  assert.equal(byClass(tree, "practice-navigation__button--pending"), undefined);
  assert.equal(byClass(tree, "practice-pending-panel"), undefined);
  assert.doesNotMatch(textOf(tree), /待完成录音/);
};

test("A 页已保存但未完成练习时，翻到 B 页继续显示同一录音和三项选择", async t => {
  const a = makePending(firstIndex, "a");
  const foreign = { ...makePending(firstIndex, "c"), context: { ...a.context, bookId: "another-book" } };
  const completed = makePending(firstIndex + 2, "d", { completedAtMs: 9 });
  const page = createPage("src/pages/Practice/Practice.tsx", { bookId: "22", practice: "0" }, {
    pendingItems: [a, foreign, completed],
  });
  t.after(() => page.dispose());
  page.render(); page.render(); await settle();
  let tree = page.render();
  assert.ok(byClass(tree, "check-in-button"), "A 页显示已保存的录音");
  assertNoPendingList(tree);

  await byClass(tree, "practice-navigation__button--primary").props.onClick();
  page.render(); await settle();
  tree = page.render();
  assert.equal(
    textOf(byClass(tree, "practice-header__progress")),
    practices[firstIndex + 1].pageLabel || `第 ${practices[firstIndex + 1].pageNumber} 页`,
  );
  assert.ok(byClass(tree, "check-in-button"), "B 页仍能完成 A 页尚未完成的录音");
  assert.ok(byClass(tree, "practice-recorder__retry"), "B 页保留重新录制选择");
  assert.ok(byClass(tree, "practice-recorder__delete"), "B 页保留删除录音选择");
  assert.match(textOf(tree), /请.*完成练习.*重新录制.*删除录音/, "B 页应引导用户处理本次录音");
  assert.equal(byClass(tree, "record-button"), undefined, "做出选择前不得在 B 页开新录音");
  assertNoPendingList(tree);
  assert.deepEqual(page.completedPending, [], "翻页不会自动完成练习");
});

test("A 页录音在 B 页结束后保留面板，B 页完成练习只完成 A 的文件", async t => {
  const page = createPage("src/pages/Practice/Practice.tsx", { bookId: "22", practice: "0" }, {
    savedFilePath: "/saved/from-a.mp3",
  });
  t.after(() => page.dispose());
  page.render();
  let tree = page.render();
  await byClass(tree, "record-button").props.onClick();
  page.recorderHandlers.Start();
  await byClass(page.render(), "practice-navigation__button--primary").props.onClick();
  tree = page.render();
  byClass(tree, "record-button--stop").props.onClick();
  await page.recorderHandlers.Stop({ tempFilePath: "/tmp/from-a.mp3", duration: 2400, fileSize: 5000 });
  await settle();

  tree = page.render();
  assert.equal(page.savedRecordings[0]?.context.practiceIndex, firstIndex);
  assert.equal(page.savedRecordings[0]?.tempFilePath, "/tmp/from-a.mp3");
  assert.ok(byClass(tree, "check-in-button"), "B 页保留 A 的完成练习入口");
  assert.ok(byClass(tree, "practice-recorder__retry"), "B 页保留重录入口");
  assert.ok(byClass(tree, "practice-recorder__delete"), "B 页保留删除入口");
  assertNoPendingList(tree);
  assert.deepEqual(page.completedPending, [], "只保存文件，不自动完成练习");
  await byClass(tree, "check-in-button").props.onClick();
  assert.deepEqual(page.completedPending, [{ requestId: "0123456789abcdef0123456789abcdef", committed: true }]);
  assert.match(page.navigations.at(-1), /CheckInDetail.*localId=0123456789abcdef0123456789abcdef/);
});

test("退出小程序后有停止文件则持久保存，回到 B 页仍可处理未完成录音", async t => {
  let appHideHandler;
  const page = createPage("src/pages/Practice/Practice.tsx", { bookId: "22", practice: "0" }, {
    savedFilePath: "/saved/exit-a.mp3",
    taroOverrides: {
      onAppHide(handler) { appHideHandler = handler; },
      offAppHide(handler) { if (appHideHandler === handler) appHideHandler = undefined; },
    },
  });
  t.after(() => page.dispose());
  page.render();
  await byClass(page.render(), "record-button").props.onClick();
  page.recorderHandlers.Start();
  assert.equal(typeof appHideHandler, "function");
  appHideHandler();
  page.hide();
  assert.equal(page.recorderActions.filter(({ action }) => action === "stop").length, 1);
  await page.recorderHandlers.Stop({ tempFilePath: "/tmp/exit-a.mp3", duration: 2100, fileSize: 5000 });
  await settle();
  assert.equal(page.savedRecordings[0]?.context.practiceIndex, firstIndex);
  assert.equal(page.savedRecordings[0]?.tempFilePath, "/tmp/exit-a.mp3");
  assert.deepEqual(page.completedPending, [], "退出时只保存文件，不自动完成练习");

  page.show();
  let tree = page.render();
  assert.ok(byClass(tree, "check-in-button"), "A 页可恢复已持久保存的本地录音");
  assertNoPendingList(tree);
  await byClass(tree, "practice-navigation__button--primary").props.onClick();
  tree = page.render();
  assert.ok(byClass(tree, "check-in-button"), "B 页仍显示 A 页未完成的录音");
  assert.ok(byClass(tree, "practice-recorder__delete"));
  assertNoPendingList(tree);
});

test("B 页选择重新录制时返回 A 页并从 A 页开始新的录音", async t => {
  const a = makePending(firstIndex, "a");
  const removed = [];
  const page = createPage("src/pages/Practice/Practice.tsx", { bookId: "22", practice: "0" }, {
    pendingItems: [a],
    pendingRemove: (requestId) => { removed.push(requestId); return true; },
  });
  t.after(() => page.dispose());
  page.render(); page.render(); await settle();
  await byClass(page.render(), "practice-navigation__button--primary").props.onClick();
  const onB = page.render();
  assert.ok(byClass(onB, "practice-recorder__retry"), "B 页须保留 A 录音的重录入口");

  await byClass(onB, "practice-recorder__retry").props.onClick();
  await settle();
  const onA = page.render();
  assert.equal(textOf(byClass(onA, "practice-header__progress")), practices[firstIndex].pageLabel || `第 ${a.context.pageNumber} 页`);
  assert.equal(page.recordingSessionJournal.read()?.context.practiceIndex, firstIndex, "重录会话必须归属 A 页");
  assert.equal(page.recorderActions.at(-1)?.action, "start", "返回 A 页后应直接开始重录");
  assert.deepEqual(removed, [], "新录音安全保存前不能删除旧文件");
});

test("B 页选择删除录音时只删除 A 的未完成录音并开放 B 页录音", async t => {
  const a = makePending(firstIndex, "a");
  const removed = [];
  const page = createPage("src/pages/Practice/Practice.tsx", { bookId: "22", practice: "0" }, {
    pendingItems: [a],
    pendingRemove: (requestId) => { removed.push(requestId); return true; },
  });
  t.after(() => page.dispose());
  page.render(); page.render(); await settle();
  await byClass(page.render(), "practice-navigation__button--primary").props.onClick();
  const onB = page.render();
  assert.ok(byClass(onB, "practice-recorder__delete"), "B 页须保留 A 录音的删除入口");

  await byClass(onB, "practice-recorder__delete").props.onClick();
  await settle();
  const afterDelete = page.render();
  assert.deepEqual(removed, [a.requestId]);
  assert.equal(byClass(afterDelete, "check-in-button"), undefined);
  assert.ok(byClass(afterDelete, "record-button"), "处理完 A 录音后 B 页可正常录音");
  const modalCount = page.modalCalls.length;
  byClass(afterDelete, "check-in-navigation__home").props.onClick();
  await settle();
  assert.equal(page.modalCalls.length, modalCount, "明确删除后退出不应再提示处理旧录音");
});

for (const [label, navigationClass] of [
  ["返回", "check-in-navigation__back"],
  ["首页", "check-in-navigation__home"],
]) {
  test(`B 页仍有 A 录音时点${label}提示离开训练，确认离开保留已保存文件`, async t => {
    const a = makePending(firstIndex, "a");
    const removed = [];
    let confirm = false;
    const page = createPage("src/pages/Practice/Practice.tsx", { bookId: "22", practice: "0" }, {
      pendingItems: [a],
      pendingRemove: (requestId) => { removed.push(requestId); return true; },
      showModal: async () => ({ confirm }),
    });
    t.after(() => page.dispose());
    page.render(); page.render(); await settle();
    await byClass(page.render(), "practice-navigation__button--primary").props.onClick();
    const onB = page.render();
    assert.ok(byClass(onB, "check-in-button"), "离开前须保留未完成录音操作区");

    byClass(onB, navigationClass).props.onClick();
    await settle();
    assert.equal(page.modalCalls.at(-1)?.title, "离开训练？");
    assert.equal(page.navigations.length, 0, "取消离开时留在训练页");
    assert.deepEqual(removed, []);

    confirm = true;
    byClass(page.render(), navigationClass).props.onClick();
    await settle();
    assert.equal(page.modalCalls.at(-1)?.title, "离开训练？");
    assert.equal(page.navigationMethods.at(-1), "reLaunch", "确认后执行离开导航");
    assert.deepEqual(removed, [], "离开训练不得把已安全保存的录音当作放弃录音删除");
  });
}

test("B 页已有自己的草稿时优先处理从 A 带来的录音，处理完再恢复 B 草稿", async t => {
  const a = makePending(firstIndex, "a", { durationMs: 2400 });
  const b = makePending(firstIndex + 1, "b", { durationMs: 9000 });
  const page = createPage("src/pages/Practice/Practice.tsx", { bookId: "22", practice: "0" }, {
    pendingItems: [a, b],
  });
  t.after(() => page.dispose());
  page.render(); page.render(); await settle();
  await byClass(page.render(), "practice-navigation__button--primary").props.onClick();
  let tree = page.render();
  assert.equal(textOf(byClass(tree, "practice-recorder__time")), "0:02", "B 页先展示从 A 带来的待完成录音");
  await byClass(tree, "check-in-button").props.onClick();
  assert.deepEqual(page.completedPending[0], { requestId: a.requestId, committed: true }, "B 页首次完成的必须是 A 录音");

  page.hide(); page.show(); page.render(); await settle();
  tree = page.render();
  assert.equal(textOf(byClass(tree, "practice-recorder__time")), "0:09", "A 已完成后 B 自己的录音应恢复显示");
  assert.ok(byClass(tree, "check-in-button"));
  assertNoPendingList(tree);
});

test("退出后本地文件未能持久保存则放弃临时录音并解除锁", async t => {
  const removed = [];
  const page = createPage("src/pages/Practice/Practice.tsx", { bookId: "22", practice: "0" }, {
    pendingRemove: (requestId) => { removed.push(requestId); return true; },
  });
  t.after(() => page.dispose());
  page.render();
  await byClass(page.render(), "record-button").props.onClick();
  page.recorderHandlers.Start();
  page.hide();
  await page.recorderHandlers.Stop({ tempFilePath: "/tmp/unsaved-a.mp3", duration: 2100, fileSize: 5000 });
  await settle();
  assert.equal(page.savedRecordings.length, 1, "应先尝试保存停止文件");
  assert.deepEqual(removed, ["0123456789abcdef0123456789abcdef"], "未持久保存的临时项应及时删除");
  assert.equal(page.recordingSessionJournal.read(), null, "放弃旧录音后应解除持久录音锁");

  page.show();
  let tree = page.render();
  assert.equal(byClass(tree, "check-in-button"), undefined, "失败的临时录音不再挂在 A 页");
  assert.ok(byClass(tree, "record-button"), "A 页恢复可录音");
  assertNoPendingList(tree);
  await byClass(tree, "practice-navigation__button--primary").props.onClick();
  tree = page.render();
  assert.ok(byClass(tree, "record-button"), "B 页也能录音");
});

test("原页的录音在后台被完成后返回，不再恢复旧录音", async t => {
  const a = makePending(firstIndex, "5");
  const page = createPage("src/pages/Practice/Practice.tsx", { bookId: "22", page: String(firstIndex) }, {
    pendingItems: [a],
  });
  t.after(() => page.dispose());
  page.render(); page.render(); await settle();
  assert.ok(byClass(page.render(), "check-in-button"));
  page.hide();
  a.completedAtMs = 12;
  page.show();
  const tree = page.render();
  assert.equal(byClass(tree, "check-in-button"), undefined);
  assert.ok(byClass(tree, "record-button"), "完成后的原页面可重新录音");
  assertNoPendingList(tree);
});
