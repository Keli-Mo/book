/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const test = require("node:test");
const { createPage, elements, textOf, byClass, load } = require("./test-practice-book-route.cjs");

const button = (tree, label) => elements(tree).find(node => node.type === "Button" && textOf(node) === label);
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const routes = [
  { name: "普通教材", file: "src/pages/Practice/Practice.tsx", params: { bookId: "22", page: "9" } },
  { name: "Think", file: "src/pages/ThinkBookReader/ThinkBookReader.tsx", params: { bookId: "28", page: "12" } },
];

async function fixture({ route = routes[0], orientation = "portrait", confirm = async () => ({ confirm: true }), remove = async () => true, ...options } = {}) {
  const removed = [], toasts = [];
  const layout = {
    isPad: false, isSplit: false, orientation,
    windowWidth: orientation === "portrait" ? 360 : 844,
    windowHeight: orientation === "portrait" ? 780 : 390,
    contentMaxWidth: null, statusBarHeight: 20, safeAreaBottom: 0,
  };
  const page = createPage(route.file, route.params, {
    savedFilePath: "/saved/delete-current.mp3",
    showModal: confirm,
    showToast: value => toasts.push(value),
    pendingRemove: async id => { removed.push(id); return remove(id); },
    overrides: { "@/hooks/useDeviceLayout": { useDeviceLayout: () => layout } },
    ...options,
  });
  page.render();
  let tree = page.render();
  assert.equal(button(tree, "删除录音"), undefined, "没有录音时不显示删除入口");
  await button(tree, "开始跟读录音").props.onClick();
  page.recorderHandlers.Start();
  tree = page.render();
  assert.equal(button(tree, "删除录音"), undefined, "正在录音时不显示删除入口");
  button(tree, "结束录音").props.onClick();
  await page.recorderHandlers.Stop({ tempFilePath: "/tmp/delete-current.mp3", duration: 2000, fileSize: 4096 });
  await settle();
  page.render();
  return { page, removed, toasts, click: () => button(page.render(), "删除录音").props.onClick() };
}

for (const route of routes) {
  for (const orientation of ["portrait", "landscape"]) {
    test(`${route.name} ${orientation}：确认删除当前录音后可重新开始录音`, async t => {
      const h = await fixture({ route, orientation });
      t.after(() => h.page.dispose());
      let tree = h.page.render();
      const actions = orientation === "portrait" ? byClass(tree, "practice-recorder__heading-actions") : byClass(tree, "practice-recorder");
      assert.ok(button(actions, "重新录制"));
      assert.ok(button(actions, "删除录音"), "删除入口应与重新录制在同一操作区域");
      button(tree, "回听录音").props.onClick();
      const audio = h.page.audios.at(-1);
      await h.click();
      assert.equal(h.page.modalCalls.at(-1).confirmText, "删除");
      assert.deepEqual(h.removed, ["0123456789abcdef0123456789abcdef"], "只删除当前录音的持久化记录");
      assert.ok(audio.events.includes("destroy"), "删除前先停止当前录音回听");
      tree = h.page.render();
      assert.ok(button(tree, "开始跟读录音"));
      assert.equal(button(tree, "重新录制"), undefined);
      assert.equal(button(tree, "删除录音"), undefined);
      assert.equal(textOf(byClass(tree, "practice-recorder__time")), "最长 5:00");
      assert.equal(h.page.completedPending.length, 0);
      assert.equal(h.page.submittedPending.length, 0);
      h.page.hide(); h.page.show(); await settle();
      assert.equal(button(h.page.render(), "删除录音"), undefined, "返回页面不能恢复已删除录音");
      await button(h.page.render(), "开始跟读录音").props.onClick();
      assert.equal(h.page.recorderActions.filter(item => item.action === "start").length, 2);
    });
  }
}

test("取消删除保留当前录音与回听", async t => {
  const h = await fixture({ confirm: async () => ({ confirm: false }) });
  t.after(() => h.page.dispose());
  button(h.page.render(), "回听录音").props.onClick();
  const audio = h.page.audios.at(-1);
  await h.click();
  assert.equal(h.removed.length, 0);
  assert.equal(audio.events.includes("destroy"), false);
  assert.ok(button(h.page.render(), "停止回听"));
  assert.equal(button(h.page.render(), "删除录音").props.disabled, false);
});

for (const outcome of ["false", "throw"]) {
  test(`删除${outcome === "false" ? "失败" : "异常"}时保留录音并允许重试`, async t => {
    let failed = true;
    const h = await fixture({ remove: async () => {
      if (!failed) return true;
      if (outcome === "throw") throw new Error("private file failure");
      return false;
    } });
    t.after(() => h.page.dispose());
    await assert.doesNotReject(h.click());
    assert.ok(button(h.page.render(), "回听录音"));
    assert.ok(button(h.page.render(), "重新录制"));
    assert.equal(button(h.page.render(), "开始跟读录音"), undefined);
    assert.equal(h.toasts.at(-1).title, "删除失败，请稍后重试");
    failed = false;
    await h.click();
    assert.ok(button(h.page.render(), "开始跟读录音"));
  });
}

