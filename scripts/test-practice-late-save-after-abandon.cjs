/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const test = require("node:test");
const { createPage, createFakeTimers, byClass, textOf, elements, buildBookPracticeBundle } = require("./test-practice-book-route.cjs");

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const flushPromises = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
const stopResult = { tempFilePath: "/tmp/old-a.mp3", duration: 2300, fileSize: 8192 };

for (const outcome of ["saved", "failed"]) {
  test(`已放弃的旧录音迟到${outcome === "saved" ? "保存成功" : "保存失败"}不影响同页新录音`, async t => {
    const timers = createFakeTimers();
    const oldSave = deferred();
    // 第一次进入可录；旧会话收尾期间禁止重新获取 owner，超时放弃后才放行。
    let allowNewOwner = false;
    const acquireSequence = new Proxy(["ok", "busy"], {
      get(target, key) {
        if (key === "1") return allowNewOwner ? "ok" : "busy";
        return Reflect.get(target, key);
      },
    });
    const page = createPage("src/pages/Practice/Practice.tsx", { bookId: "22", practice: "0" }, {
      acquireSequence,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      saveRecording: () => oldSave.promise,
    });
    t.after(() => page.dispose());

    page.render();
    let tree = page.render();
    await byClass(tree, "record-button").props.onClick();
    page.recorderHandlers.Start();
    const oldSessionId = page.recordingSessionJournal.read()?.id;
    assert.ok(oldSessionId);

    page.hide();
    const oldStop = page.recorderHandlers.Stop(stopResult);
    await flushPromises();
    assert.equal(page.recordingSessionJournal.read()?.stage, "terminal");
    page.show();
    page.render();

    timers.advance(18_500);
    await flushPromises();
    assert.equal(page.recordingSessionJournal.read(), null, "退出超时后应放弃未完成的旧会话");
    allowNewOwner = true;
    tree = page.render();
    tree = page.render();
    const startButton = byClass(tree, "record-button");
    assert.ok(startButton, "旧保存挂起时也应及时恢复录音入口");
    assert.equal(startButton.props["aria-disabled"], false,
      `旧保存挂起时不能继续锁住新录音：${textOf(tree)}`);
    await startButton.props.onClick();
    page.recorderHandlers.Start();
    const newSessionId = page.recordingSessionJournal.read()?.id;
    assert.ok(newSessionId && newSessionId !== oldSessionId, "应开始独立的新录音会话");
    const releaseCallsBeforeLateSave = page.recorderReleaseCalls.length;
    tree = page.render();
    assert.ok(byClass(tree, "record-button--stop"), "新录音应处于录制中");

    if (outcome === "saved") {
      oldSave.resolve({
        item: { requestId: oldSessionId, localPath: "/saved/old-a.mp3", recoverable: true,
          context: { bookId: "22", practiceId: "old-a", practiceIndex: 0 },
          durationMs: 2300, fileSizeBytes: 8192, cloudFileId: "", status: "local", updatedAtMs: 1 },
        persisted: true,
        message: "",
      });
    } else {
      oldSave.reject(new Error("old save failed after abandon"));
    }
    await oldStop;
    await flushPromises();
    tree = page.render();

    assert.equal(page.recordingSessionJournal.read()?.id, newSessionId,
      "旧保存返回不得清理新录音的会话记录");
    assert.equal(page.recordingSessionJournal.read()?.stage, "confirmed");
    assert.equal(page.recorderReleaseCalls.length, releaseCallsBeforeLateSave,
      "旧保存返回不得释放新录音的 owner");
    assert.ok(byClass(tree, "record-button--stop"), "旧保存返回不得覆盖新录音界面");
  });
}

