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
const livePages = new Set();

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
  const completedPending = [];
  const recorderReleaseCalls = [];
  const recorderTerminalOutcomes = [];
  const modalCalls = [];
  const pendingItems = [...(options.pendingItems || [])];
  const recorderActionOutcomes = Object.fromEntries(
    Object.entries(options.recorderActionOutcomes || {}).map(([action, outcomes]) => [
      action,
      [...outcomes],
    ]),
  );
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
    navigateTo: async ({ url }) => {
      navigations.push(url);
      navigationMethods.push("navigateTo");
      if (options.navigateTo) return options.navigateTo({ url });
    },
    redirectTo: async ({ url }) => {
      navigations.push(url);
      navigationMethods.push("redirectTo");
      if (options.redirectTo) return options.redirectTo({ url });
    },
    navigateBack: async () => { navigationMethods.push("navigateBack"); },
    getCurrentPages: () => options.pageStack || [],
    getMenuButtonBoundingClientRect: () => ({}),
    reLaunch: async ({ url }) => { navigations.push(url); navigationMethods.push("reLaunch"); },
    showToast(input) { options.showToast?.(input); }, showLoading() {}, hideLoading() {}, pageScrollTo() {},
    showModal: async (input) => {
      modalCalls.push(input);
      if (options.showModal) return options.showModal(input);
      return { confirm: true };
    },
    getSetting: async () => {
      permissionChecks.push("scope.record:granted");
      if (options.getSetting) return options.getSetting();
      return { authSetting: { "scope.record": true } };
    },
    openSetting: async () => ({ authSetting: { "scope.record": true } }),
    authorize: async () => {},
    createInnerAudioContext() {
      const handlers = {};
      const audio = { src: "", events: [], currentTime: 0 };
      for (const event of ["Play", "Ended", "Stop", "Error", "TimeUpdate"]) audio[`on${event}`] = (callback) => { handlers[event] = callback; };
      audio.play = () => {
        audio.events.push("play");
        if (!options.deferAudioPlay) handlers.Play?.();
      };
      audio.stop = () => { audio.events.push("stop"); handlers.Stop?.(); };
      audio.destroy = () => { audio.events.push("destroy"); };
      audio.trigger = (event, value) => handlers[event]?.(value);
      audios.push(audio);
      return audio;
    },
    ...options.taroOverrides,
  };
  const recorderCoordinator = {
    acquire() {
      const acquireSequence = options.acquireSequence || ["ok"];
      const outcome = acquireSequence[Math.min(acquireAttempts, acquireSequence.length - 1)];
      acquireAttempts += 1;
      if (outcome === "busy") return { ok: false, reason: "busy", phase: "draining" };
      if (outcome === "unavailable") return { ok: false, reason: "unavailable" };
      const session = { listener: null, detachedTerminalSink: null, phase: "idle", released: false };
      const runAction = (action, actionOptions) => {
        recorderActions.push(actionOptions === undefined ? { action } : { action, options: actionOptions });
        const actionOutcome = recorderActionOutcomes[action]?.shift();
        if (actionOutcome === "throw") {
          return { ok: false, reason: "exception", error: new Error(`${action} 同步失败`) };
        }
        session.phase = action === "start" ? "starting" : action === "stop" ? "stopping" : action === "pause" ? "paused" : "recording";
        return { ok: true };
      };
      const owner = {
        start: (recordingOptions) => runAction("start", recordingOptions),
        pause: () => runAction("pause"),
        resume: () => runAction("resume"),
        stop: () => runAction("stop"),
        release(releaseOptions) {
          recorderReleaseCalls.push(releaseOptions);
          session.detachedTerminalSink = releaseOptions?.terminalSink || null;
          if (["starting", "recording", "paused"].includes(session.phase)) {
            runAction("stop");
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
  recorderHandlers.OperationTimeout = (operation) => {
    if (activeRecorder) activeRecorder.phase = "draining";
    return activeRecorder?.listener?.onError?.({
      errMsg: operation === "stop" ? "录音停止确认超时，请重试" : "录音启动确认超时，请重试",
      code: "RECORDER_OPERATION_TIMEOUT",
      operation,
    });
  };
  recorderHandlers.DrainTimeout = () => {
    if (activeRecorder?.phase === "draining") activeRecorder.phase = "idle";
  };
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
    checkCanStartRecording: options.capacityCheck || (async () => ({ allowed: true, message: "" })),
    saveRecording(input) {
      savedRecordings.push(input);
      if (options.saveRecording) return options.saveRecording(input);
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
      if (options.pendingRemove && !(await options.pendingRemove(requestId))) return false;
      const index = pendingItems.findIndex((item) => item.requestId === requestId);
      if (index < 0) return false;
      pendingItems.splice(index, 1);
      return true;
    },
    async complete(requestId, committed) {
      completedPending.push({ requestId, committed });
      if (options.pendingComplete) return options.pendingComplete(requestId, committed);
      const index = pendingItems.findIndex((current) => current.requestId === requestId);
      if (index < 0 || !committed) return false;
      pendingItems[index] = { ...pendingItems[index], completedAtMs: 2 };
      return true;
    },
  };
  const submissionCoordinator = {
    isSubmitting: () => false,
    getActive: () => undefined,
    submit(pending) {
      submittedPending.push(pending);
      const index = pendingItems.findIndex((item) => item.requestId === pending.requestId);
      if (index >= 0) pendingItems.splice(index, 1);
      return {
        promise: options.submissionPromise || Promise.resolve({ state: "committed", id: "record&1", shareToken: "token&1", cleanupPending: false }),
        cancel: () => false,
      };
    },
  };
  const overrides = {
    react,
    "taro-ui/lib/components/icon": {
      __esModule: true,
      default: (props) => ({ type: "Text", props }),
    },
    "@tarojs/components": Object.fromEntries(["View", "Text", "Image", "Input", "Button", "ScrollView"].map((name) => [name, name])),
    "@tarojs/taro": { __esModule: true, default: taro, ...taro },
    "@/constant": { sharedImage: "share.png" },
    "@/services/cloudCheckIn": {
      getCheckInDetail: async () => options.detail,
      getReadableCloudError: (error) => error.message,
    },
    "@/features/listeningPractice/recorderCoordinator": { getRecorderCoordinator: () => recorderCoordinator },
    "@/features/listeningPractice/pendingCheckInRuntime": { getPendingCheckInStore: () => pendingStore, logRecordingDiagnostic: options.recordingDiagnostic || (() => {}), diagnoseLocalRecordingFailure: options.recordingFailureProbe || (() => {}), getActivePendingRecovery: () => undefined },
    "@/features/listeningPractice/checkInSubmissionRuntime": { getCheckInSubmissionCoordinator: () => submissionCoordinator },
    "@/hooks/useAppEntryIntroGuard": { useAppEntryIntroGuard() {} },
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
  const page = {
    render, navigations, navigationMethods, audios, recorderHandlers, recorderActions, permissionChecks, savedRecordings, submittedPending, completedPending,
    modalCalls,
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
    dispose() {
      for (const current of frames.values()) {
        for (const item of current.slots) item.cleanup?.();
      }
      frames.clear();
      effects.length = 0;
      livePages.delete(page);
    },
  };
  livePages.add(page);
  return page;
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
      assert.deepEqual(page.completedPending[0], { requestId: "0123456789abcdef0123456789abcdef", committed: true }, "完成练习只持久化本机完成状态");
      assert.equal(page.submittedPending.length, 0, "完成练习不能启动云端提交");
      assert.equal(page.navigations.at(-1), "/pages/CheckInDetail/CheckInDetail?localId=0123456789abcdef0123456789abcdef&fromPractice=1");
      assert.equal(page.navigationMethods.at(-1), "navigateTo", "本机完成后必须保留原教材页，供原生返回箭头恢复");
    }
  }

  let throwingCompleteCalls = 0;
  const throwingPending = {
    requestId: "fedcba9876543210fedcba9876543210",
    localPath: "/saved/throwing-complete.mp3",
    recoverable: true,
    context: {
      bookId: "22",
      bookTitle: buildBookPracticeBundle("22").book.title,
      practiceId: buildBookPracticeBundle("22").practices[0].id,
      practiceIndex: 0,
      pageNumber: buildBookPracticeBundle("22").practices[0].pageNumber,
      sectionTitle: buildBookPracticeBundle("22").practices[0].sectionTitle,
      imageUrl: buildBookPracticeBundle("22").practices[0].imageUrl,
    },
    durationMs: 1800,
    fileSizeBytes: 5000,
    cloudFileId: "",
    status: "local",
    updatedAtMs: 1,
  };
  const throwingCompletePage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      pendingItems: [throwingPending],
      pendingComplete: async () => {
        throwingCompleteCalls += 1;
        throw new Error("metadata write failed");
      },
    },
  );
  let throwingCompleteTree = throwingCompletePage.render();
  throwingCompleteTree = throwingCompletePage.render();
  await settle();
  throwingCompleteTree = throwingCompletePage.render();
  await byClass(throwingCompleteTree, "check-in-button").props.onClick();
  throwingCompleteTree = throwingCompletePage.render();
  await byClass(throwingCompleteTree, "check-in-button").props.onClick();
  assert.equal(throwingCompleteCalls, 2, "complete 抛异常后必须解除互斥并允许用户重试");

  let completedRemovalCalls = 0;
  const redirectFailurePage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      savedFilePath: "/saved/completed-before-navigation.mp3",
      navigateTo: async () => { throw new Error("navigation failed"); },
      pendingRemove: async () => { completedRemovalCalls += 1; return true; },
    },
  );
  let redirectFailureTree = redirectFailurePage.render();
  redirectFailureTree = redirectFailurePage.render();
  await byClass(redirectFailureTree, "record-button").props.onClick();
  redirectFailurePage.recorderHandlers.Start();
  redirectFailureTree = redirectFailurePage.render();
  byClass(redirectFailureTree, "record-button--stop").props.onClick();
  await redirectFailurePage.recorderHandlers.Stop({
    tempFilePath: "/tmp/completed-before-navigation.mp3",
    duration: 1800,
    fileSize: 5000,
  });
  await settle();
  redirectFailureTree = redirectFailurePage.render();
  await byClass(redirectFailureTree, "check-in-button").props.onClick();
  redirectFailureTree = redirectFailurePage.render();
  assert.equal(
    elements(redirectFailureTree).some((node) => node.type === "Button" && textOf(node) === "重新录制"),
    false,
    "完成持久化后即使详情导航失败，也不得把已完成录音继续暴露为可重录草稿",
  );
  await byClass(redirectFailureTree, "record-button").props.onClick();
  assert.equal(completedRemovalCalls, 0, "导航失败后开始新录音不得自动删除刚完成的文件");

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

  const hiddenPauseFailure = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { recorderActionOutcomes: { pause: ["throw"] } },
  );
  let hiddenPauseFailureTree = hiddenPauseFailure.render();
  hiddenPauseFailureTree = hiddenPauseFailure.render();
  await byClass(hiddenPauseFailureTree, "record-button").props.onClick();
  hiddenPauseFailure.recorderHandlers.Start();
  hiddenPauseFailure.hide();
  assert.deepEqual(
    hiddenPauseFailure.recorderActions.slice(-2).map(({ action }) => action),
    ["pause", "stop"],
    "隐藏页 pause 同步失败后必须立即降级 stop，不能继续后台录音",
  );
  assert.equal(
    hiddenPauseFailure.modalCalls.some(({ title }) => title === "录音操作失败"),
    false,
    "隐藏页安全收口失败不得弹出用户当前看不到的操作弹窗",
  );

  const hiddenStartRetryTimers = createFakeTimers();
  const hiddenStartFailure = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      recorderActionOutcomes: { stop: ["throw", "ok"] },
      setTimeout: hiddenStartRetryTimers.setTimeout,
      clearTimeout: hiddenStartRetryTimers.clearTimeout,
    },
  );
  let hiddenStartFailureTree = hiddenStartFailure.render();
  hiddenStartFailureTree = hiddenStartFailure.render();
  await byClass(hiddenStartFailureTree, "record-button").props.onClick();
  hiddenStartFailure.hide();
  assert.equal(hiddenStartRetryTimers.size, 1, "隐藏时首次 stop 同步失败必须安排有限安全重试");
  hiddenStartFailure.recorderHandlers.Start();
  assert.equal(
    hiddenStartFailure.recorderActions.filter(({ action }) => action === "stop").length,
    2,
    "stop 失败后的迟到 onStart 必须被接收并再次 stop",
  );
  assert.equal(hiddenStartRetryTimers.size, 0, "迟到 onStart 已成功收口后必须清除备用重试");
  assert.equal(
    hiddenStartFailure.modalCalls.some(({ title }) => title === "录音操作失败"),
    false,
    "隐藏页 stop 同步失败不得弹出操作失败弹窗",
  );

  const boundedRetryTimers = createFakeTimers();
  const boundedRetryPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      recorderActionOutcomes: {
        pause: ["throw"],
        stop: ["throw", "throw", "throw", "throw"],
      },
      setTimeout: boundedRetryTimers.setTimeout,
      clearTimeout: boundedRetryTimers.clearTimeout,
    },
  );
  let boundedRetryTree = boundedRetryPage.render();
  boundedRetryTree = boundedRetryPage.render();
  await byClass(boundedRetryTree, "record-button").props.onClick();
  boundedRetryPage.recorderHandlers.Start();
  boundedRetryPage.hide();
  boundedRetryTimers.advance(5000);
  assert.equal(
    boundedRetryPage.recorderActions.filter(({ action }) => action === "stop").length,
    3,
    "隐藏页 stop 连续失败时只做固定三次尝试，不能无限循环",
  );
  assert.equal(boundedRetryTimers.size, 0, "安全重试达到上限后不得残留定时器");

  const unloadRetryTimers = createFakeTimers();
  const unloadRetryPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      recorderActionOutcomes: { pause: ["throw"], stop: ["throw", "throw"] },
      setTimeout: unloadRetryTimers.setTimeout,
      clearTimeout: unloadRetryTimers.clearTimeout,
    },
  );
  let unloadRetryTree = unloadRetryPage.render();
  unloadRetryTree = unloadRetryPage.render();
  await byClass(unloadRetryTree, "record-button").props.onClick();
  unloadRetryPage.recorderHandlers.Start();
  unloadRetryPage.hide();
  assert.equal(unloadRetryTimers.size, 1);
  unloadRetryPage.unload();
  const unloadActionCount = unloadRetryPage.recorderActions.length;
  assert.equal(unloadRetryTimers.size, 0, "页面卸载必须取消隐藏页 stop 重试");
  unloadRetryTimers.advance(5000);
  assert.equal(unloadRetryPage.recorderActions.length, unloadActionCount, "卸载后不得再次调用录音器或更新页面状态");

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

  const hiddenResumeRetryTimers = createFakeTimers();
  const hiddenResumeFailure = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      recorderActionOutcomes: {
        pause: ["ok", "throw"],
        stop: ["throw", "ok"],
      },
      setTimeout: hiddenResumeRetryTimers.setTimeout,
      clearTimeout: hiddenResumeRetryTimers.clearTimeout,
    },
  );
  let hiddenResumeFailureTree = hiddenResumeFailure.render();
  hiddenResumeFailureTree = hiddenResumeFailure.render();
  await byClass(hiddenResumeFailureTree, "record-button").props.onClick();
  hiddenResumeFailure.recorderHandlers.Start();
  hiddenResumeFailureTree = hiddenResumeFailure.render();
  byClass(hiddenResumeFailureTree, "record-button--pause").props.onClick();
  hiddenResumeFailure.recorderHandlers.Pause();
  hiddenResumeFailureTree = hiddenResumeFailure.render();
  byClass(hiddenResumeFailureTree, "record-button--resume").props.onClick();
  hiddenResumeFailure.hide();
  hiddenResumeFailure.recorderHandlers.Resume();
  assert.deepEqual(
    hiddenResumeFailure.recorderActions.slice(-2).map(({ action }) => action),
    ["pause", "stop"],
    "隐藏后迟到 onResume 的 pause 失败时必须立即降级 stop",
  );
  assert.equal(hiddenResumeRetryTimers.size, 1, "迟到 onResume 的首次 stop 失败也必须进入有限重试");
  hiddenResumeRetryTimers.advance(5000);
  assert.equal(
    hiddenResumeFailure.recorderActions.filter(({ action }) => action === "stop").length,
    2,
    "迟到 onResume 必须在有限重试内完成 stop",
  );
  assert.equal(hiddenResumeRetryTimers.size, 0);

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

  const lateStopPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { savedFilePath: "/saved/late-stop.mp3" },
  );
  let lateStopTree = lateStopPage.render();
  lateStopTree = lateStopPage.render();
  const timedOutPractice = buildBookPracticeBundle("22").practices[0];
  await byClass(lateStopTree, "record-button").props.onClick();
  lateStopPage.recorderHandlers.Start();
  lateStopTree = lateStopPage.render();
  byClass(lateStopTree, "record-button--stop").props.onClick();
  lateStopPage.recorderHandlers.OperationTimeout("stop");
  lateStopTree = lateStopPage.render();
  await byClass(lateStopTree, "practice-navigation__button--primary").props.onClick();
  lateStopPage.render();
  await lateStopPage.recorderHandlers.Stop({
    tempFilePath: "/tmp/late-stop.mp3",
    duration: 2100,
    fileSize: 6000,
  });
  await settle();
  assert.equal(lateStopPage.savedRecordings.length, 1, "停止确认超时后的迟到 onStop 仍必须持久保存");
  assert.equal(
    lateStopPage.savedRecordings[0].context.practiceId,
    timedOutPractice.id,
    "迟到 onStop 必须保存到原训练，不能误贴到超时后切换的新页面",
  );

  const lateSafetyStopPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { savedFilePath: "/saved/late-safety-stop.mp3" },
  );
  let lateSafetyStopTree = lateSafetyStopPage.render();
  lateSafetyStopTree = lateSafetyStopPage.render();
  await byClass(lateSafetyStopTree, "record-button").props.onClick();
  lateSafetyStopPage.recorderHandlers.Start();
  lateSafetyStopTree = lateSafetyStopPage.render();
  byClass(lateSafetyStopTree, "record-button--pause").props.onClick();
  lateSafetyStopPage.recorderHandlers.OperationTimeout("stop");
  lateSafetyStopTree = lateSafetyStopPage.render();
  await lateSafetyStopPage.recorderHandlers.Stop({
    tempFilePath: "/tmp/late-safety-stop.mp3",
    duration: 1800,
    fileSize: 5000,
  });
  await settle();
  assert.equal(
    lateSafetyStopPage.savedRecordings.length,
    1,
    "暂停/恢复保护触发的 stop 超时后，迟到录音也必须由原会话保存",
  );

  const saveDuringSwitch = deferred();
  const savedDuringSwitchItem = {
    ...oldPending,
    requestId: "saved-during-switch-0123456789abcd",
    localPath: "/saved/during-switch.mp3",
    updatedAtMs: 2,
  };
  const saveDuringSwitchPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      saveRecording: () => saveDuringSwitch.promise,
    },
  );
  let saveDuringSwitchTree = saveDuringSwitchPage.render();
  saveDuringSwitchTree = saveDuringSwitchPage.render();
  await byClass(saveDuringSwitchTree, "record-button").props.onClick();
  saveDuringSwitchPage.recorderHandlers.Start();
  saveDuringSwitchTree = saveDuringSwitchPage.render();
  byClass(saveDuringSwitchTree, "record-button--stop").props.onClick();
  saveDuringSwitchPage.recorderHandlers.OperationTimeout("stop");
  saveDuringSwitchTree = saveDuringSwitchPage.render();
  const lateStopDuringSwitch = saveDuringSwitchPage.recorderHandlers.Stop({
    tempFilePath: "/tmp/during-switch.mp3",
    duration: 2200,
    fileSize: 6500,
  });
  const switchWhileSaving = byClass(
    saveDuringSwitchTree,
    "practice-navigation__button--primary",
  ).props.onClick();
  saveDuringSwitch.resolve({
    item: savedDuringSwitchItem,
    persisted: false,
    message: "",
  });
  await Promise.all([lateStopDuringSwitch, switchWhileSaving]);
  await settle();
  saveDuringSwitchTree = saveDuringSwitchPage.render();
  assert.match(
    textOf(byClass(saveDuringSwitchTree, "practice-header__progress")),
    /跟读训练 1 \/ 24/,
    "切页事务期间若原训练新录音完成落盘，应取消切页并留在原训练",
  );
  assert.equal(
    saveDuringSwitchPage.stateValues().some(
      (value) => value?.requestId === savedDuringSwitchItem.requestId && value.context?.practiceIndex === 0,
    ),
    true,
    "切页与迟到保存竞态不能把训练 A 的 pending 挂到训练 B",
  );

  const restoredDuringTimeoutPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { pendingItems: [oldPending], savedFilePath: "/saved/replaced-after-timeout.mp3" },
  );
  let restoredDuringTimeoutTree = restoredDuringTimeoutPage.render();
  restoredDuringTimeoutTree = restoredDuringTimeoutPage.render();
  await settle();
  restoredDuringTimeoutTree = restoredDuringTimeoutPage.render();
  const replaceBeforeTimeout = elements(restoredDuringTimeoutTree).find(
    (node) => node.type === "Button" && textOf(node) === "重新录制",
  );
  assert.ok(replaceBeforeTimeout);
  await replaceBeforeTimeout.props.onClick();
  restoredDuringTimeoutPage.recorderHandlers.Start();
  restoredDuringTimeoutTree = restoredDuringTimeoutPage.render();
  byClass(restoredDuringTimeoutTree, "record-button--stop").props.onClick();
  restoredDuringTimeoutPage.recorderHandlers.OperationTimeout("stop");
  restoredDuringTimeoutTree = restoredDuringTimeoutPage.render();
  await settle();
  restoredDuringTimeoutTree = restoredDuringTimeoutPage.render();
  assert.equal(
    restoredDuringTimeoutPage.stateValues().some((value) => value?.localPath === oldPending.localPath),
    true,
    "stop terminal 缺失时旧录音必须恢复可见，不能让用户已有录音消失",
  );
  await restoredDuringTimeoutPage.recorderHandlers.Stop({
    tempFilePath: "/tmp/replaced-after-timeout.mp3",
    duration: 2400,
    fileSize: 7000,
  });
  await settle();
  restoredDuringTimeoutPage.render();
  assert.equal(restoredDuringTimeoutPage.savedRecordings.length, 1);
  assert.equal(
    restoredDuringTimeoutPage.stateValues().some((value) => value?.localPath === "/saved/replaced-after-timeout.mp3"),
    true,
    "迟到的新录音保存成功后必须原子替换页面正在回听的旧录音",
  );
  assert.equal(
    restoredDuringTimeoutPage.stateValues().some((value) => value?.localPath === oldPending.localPath),
    false,
    "删除旧备份后页面不得继续指向已删除的录音路径",
  );

  for (const failure of ["invalid-result", "save-error"]) {
    const failedLateStopPage = createPage(
      "src/pages/Practice/Practice.tsx",
      { bookId: "22", practice: "0" },
      {
        pendingItems: [oldPending],
        ...(failure === "save-error"
          ? { saveRecording: async () => { throw new Error("持久化失败"); } }
          : {}),
      },
    );
    let failedLateStopTree = failedLateStopPage.render();
    failedLateStopTree = failedLateStopPage.render();
    await settle();
    failedLateStopTree = failedLateStopPage.render();
    const retryButton = elements(failedLateStopTree).find(
      (node) => node.type === "Button" && textOf(node) === "重新录制",
    );
    await retryButton.props.onClick();
    failedLateStopPage.recorderHandlers.Start();
    failedLateStopTree = failedLateStopPage.render();
    byClass(failedLateStopTree, "record-button--stop").props.onClick();
    failedLateStopPage.recorderHandlers.OperationTimeout("stop");
    failedLateStopTree = failedLateStopPage.render();
    await settle();
    failedLateStopTree = failedLateStopPage.render();
    await failedLateStopPage.recorderHandlers.Stop({
      ...(failure === "save-error" ? { tempFilePath: "/tmp/save-error.mp3" } : {}),
      duration: 2000,
      fileSize: 6000,
    });
    await settle();
    failedLateStopTree = failedLateStopPage.render();
    assert.ok(
      elements(failedLateStopTree).some(
        (node) => node.type === "Button" && textOf(node) === "回听录音",
      ),
      `迟到 stop ${failure} 时必须继续显示可回听的旧录音`,
    );
    assert.equal(
      failedLateStopPage.stateValues().some((value) => value?.localPath === oldPending.localPath),
      true,
      `迟到 stop ${failure} 时页面不得丢失旧录音路径`,
    );
  }

  const delayedPendingRemoval = deferred();
  const switchingRemovalPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      pendingItems: [oldPending],
      pendingRemove: () => delayedPendingRemoval.promise,
    },
  );
  let switchingRemovalTree = switchingRemovalPage.render();
  switchingRemovalTree = switchingRemovalPage.render();
  await settle();
  switchingRemovalTree = switchingRemovalPage.render();
  const switchingAttempt = byClass(
    switchingRemovalTree,
    "practice-navigation__button--primary",
  ).props.onClick();
  await settle();
  switchingRemovalTree = switchingRemovalPage.render();
  const recordingDuringSwitch = elements(switchingRemovalTree).find(
    (node) => node.type === "Button" && textOf(node) === "重新录制",
  );
  await recordingDuringSwitch.props.onClick();
  assert.equal(
    switchingRemovalPage.recorderActions.length,
    0,
    "旧 pending 删除未完成时不得同时启动麦克风",
  );
  delayedPendingRemoval.resolve(true);
  await switchingAttempt;
  switchingRemovalTree = switchingRemovalPage.render();
  assert.match(
    textOf(byClass(switchingRemovalTree, "practice-header__progress")),
    /跟读训练 2 \/ 24/,
    "删除完成后切页事务应继续落到目标训练",
  );

  const delayedRemovalBeforeSubmit = deferred();
  const submitDuringSwitchPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      pendingItems: [oldPending],
      pendingRemove: () => delayedRemovalBeforeSubmit.promise,
    },
  );
  let submitDuringSwitchTree = submitDuringSwitchPage.render();
  submitDuringSwitchTree = submitDuringSwitchPage.render();
  await settle();
  submitDuringSwitchTree = submitDuringSwitchPage.render();
  const submitSwitchAttempt = byClass(
    submitDuringSwitchTree,
    "practice-navigation__button--primary",
  ).props.onClick();
  await settle();
  submitDuringSwitchTree = submitDuringSwitchPage.render();
  await byClass(submitDuringSwitchTree, "check-in-button").props.onClick();
  assert.equal(
    submitDuringSwitchPage.submittedPending.length,
    0,
    "切页删除旧 pending 期间不得并发提交同一条录音",
  );
  delayedRemovalBeforeSubmit.resolve(true);
  await submitSwitchAttempt;

  const uploadBeforeSwitch = deferred();
  let removalCallsDuringUpload = 0;
  const switchingDuringUploadPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      pendingItems: [oldPending],
      submissionPromise: uploadBeforeSwitch.promise,
      pendingRemove: async () => {
        removalCallsDuringUpload += 1;
        return true;
      },
    },
  );
  let switchingDuringUploadTree = switchingDuringUploadPage.render();
  switchingDuringUploadTree = switchingDuringUploadPage.render();
  await settle();
  switchingDuringUploadTree = switchingDuringUploadPage.render();
  const uploadAttempt = byClass(switchingDuringUploadTree, "check-in-button").props.onClick();
  const switchDuringUploadAttempt = byClass(
    switchingDuringUploadTree,
    "practice-navigation__button--primary",
  ).props.onClick();
  await switchDuringUploadAttempt;
  assert.equal(removalCallsDuringUpload, 0, "提交已开始后，切页流程不得调用本地录音删除");
  assert.equal(switchingDuringUploadPage.submittedPending.length, 0, "完成练习不得上传");
  assert.equal(
    switchingDuringUploadPage.stateValues().some(
      (value) => value?.requestId === oldPending.requestId && value.localPath === oldPending.localPath,
    ),
    false,
    "完成记录应与训练页草稿状态脱钩，但仍保留在 store 中",
  );
  assert.match(
    textOf(byClass(switchingDuringUploadPage.render(), "practice-header__progress")),
    /跟读训练 1 \/ 24/,
    "完成收口期间旧点击必须被同步互斥，且不得删除录音",
  );
  uploadBeforeSwitch.resolve({ state: "cancelled", error: new Error("用户取消") });
  await uploadAttempt;

  const discardedStopErrorPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { savedFilePath: "/saved/after-discard-error.mp3" },
  );
  let discardedStopErrorTree = discardedStopErrorPage.render();
  discardedStopErrorTree = discardedStopErrorPage.render();
  await byClass(discardedStopErrorTree, "record-button").props.onClick();
  discardedStopErrorPage.recorderHandlers.Start();
  discardedStopErrorTree = discardedStopErrorPage.render();
  await byClass(discardedStopErrorTree, "practice-navigation__button--primary").props.onClick();
  discardedStopErrorPage.recorderHandlers.Error(new Error("旧训练停止失败"));
  discardedStopErrorTree = discardedStopErrorPage.render();
  await byClass(discardedStopErrorTree, "record-button").props.onClick();
  discardedStopErrorPage.recorderHandlers.Start();
  discardedStopErrorTree = discardedStopErrorPage.render();
  byClass(discardedStopErrorTree, "record-button--stop").props.onClick();
  await discardedStopErrorPage.recorderHandlers.Stop({
    tempFilePath: "/tmp/after-discard-error.mp3",
    duration: 1600,
    fileSize: 4800,
  });
  await settle();
  assert.equal(
    discardedStopErrorPage.savedRecordings.length,
    1,
    "训练 A 的废弃 stop 返回 onError 后，训练 B 的新录音仍必须正常保存",
  );
  assert.equal(
    discardedStopErrorPage.savedRecordings[0].context.practiceIndex,
    1,
    "旧 stop 错误不能让训练 B 的录音误贴或丢失",
  );

  const discardedStopTimeoutPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { savedFilePath: "/saved/after-discard-timeout.mp3" },
  );
  let discardedStopTimeoutTree = discardedStopTimeoutPage.render();
  discardedStopTimeoutTree = discardedStopTimeoutPage.render();
  await byClass(discardedStopTimeoutTree, "record-button").props.onClick();
  discardedStopTimeoutPage.recorderHandlers.Start();
  discardedStopTimeoutTree = discardedStopTimeoutPage.render();
  await byClass(discardedStopTimeoutTree, "practice-navigation__button--primary").props.onClick();
  discardedStopTimeoutPage.recorderHandlers.OperationTimeout("stop");
  discardedStopTimeoutPage.recorderHandlers.DrainTimeout();
  discardedStopTimeoutTree = discardedStopTimeoutPage.render();
  await byClass(discardedStopTimeoutTree, "record-button").props.onClick();
  discardedStopTimeoutPage.recorderHandlers.Start();
  discardedStopTimeoutTree = discardedStopTimeoutPage.render();
  byClass(discardedStopTimeoutTree, "record-button--stop").props.onClick();
  await discardedStopTimeoutPage.recorderHandlers.Stop({
    tempFilePath: "/tmp/after-discard-timeout.mp3",
    duration: 1750,
    fileSize: 5200,
  });
  await settle();
  assert.equal(
    discardedStopTimeoutPage.savedRecordings.length,
    1,
    "训练 A 的废弃 stop 超时且无 terminal 时，解锁后训练 B 的新录音仍必须正常保存",
  );
  assert.equal(discardedStopTimeoutPage.savedRecordings[0].context.practiceIndex, 1);

  const hiddenPermission = deferred();
  const hiddenPermissionPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { pendingItems: [oldPending], getSetting: () => hiddenPermission.promise },
  );
  let hiddenPermissionTree = hiddenPermissionPage.render();
  hiddenPermissionTree = hiddenPermissionPage.render();
  await settle();
  hiddenPermissionTree = hiddenPermissionPage.render();
  const reRecordButton = elements(hiddenPermissionTree).find(
    (node) => node.type === "Button" && textOf(node) === "重新录制",
  );
  assert.ok(reRecordButton, "旧录音恢复后应能发起重新录制");
  const hiddenStartAttempt = reRecordButton.props.onClick();
  hiddenPermissionPage.hide();
  hiddenPermission.resolve({ authSetting: { "scope.record": true } });
  await hiddenStartAttempt;
  await settle();
  assert.equal(hiddenPermissionPage.recorderActions.length, 0, "权限等待期间切后台后不得启动麦克风");
  assert.equal(
    hiddenPermissionPage.stateValues().some((value) => value?.requestId === oldPending.requestId),
    true,
    "后台失效的启动请求不得移走或清空旧 pending 录音",
  );

  const hiddenCapacity = deferred();
  const hiddenCapacityPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { pendingItems: [oldPending], capacityCheck: () => hiddenCapacity.promise },
  );
  let hiddenCapacityTree = hiddenCapacityPage.render();
  hiddenCapacityTree = hiddenCapacityPage.render();
  await settle();
  hiddenCapacityTree = hiddenCapacityPage.render();
  const capacityReRecord = elements(hiddenCapacityTree).find((node) => node.type === "Button" && textOf(node) === "重新录制");
  const capacityAttempt = capacityReRecord.props.onClick();
  hiddenCapacityPage.hide();
  hiddenCapacity.resolve({ allowed: true, message: "" });
  await capacityAttempt;
  assert.equal(hiddenCapacityPage.permissionChecks.length, 0, "容量检查未结束就离页不得继续请求权限或开麦");
  assert.equal(hiddenCapacityPage.stateValues().some((value) => value?.requestId === oldPending.requestId), true, "失效容量检查不得清空旧录音");
  hiddenCapacityPage.dispose();

  const insufficientPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { pendingItems: [oldPending], capacityCheck: async () => ({ allowed: false, message: "本地录音空间不足，请先清理历史录音" }) },
  );
  let insufficientTree = insufficientPage.render();
  insufficientTree = insufficientPage.render();
  await settle();
  insufficientTree = insufficientPage.render();
  await elements(insufficientTree).find((node) => node.type === "Button" && textOf(node) === "重新录制").props.onClick();
  assert.equal(insufficientPage.recorderActions.length, 0, "容量不足不得开麦");
  assert.equal(insufficientPage.permissionChecks.length, 0, "容量不足无需请求麦克风权限");
  assert.equal(insufficientPage.stateValues().some((value) => value?.requestId === oldPending.requestId), true, "容量不足必须保留旧录音");
  insufficientPage.dispose();

  const replacedOwnerPermission = deferred();
  const replacedOwnerPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { getSetting: () => replacedOwnerPermission.promise },
  );
  let replacedOwnerTree = replacedOwnerPage.render();
  replacedOwnerTree = replacedOwnerPage.render();
  const replacedOwnerAttempt = byClass(replacedOwnerTree, "record-button").props.onClick();
  replacedOwnerPage.setRoute({ bookId: "23", practice: "0" });
  replacedOwnerPermission.resolve({ authSetting: { "scope.record": true } });
  await replacedOwnerAttempt;
  await settle();
  assert.equal(replacedOwnerPage.recorderActions.length, 0, "权限等待期间 owner 被替换后不得启动新页面麦克风");

  const switchedPracticePermission = deferred();
  const switchedPracticePage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { getSetting: () => switchedPracticePermission.promise },
  );
  let switchedPracticeTree = switchedPracticePage.render();
  switchedPracticeTree = switchedPracticePage.render();
  const switchedPracticeAttempt = byClass(switchedPracticeTree, "record-button").props.onClick();
  await byClass(switchedPracticeTree, "practice-navigation__button--primary").props.onClick();
  switchedPracticePage.render();
  switchedPracticePermission.resolve({ authSetting: { "scope.record": true } });
  await switchedPracticeAttempt;
  await settle();
  assert.equal(
    switchedPracticePage.recorderActions.length,
    0,
    "训练 A 的权限请求返回时已切到训练 B，不得未经新页面点击自动启动麦克风",
  );

  const resumedPermission = deferred();
  const hideThenShowPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { getSetting: () => resumedPermission.promise },
  );
  let hideThenShowTree = hideThenShowPage.render();
  hideThenShowTree = hideThenShowPage.render();
  const hiddenAttempt = byClass(hideThenShowTree, "record-button").props.onClick();
  hideThenShowPage.hide();
  hideThenShowPage.show();
  resumedPermission.resolve({ authSetting: { "scope.record": true } });
  await hiddenAttempt;
  await settle();
  assert.equal(
    hideThenShowPage.recorderActions.length,
    0,
    "权限等待期间曾切入后台，即使返回前重新显示也必须由用户再次点击才能开麦",
  );

  const firstConcurrentPermission = deferred();
  let concurrentPermissionCalls = 0;
  const concurrentPermissionPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      savedFilePath: "/saved/concurrent-latest.mp3",
      getSetting: () => {
        concurrentPermissionCalls += 1;
        return concurrentPermissionCalls === 1
          ? firstConcurrentPermission.promise
          : Promise.resolve({ authSetting: { "scope.record": true } });
      },
    },
  );
  let concurrentPermissionTree = concurrentPermissionPage.render();
  concurrentPermissionTree = concurrentPermissionPage.render();
  const concurrentButton = byClass(concurrentPermissionTree, "record-button");
  const firstConcurrentAttempt = concurrentButton.props.onClick();
  await settle();
  await concurrentButton.props.onClick();
  concurrentPermissionPage.recorderHandlers.Start();
  concurrentPermissionTree = concurrentPermissionPage.render();
  byClass(concurrentPermissionTree, "record-button--stop").props.onClick();
  await concurrentPermissionPage.recorderHandlers.Stop({
    tempFilePath: "/tmp/concurrent-latest.mp3",
    duration: 1900,
    fileSize: 5500,
  });
  await settle();
  concurrentPermissionPage.render();
  firstConcurrentPermission.resolve({ authSetting: { "scope.record": true } });
  await firstConcurrentAttempt;
  await settle();
  assert.deepEqual(
    concurrentPermissionPage.recorderActions.map(({ action }) => action),
    ["start", "stop"],
    "较早权限请求迟到时不得覆盖已完成的新录音或再次自动开麦",
  );
  assert.equal(
    concurrentPermissionPage.stateValues().some((value) => value?.localPath === "/saved/concurrent-latest.mp3"),
    true,
    "迟到的旧权限 continuation 不得移走刚保存的 pending 录音",
  );

  for (const delayedStage of ["ready", "cleanup"]) {
    const delayedRestore = deferred();
    const restoreAfterSwitchPage = createPage(
      "src/pages/Practice/Practice.tsx",
      { bookId: "22", practice: "0" },
      {
        pendingItems: [oldPending],
        ...(delayedStage === "ready"
          ? { pendingReady: () => delayedRestore.promise }
          : { pendingCleanup: () => delayedRestore.promise }),
      },
    );
    let restoreAfterSwitchTree = restoreAfterSwitchPage.render();
    restoreAfterSwitchTree = restoreAfterSwitchPage.render();
    if (delayedStage === "cleanup") await settle();
    await byClass(
      restoreAfterSwitchTree,
      "practice-navigation__button--primary",
    ).props.onClick();
    delayedRestore.resolve();
    await settle();
    restoreAfterSwitchTree = restoreAfterSwitchPage.render();
    assert.match(
      textOf(byClass(restoreAfterSwitchTree, "practice-header__progress")),
      /跟读训练 2 \/ 24/,
      `旧 ${delayedStage} 恢复任务返回时应保留已经提交的新训练`,
    );
    assert.equal(
      restoreAfterSwitchPage.stateValues().some((value) => value?.requestId === oldPending.requestId),
      false,
      `训练 A 的 ${delayedStage} 恢复任务不得把旧 pending 挂到训练 B`,
    );
  }

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
  await byClass(leavingTree, "check-in-navigation__home").props.onClick();
  assert.equal(leavingPage.navigationMethods.at(-1), "reLaunch", "活动录音点击房子必须离开到首页");
  assert.equal(leavingPage.navigations.at(-1), "/pages/Home/Home");
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
  assert.equal(leavingPage.savedRecordings[0].context.bookId, "22", "离页保存必须保留原教材");
  assert.equal(leavingPage.savedRecordings[0].context.practiceIndex, 0, "离页保存必须保留原训练页");
  assert.equal(
    typeof leavingPage.recorderTerminalOutcomes[0]?.then,
    "function",
    "terminal sink 必须把异步本地持久化 Promise 交还协调器等待",
  );

  const pausedLeavingPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { savedFilePath: "/saved/paused-leaving.mp3" },
  );
  let pausedLeavingTree = pausedLeavingPage.render();
  pausedLeavingTree = pausedLeavingPage.render();
  await byClass(pausedLeavingTree, "record-button").props.onClick();
  pausedLeavingPage.recorderHandlers.Start();
  pausedLeavingTree = pausedLeavingPage.render();
  byClass(pausedLeavingTree, "record-button--pause").props.onClick();
  pausedLeavingPage.recorderHandlers.Pause();
  await byClass(pausedLeavingTree, "check-in-navigation__home").props.onClick();
  pausedLeavingPage.hide();
  pausedLeavingPage.unload();
  assert.equal(pausedLeavingPage.recorderActions.at(-1).action, "stop", "暂停录音从房子离页也必须收口");
  assert.equal(pausedLeavingPage.recorderReleaseCalls.length, 1, "暂停录音离页必须立即释放 owner");
  assert.equal(typeof pausedLeavingPage.recorderReleaseCalls[0]?.terminalSink, "function", "暂停录音离页必须托管 terminal sink");
  await pausedLeavingPage.recorderHandlers.Stop({ tempFilePath: "/tmp/paused-leaving.mp3", duration: 2400, fileSize: 8200 });
  await settle();
  assert.equal(pausedLeavingPage.savedRecordings[0].context.bookId, "22");
  assert.equal(pausedLeavingPage.savedRecordings[0].context.practiceIndex, 0);

  const modelPlaybackLeavingPage = createPage("src/pages/Practice/Practice.tsx", { bookId: "22", practice: "0" });
  let modelPlaybackTree = modelPlaybackLeavingPage.render();
  modelPlaybackTree = modelPlaybackLeavingPage.render();
  byClass(modelPlaybackTree, "audio-hotspot").props.onClick();
  modelPlaybackTree = modelPlaybackLeavingPage.render();
  await byClass(modelPlaybackTree, "check-in-navigation__home").props.onClick();
  modelPlaybackLeavingPage.hide();
  assert.equal(modelPlaybackLeavingPage.audios.find((audio) => audio.src)?.events.at(-1), "destroy", "示范播放从房子离页必须销毁并停止会话");

  const recordingDiagnostics = [], recordingProbes = [];
  const diagnosticPage = createPage("src/pages/Practice/Practice.tsx", { bookId: "22", practice: "0" }, {
    pendingItems: [oldPending], recordingDiagnostic: (...args) => recordingDiagnostics.push(args), recordingFailureProbe: (...args) => recordingProbes.push(args),
  });
  diagnosticPage.render(); diagnosticPage.render(); await settle();
  elements(diagnosticPage.render()).find(node => node.type === "Button" && textOf(node) === "回听录音").props.onClick();
  const nativePlaybackError = { errCode: 10003, errMsg: "private-path" };
  diagnosticPage.audios.find(a => a.src === oldPending.localPath).trigger("Error", nativePlaybackError);
  assert.ok(recordingDiagnostics.some(([stage]) => stage === "playback.local.start"), "训练回听记录本机来源");
  assert.equal(recordingProbes[0]?.[0]?.localPath, oldPending.localPath, "失败只读探针检查实际回听路径");
  assert.equal(recordingProbes[0]?.[1], nativePlaybackError, "原生错误交给脱敏边界，不打印原文");
  diagnosticPage.dispose();

  const recordingPlaybackLeavingPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { pendingItems: [oldPending] },
  );
  let recordingPlaybackTree = recordingPlaybackLeavingPage.render();
  recordingPlaybackTree = recordingPlaybackLeavingPage.render();
  await settle();
  recordingPlaybackTree = recordingPlaybackLeavingPage.render();
  const playbackButton = elements(recordingPlaybackTree).find(
    (node) => node.type === "Button" && textOf(node) === "回听录音",
  );
  playbackButton.props.onClick();
  recordingPlaybackTree = recordingPlaybackLeavingPage.render();
  await byClass(recordingPlaybackTree, "check-in-navigation__home").props.onClick();
  recordingPlaybackLeavingPage.hide();
  assert.equal(recordingPlaybackLeavingPage.audios.find((audio) => audio.src === oldPending.localPath)?.events.at(-1), "destroy", "录音回听从房子离页必须释放当前会话");

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
    assert.equal(page.navigationMethods.at(-1), "redirectTo", "恢复应替换无效页，不能把错误页留在返回栈");
    assert.equal(page.audios.length, 0, "非法路由不能初始化录音会话");
  }
  const broken = createPage("src/pages/Practice/Practice.tsx", { bookId: "22", practice: "0" }, {
    overrides: { "@/features/listeningPractice/bookPractice": { buildBookPracticeBundle() { throw new Error("教材 22 第 2 页：缺少图片"); } } },
  });
  assert.match(textOf(broken.render()), /教材 22 第 2 页：缺少图片/);
  const brokenButton = elements(broken.render()).find((node) => node.type === "Button" && textOf(node) === "选择教材");
  assert.ok(brokenButton, "损坏教材应有可恢复的书库入口");
  brokenButton.props.onClick();
  assert.equal(broken.navigationMethods.at(-1), "redirectTo", "损坏教材恢复应替换无效页，不能把错误页留在返回栈");

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
  for (const book of BOOKS.filter((item) => item.seriesId !== "think")) {
    assert.equal(resolveBookAction(book).url, `/pages/Practice/Practice?bookId=${encodeURIComponent(book.id)}&practice=0`);
  }
  for (const book of BOOKS.filter((item) => item.seriesId === "think")) {
    assert.equal(resolveBookAction(book).url, `/pages/ThinkBookReader/ThinkBookReader?bookId=${encodeURIComponent(book.id)}&page=0`);
  }
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

module.exports = { createPage, elements, textOf, byClass, buildBookPracticeBundle, load };
if (require.main === module) {
  testRoutes()
    .catch((error) => { console.error(error); process.exitCode = 1; })
    .finally(() => {
      // 无论断言成功或失败都卸载测试页，验证真实 interval/timeout 不会拖住 Node 进程。
      for (const page of [...livePages]) page.dispose();
    });
}
