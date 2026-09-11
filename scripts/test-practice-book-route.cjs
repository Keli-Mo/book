/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const projectRoot = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(projectRoot, file), "utf8");
const compiled = new Map();
const load = (file, overrides = {}, cache = new Map()) => {
  if (cache.has(file)) return cache.get(file);
  if (!compiled.has(file)) {
    compiled.set(file, ts.transpileModule(read(file), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    }).outputText);
  }
  const loaded = { exports: {} };
  cache.set(file, loaded.exports);
  new Function(
    "module",
    "exports",
    "require",
    "wx",
    "setTimeout",
    "clearTimeout",
    compiled.get(file),
  )(
    loaded, loaded.exports, (request) => {
      if (Object.hasOwn(overrides, request)) return overrides[request];
      if (request.endsWith(".scss")) return {};
      if (request.startsWith("@/") || request.startsWith(".")) {
        const base = request.startsWith("@/") ? `src/${request.slice(2)}` : path.join(path.dirname(file), request);
        const target = [base, `${base}.ts`, `${base}.tsx`].find((candidate) => fs.existsSync(path.join(projectRoot, candidate)));
        assert.ok(target, `依赖必须存在：${request}`);
        return load(target, overrides, cache);
      }
      return require(request);
    },
    overrides.wx,
    overrides.__setTimeout || setTimeout,
    overrides.__clearTimeout || clearTimeout,
  );
  return loaded.exports;
};
const { buildBookPracticeBundle } = load("src/features/listeningPractice/bookPractice.ts");
const { requestRecorderAction, resolveRecorderCallback } = load("src/features/listeningPractice/recordingStateMachine.ts");

