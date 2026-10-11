/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const sourcePath = path.resolve(__dirname, "../src/features/listeningPractice/recordingSessionJournal.ts");
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const moduleContainer = { exports: {} };
vm.runInNewContext(compiled.outputText, {
  module: moduleContainer, exports: moduleContainer.exports,
  Math, Date, Object, Array, Number, String, RegExp, Error,
});
const { createRecordingSessionJournal, RECORDING_SESSION_JOURNAL_KEY } = moduleContainer.exports;

const context = {
  bookId: "book", bookTitle: "Book", practiceId: "a", practiceIndex: 2,
  pageNumber: 24, imageUrl: "https://example.com/a.png", sectionTitle: "Wrap Up",
};
const idA = "a".repeat(32);
const idB = "b".repeat(32);
const nativeStop = { tempFilePath: "wxfile://a.mp3", duration: 1200, fileSize: 3456 };
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const makeJournal = (config = {}) => {
  const state = { value: config.value, failGet: false, failSet: false, ignoreSet: false };
  const storage = {
    get(key) {
      assert.equal(key, RECORDING_SESSION_JOURNAL_KEY);
      if (state.failGet) throw Error("read failed");
      return clone(state.value);
    },
    set(key, value) {
      assert.equal(key, RECORDING_SESSION_JOURNAL_KEY);
      if (state.failSet) throw Error("write failed");
      if (!state.ignoreSet) state.value = clone(value);
    },
  };
  const journal = createRecordingSessionJournal({
    storage, clock: { now: () => 1000 }, random: { hex: () => idA },
  });
  return { journal, state };
};

// start 之前同步持久化 A 的归属；复制快照防止页面对象事后修改。
const first = makeJournal({ value: "" });
assert.equal(first.journal.read(), null);
const started = first.journal.begin(context);
assert.equal(started.stage, "starting");
assert.equal(started.id, idA);
assert.equal(first.state.value.context.pageNumber, 24);
started.context.pageNumber = 99;
assert.equal(first.journal.read().context.pageNumber, 24);
assert.throws(() => first.journal.begin(context), /上次录音仍待处理/);
assert.equal(first.journal.recordTerminal(idA, nativeStop), false, "未收到 onStart 时不能认领 onStop 文件");
assert.equal(first.journal.confirm(idB), false, "旧回调不能确认别的会话");
assert.equal(first.journal.confirm(idA), true);
assert.equal(first.journal.confirm(idA), true);
assert.equal(first.journal.read().stage, "confirmed");
assert.equal(first.journal.recordTerminal(idB, nativeStop), false);
assert.equal(first.journal.recordTerminal(idA, { ...nativeStop, fileSize: 0 }), false);
assert.equal(first.journal.read().stage, "confirmed");
assert.equal(first.journal.recordTerminal(idA, nativeStop), true);
assert.deepEqual(clone(first.journal.read().terminal), {
  tempFilePath: "wxfile://a.mp3", durationMs: 1200, fileSizeBytes: 3456,
});
assert.equal(first.journal.clear(idB), false, "迟到旧回调不能清理另一会话");
assert.equal(first.journal.clear(idA), true);
assert.equal(first.journal.read(), null);

// 放弃只落墓碑，锁的释放交给下一进程的恢复流程。
const second = makeJournal();
second.journal.begin(context);
assert.equal(second.journal.markAbandoned(idA), true);
assert.equal(second.journal.read().stage, "abandoned");
assert.equal(second.journal.confirm(idA), false);
assert.equal(second.journal.recordTerminal(idA, nativeStop), false);
assert.throws(() => second.journal.begin(context), /上次录音仍待处理/);
assert.equal(second.journal.clear(idA), true);

// 存储故障或损坏记录必须阻止新录音，不能误认为原生录音已结束。
const unreadable = makeJournal();
unreadable.state.failGet = true;
assert.throws(() => unreadable.journal.read(), /read failed/);
assert.throws(() => unreadable.journal.begin(context), /read failed/);
const unwritable = makeJournal();
unwritable.state.failSet = true;
assert.throws(() => unwritable.journal.begin(context), /write failed/);
const silentFailure = makeJournal();
silentFailure.state.ignoreSet = true;
assert.throws(() => silentFailure.journal.begin(context), /录音会话记录写入失败/);
const corrupt = makeJournal({ value: { version: 1, stage: "confirmed" } });
assert.throws(() => corrupt.journal.read(), /录音会话记录损坏/);
assert.throws(() => corrupt.journal.begin(context), /录音会话记录损坏/);
corrupt.journal.discardUnreadable();
assert.equal(corrupt.journal.read(), null);
assert.throws(() => unreadable.journal.discardUnreadable(), /read failed/, "无法验证清除结果时必须保持锁");

console.log("recording session journal tests passed");