test("旧录音迟到保存成功不能删除新页重新录制所保留的旧文件", async t => {
  const timers = createFakeTimers();
  const oldSave = deferred();
  const bundle = buildBookPracticeBundle("22");
  const pendingFor = (index, requestId) => ({
    requestId,
    localPath: `/saved/${requestId}.mp3`,
    recoverable: true,
    context: {
      bookId: bundle.book.id, bookTitle: bundle.book.title,
      practiceId: bundle.practices[index].id, practiceIndex: bundle.practices[index].imageIndex,
      pageNumber: bundle.practices[index].pageNumber,
      sectionTitle: bundle.practices[index].sectionTitle,
      imageUrl: bundle.practices[index].imageUrl,
    },
    durationMs: 1800, fileSizeBytes: 6000, cloudFileId: "", status: "local", updatedAtMs: 1,
  });
  const previousA = pendingFor(0, "a".repeat(32));
  const previousB = pendingFor(1, "b".repeat(32));
  const removed = [];
  let allowNewOwner = false;
  const acquireSequence = new Proxy(["ok", "busy"], {
    get(target, key) {
      if (key === "1") return allowNewOwner ? "ok" : "busy";
      return Reflect.get(target, key);
    },
  });
  const page = createPage("src/pages/Practice/Practice.tsx", { bookId: "22", practice: "0" }, {
    acquireSequence, pendingItems: [previousA, previousB],
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    saveRecording: () => oldSave.promise,
    pendingRemove: async requestId => { removed.push(requestId); return true; },
  });
  t.after(() => page.dispose());

  page.render(); page.render();
  await flushPromises();
  let tree = page.render();
  const startReplacement = elements(tree).find(node => node.type === "Button" && textOf(node) === "重新录制");
  assert.ok(startReplacement, "A 页应恢复已有录音并提供重录入口");
  await startReplacement.props.onClick();
  page.recorderHandlers.Start();
  const oldSessionId = page.recordingSessionJournal.read()?.id;
  page.hide();
  const oldStop = page.recorderHandlers.Stop(stopResult);
  await flushPromises();
  page.show(); page.render();
  timers.advance(18_500);
  await flushPromises();
  allowNewOwner = true;
  page.render(); page.render();

  tree = page.render();
  for (let step = 0; step < 12 && !/第 14 页/.test(textOf(byClass(tree, "practice-header__progress"))); step += 1) {
    await byClass(tree, "practice-navigation__button--primary").props.onClick();
    await flushPromises();
    tree = page.render();
  }
  assert.match(textOf(byClass(tree, "practice-header__progress")), /第 14 页/);
  await flushPromises();
  tree = page.render();
  const startBReplacement = elements(tree).find(node => node.type === "Button" && textOf(node) === "重新录制");
  assert.ok(startBReplacement, `B 页已有录音应可重新录制：${textOf(tree)}`);
  await startBReplacement.props.onClick();
  page.recorderHandlers.Start();
  const newSessionId = page.recordingSessionJournal.read()?.id;
  assert.ok(newSessionId && newSessionId !== oldSessionId);

  oldSave.resolve({
    item: { ...previousA, requestId: oldSessionId, localPath: "/saved/new-a.mp3" },
    persisted: true, message: "",
  });
  await oldStop;
  await flushPromises();
  assert.equal(page.recordingSessionJournal.read()?.id, newSessionId);
  assert.equal(removed.includes(previousB.requestId), false,
    "A 的迟到保存不能删除 B 正在替换的旧录音");
  assert.ok(byClass(page.render(), "record-button--stop"), "B 仍应继续录制");
});

test("退出已放弃的旧录音迟到持久化成功仍应清理旧保存项", async t => {
  const timers = createFakeTimers();
  const oldSave = deferred();
  const storedItems = [];
  const removed = [];
  // 生产 store 的 saveRecording/remove 共用同一条 mutation 队列；放弃清理须排在挂起保存之后。
  let mutationTail = Promise.resolve();
  const enqueueMutation = task => {
    const result = mutationTail.then(task, task);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  };
  const store = {
    ready: async () => {}, cleanup: async () => {}, list: () => storedItems,
    checkCanStartRecording: async () => ({ allowed: true, message: "" }),
    retrySave: async () => null,
    saveRecording: input => enqueueMutation(async () => {
      const result = await oldSave.promise;
      storedItems.push(result.item);
      return result;
    }),
    remove: requestId => enqueueMutation(async () => {
      removed.push(requestId);
      const index = storedItems.findIndex(item => item.requestId === requestId);
      if (index < 0) return false;
      storedItems.splice(index, 1);
      return true;
    }),
    complete: async () => false,
  };
  let allowNewOwner = false;
  const acquireSequence = new Proxy(["ok", "busy"], {
    get(target, key) {
      if (key === "1") return allowNewOwner ? "ok" : "busy";
      return Reflect.get(target, key);
    },
  });
  const page = createPage("src/pages/Practice/Practice.tsx", { bookId: "22", practice: "0" }, {
    acquireSequence, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    overrides: {
      "@/features/listeningPractice/pendingCheckInRuntime": {
        getPendingCheckInStore: () => store,
        logRecordingDiagnostic() {}, diagnoseLocalRecordingFailure() {},
      },
    },
  });
  t.after(() => page.dispose());

  page.render();
  await byClass(page.render(), "record-button").props.onClick();
  page.recorderHandlers.Start();
  const oldSessionId = page.recordingSessionJournal.read()?.id;
  page.hide();
  const oldStop = page.recorderHandlers.Stop(stopResult);
  await flushPromises();
  page.show(); page.render();
  timers.advance(18_500);
  await flushPromises();
  assert.equal(page.recordingSessionJournal.read(), null);

  allowNewOwner = true;
  page.render();
  const tree = page.render();
  await byClass(tree, "record-button").props.onClick();
  page.recorderHandlers.Start();
  const newSessionId = page.recordingSessionJournal.read()?.id;
  assert.ok(newSessionId && newSessionId !== oldSessionId);

  oldSave.resolve({
    item: { requestId: oldSessionId, localPath: "/saved/abandoned-a.mp3", recoverable: true,
      context: { bookId: "22", practiceId: "22-page-10", practiceIndex: 9 },
      durationMs: 2300, fileSizeBytes: 8192, cloudFileId: "", status: "local", updatedAtMs: 1 },
    persisted: true, message: "",
  });
  await oldStop;
  await flushPromises();
  assert.equal(page.recordingSessionJournal.read()?.id, newSessionId,
    "清理旧保存项不能清除新会话记录");
  assert.ok(byClass(page.render(), "record-button--stop"), "B 录音仍应继续");
  assert.equal(storedItems.some(item => item.requestId === oldSessionId), false,
    "已自动放弃的 A 不应因迟到保存成功重新出现在本地录音列表");
  assert.deepEqual(removed, [oldSessionId], "应仅清理 A 的迟到保存项");
});