test("删除期间重复点击、重录、完成、回听和翻页不能并发操作当前录音", async t => {
  const gate = deferred();
  const h = await fixture({ remove: () => gate.promise });
  t.after(() => h.page.dispose());
  const tree = h.page.render();
  const progress = textOf(byClass(tree, "practice-header__progress"));
  const deletion = h.click();
  await settle();
  await h.click();
  await button(tree, "重新录制").props.onClick();
  await button(tree, "完成练习").props.onClick();
  button(tree, "回听录音").props.onClick();
  await byClass(tree, "practice-navigation__button--primary").props.onClick();
  assert.equal(h.page.modalCalls.length, 1);
  assert.equal(h.removed.length, 1);
  assert.equal(h.page.recorderActions.filter(item => item.action === "start").length, 1);
  assert.equal(h.page.completedPending.length, 0);
  assert.equal(h.page.audios.length, 0);
  assert.equal(textOf(byClass(h.page.render(), "practice-header__progress")), progress);
  assert.equal(button(h.page.render(), "删除录音").props.disabled, true);
  gate.resolve(true);
  await deletion;
  assert.ok(button(h.page.render(), "开始跟读录音"));
});

for (const leave of ["hide", "dispose"]) {
  test(`确认框等待期间${leave}后不删除录音`, async t => {
    const gate = deferred();
    const h = await fixture({ confirm: () => gate.promise });
    t.after(() => h.page.dispose());
    const deletion = h.click();
    h.page[leave]();
    gate.resolve({ confirm: true });
    await deletion;
    assert.equal(h.removed.length, 0);
  });
}

test("完成练习正在持久化时不能删除同一条录音", async t => {
  const gate = deferred();
  const h = await fixture({ pendingComplete: () => gate.promise });
  t.after(() => h.page.dispose());
  const completion = button(h.page.render(), "完成练习").props.onClick();
  await h.click();
  assert.equal(h.removed.length, 0);
  assert.equal(h.page.modalCalls.length, 0);
  gate.resolve(true);
  await completion;
});

test("删除会使较早的重录权限请求失效", async t => {
  const gate = deferred();
  let permissionRequests = 0;
  const h = await fixture({ getSetting: () => ++permissionRequests === 1
    ? Promise.resolve({ authSetting: { "scope.record": true } })
    : gate.promise });
  t.after(() => h.page.dispose());
  const restart = button(h.page.render(), "重新录制").props.onClick();
  await settle();
  await h.click();
  gate.resolve({ authSetting: { "scope.record": true } });
  await restart;
  assert.equal(h.page.recorderActions.filter(item => item.action === "start").length, 1);
  assert.ok(button(h.page.render(), "开始跟读录音"));
});

for (const persisted of [true, false]) {
  test(`删除${persisted ? "已保存" : "临时"}重录后不自动带回旧备份`, async t => {
    const { buildFullBookPracticeBundle } = load("src/features/listeningPractice/bookPractice.ts");
    const bundle = buildFullBookPracticeBundle("22");
    const practiceIndex = bundle.practices.findIndex(item => item.imageIndex === 9);
    const practice = bundle.practices[practiceIndex];
    const old = {
      requestId: "a".repeat(32), localPath: "/saved/old-backup.mp3", recoverable: true,
      context: { bookId: "22", bookTitle: bundle.book.title, practiceId: practice.id, practiceIndex,
        pageNumber: practice.pageNumber, imageUrl: practice.imageUrl, sectionTitle: practice.sectionTitle },
      durationMs: 1000, fileSizeBytes: 4096, status: "local", updatedAtMs: 0,
    };
    const removed = [];
    const page = createPage(routes[0].file, routes[0].params, {
      pendingItems: [old], savedFilePath: persisted ? "/saved/new-recording.mp3" : undefined,
      showModal: async () => ({ confirm: true }),
      pendingRemove: async id => { removed.push(id); return id !== old.requestId; },
    });
    t.after(() => page.dispose());
    page.render(); page.render(); await settle();
    await button(page.render(), "重新录制").props.onClick();
    page.recorderHandlers.Start();
    button(page.render(), "结束录音").props.onClick();
    await page.recorderHandlers.Stop({ tempFilePath: "/tmp/new-recording.mp3", duration: 2000, fileSize: 4096 });
    await settle();
    removed.length = 0;
    await button(page.render(), "删除录音").props.onClick();
    page.render(); await settle();
    assert.ok(button(page.render(), "开始跟读录音"), "删除后保持可开始录音，不恢复旧备份");
    page.hide(); page.show(); page.render(); await settle();
    assert.ok(button(page.render(), "开始跟读录音"), "返回当前页面也不能自动带回旧备份");
    assert.deepEqual(removed, ["0123456789abcdef0123456789abcdef"], "删除当前录音不能顺带删除旧备份");
    await byClass(page.render(), "practice-navigation__button--primary").props.onClick();
    page.render(); await settle();
    await byClass(page.render(), "practice-navigation__button").props.onClick();
    page.render(); await settle();
    button(page.render(), "回听录音").props.onClick();
    assert.equal(page.audios.at(-1).src, old.localPath, "重新进入教材页时仍按原逻辑恢复保留的备份");
  });
}
