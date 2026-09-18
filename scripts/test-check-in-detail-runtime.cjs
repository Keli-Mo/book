/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const { createPage, byClass, textOf, load } = require("./test-practice-book-route.cjs");
const { getShareFailureMessage } = load("src/services/cloudCheckIn.ts");

const settle = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const localId = "a".repeat(32);
const makePending = (share) => ({
  requestId: localId,
  localPath: "wxfile://saved.mp3",
  recoverable: true,
  context: { bookId: "22", bookTitle: "教材", practiceId: "p", practiceIndex: 0, pageNumber: 8, imageUrl: "cover", sectionTitle: "第一课" },
  durationMs: 3000,
  fileSizeBytes: 20,
  cloudFileId: "",
  status: "local",
  updatedAtMs: 1,
  completedAtMs: 2,
  ...(share ? { share } : {}),
});
const createLocalPage = ({ pending = makePending(), beginShare, submit, isSubmitting = () => false, getActive = () => undefined, probe, expire, timers, deferAudioPlay = false } = {}) => {
  const items = [pending];
  const toasts = [], diagnostics = [];
  let cloudCalls = 0;
  const store = {
    ready: async () => {},
    list: () => items,
    beginShare: beginShare || (async () => items[0]),
    markShareExpired: expire || (async (id, generation) => {
      if (items[0].requestId !== id || items[0].shareRequestId !== generation) return false;
      items[0] = { ...items[0], share: undefined, shareRequestId: undefined, cloudFileId: "" };
      return true;
    }),
  };
  const coordinator = { submit: submit || (() => { throw new Error("不应上传"); }), isSubmitting, getActive };
  const page = createPage("src/pages/CheckInDetail/CheckInDetail.tsx", { localId }, {
    showToast: ({ title }) => toasts.push(title),
    deferAudioPlay,
    ...(timers ? { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout } : {}),
    overrides: {
      "@/features/listeningPractice/pendingCheckInRuntime": { getPendingCheckInStore: () => store, logRecordingDiagnostic: (stage, details) => diagnostics.push({ stage, ...details }) },
      "@/features/listeningPractice/checkInSubmissionRuntime": { getCheckInSubmissionCoordinator: () => coordinator },
      "@/services/cloudCheckIn": {
        getCheckInDetail: async () => { cloudCalls += 1; throw new Error("本地详情不得访问云端"); },
        getReadableCloudError: (error) => error.message,
        getShareFailureMessage,
        getCheckInShareStatus: async (...args) => { cloudCalls += 1; return probe(...args); },
      },
    },
  });
  return { page, items, toasts, diagnostics, get cloudCalls() { return cloudCalls; } };
};

