/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const { createPage, byClass, textOf } = require("./test-practice-book-route.cjs");

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
const createLocalPage = ({ pending = makePending(), beginShare, submit, isSubmitting = () => false, timers } = {}) => {
  const items = [pending];
  let cloudCalls = 0;
  const store = {
    ready: async () => {},
    list: () => items,
    beginShare: beginShare || (async () => items[0]),
  };
  const coordinator = { submit: submit || (() => { throw new Error("不应上传"); }), isSubmitting };
  const page = createPage("src/pages/CheckInDetail/CheckInDetail.tsx", { localId }, {
    ...(timers ? { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout } : {}),
    overrides: {
      "@/features/listeningPractice/pendingCheckInRuntime": { getPendingCheckInStore: () => store },
      "@/features/listeningPractice/checkInSubmissionRuntime": { getCheckInSubmissionCoordinator: () => coordinator },
      "@/services/cloudCheckIn": {
        getCheckInDetail: async () => { cloudCalls += 1; throw new Error("本地详情不得访问云端"); },
        getReadableCloudError: (error) => error.message,
      },
    },
  });
  return { page, items, get cloudCalls() { return cloudCalls; } };
};

(async () => {
  const local = createLocalPage();
  local.page.render(); await settle();
  let tree = local.page.render();
  await byClass(tree, "shared-recording__play").props.onClick();
  assert.equal(local.cloudCalls, 0, "本地加载和回听必须零云调用");
  assert.deepEqual(local.page.audios[0].events, ["play"]);
  local.page.hide();
  local.page.audios[0].trigger("Play");
  assert.equal(local.page.audios[0].events.at(-1), "stop", "隐藏后的迟到 onPlay 必须再次停止音频");
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
  assert.equal(cloudPage.audios[0].events.includes("play"), false, "云地址刷新迟到且页面已隐藏时不得启动播放");
  cloudPage.dispose();

  console.log("录音详情运行时测试通过：本地零云请求、离页分享门闩、隐藏提交恢复、长计时器与云播放迟到均正确。");
})().catch((error) => { console.error(error); process.exitCode = 1; });
