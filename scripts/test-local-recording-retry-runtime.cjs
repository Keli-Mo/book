/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const vm = require("node:vm");
const { createPage, byClass, elements, textOf, buildBookPracticeBundle } = require("./test-practice-book-route.cjs");
const mod = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(require("node:path").join(__dirname, "../src/features/listeningPractice/pendingCheckInStore.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, { exports: mod.exports, module: mod });
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const button = (tree, label) => elements(tree).find(node => node.type === "Button" && textOf(node) === label);

(async () => {
  for (const kind of ["Practice", "CheckInDetail"]) {
   for (const failure of ["metadata", "file", "permission"]) {
    if (failure === "permission" && kind !== "Practice") continue;
    const bundle = buildBookPracticeBundle("22");
    const practice = bundle.practices[0];
    let writes = 0, saves = 0, uploads = 0, release;
    const gate = new Promise(resolve => { release = resolve; });
    let allowPermission;
    const permission = new Promise(resolve => { allowPermission = resolve; });
    const store = mod.exports.createPendingCheckInStore({
      storage: { get: () => [], set: async () => { writes++; if (failure !== "file" && writes === 1) throw new Error("metadata failed"); await gate; } },
      file: { usageBytes: () => 0, save: async () => { saves++; if (failure === "file" && saves === 1) throw new Error("save failed"); return { savedFilePath: "/saved/retry.mp3" }; }, exists: () => true, remove: () => { throw new Error("不得删除"); } },
      clock: { now: () => 100 }, random: { hex: () => "a".repeat(32) },
    });
    const saved = await store.saveRecording({ tempFilePath: "/tmp/retry.mp3", durationMs: 2000, fileSizeBytes: 20,
      context: { bookId: "22", bookTitle: bundle.book.title, practiceId: practice.id, practiceIndex: 0, pageNumber: practice.pageNumber, imageUrl: practice.imageUrl, sectionTitle: practice.sectionTitle } });
    const page = createPage(`src/pages/${kind}/${kind}.tsx`, kind === "Practice" ? { bookId: "22", practice: "0" } : { localId: saved.item.requestId }, {
      ...(failure === "permission" ? { getSetting: () => permission } : {}),
      overrides: {
        "@/features/listeningPractice/pendingCheckInRuntime": { getPendingCheckInStore: () => store, getActivePendingRecovery: () => undefined, logRecordingDiagnostic() {}, diagnoseLocalRecordingFailure() {} },
        "@/features/listeningPractice/checkInSubmissionRuntime": { getCheckInSubmissionCoordinator: () => ({ isSubmitting: () => false, getActive: () => undefined, submit: () => { uploads++; throw new Error("不得隐式上传"); } }) },
      },
    });
    page.render(); await settle(); let tree = page.render(); await settle(); tree = page.render();
    const retry = button(tree, "重试保存");
    assert.ok(retry, `${kind} 未持久录音必须提供重试保存`);
    await (kind === "Practice" ? button(tree, "回听录音") : byClass(tree, "shared-recording__play")).props.onClick();
    assert.ok(page.audios.some(audio => audio.src === saved.item.localPath), "失败后可回听当前真实路径");
    const earlierStart = failure === "permission" ? button(tree, "重新录制").props.onClick() : null;
    const attempt = retry.props.onClick();
    await retry.props.onClick();
    if (kind === "Practice") {
      if (failure !== "permission") await button(tree, "重新录制").props.onClick();
      await button(tree, "完成练习").props.onClick();
      assert.equal(page.recorderActions.some(action => action.action === "start"), false, "重试期间不得开麦");
    } else {
      await byClass(tree, "check-in-actions__share").props.onClick();
    }
    if (failure !== "permission") page.hide();
    await settle(); release(); await attempt;
    if (earlierStart) {
      allowPermission({ authSetting: { "scope.record": true } });
      await earlierStart;
      assert.equal(page.recorderActions.some(action => action.action === "start"), false, "重试成功后旧权限请求也不得迟到开麦");
    }
    assert.equal(uploads, 0, "重试和离页不得触发上传");
    assert.equal(saves, failure !== "file" ? 1 : 2, "仅临时路径才重新保存文件");
    assert.equal(writes, failure !== "file" ? 2 : 1, "重复点击必须互斥");
    page.show(); tree = page.render(); await settle(); tree = page.render();
    assert.equal(button(tree, "重试保存"), undefined, "返回后应读取最新持久快照");
    await (kind === "Practice" ? button(tree, "回听录音") : byClass(tree, "shared-recording__play")).props.onClick();
    assert.ok(page.audios.some(audio => audio.src === "/saved/retry.mp3"), "回听必须绑定保存后的路径");
    if (kind === "Practice") await button(tree, "完成练习").props.onClick();
    assert.equal(uploads, 0);
    page.dispose();
   }
  }
  console.log("真实页面重试保存通过：同 ID 恢复、互斥、离页、回听路径与零隐式上传。");
})().catch(error => { console.error(error); process.exitCode = 1; });
