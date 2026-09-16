/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const { createPage, byClass, elements, textOf } = require("./test-practice-book-route.cjs");
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const record = {
  requestId: "a".repeat(32), localPath: "wxfile://store/private.mp3", recoverable: true,
  context: { bookId: "3", bookTitle: "测试教材", practiceId: "3-page-4", practiceIndex: 0, pageNumber: 4, imageUrl: "page.png", sectionTitle: "Unit 1" },
  durationMs: 1000, fileSizeBytes: 4096, status: "local", updatedAtMs: 100,
};

async function fixture({ remove = async () => true, confirm = true, sharing = false, local = [record], listCloud = async () => [], removeCloud = async () => {} } = {}) {
  const logs = [], toasts = [];
  let calls = 0, cloudDeletes = 0;
  const page = createPage("src/pages/MyCheckIns/MyCheckIns.tsx", {}, {
    showModal: async () => ({ confirm }),
    showToast: input => toasts.push(input),
    overrides: {
      "@/features/listeningPractice/pendingCheckInRuntime": {
        getPendingCheckInStore: () => ({ ready: async () => {}, cleanup: async () => {}, list: () => local, remove: async () => { calls++; return remove(); } }),
        logRecordingDiagnostic: (...args) => logs.push(args),
      },
      "@/features/listeningPractice/checkInSubmissionRuntime": { getCheckInSubmissionCoordinator: () => ({ isSubmitting: () => sharing }) },
      "@/services/cloudCheckIn": { listMyCheckIns: listCloud, removeCheckIn: async () => { cloudDeletes++; return removeCloud(); } },
    },
  });
  page.render(); page.show(); await settle();
  const click = () => byClass(page.render(), "check-in-list-card__delete").props.onClick();
  const hasCard = () => elements(page.render()).some(node => node.props?.className?.includes("check-in-list-card__delete"));
  return { page, click, hasCard, logs, toasts, calls: () => calls, cloudDeletes: () => cloudDeletes };
}

(async () => {
  const cloudRecord = { id: "cloud-delete", ...record.context, createdAt: 1, durationMs: 1000, shareToken: "token", status: "deletePending" };
  const pending = await fixture({ local: [], listCloud: async () => [cloudRecord] });
  let pendingTree = pending.page.render();
  assert.equal(byClass(pendingTree, "check-in-list-card__open").props.disabled, true, "待删除云录音不能回听或分享");
  assert.equal(textOf(byClass(pendingTree, "check-in-list-card__delete")), "重试");
  await pending.click(); assert.equal(pending.hasCard(), false); pending.page.dispose();

  let finishRefresh, finishDelete, loads = 0;
  const stale = new Promise(resolve => { finishRefresh = resolve; });
  const deleting = new Promise(resolve => { finishDelete = resolve; });
  const racing = await fixture({ local: [], listCloud: () => ++loads === 1 ? Promise.resolve([cloudRecord]) : stale, removeCloud: () => deleting });
  racing.page.show(); await settle();
  const deletion = racing.click(), duplicate = racing.click(); await settle();
  assert.equal(racing.cloudDeletes(), 1, "云删除重复点击只发一次请求");
  assert.equal(racing.page.modalCalls.length, 1);
  finishDelete(); await Promise.all([deletion, duplicate]);
  finishRefresh([cloudRecord]); await settle();
  assert.equal(racing.hasCard(), false, "旧刷新返回不能恢复已删云卡片");
  racing.page.dispose();

  let finishOld, reloads = 0;
  const oldResult = new Promise(resolve => { finishOld = resolve; });
  const returning = await fixture({ local: [], listCloud: () => ++reloads === 1 ? oldResult : Promise.resolve([]) });
  returning.page.hide(); returning.page.show(); await settle();
  finishOld([cloudRecord]); await settle();
  assert.equal(returning.hasCard(), false, "离页前旧请求不能污染返回后的页面");
  returning.page.dispose();

  let finishLocalDelete;
  const lateDelete = new Promise(resolve => { finishLocalDelete = resolve; });
  const returnedLocal = await fixture({ remove: () => lateDelete });
  const localAttempt = returnedLocal.click(); await settle();
  returnedLocal.page.hide(); returnedLocal.page.show(); await settle();
  finishLocalDelete(true); await localAttempt;
  assert.equal(returnedLocal.hasCard(), true, "上一轮页面的本地删除回调不得覆盖返回后的新快照");
  returnedLocal.page.dispose();

  const success = await fixture();
  await success.click();
  assert.equal(success.hasCard(), false);
  const emptyState = byClass(success.page.render(), "my-check-ins-state");
  assert.equal(textOf(emptyState), "还没有录音", "空列表只显示没有录音，不再显示开始跟读入口");
  assert.equal(elements(emptyState).some(node => node.type === "Button"), false);
  assert.equal(success.cloudDeletes(), 0, "本地删除不得删除云分享");
  success.page.dispose();

  const fail = await fixture({ remove: async () => false });
  await fail.click();
  assert.equal(fail.hasCard(), true);
  assert.equal(fail.toasts[0].title, "删除失败，请稍后重试");
  fail.page.dispose();

  const thrown = await fixture({ remove: async () => { throw new Error("native internal failure"); } });
  await assert.doesNotReject(thrown.click(), "原生/仓储意外异常必须在页面收口，不能产生未处理 Promise");
  assert.equal(thrown.hasCard(), true);
  assert.equal(thrown.toasts[0].title, "删除失败，请稍后重试");
  assert.ok(thrown.logs.some(([stage]) => stage === "delete.unexpected.failed"));
  assert.equal(JSON.stringify(thrown.toasts).includes("native internal failure"), false, "用户不显示底层错误");
  thrown.page.dispose();

  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const double = await fixture({ remove: async () => { await gate; return true; } });
  const first = double.click();
  const second = double.click();
  await settle();
  assert.equal(double.calls(), 1, "连续点击不得重复删除同一录音");
  assert.equal(double.page.modalCalls.length, 1, "弹确认框期间就应互斥");
  release(); await Promise.all([first, second]);
  assert.equal(double.hasCard(), false);
  double.page.dispose();

  for (const state of [{ confirm: false }, { sharing: true }]) {
    const blocked = await fixture(state);
    await blocked.click();
    assert.equal(blocked.calls(), 0);
    assert.equal(blocked.hasCard(), true);
    assert.ok(blocked.logs.some(([stage]) => stage === (state.sharing ? "delete.blocked_sharing" : "delete.cancelled")));
    blocked.page.dispose();
  }
  console.log("录音删除页面测试通过：成功、失败、异常、重复点击、取消、分享中阻止及简洁提示。");
})().catch(error => { console.error(error); process.exitCode = 1; });
