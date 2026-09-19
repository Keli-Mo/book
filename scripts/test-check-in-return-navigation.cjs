/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const { createPage, byClass, textOf, elements, buildBookPracticeBundle } = require("./test-practice-book-route.cjs");

const settle = async () => { for (let index = 0; index < 10; index += 1) await Promise.resolve(); };
const pages = [];
const page = (...args) => { const result = createPage(...args); pages.push(result); return result; };

(async () => {
  // 使用真实教材组件完成录音；故意翻到与入口路由不同的页，不能靠原始 URL 猜回跳页码。
  const practice = page("src/pages/Practice/Practice.tsx", { bookId: "22", practice: "0" }, { savedFilePath: "/saved/return-test.mp3" });
  practice.render();
  let tree = practice.render();
  await elements(tree).find((node) => node.type?.name === "PracticeDirectory").props.onSelect(4);
  tree = practice.render();
  await byClass(tree, "record-button").props.onClick();
  practice.recorderHandlers.Start();
  tree = practice.render();
  byClass(tree, "record-button--stop").props.onClick();
  await practice.recorderHandlers.Stop({ tempFilePath: "/tmp/return-test.mp3", duration: 1800, fileSize: 5000 });
  await settle();
  await byClass(practice.render(), "check-in-button").props.onClick();
  assert.equal(practice.navigationMethods.at(-1), "navigateTo", "完成录音不能 redirectTo 移除原教材页，否则原生返回会落到书架");

  const params = Object.fromEntries(new URLSearchParams(practice.navigations.at(-1).split("?")[1]));
  assert.equal(params.fromPractice, "1", "详情需要识别保留的训练页，避免继续跟读时重复压栈并抢占录音器");
  const pending = {
    requestId: params.localId, localPath: "/saved/return-test.mp3", recoverable: true,
    context: practice.savedRecordings[0].context, durationMs: 1800, fileSizeBytes: 5000,
    cloudFileId: "", status: "local", updatedAtMs: 1, completedAtMs: 2,
  };
  const overrides = {
    "@/features/listeningPractice/pendingCheckInRuntime": { getPendingCheckInStore: () => ({ ready: async () => {}, list: () => [pending] }), getActivePendingRecovery: () => undefined, logRecordingDiagnostic() {}, diagnoseLocalRecordingFailure() {} },
  };
  const pageStack = [{ route: "pages/BookLibrary/BookLibrary" }, { route: "pages/Practice/Practice" }, { route: "pages/CheckInDetail/CheckInDetail" }];
  practice.hide();
  const detail = page("src/pages/CheckInDetail/CheckInDetail.tsx", params, { overrides, pageStack });
  detail.render(); await settle(); tree = detail.render();
  await byClass(tree, "shared-recording__play").props.onClick();
  const playbackAudio = detail.audios.findLast((audio) => audio.src === pending.localPath);
  assert.ok(playbackAudio, "应通过保存路径找到实际回听原生实例");
  assert.equal(playbackAudio.events.at(-1), "play", "实际回听原生实例必须已开始播放");
  await byClass(tree, "check-in-actions__practice").props.onClick();
  assert.equal(detail.navigationMethods.at(-1), "navigateBack", "继续跟读应复用原训练页，不新建抢占录音器的第二个训练页");

  // 按微信返回的生命周期顺序卸载详情、重新显示栈内原页；原生箭头与 navigateBack 使用同一栈语义。
  detail.hide();
  tree = detail.render();
  assert.equal(playbackAudio.events.filter((event) => event === "destroy").length, 1, "隐藏详情应恰好销毁当前回听实例");
  assert.equal(textOf(byClass(tree, "shared-recording__play")), "▶播放本次跟读", "隐藏详情应恢复播放按钮");
  assert.doesNotMatch(textOf(byClass(tree, "shared-recording__duration")), / \/ /, "隐藏详情不得显示播放中的当前/总时长");
  const audioCountAfterHide = detail.audios.length;
  detail.unload(); detail.dispose();
  assert.equal(playbackAudio.events.filter((event) => event === "destroy").length, 1, "卸载和销毁后不得重复销毁回听实例");
  assert.equal(detail.audios.length, audioCountAfterHide, "卸载和销毁后不得创建新的回听实例");
  practice.show(); practice.render(); await settle(); tree = practice.render();
  const bundle = buildBookPracticeBundle("22");
  assert.equal(byClass(tree, "practice-book-page__image").props.src, bundle.practices[4].imageUrl, "返回必须保留翻页后的教材图片");
  assert.equal(textOf(byClass(tree, "practice-header__course")), bundle.book.title);
  assert.equal(textOf(byClass(tree, "practice-header__progress")).trim(), `跟读训练 5 / ${bundle.practices.length}`);
  assert.equal(byClass(tree, "check-in-button"), undefined, "完成的录音不能被恢复为待完成草稿");
  const startsBefore = practice.recorderActions.filter(({ action }) => action === "start").length;
  await byClass(tree, "record-button").props.onClick();
  assert.equal(practice.recorderActions.filter(({ action }) => action === "start").length, startsBefore + 1, "回到原教材后必须仍可开启新录音");
  assert.equal(practice.submittedPending.length, 0, "返回路径不能触发云端上传");

  // 显式首页按钮仍回首页；历史/分享入口或来源标记失去页面栈时不能误退到不相关页面。
  for (const [route, stack] of [[params, pageStack], [{ localId: params.localId }, pageStack], [params, []]]) {
    const other = page("src/pages/CheckInDetail/CheckInDetail.tsx", route, { overrides, pageStack: stack });
    other.render(); await settle(); const otherTree = other.render();
    await byClass(otherTree, "check-in-detail__home").props.onClick();
    assert.equal(other.navigationMethods.at(-1), "reLaunch");
    assert.equal(other.navigations.at(-1), "/pages/Home/Home");
    if (route.fromPractice !== "1" || stack.length === 0) {
      await byClass(otherTree, "check-in-actions__practice").props.onClick();
      assert.equal(other.navigationMethods.at(-1), "navigateTo");
      assert.equal(other.navigations.at(-1), "/pages/Practice/Practice?bookId=22&practice=4");
    }
  }
  console.log("打卡返回测试通过：原书原页、继续录音、停止回听、显式首页与独立分享入口。");
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => pages.forEach((item) => item.dispose()));
