/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const test = require("node:test");
const { createPage, createFakeTimers, byClass, textOf } = require("./test-practice-book-route.cjs");

test("旧录音收尾超时后自动放弃并恢复录音入口", async t => {
  const timers = createFakeTimers();
  let phase = "draining";
  let abandonCalls = 0;
  const owner = {
    start: () => ({ ok: true }), pause: () => ({ ok: true }),
    resume: () => ({ ok: true }), stop: () => ({ ok: true }),
    release: () => ({ ok: true, phase: "idle" }),
    subscribe: () => ({ ok: true, unsubscribe() {} }),
  };
  const coordinator = {
    acquire: () => phase === "idle"
      ? { ok: true, owner, capabilities: { canRecord: true, canPause: true, canResume: true, canInterrupt: true } }
      : { ok: false, reason: "busy", phase },
    getPhase: () => phase,
    getEntryRecoveryStatus: () => "none",
    abandonUnconfirmedRecording: () => { abandonCalls += 1; phase = "idle"; return true; },
  };
  const page = createPage("src/pages/Practice/Practice.tsx", { bookId: "22", practice: "0" }, {
    recorderCoordinator: coordinator, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  t.after(() => page.dispose());
  page.render();
  let tree = page.render();
  assert.match(textOf(tree), /正在自动恢复录音设备/);
  assert.equal(byClass(tree, "record-button--check-recovery"), undefined, "自动处理无需用户点击入口");
  assert.doesNotMatch(textOf(tree), /待完成录音/, "退出后的录音不应出现待完成列表");
  timers.advance(1499);
  assert.equal(abandonCalls, 0);
  timers.advance(1);
  await Promise.resolve();
  assert.equal(abandonCalls, 1, "短时等待后仅自动放弃一次");
  tree = page.render();
  tree = page.render();
  assert.ok(byClass(tree, "record-button"), "自动恢复可录音按钮");
  assert.match(textOf(byClass(tree, "record-button")), /开始跟读录音/);
});

test("隐藏页面不让前台自动放弃逻辑误处理其他页面录音", t => {
  const timers = createFakeTimers();
  let abandonCalls = 0;
  const page = createPage("src/pages/Practice/Practice.tsx", { bookId: "22", practice: "0" }, {
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    recorderCoordinator: {
      acquire: () => ({ ok: false, reason: "busy", phase: "draining" }),
      getPhase: () => "draining", getEntryRecoveryStatus: () => "none",
      abandonUnconfirmedRecording: () => { abandonCalls += 1; return true; },
    },
  });
  t.after(() => page.dispose());
  page.render(); page.render();
  page.hide();
  timers.advance(5000);
  assert.equal(abandonCalls, 0);
});

test("微信底层仍占用录音器时提示解决办法，且不要求手动放弃旧录音", async t => {
  const timers = createFakeTimers();
  const page = createPage("src/pages/Practice/Practice.tsx", { bookId: "22", practice: "0" }, {
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    recorderActionOutcomes: { start: ["throw-busy", "throw-busy"] },
  });
  t.after(() => page.dispose());
  page.render();
  await byClass(page.render(), "record-button").props.onClick();
  let tree = page.render();
  assert.match(page.modalCalls.at(-1).content, /结束.*通话|结束.*录音/);
  assert.match(page.modalCalls.at(-1).content, /重新打开微信/);
  assert.doesNotMatch(page.modalCalls.at(-1).content, /operateRecorder:/);
  assert.equal(byClass(tree, "record-button--check-recovery"), undefined);
  timers.advance(1500);
  await Promise.resolve();
  tree = page.render();
  tree = page.render();
  assert.equal(page.recordingSessionJournal.read(), null, "自动放弃未成功启动的旧录音会话");
  assert.match(textOf(tree), /结束.*通话|结束.*录音/);
  timers.advance(1000);
  tree = page.render();
  tree = page.render();
  await byClass(tree, "record-button").props.onClick();
  assert.match(page.modalCalls.at(-1).content, /结束.*通话|结束.*录音/, "底层仍占用时再次尝试也应说明解决方法");
});

test("自动放弃连续失败后显示解决办法，锁住的按钮可说明原因", async t => {
  const timers = createFakeTimers();
  let phase = "idle";
  let abandonCalls = 0;
  const owner = {
    start: () => ({ ok: true }), pause: () => ({ ok: true }),
    resume: () => ({ ok: true }), stop: () => ({ ok: true }),
    release: () => ({ ok: true, phase: "idle" }),
    subscribe: () => ({ ok: true, unsubscribe() {} }),
  };
  const coordinator = {
    acquire: () => ({
      ok: true, owner,
      capabilities: { canRecord: true, canPause: true, canResume: true, canInterrupt: true },
    }),
    getPhase: () => phase,
    getEntryRecoveryStatus: () => "none",
    abandonUnconfirmedRecording: () => { abandonCalls += 1; return false; },
  };
  const page = createPage("src/pages/Practice/Practice.tsx", { bookId: "22", practice: "0" }, {
    recorderCoordinator: coordinator, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  t.after(() => page.dispose());
  page.render();
  assert.match(textOf(byClass(page.render(), "record-button")), /开始跟读录音/);
  phase = "uncertain";
  let tree = page.render();
  assert.equal(byClass(tree, "record-button").props["aria-disabled"], true);
  timers.advance(1500);
  await Promise.resolve();
  assert.equal(abandonCalls, 1);
  page.render();
  timers.advance(1500);
  await Promise.resolve();
  tree = page.render();
  assert.equal(abandonCalls, 2, "最多自动尝试两次，不应无限重试");
  assert.match(textOf(tree), /录音设备暂未恢复/);
  assert.match(textOf(tree), /关闭并重新打开微信/);
  assert.equal(byClass(tree, "record-button--check-recovery"), undefined, "热态恢复失败时不增加手动入口");
  const locked = byClass(tree, "record-button");
  assert.equal(locked.props["aria-disabled"], true);
  locked.props.onClick();
  assert.match(page.modalCalls.at(-1).content, /录音设备暂未恢复/);
  assert.match(page.modalCalls.at(-1).content, /关闭并重新打开微信/);
  timers.advance(10000);
  page.render();
  assert.equal(abandonCalls, 2);
});

test("录音文件保存失败后自动放弃本段，不保留待处理入口", async t => {
  const timers = createFakeTimers();
  const page = createPage("src/pages/Practice/Practice.tsx", { bookId: "22", practice: "0" }, {
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    saveRecording: async () => { throw new Error("本地录音保存失败"); },
  });
  t.after(() => page.dispose());
  page.render();
  await byClass(page.render(), "record-button").props.onClick();
  page.recorderHandlers.Start();
  let tree = page.render();
  byClass(tree, "record-button--stop").props.onClick();
  await page.recorderHandlers.Stop({
    tempFilePath: "/tmp/failed-save.mp3", duration: 2100, fileSize: 5000,
  });
  assert.equal(page.recordingSessionJournal.read(), null, "持久化失败后清除本段会话，不继续占用录音器");
  tree = page.render();
  tree = page.render();
  assert.equal(byClass(tree, "record-button--check-recovery"), undefined);
  assert.doesNotMatch(textOf(tree), /待完成录音/);
  assert.match(textOf(byClass(tree, "record-button")), /开始跟读录音|重新尝试录音/);
  assert.equal(page.recorderActions.filter(({ action }) => action === "start").length, 1, "不能自动开启新录音");
});

test("会话记录无法读取时说明录音锁状态，但不显示手动处理入口", t => {
  const page = createPage("src/pages/Practice/Practice.tsx", { bookId: "22", practice: "0" });
  t.after(() => page.dispose());
  page.recordingSessionJournal.read = () => { throw new Error("journal unreadable"); };
  page.render();
  const tree = page.render();
  assert.equal(byClass(tree, "record-button").props["aria-disabled"], true);
  assert.equal(byClass(tree, "record-button--check-recovery"), undefined);
  assert.doesNotMatch(textOf(tree), /待完成录音/);
  assert.match(textOf(tree), /录音设备|录音状态/);
});

test("检测态自动放弃失败后也停止显示无限等待文案", async t => {
  const timers = createFakeTimers();
  let abandonCalls = 0;
  const page = createPage("src/pages/Practice/Practice.tsx", { bookId: "22", practice: "0" }, {
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    recorderCoordinator: {
      acquire: () => ({ ok: false, reason: "busy", phase: "draining" }),
      getPhase: () => "draining", getEntryRecoveryStatus: () => "none",
      abandonUnconfirmedRecording: () => { abandonCalls += 1; return false; },
    },
  });
  t.after(() => page.dispose());
  page.render(); page.render();
  timers.advance(1500);
  await Promise.resolve();
  page.render();
  timers.advance(1500);
  await Promise.resolve();
  const tree = page.render();
  assert.equal(abandonCalls, 2);
  assert.match(textOf(tree), /录音设备暂未恢复/);
  assert.doesNotMatch(textOf(tree), /正在自动恢复录音设备/);
});

test("旧录音记录清理遇到设备空间不足时给出清理空间的建议", async t => {
  const timers = createFakeTimers();
  const page = createPage("src/pages/Practice/Practice.tsx", { bookId: "22", practice: "0" }, {
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    recorderActionOutcomes: { start: ["throw-busy"] },
  });
  t.after(() => page.dispose());
  page.render();
  await byClass(page.render(), "record-button").props.onClick();
  page.recordingSessionJournal.markAbandoned = () => { throw new Error("ENOSPC"); };
  page.render();
  timers.advance(1500);
  await Promise.resolve();
  page.render();
  timers.advance(1500);
  await Promise.resolve();
  const tree = page.render();
  assert.match(textOf(tree), /设备存储空间不足/);
  assert.match(textOf(tree), /清理手机存储空间/);
  assert.equal(byClass(tree, "record-button--check-recovery"), undefined);
});