// 仅替换 React/Taro 调度与录音持久化、提交边界；路由、bundle、目录、音频控制器及点击回调都执行生产代码。
const createPage = (file, params, options = {}) => {
  let frame;
  let slot;
  const frames = new Map();
  const effects = [];
  const navigations = [];
  const navigationMethods = [];
  const audios = [];
  const recorderActions = [];
  const permissionChecks = [];
  const recorderHandlers = {};
  const savedRecordings = [];
  const submittedPending = [];
  const recorderReleaseCalls = [];
  const recorderTerminalOutcomes = [];
  const pendingItems = [...(options.pendingItems || [])];
  let activeRecorder = null;
  let acquireAttempts = 0;
  const hook = (initial) => {
    const index = slot++;
    if (!frame.slots[index]) frame.slots[index] = initial();
    return frame.slots[index];
  };
  const changed = (before, after) => !before || !after || before.length !== after.length || after.some((item, i) => !Object.is(item, before[i]));
  const react = {
    useState(initial) {
      const state = hook(() => ({ value: typeof initial === "function" ? initial() : initial }));
      return [state.value, (value) => { state.value = typeof value === "function" ? value(state.value) : value; }];
    },
    useRef(initial) { return hook(() => ({ current: initial })); },
    useMemo(factory, deps) {
      const memo = hook(() => ({}));
      if (changed(memo.deps, deps)) { memo.value = factory(); memo.deps = deps; }
      return memo.value;
    },
    useCallback(callback, deps) {
      const memo = hook(() => ({}));
      if (changed(memo.deps, deps)) { memo.value = callback; memo.deps = deps; }
      return memo.value;
    },
    useEffect(callback, deps) {
      const effect = hook(() => ({}));
      if (changed(effect.deps, deps)) {
        effects.push(() => { effect.cleanup?.(); effect.cleanup = callback(); });
        effect.deps = deps;
      }
    },
  };
  const taro = {
    useRouter: () => ({ params }),
    useDidShow(callback) { frame.show = callback; },
    useDidHide(callback) { frame.hide = callback; },
    useUnload(callback) { frame.unload = callback; },
    useShareAppMessage() {},
    navigateTo: async ({ url }) => { navigations.push(url); navigationMethods.push("navigateTo"); },
    redirectTo: async ({ url }) => { navigations.push(url); navigationMethods.push("redirectTo"); },
    reLaunch: async ({ url }) => { navigations.push(url); },
    showToast() {}, showLoading() {}, hideLoading() {}, pageScrollTo() {},
    showModal: async () => ({ confirm: true }),
    getSetting: async () => {
      permissionChecks.push("scope.record:granted");
      return { authSetting: { "scope.record": true } };
    },
    openSetting: async () => ({ authSetting: { "scope.record": true } }),
    authorize: async () => {},
    createInnerAudioContext() {
      const handlers = {};
      const audio = { src: "", events: [], currentTime: 0 };
      for (const event of ["Play", "Ended", "Stop", "Error", "TimeUpdate"]) audio[`on${event}`] = (callback) => { handlers[event] = callback; };
      audio.play = () => { audio.events.push("play"); handlers.Play?.(); };
      audio.stop = () => { audio.events.push("stop"); handlers.Stop?.(); };
      audio.destroy = () => { audio.events.push("destroy"); };
      audios.push(audio);
      return audio;
    },
  };
  const recorderCoordinator = {
    acquire() {
      const acquireSequence = options.acquireSequence || ["ok"];
      const outcome = acquireSequence[Math.min(acquireAttempts, acquireSequence.length - 1)];
      acquireAttempts += 1;
      if (outcome === "busy") return { ok: false, reason: "busy", phase: "draining" };
      if (outcome === "unavailable") return { ok: false, reason: "unavailable" };
      const session = { listener: null, detachedTerminalSink: null, phase: "idle", released: false };
      const succeed = (action, actionOptions) => {
        recorderActions.push(actionOptions === undefined ? { action } : { action, options: actionOptions });
        session.phase = action === "start" ? "starting" : action === "stop" ? "stopping" : action === "pause" ? "paused" : "recording";
        return { ok: true };
      };
      const owner = {
        start: (recordingOptions) => succeed("start", recordingOptions),
        pause: () => succeed("pause"),
        resume: () => succeed("resume"),
        stop: () => succeed("stop"),
        release(releaseOptions) {
          recorderReleaseCalls.push(releaseOptions);
          session.detachedTerminalSink = releaseOptions?.terminalSink || null;
          if (["starting", "recording", "paused"].includes(session.phase)) {
            succeed("stop");
          }
          session.listener = null;
          session.released = true;
          return { ok: true, phase: session.phase === "idle" ? "idle" : "draining" };
        },
        subscribe(listener) {
          session.listener = listener;
          return { ok: true, unsubscribe: () => { if (session.listener === listener) session.listener = null; } };
        },
      };
      session.owner = owner;
      activeRecorder = session;
      return {
        ok: true,
        owner,
        capabilities: options.recorderCapabilities || {
          canRecord: true,
          canPause: true,
          canResume: true,
          canInterrupt: true,
        },
      };
    },
    getPhase: () => activeRecorder?.phase || "idle",
  };
  const dispatchRecorder = (event, value) => {
    const session = activeRecorder;
    const terminalEvent = event === "Stop" || event === "Error";
    assert.ok(
      session?.listener || (terminalEvent && session?.detachedTerminalSink),
      `录音事件 ${event} 必须由页面 listener 或卸载后的 terminal sink 接收`,
    );
    if (event === "Start") session.phase = "recording";
    if (event === "Pause") session.phase = "paused";
    if (event === "Resume") session.phase = "recording";
    if (event === "Stop" || event === "Error") session.phase = "idle";
    if (session.listener) return session.listener[`on${event}`]?.(value);
    const terminalSink = session.detachedTerminalSink;
    session.detachedTerminalSink = null;
    const outcome = terminalSink(
      event === "Stop" ? { type: "stop", result: value } : { type: "error", error: value },
    );
    recorderTerminalOutcomes.push(outcome);
    return outcome;
  };
  const primeLegacyStop = () => {
    for (const currentFrame of frames.values()) {
      const stateSlot = currentFrame.slots.find((item) => item?.value?.state === "idle" && item.value.capabilities?.canRecord);
      if (!stateSlot) continue;
      const refSlot = currentFrame.slots.find((item) => item?.current === stateSlot.value);
      assert.ok(refSlot, "录音状态 ref 必须与视图状态同步");
      const startedRequest = requestRecorderAction(stateSlot.value, "start");
      assert.ok(startedRequest.command, "旧 Stop 兼容入口必须能启动录音状态机");
      const started = resolveRecorderCallback(startedRequest.machine, {
        type: "start",
        sessionId: startedRequest.command.sessionId,
        operationSeq: startedRequest.command.operationSeq,
      });
      const stoppedRequest = requestRecorderAction(started, "stop");
      assert.ok(stoppedRequest.command, "旧 Stop 兼容入口必须能停止录音状态机");
      stateSlot.value = stoppedRequest.machine;
      refSlot.current = stoppedRequest.machine;
      return;
    }
    assert.fail("旧 Stop 兼容入口找不到 idle 录音状态机");
  };
  for (const event of ["Start", "Pause", "Resume", "Stop", "Error"]) {
    recorderHandlers[event] = (value) => {
      // 旧的音频生命周期回归直接投递 Stop；为它补齐一条合法的录音会话，
      // 路由主测试仍显式驱动 start -> Start -> stop -> Stop 全链路。
      if (event === "Stop" && activeRecorder?.phase === "idle") {
        primeLegacyStop();
        activeRecorder.owner.start({});
        activeRecorder.owner.stop();
      }
      const result = event === "Stop" && value?.fileSize === undefined
        ? { ...value, fileSize: 4096 }
        : value;
      return dispatchRecorder(event, result);
    };
  }
  recorderHandlers.InterruptionBegin = () => activeRecorder?.listener?.onInterruptionBegin?.();
  recorderHandlers.InterruptionEnd = () => activeRecorder?.listener?.onInterruptionEnd?.();
  const immediate = (value) => {
    const chain = {
      then(callback) { callback(value); return chain; },
      catch() { return chain; },
      finally(callback) { callback(); return chain; },
    };
    return chain;
  };
  const pendingStore = {
    ready: options.pendingReady || (async () => {}),
    cleanup: options.pendingCleanup || (async () => {}),
    list: () => pendingItems,
    saveRecording(input) {
      savedRecordings.push(input);
      const item = {
        requestId: "0123456789abcdef0123456789abcdef",
        localPath: options.savedFilePath || input.tempFilePath,
        recoverable: Boolean(options.savedFilePath),
        context: input.context,
        durationMs: input.durationMs,
        fileSizeBytes: input.fileSizeBytes,
        cloudFileId: "",
        status: "local",
        updatedAtMs: 1,
      };
      pendingItems.push(item);
      return immediate({ item, persisted: item.recoverable, message: "" });
    },
    async remove(requestId) {
      const index = pendingItems.findIndex((item) => item.requestId === requestId);
      if (index < 0) return false;
      pendingItems.splice(index, 1);
      return true;
    },
  };
  const submissionCoordinator = {
    submit(pending) {
      submittedPending.push(pending);
      const index = pendingItems.findIndex((item) => item.requestId === pending.requestId);
      if (index >= 0) pendingItems.splice(index, 1);
      return {
        promise: Promise.resolve({ state: "committed", id: "record&1", shareToken: "token&1", cleanupPending: false }),
        cancel: () => false,
      };
    },
  };
  const overrides = {
    react,
    "@tarojs/components": Object.fromEntries(["View", "Text", "Image", "Button", "ScrollView"].map((name) => [name, name])),
    "@tarojs/taro": { __esModule: true, default: taro, ...taro },
    "@/constant": { sharedImage: "share.png" },
    "@/services/cloudCheckIn": {
      getCheckInDetail: async () => options.detail,
      getReadableCloudError: (error) => error.message,
    },
    "@/features/listeningPractice/recorderCoordinator": { getRecorderCoordinator: () => recorderCoordinator },
    "@/features/listeningPractice/pendingCheckInRuntime": { getPendingCheckInStore: () => pendingStore },
    "@/features/listeningPractice/checkInSubmissionRuntime": { getCheckInSubmissionCoordinator: () => submissionCoordinator },
    wx: {},
    __setTimeout: options.setTimeout,
    __clearTimeout: options.clearTimeout,
    ...options.overrides,
  };
  const Component = load(file, overrides).default;
  let tree;
  const renderNode = (node, location) => {
    if (Array.isArray(node)) return node.map((child, index) => renderNode(child, `${location}/${index}`));
    if (!node || typeof node !== "object") return node;
    if (typeof node.type === "function") {
      const id = `${location}/${node.type.name}:${node.key || ""}`;
      if (!frames.has(id)) frames.set(id, { slots: [] });
      frame = frames.get(id);
      frame.used = true;
      slot = 0;
      const result = node.type(node.props);
      return { ...node, props: { ...node.props, children: renderNode(result, id) } };
    }
    return { ...node, props: { ...node.props, children: renderNode(node.props?.children, location) } };
  };
  const render = () => {
    for (const current of frames.values()) current.used = false;
    tree = renderNode({ type: Component, props: {} }, "root");
    for (const [id, current] of frames) {
      if (!current.used) {
        for (const item of current.slots) item.cleanup?.();
        frames.delete(id);
      }
    }
    effects.splice(0).forEach((effect) => effect());
    return tree;
  };
  return {
    render, navigations, navigationMethods, audios, recorderHandlers, recorderActions, permissionChecks, savedRecordings, submittedPending,
    recorderReleaseCalls, recorderTerminalOutcomes,
    get acquireAttempts() { return acquireAttempts; },
    stateValues() {
      return [...frames.values()].flatMap((current) =>
        current.slots.filter((item) => Object.hasOwn(item, "value")).map((item) => item.value),
      );
    },
    setRoute(next) { params = next; return render(); },
    show() { for (const current of frames.values()) current.show?.(); },
    hide() { for (const current of frames.values()) current.hide?.(); },
    unload() { for (const current of frames.values()) current.unload?.(); },
  };
};
const elements = (node) => Array.isArray(node) ? node.flatMap(elements) : node && typeof node === "object" ? [node, ...elements(node.props?.children)] : [];
const textOf = (node) => Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" ? textOf(node.props?.children) : node == null || typeof node === "boolean" ? "" : String(node);
const byClass = (tree, name) => elements(tree).find((node) => String(node.props?.className || "").split(" ").includes(name));
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const createFakeTimers = () => {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(callback, delay = 0) {
      const id = nextId++;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const target = now + ms;
      while (true) {
        const ready = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (!ready) break;
        const [id, timer] = ready;
        timers.delete(id);
        now = timer.at;
        timer.callback();
      }
      now = target;
    },
    get size() { return timers.size; },
  };
};