test("录音已安全保存但会话日志首次清理失败时不得删除已保存文件", async t => {
  const timers = createFakeTimers();
  const storedItems = [];
  const removed = [];
  let mutationTail = Promise.resolve();
  const enqueueMutation = task => {
    const result = mutationTail.then(task, task);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  };
  const store = {
    ready: async () => {}, cleanup: async () => {}, list: () => storedItems,
    checkCanStartRecording: async () => ({ allowed: true, message: "" }),
    retrySave: async () => null,
    saveRecording: input => enqueueMutation(async () => {
      const item = { requestId: input.recordingSessionId, localPath: "/saved/safe-a.mp3",
        recoverable: true, context: input.context, durationMs: input.durationMs,
        fileSizeBytes: input.fileSizeBytes, cloudFileId: "", status: "local", updatedAtMs: 1 };
      storedItems.push(item);
      return { item, persisted: true, message: "" };
    }),
    remove: requestId => enqueueMutation(async () => {
      removed.push(requestId);
      const index = storedItems.findIndex(item => item.requestId === requestId);
      if (index < 0) return false;
      storedItems.splice(index, 1);
      return true;
    }),
    complete: async () => false,
  };
  const page = createPage("src/pages/Practice/Practice.tsx", { bookId: "22", practice: "0" }, {
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    overrides: {
      "@/features/listeningPractice/pendingCheckInRuntime": {
        getPendingCheckInStore: () => store,
        logRecordingDiagnostic() {}, diagnoseLocalRecordingFailure() {},
      },
    },
  });
  t.after(() => page.dispose());
  const originalClear = page.recordingSessionJournal.clear.bind(page.recordingSessionJournal);
  let failOnce = true;
  page.recordingSessionJournal.clear = id => {
    if (failOnce) { failOnce = false; throw new Error("transient journal clear failure"); }
    return originalClear(id);
  };

  page.render();
  await byClass(page.render(), "record-button").props.onClick();
  page.recorderHandlers.Start();
  byClass(page.render(), "record-button--stop").props.onClick();
  await page.recorderHandlers.Stop(stopResult);
  await flushPromises();
  const savedSessionId = storedItems[0]?.requestId;
  assert.ok(savedSessionId, "录音文件已安全保存");
  assert.equal(page.recordingSessionJournal.read()?.stage, "terminal",
    "首次 journal.clear 失败后只剩日志待清理");

  page.hide();
  timers.advance(1500);
  await flushPromises();
  assert.equal(page.recordingSessionJournal.read(), null, "稍后应清掉残留会话日志");
  assert.equal(storedItems.some(item => item.requestId === savedSessionId), true,
    "日志清理失败不代表录音保存失败，不能删除已持久化的文件");
  assert.deepEqual(removed, [], "已安全保存的文件不能进入放弃删除队列");
});