(async () => {
  for (const state of ["active", "deleted", "expired", "missing", "invalid", "network", "unavailable", "persist-failed", "new-generation"]) {
    const share = { id: "old-cloud", shareToken: "old-token", expiresAtMs: Date.now() + 60_000 };
    const pending = { ...makePending(share), shareRequestId: "b".repeat(32) };
    let uploads = 0;
    const checked = createLocalPage({ pending,
      probe: async (id, generation) => {
        assert.equal(id, share.id); assert.equal(generation, pending.shareRequestId);
        if (state === "network") throw { code: "ETIMEDOUT", message: "https://secret?token=private" };
        if (state === "unavailable") throw { code: "SHARE_STATUS_UNAVAILABLE", message: "暂时无法核验分享，请稍后重试" };
        if (state === "new-generation") checked.items[0] = { ...pending, shareRequestId: "c".repeat(32), share: { ...share, id: "new-cloud" } };
        return { state: ["persist-failed", "new-generation"].includes(state) ? "missing" : state };
      },
      ...(state === "persist-failed" ? { expire: async () => false } : {}),
      submit: () => { uploads++; return { promise: Promise.resolve({ state: "failed", error: { code: "ETIMEDOUT" } }), cancel: () => false }; },
    });
    checked.page.render(); await settle();
    let tree = checked.page.render();
    assert.equal(textOf(byClass(tree, "check-in-detail__title")), "完成英语跟读", "详情标题使用精简文案");
    assert.equal(checked.cloudCalls, 0, "不能在打开本机录音时自动核验");
    const repair = byClass(tree, "shared-recording__repair");
    assert.ok(repair, "已有链接需要主动核验入口");
    await repair.props.onClick();
    tree = checked.page.render();
    assert.equal(uploads, 0, "核验与失效均不能自动上传");
    assert.equal(checked.items[0].localPath, pending.localPath);
    assert.doesNotMatch(JSON.stringify(checked.toasts), /private|secret/);
    if (["deleted", "expired", "missing", "invalid"].includes(state)) {
      assert.equal(checked.items[0].share, undefined);
      assert.equal(byClass(tree, "check-in-actions__share").props.disabled, false);
      await byClass(tree, "check-in-actions__share").props.onClick();
      assert.equal(uploads, 1, "仅再次明确点击分享才可开始提交");
    } else {
      assert.equal(checked.items[0].share.id, state === "new-generation" ? "new-cloud" : "old-cloud");
      assert.equal(byClass(tree, "check-in-actions__share").props.openType, "share");
    }
    checked.page.dispose();
  }
  for (const state of ["committed", "failed"]) {
    const completion = deferred();
    const handle = { promise: completion.promise, cancel: () => false };
    let submissions = 0;
    const reopened = createLocalPage({ isSubmitting: () => true, getActive: () => handle,
      submit: () => { submissions++; return { promise: Promise.resolve({ state: "failed", error: { code: "ETIMEDOUT" } }), cancel: () => false }; },
    });
    reopened.page.render(); reopened.page.show(); await settle();
    assert.equal(byClass(reopened.page.render(), "check-in-actions__share").props.loading, true);
    if (state === "committed") reopened.items[0] = makePending({ id: "existing", shareToken: "token", expiresAtMs: Date.now() + 60_000 });
    completion.resolve({ state, cleanupPending: false, error: { code: "ETIMEDOUT" } });
    await settle();
    const button = byClass(reopened.page.render(), "check-in-actions__share");
    assert.notEqual(button.props.loading, true, "重开页面应接收原任务完成或失败并解除 loading");
    assert.equal(state === "committed" ? button.props.openType : button.props.disabled, state === "committed" ? "share" : false);
    assert.equal(submissions, 0, "采用旧任务不能调用 submit 启动观察任务");
    if (state === "failed") {
      await button.props.onClick();
      assert.equal(submissions, 1, "重开采用旧任务失败后，明确点击仍可重试");
    }
    reopened.page.dispose();
  }
  for (const [code, title] of [["SHARE_PROTOCOL_MISMATCH", /版本不匹配/], ["ETIMEDOUT", /网络异常/], ["PENDING_PERSIST_FAILED", /本机状态保存失败/]]) {
    const failure = createLocalPage({ submit: () => ({ promise: Promise.resolve({ state: "failed", error: { code, message: "private-token" } }), cancel: () => false }) });
    failure.page.render(); await settle();
    await byClass(failure.page.render(), "check-in-actions__share").props.onClick();
    assert.match(failure.toasts.at(-1), title, "页面应使用真实错误分类，而非泛化或误报成功");
    assert.doesNotMatch(failure.toasts.at(-1), /private-token/);
    assert.equal(byClass(failure.page.render(), "check-in-actions__share").props.loading, false);
    failure.page.dispose();
  }
  const localFailure = createLocalPage({ beginShare: async () => null });
  localFailure.page.render(); await settle();
  await byClass(localFailure.page.render(), "check-in-actions__share").props.onClick();
  assert.match(localFailure.toasts.at(-1), /本机状态保存失败/);
  assert.ok(localFailure.diagnostics.some(log => log.stage === "share.prepare.failed" && log.error.code === "PENDING_PERSIST_FAILED"));
  localFailure.page.dispose();

  const local = createLocalPage({ deferAudioPlay: true });
  local.page.render(); await settle();
  let tree = local.page.render();
  await byClass(tree, "shared-recording__play").props.onClick();
  assert.equal(local.cloudCalls, 0, "本地加载和回听必须零云调用");
  const playbackA = local.page.audios.find((audio) => audio.src === "wxfile://saved.mp3");
  assert.deepEqual(playbackA.events, ["play"]);
  tree = local.page.render();
  assert.equal(textOf(byClass(tree, "shared-recording__play")), "▶播放本次跟读", "原生 onPlay 未到时不能提前显示停止按钮");
  assert.equal(textOf(byClass(tree, "shared-recording__duration")), "0:03", "原生 onPlay 未到时应只显示总时长");
  playbackA.trigger("Play");
  tree = local.page.render();
  assert.equal(textOf(byClass(tree, "shared-recording__play")), "■停止播放", "原生 onPlay 到达后才显示停止按钮");
  assert.equal(textOf(byClass(tree, "shared-recording__duration")), "0:00 / 0:03", "原生 onPlay 到达后才显示当前与总时长");
  await byClass(tree, "shared-recording__play").props.onClick();
  tree = local.page.render();
  assert.equal(textOf(byClass(tree, "shared-recording__play")), "▶播放本次跟读", "再次点击应停止并释放 A 会话");
  await byClass(tree, "shared-recording__play").props.onClick();
  const playbackB = local.page.audios.findLast((audio) => audio.src === "wxfile://saved.mp3");
  assert.notEqual(playbackB, playbackA, "再次播放必须创建独立 B 会话");
  playbackB.trigger("Play");
  playbackB.currentTime = 2.8;
  playbackB.trigger("TimeUpdate");
  const toastCountBeforeOldEvents = local.toasts.length;
  playbackA.currentTime = 0.1;
  for (const event of ["Play", "TimeUpdate", "Stop", "Ended", "Error"]) {
    playbackA.trigger(event, event === "Error" ? { errCode: 1, errMsg: "old" } : undefined);
  }
  tree = local.page.render();
  assert.equal(textOf(byClass(tree, "shared-recording__play")), "■停止播放", "A 的全部迟到事件不能清空 B 播放态");
  assert.equal(textOf(byClass(tree, "shared-recording__duration")), "0:02 / 0:03", "A 的迟到进度不能让 B 倒退或跳变");
  assert.equal(local.toasts.length, toastCountBeforeOldEvents, "A 的迟到错误不能额外弹提示");
  playbackB.trigger("Ended");
  tree = local.page.render();
  assert.equal(textOf(byClass(tree, "shared-recording__play")), "▶播放本次跟读", "B 正常结束应复位播放态");
  await byClass(tree, "shared-recording__play").props.onClick();
  const playbackC = local.page.audios.findLast((audio) => audio.src === "wxfile://saved.mp3");
  playbackC.trigger("Play");
  playbackC.trigger("Error", { errCode: 2, errMsg: "current" });
  tree = local.page.render();
  assert.equal(textOf(byClass(tree, "shared-recording__play")), "▶播放本次跟读", "当前会话报错应复位播放态");
  assert.equal(local.toasts.at(-1), "录音播放失败", "仅当前会话错误应显示固定提示");
  await byClass(tree, "shared-recording__play").props.onClick();
  const hiddenPlayback = local.page.audios.findLast((audio) => audio.src === "wxfile://saved.mp3");
  local.page.hide();
  hiddenPlayback.trigger("Play");
  assert.equal(textOf(byClass(local.page.render(), "shared-recording__play")), "▶播放本次跟读", "隐藏后的迟到 onPlay 不能复活页面播放态");
  local.page.dispose();

  const begin = deferred();
  let submitCalls = 0;
  const leaving = createLocalPage({
    beginShare: () => begin.promise,
    submit: () => { submitCalls += 1; throw new Error("离页后不得提交"); },
  });
  leaving.page.render(); await settle(); tree = leaving.page.render();
  const shareAttempt = byClass(tree, "check-in-actions__share").props.onClick();
  leaving.page.hide(); begin.resolve(leaving.items[0]); await shareAttempt;
  assert.equal(submitCalls, 0, "beginShare 等待期间离页不得补启动上传");
  leaving.page.show(); tree = leaving.page.render();
  assert.equal(byClass(tree, "check-in-actions__share").props.loading, false, "返回页面必须解除过期 loading");
  leaving.page.dispose();

  const commit = deferred();
  const shared = { id: "cloud-new", shareToken: "token-new", expiresAtMs: Date.now() + 60_000 };
  let commitActive = true;
  const hiddenCommit = createLocalPage({
    submit: () => ({ promise: commit.promise, cancel: () => false }),
    isSubmitting: () => commitActive,
  });
  hiddenCommit.page.render(); await settle(); tree = hiddenCommit.page.render();
  const commitAttempt = byClass(tree, "check-in-actions__share").props.onClick();
  await settle(); hiddenCommit.page.hide();
  hiddenCommit.page.show();
  tree = hiddenCommit.page.render();
  assert.equal(byClass(tree, "check-in-actions__share").props.loading, true, "返回时 commit 未完成应准确保持 busy");
  hiddenCommit.items[0] = makePending(shared);
  commitActive = false;
  commit.resolve({ state: "committed", ...shared, cleanupPending: false });
  await commitAttempt; tree = hiddenCommit.page.render();
  assert.equal(textOf(byClass(tree, "check-in-actions__share")), "发送给朋友", "hide→show→commit 后应收敛为可发送分享");
  assert.equal(byClass(tree, "check-in-actions__share").props.openType, "share");
  hiddenCommit.page.dispose();

  const cleanupPending = createLocalPage({
    submit: () => ({ promise: Promise.resolve({ state: "committed", id: "cloud", shareToken: "token", expiresAtMs: Date.now() + 60_000, cleanupPending: true }), cancel: () => false }),
  });
  cleanupPending.page.render(); await settle(); tree = cleanupPending.page.render();
  await byClass(tree, "check-in-actions__share").props.onClick();
  tree = cleanupPending.page.render();
  assert.equal(textOf(byClass(tree, "check-in-actions__share")), "分享给朋友", "分享回写失败不得虚报为可发送，且应保留重试入口");
  cleanupPending.page.dispose();

  const delays = [];
  const timerCallbacks = [];
  const timers = { setTimeout: (callback, delay) => { delays.push(delay); timerCallbacks.push(callback); return delays.length; }, clearTimeout: () => {} };
  const longExpiry = createLocalPage({ pending: makePending({ id: "cloud", shareToken: "token", expiresAtMs: Date.now() + 30 * 24 * 60 * 60 * 1000 }), timers });
  longExpiry.page.render(); await settle(); longExpiry.page.render();
  assert.ok(delays.length > 0 && delays.every((delay) => delay <= 2_147_000_000), "30 天期限必须分段调度，不得溢出原生计时器");
  timerCallbacks[0]();
  longExpiry.page.render();
  assert.ok(delays.length >= 2, "长分享期限首次分段唤醒后必须继续调度剩余时间");
  longExpiry.page.dispose();

  const refreshed = deferred();
  let detailCalls = 0;
  const cloudPage = createPage("src/pages/CheckInDetail/CheckInDetail.tsx", { id: "cloud", token: "token" }, {
    overrides: {
      "@/services/cloudCheckIn": {
        getCheckInDetail: async () => {
          detailCalls += 1;
          if (detailCalls === 1) return { id: "cloud", shareToken: "token", bookId: "22", bookTitle: "教材", practiceIndex: 0, pageNumber: 8, sectionTitle: "第一课", imageUrl: "cover", durationMs: 3000, createdAt: 1, recordingUrl: "old-url", isOwner: false };
          return refreshed.promise;
        },
        getReadableCloudError: (error) => error.message,
      },
    },
  });
  cloudPage.render(); await settle(); tree = cloudPage.render();
  const cloudPlay = byClass(tree, "shared-recording__play").props.onClick();
  assert.equal(detailCalls, 2, "云录音每次点击播放应刷新 300 秒临时地址");
  cloudPage.hide();
  refreshed.resolve({ id: "cloud", shareToken: "token", bookId: "22", bookTitle: "教材", practiceIndex: 0, pageNumber: 8, sectionTitle: "第一课", imageUrl: "cover", durationMs: 3000, createdAt: 1, recordingUrl: "fresh-url", isOwner: false });
  await cloudPlay;
  assert.equal(cloudPage.audios.some((audio) => audio.events.includes("play")), false, "云地址刷新迟到且页面已隐藏时不得启动播放");
  cloudPage.dispose();

  const rejectedRefresh = deferred();
  let rejectedCalls = 0;
  const rejectedToasts = [];
  const rejectedCloudPage = createPage("src/pages/CheckInDetail/CheckInDetail.tsx", { id: "cloud", token: "token" }, {
    showToast: ({ title }) => rejectedToasts.push(title),
    overrides: {
      "@/services/cloudCheckIn": {
        getCheckInDetail: async () => {
          rejectedCalls += 1;
          if (rejectedCalls === 1) return { id: "cloud", shareToken: "token", bookId: "22", bookTitle: "教材", practiceIndex: 0, pageNumber: 8, sectionTitle: "第一课", imageUrl: "cover", durationMs: 3000, createdAt: 1, recordingUrl: "old-url", isOwner: false };
          return rejectedRefresh.promise;
        },
        getReadableCloudError: (error) => error.message,
      },
    },
  });
  rejectedCloudPage.render(); await settle(); tree = rejectedCloudPage.render();
  const rejectedPlay = byClass(tree, "shared-recording__play").props.onClick();
  rejectedCloudPage.hide();
  rejectedRefresh.reject(new Error("旧请求失败"));
  await rejectedPlay;
  assert.deepEqual(rejectedToasts, [], "隐藏后迟到的云地址刷新失败不能弹提示");
  rejectedCloudPage.dispose();

  console.log("录音详情运行时测试通过：本地零云请求、离页分享门闩、隐藏提交恢复、长计时器与云播放迟到均正确。");
})().catch((error) => { console.error(error); process.exitCode = 1; });