async function testRoutes() {
  const practiceSource = read("src/pages/Practice/Practice.tsx");
  assert.doesNotMatch(practiceSource, /SAMPLE_BOOK_(?:ID|TITLE|COVER|PRACTICES)|book3Practice/, "Practice 必须移除固定 CASA 模型，改为实际 router 选择教材");
  assert.doesNotMatch(practiceSource, /DEFAULT_BOOK_ID/, "训练页不得自行猜默认教材");
  assert.equal(fs.existsSync(path.join(projectRoot, "src/features/listeningPractice/book3Practice.ts")), false, "固定 CASA 死文件应在替换引用后删除");
  for (const bookId of ["3", "22", "25"]) {
    const bundle = buildBookPracticeBundle(bookId);
    for (const index of [0, bundle.practices.length - 1]) {
      const page = createPage("src/pages/Practice/Practice.tsx", { bookId, practice: String(index) }, { savedFilePath: "/saved/recording.mp3" });
      let tree = page.render();
      const practice = bundle.practices[index];
      assert.equal(textOf(byClass(tree, "practice-header__course")), bundle.book.title);
      assert.equal(textOf(byClass(tree, "practice-header__progress")).trim(), `跟读训练 ${index + 1} / ${bundle.practices.length}`);
      assert.equal(byClass(tree, "practice-book-page__image").props.src, practice.imageUrl);
      assert.equal(textOf(byClass(tree, "practice-header__section")), practice.sectionTitle);
      const hotspots = elements(tree).filter((node) => String(node.props?.className || "").split(" ").includes("audio-hotspot"));
      assert.equal(hotspots.length, practice.tracks.length);
      assert.deepEqual(hotspots[0].props.style, { left: practice.tracks[0].left, top: practice.tracks[0].top });
      hotspots[0].props.onClick();
      assert.equal(page.audios.at(-1).src, practice.tracks[0].url);
      const directory = elements(tree).find((node) => node.type?.name === "PracticeDirectory");
      assert.deepEqual(directory.props.groups.flatMap((group) => group.items).map((item) => item.id), bundle.practices.map((item) => item.id));
      await directory.props.onSelect(bundle.practices.length);
      await directory.props.onSelect(-1);
      await directory.props.onSelect(0.5);
      assert.equal(textOf(byClass(page.render(), "practice-header__progress")).trim(), `跟读训练 ${index + 1} / ${bundle.practices.length}`, "目录越界不能破坏当前训练");
      const navigation = () => elements(page.render()).filter((node) => String(node.props?.className || "").split(" ").includes("practice-navigation__button"));
      const boundaryButton = index === 0 ? 0 : 1;
      assert.match(navigation()[boundaryButton].props.className, /practice-navigation__button--disabled/);
      await navigation()[boundaryButton].props.onClick();
      assert.equal(byClass(page.render(), "practice-book-page__image").props.src, practice.imageUrl, "首尾点击不能夹页或跨教材");
      await navigation()[1 - boundaryButton].props.onClick();
      const adjacent = index === 0 ? 1 : index - 1;
      assert.equal(byClass(page.render(), "practice-book-page__image").props.src, bundle.practices[adjacent].imageUrl, "上下页应在当前 bundle 内切换");
      await navigation()[boundaryButton].props.onClick();
      tree = page.render();
      const startButton = elements(tree).find((node) => node.type === "Button" && textOf(node).includes("开始跟读录音"));
      assert.ok(startButton, "录音能力确认后应显示开始按钮");
      await startButton.props.onClick();
      assert.deepEqual(page.permissionChecks, ["scope.record:granted"], "开始录音前必须确认麦克风已授权");
      assert.deepEqual(page.recorderActions[0], {
        action: "start",
        options: { duration: 300000, sampleRate: 16000, numberOfChannels: 1, encodeBitRate: 48000, format: "mp3" },
      }, "点击开始必须把生产录音参数交给 recorder owner");
      page.recorderHandlers.Start();
      tree = page.render();
      const stopButton = elements(tree).find((node) => node.type === "Button" && textOf(node) === "结束录音");
      assert.ok(stopButton, "原生 Start 回调后应进入录音态");
      stopButton.props.onClick();
      assert.equal(page.recorderActions.at(-1).action, "stop", "结束按钮必须请求原生 stop");
      page.recorderHandlers.Stop({ tempFilePath: "/tmp/recording.mp3", duration: 1200, fileSize: 4096 });
      await settle();
      tree = page.render();
      const context = {
        bookId, bookTitle: bundle.book.title, practiceId: practice.id,
        practiceIndex: index, pageNumber: practice.pageNumber,
        sectionTitle: practice.sectionTitle, imageUrl: practice.imageUrl,
      };
      assert.deepEqual(page.savedRecordings[0], {
        tempFilePath: "/tmp/recording.mp3",
        durationMs: 1200,
        fileSizeBytes: 4096,
        context,
      }, "原生 Stop 元数据与当前训练上下文必须先交给本地 pending store");
      await byClass(tree, "check-in-button").props.onClick();
      assert.deepEqual(page.submittedPending[0], {
        requestId: "0123456789abcdef0123456789abcdef",
        localPath: "/saved/recording.mp3",
        recoverable: true,
        context,
        durationMs: 1200,
        fileSizeBytes: 4096,
        cloudFileId: "",
        status: "local",
        updatedAtMs: 1,
      }, "提交 coordinator 必须收到本地保存后的完整 pending 记录");
      assert.equal(page.navigations.at(-1), "/pages/CheckInDetail/CheckInDetail?id=record%261&token=token%261");
      assert.equal(page.navigationMethods.at(-1), "redirectTo", "打卡成功必须替换训练页，确保旧页面卸载并释放录音 owner");
    }
  }

  const hiddenWhileStarting = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { savedFilePath: "/saved/hidden-start.mp3" },
  );
  let hiddenStartingTree = hiddenWhileStarting.render();
  hiddenStartingTree = hiddenWhileStarting.render();
  await byClass(hiddenStartingTree, "record-button").props.onClick();
  assert.equal(hiddenWhileStarting.recorderActions.at(-1).action, "start");
  hiddenWhileStarting.hide();
  assert.equal(hiddenWhileStarting.recorderActions.at(-1).action, "stop", "start 尚未确认时切后台也必须覆盖为安全 stop");
  hiddenWhileStarting.recorderHandlers.Stop({
    tempFilePath: "/tmp/hidden-start.mp3",
    duration: 1700,
    fileSize: 5000,
  });
  await settle();
  assert.equal(hiddenWhileStarting.savedRecordings.length, 1, "后台收口 start 后的有效 Stop 仍必须保存到本地队列");

  const hiddenWhileResuming = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
  );
  let hiddenResumeTree = hiddenWhileResuming.render();
  hiddenResumeTree = hiddenWhileResuming.render();
  await byClass(hiddenResumeTree, "record-button").props.onClick();
  hiddenWhileResuming.recorderHandlers.Start();
  hiddenResumeTree = hiddenWhileResuming.render();
  byClass(hiddenResumeTree, "record-button--pause").props.onClick();
  hiddenWhileResuming.recorderHandlers.Pause();
  hiddenResumeTree = hiddenWhileResuming.render();
  byClass(hiddenResumeTree, "record-button--resume").props.onClick();
  hiddenWhileResuming.hide();
  hiddenWhileResuming.recorderHandlers.Resume();
  assert.equal(hiddenWhileResuming.recorderActions.at(-1).action, "pause", "隐藏后迟到的 Resume 确认必须立即再次暂停");

  const hiddenResumeWithoutPause = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { recorderCapabilities: { canRecord: true, canPause: false, canResume: true, canInterrupt: true } },
  );
  let noPauseTree = hiddenResumeWithoutPause.render();
  noPauseTree = hiddenResumeWithoutPause.render();
  await byClass(noPauseTree, "record-button").props.onClick();
  hiddenResumeWithoutPause.recorderHandlers.Start();
  hiddenResumeWithoutPause.recorderHandlers.InterruptionBegin();
  hiddenResumeWithoutPause.recorderHandlers.Pause();
  noPauseTree = hiddenResumeWithoutPause.render();
  byClass(noPauseTree, "record-button--resume").props.onClick();
  hiddenResumeWithoutPause.hide();
  hiddenResumeWithoutPause.recorderHandlers.Resume();
  assert.equal(hiddenResumeWithoutPause.recorderActions.at(-1).action, "stop", "不能暂停的设备收到后台 Resume 时必须安全停止");

  const retryTimers = createFakeTimers();
  const busyPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      acquireSequence: ["busy", "busy", "ok"],
      setTimeout: retryTimers.setTimeout,
      clearTimeout: retryTimers.clearTimeout,
    },
  );
  let busyTree = busyPage.render();
  busyTree = busyPage.render();
  assert.match(textOf(busyTree), /录音设备正在收尾/, "busy 应保持检测态并解释正在收尾，不能误报设备不支持");
  assert.equal(busyPage.acquireAttempts, 1);
  retryTimers.advance(299);
  assert.equal(busyPage.acquireAttempts, 1, "重试间隔未到不得频繁抢占录音器");
  retryTimers.advance(1);
  busyPage.render();
  assert.equal(busyPage.acquireAttempts, 2);
  retryTimers.advance(300);
  busyPage.render();
  assert.equal(busyPage.acquireAttempts, 3);
  busyTree = busyPage.render();
  assert.ok(byClass(busyTree, "record-button"), "旧录音器释放后应自动恢复录音入口");

  const cleanupTimers = createFakeTimers();
  const abandonedBusyPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      acquireSequence: ["busy"],
      setTimeout: cleanupTimers.setTimeout,
      clearTimeout: cleanupTimers.clearTimeout,
    },
  );
  abandonedBusyPage.render();
  assert.equal(cleanupTimers.size, 1);
  abandonedBusyPage.setRoute({});
  assert.equal(cleanupTimers.size, 0, "训练页卸载必须清除 recorder acquire 重试 timer");
  cleanupTimers.advance(1000);
  assert.equal(abandonedBusyPage.acquireAttempts, 1, "卸载后不得继续获取全局录音器");

  const unavailablePage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { acquireSequence: ["unavailable"] },
  );
  unavailablePage.render();
  assert.match(textOf(unavailablePage.render()), /暂不支持跟读录音/, "只有 unavailable 才应显示不支持录音");

  const restoredContext = buildBookPracticeBundle("22").practices[0];
  const oldPending = {
    requestId: "oldpending0123456789abcdef01234567",
    localPath: "/saved/old.mp3",
    recoverable: true,
    context: {
      bookId: "22",
      bookTitle: buildBookPracticeBundle("22").book.title,
      practiceId: restoredContext.id,
      practiceIndex: 0,
      pageNumber: restoredContext.pageNumber,
      sectionTitle: restoredContext.sectionTitle,
      imageUrl: restoredContext.imageUrl,
    },
    durationMs: 900,
    fileSizeBytes: 3000,
    cloudFileId: "",
    status: "local",
    updatedAtMs: 1,
  };
  const delayedReady = deferred();
  const readyRacePage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { pendingItems: [oldPending], pendingReady: () => delayedReady.promise },
  );
  let readyRaceTree = readyRacePage.render();
  readyRaceTree = readyRacePage.render();
  await byClass(readyRaceTree, "record-button").props.onClick();
  delayedReady.resolve();
  await settle();
  assert.equal(
    readyRacePage.stateValues().some((value) => value?.requestId === oldPending.requestId),
    false,
    "ready 等待期间启动新 session 后，不得把旧 pending 挂回当前页面",
  );

  const delayedCleanup = deferred();
  const cleanupRacePage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { pendingItems: [oldPending], pendingCleanup: () => delayedCleanup.promise },
  );
  let cleanupRaceTree = cleanupRacePage.render();
  cleanupRaceTree = cleanupRacePage.render();
  await settle();
  await byClass(cleanupRaceTree, "record-button").props.onClick();
  delayedCleanup.resolve();
  await settle();
  assert.equal(
    cleanupRacePage.stateValues().some((value) => value?.requestId === oldPending.requestId),
    false,
    "cleanup 等待期间启动新 session 后，旧 pending 只能留在 store",
  );

  const leavingTimers = createFakeTimers();
  const leavingPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      savedFilePath: "/saved/leaving.mp3",
      setTimeout: leavingTimers.setTimeout,
      clearTimeout: leavingTimers.clearTimeout,
    },
  );
  let leavingTree = leavingPage.render();
  leavingTree = leavingPage.render();
  await byClass(leavingTree, "record-button").props.onClick();
  leavingPage.recorderHandlers.Start();
  leavingPage.hide();
  assert.equal(leavingPage.recorderActions.at(-1).action, "pause", "页面隐藏应优先暂停录音");
  leavingPage.unload();
  assert.equal(leavingPage.recorderActions.at(-1).action, "stop", "页面真正卸载前必须收口录音");
  assert.equal(leavingPage.recorderReleaseCalls.length, 1, "卸载时必须立即把 owner 交还给全局协调器");
  assert.equal(
    typeof leavingPage.recorderReleaseCalls[0]?.terminalSink,
    "function",
    "卸载活动录音时必须托管一次 terminal sink",
  );
  assert.equal(leavingTimers.size, 0, "页面不得再用 8 秒硬截止撤销唯一 stop 消费器");
  leavingTimers.advance(9000);
  await leavingPage.recorderHandlers.Stop({
    tempFilePath: "/tmp/leaving.mp3",
    duration: 2300,
    fileSize: 8192,
  });
  await settle();
  assert.equal(leavingPage.savedRecordings.length, 1, "离页 stop 结果仍必须进入本地待上传队列");
  assert.equal(leavingPage.savedRecordings[0].durationMs, 2300);
  assert.equal(
    typeof leavingPage.recorderTerminalOutcomes[0]?.then,
    "function",
    "terminal sink 必须把异步本地持久化 Promise 交还协调器等待",
  );

  const invalidRoutes = [{}, { practice: "0" }, { bookId: "3" }, { bookId: "unknown", practice: "0" }];
  for (const bookId of ["3", "22", "25"]) {
    for (const practice of ["", " ", "-1", "1.5", "NaN", "Infinity", "1e1", "0x1", "01", "9007199254740992", String(buildBookPracticeBundle(bookId).practices.length)]) invalidRoutes.push({ bookId, practice });
  }
  for (const params of invalidRoutes) {
    const page = createPage("src/pages/Practice/Practice.tsx", params);
    const tree = page.render();
    assert.equal(byClass(tree, "practice-page"), undefined, `非法路由不能夹到首尾：${JSON.stringify(params)}`);
    const button = elements(tree).find((node) => node.type === "Button" && textOf(node) === "选择教材");
    assert.ok(button, "非法路由应有可恢复的书库入口");
    button.props.onClick();
    assert.equal(page.navigations.at(-1), "/pages/BookLibrary/BookLibrary");
    assert.equal(page.audios.length, 0, "非法路由不能初始化录音会话");
  }
  const broken = createPage("src/pages/Practice/Practice.tsx", { bookId: "22", practice: "0" }, {
    overrides: { "@/features/listeningPractice/bookPractice": { buildBookPracticeBundle() { throw new Error("教材 22 第 2 页：缺少图片"); } } },
  });
  assert.match(textOf(broken.render()), /教材 22 第 2 页：缺少图片/);

  for (const bookId of ["3", "22", "25"]) {
    const bundle = buildBookPracticeBundle(bookId);
    for (const practiceIndex of [0, bundle.practices.length - 1, undefined, -1, 0.5, "0", bundle.practices.length]) {
      await testHistory({ bookId, practiceIndex }, Number.isInteger(practiceIndex) && practiceIndex >= 0 && practiceIndex < bundle.practices.length);
    }
  }
  await testHistory({}, false);
  await testHistory({ bookId: "unknown", practiceIndex: 0 }, false);
  await testHistory({ bookId: "book &1", practiceIndex: 0 }, true, { "@/features/listeningPractice/bookPractice": { buildBookPracticeBundle: () => buildBookPracticeBundle("22") } });
  await testHistory({ bookId: "22", practiceIndex: 0 }, false, { "@/features/listeningPractice/bookPractice": { buildBookPracticeBundle() { throw new Error("损坏教材"); } } });
  const { BOOKS, resolveBookAction } = load("src/features/bookLibrary/bookCatalog.ts");
  for (const book of BOOKS) assert.equal(resolveBookAction(book).url, `/pages/Practice/Practice?bookId=${encodeURIComponent(book.id)}&practice=0`);
  assert.equal(resolveBookAction({ ...BOOKS[0], id: "book &1" }).url, "/pages/Practice/Practice?bookId=book%20%261&practice=0");
  console.log("教材路由测试通过：真实路由、首尾边界、恢复页、教材内容、打卡与历史回跳正确。");
}

async function testHistory(fields, valid, overrides = {}) {
  const detail = { id: "record", bookTitle: "历史书名", sectionTitle: "历史章节", imageUrl: "history.png", durationMs: 1000, createdAt: 0, recordingUrl: "record.mp3", shareToken: "token", isOwner: true, ...fields };
  const page = createPage("src/pages/CheckInDetail/CheckInDetail.tsx", { id: "record" }, { detail, overrides });
  page.render();
  await settle();
  const tree = page.render();
  const button = byClass(tree, "check-in-actions__practice");
  assert.equal(textOf(button), valid ? "我也来跟读" : "选择教材", JSON.stringify(fields));
  button.props.onClick();
  assert.equal(page.navigations.at(-1), valid ? `/pages/Practice/Practice?bookId=${encodeURIComponent(fields.bookId)}&practice=${fields.practiceIndex}` : "/pages/BookLibrary/BookLibrary");
}

module.exports = { createPage, elements, textOf, byClass, buildBookPracticeBundle };
if (require.main === module) testRoutes().catch((error) => { console.error(error); process.exitCode = 1; });
