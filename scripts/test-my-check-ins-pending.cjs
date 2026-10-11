/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { createPage, byClass } = require("./test-practice-book-route.cjs");

const root = path.resolve(__dirname, "..");
const page = fs.readFileSync(
  path.join(root, "src/pages/MyCheckIns/MyCheckIns.tsx"),
  "utf8",
);
const styles = fs.readFileSync(
  path.join(root, "src/pages/MyCheckIns/MyCheckIns.scss"),
  "utf8",
);

const pageAst = ts.createSourceFile(
  "MyCheckIns.tsx",
  page,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
assert.equal(pageAst.parseDiagnostics.length, 0, "MyCheckIns.tsx 必须可被 TypeScript 解析");

for (const required of [
  "getPendingCheckInStore",
  "getCheckInSubmissionCoordinator",
  "useDidShow",
  "useDidHide",
  "useUnload",
]) {
  assert.match(page, new RegExp(`\\b${required}\\b`), `我的打卡必须接入 ${required}`);
}

assert.match(page, /await\s+pendingStore\.ready\s*\(\s*\)/);
assert.match(page, /await\s+pendingStore\.cleanup\s*\(\s*\)/);
assert.match(page, /pendingStore\.list\s*\(\s*\)/);
assert.doesNotMatch(page, /submissionCoordinator\.submit\s*\(/, "列表展示和回听不得启动上传");
assert.match(page, /submissionCoordinator\.isSubmitting\s*\(/, "上传中的本机文件不得删除");
assert.match(page, /pendingStore\.remove\s*\(/);
assert.match(page, /setLocalRecords[\s\S]*?await\s+listMyCheckIns/, "本地录音必须先于云历史落屏");
assert.match(page, /正在加载录音…/, "首屏必须先展示加载态，不能空列表闪成卡片");
assert.match(page, /finally\s*\{[\s\S]*?setLoading\(false\)/, "云端成功或失败后都必须结束加载态");
assert.match(page, /title:\s*["']删除本机录音？["']/);

for (const copy of ["待上传", "已上传待确认", "继续提交"]) assert.equal(page.includes(copy), false);
for (const copy of ["我的录音", "回听 / 分享", "临时文件"]) assert.ok(page.includes(copy));

for (const field of [
  "context?.imageUrl",
  "context?.bookTitle",
  "context?.sectionTitle",
  "context?.pageNumber",
  "durationMs",
]) {
  assert.ok(page.includes(field), `待上传卡片必须展示 ${field}`);
}

assert.match(page, /CheckInDetail\/CheckInDetail\?localId=/);
assert.match(page, /CheckInDetail\/CheckInDetail\?id=/);
assert.match(styles, /pending-check-in-status/);

const settle = async () => { for (let index = 0; index < 40; index += 1) await Promise.resolve(); };
const localId = "a".repeat(32);
const localRecording = {
  requestId: localId,
  localPath: "wxfile://store/recording.mp3",
  recoverable: true,
  context: { bookId: "1", bookTitle: "教材", practiceId: "page-1", practiceIndex: 0,
    pageNumber: 1, imageUrl: "page.png", sectionTitle: "Unit 1" },
  durationMs: 1200,
  fileSizeBytes: 4096,
  status: "local",
  updatedAtMs: 1,
};

const createDeletionPage = (clearJournal) => {
  const events = [];
  const toasts = [];
  const records = [localRecording];
  const journalEntry = { id: localId, stage: "terminal", context: localRecording.context,
    terminal: { tempFilePath: "/tmp/recording.mp3", durationMs: 1200, fileSizeBytes: 4096 } };
  const page = createPage("src/pages/MyCheckIns/MyCheckIns.tsx", {}, {
    showModal: async () => ({ confirm: true }),
    showToast: (toast) => toasts.push(toast),
    overrides: {
      "@/features/listeningPractice/pendingCheckInRuntime": {
        getPendingCheckInStore: () => ({
          ready: async () => {}, cleanup: async () => {}, list: () => records,
          remove: async (id) => {
            events.push(`remove:${id}`);
            assert.equal(id, localId);
            records.length = 0;
            return true;
          },
        }),
        logRecordingDiagnostic: () => {},
      },
      "@/features/listeningPractice/recordingSessionJournal": {
        getRecordingSessionJournal: () => ({
          read: () => journalEntry,
          clear: (id) => { events.push(`clear:${id}`); return clearJournal(id); },
        }),
      },
      "@/features/listeningPractice/recorderCoordinator": {
        getRecorderCoordinator: () => ({ getPhase: () => "idle", abandonUnconfirmedRecording: () => {
          throw new Error("空闲录音器不应执行放弃操作");
        } }),
      },
      "@/features/listeningPractice/checkInSubmissionRuntime": {
        getCheckInSubmissionCoordinator: () => ({ isSubmitting: () => false }),
      },
      "@/services/cloudCheckIn": { listMyCheckIns: async () => [] },
    },
  });
  return { page, events, toasts, records };
};

(async () => {
  for (const clearJournal of [() => false, () => { throw new Error("journal write failed"); }]) {
    const scenario = createDeletionPage(clearJournal);
    scenario.page.render(); scenario.page.show(); await settle();
    await byClass(scenario.page.render(), "check-in-list-card__delete").props.onClick();
    assert.deepEqual(scenario.events, [`clear:${localId}`], "旧会话日志未清理时，不得删除已保存录音");
    assert.equal(scenario.records.length, 1, "清理失败后录音仍在列表中");
    assert.equal(scenario.toasts.at(-1)?.title, "删除失败，请稍后重试");
    scenario.page.dispose();
  }

  const success = createDeletionPage(() => true);
  success.page.render(); success.page.show(); await settle();
  await byClass(success.page.render(), "check-in-list-card__delete").props.onClick();
  assert.deepEqual(success.events, [`clear:${localId}`, `remove:${localId}`],
    "必须先清除同 ID 会话日志，再删除本地录音");
  assert.equal(success.records.length, 0);
  success.page.dispose();
  console.log("我的录音接线测试通过：本地优先、云端补充、详情与会话日志安全删除均已接入。");
})().catch((error) => { console.error(error); process.exitCode = 1; });
