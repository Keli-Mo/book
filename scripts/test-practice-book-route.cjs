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
const { buildBookPracticeBundle, buildFullBookPracticeBundle } = load("src/features/listeningPractice/bookPractice.ts");
const { readBookImageSize, readBookStableCanvasSize } = load("src/features/listeningPractice/bookImageSizes.ts");
const { requestRecorderAction, resolveRecorderCallback } = load("src/features/listeningPractice/recordingStateMachine.ts");
const { createRecorderCoordinator, isRecorderStateConflictError } = load("src/features/listeningPractice/recorderCoordinator.ts");
const { createRecordingSessionJournal } = load("src/features/listeningPractice/recordingSessionJournal.ts");
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
  const actionSheetCalls = [];
  const pendingItems = [...(options.pendingItems || [])];
  const recordingSessionStorage = new Map();
  let recordingSessionSequence = 0;
  const recordingSessionJournal = createRecordingSessionJournal({
    storage: {
      get: (key) => recordingSessionStorage.get(key),
      set: (key, value) => recordingSessionStorage.set(key, value),
    },
    clock: { now: () => 1 },
    random: { hex: () => (++recordingSessionSequence).toString(16).padStart(32, "0") },
  });
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
    canIUse: (schema) => options.canIUse ? options.canIUse(schema) : true,
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
    showActionSheet: async (input) => {
      actionSheetCalls.push(input);
      if (options.showActionSheet) return options.showActionSheet(input);
      return { tapIndex: 0 };
    },
    getSetting: async () => {
      permissionChecks.push("scope.record:granted");
      if (options.getSetting) return options.getSetting();
      return { authSetting: { "scope.record": true } };
    },
    openSetting: async () => ({ authSetting: { "scope.record": true } }),
    authorize: async () => {},
    getImageInfo({ src, success }) {
      const bookId = String(params.bookId || "");
      const page = buildFullBookPracticeBundle(bookId)?.practices.find((practice) => practice.imageUrl === src);
      const size = page
        ? readBookImageSize(bookId, page.imageIndex) ?? readBookStableCanvasSize(bookId)
        : readBookStableCanvasSize(bookId);
      if (size) success?.(size);
    },
    createSelectorQuery() {
      let callback;
      const query = {
        select() { return query; },
        boundingClientRect(next) { callback = next; return query; },
        exec() { callback?.({ width: 374, height: 560 }); return query; },
      };
      return query;
    },
    createInnerAudioContext() {
      const handlers = {};
      const audio = {
        src: "",
        events: [],
        currentTime: 0,
        duration: 0,
        paused: true,
        playbackRate: 1,
      };
      for (const event of ["Canplay", "Play", "Pause", "Ended", "Stop", "Error", "TimeUpdate", "Waiting"]) audio[`on${event}`] = (callback) => { handlers[event] = callback; };
      audio.play = () => {
        audio.paused = false;
        audio.events.push("play");
        if (!options.deferAudioPlay) handlers.Play?.();
      };
      audio.pause = () => {
        audio.paused = true;
        audio.events.push("pause");
        handlers.Pause?.();
      };
      audio.seek = (seconds) => {
        audio.currentTime = seconds;
        audio.events.push(`seek:${seconds}`);
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
      if (outcome === "busy" || outcome === "uncertain") return { ok: false, reason: "busy", phase: outcome === "uncertain" ? "uncertain" : "draining" };
      if (outcome === "unavailable") return { ok: false, reason: "unavailable" };
      const session = { listener: null, detachedTerminalSink: null, phase: "idle", released: false };
      const runAction = (action, actionOptions) => {
        recorderActions.push(actionOptions === undefined ? { action } : { action, options: actionOptions });
        const actionOutcome = recorderActionOutcomes[action]?.shift();
        if (actionOutcome === "throw") {
          return { ok: false, reason: "exception", error: new Error(`${action} 同步失败`) };
        }
        if (actionOutcome === "throw-busy") {
          session.phase = "uncertain";
          return { ok: false, reason: "native-error", error: { errMsg: "operateRecorder:fail is recording or paused" } };
        }
        if (actionOutcome === "throw-uncertain") {
          session.phase = "uncertain";
          return { ok: false, reason: "native-error", error: new Error("native stop failed before terminal") };
        }
        if (actionOutcome === "stop-then-throw") {
          assert.equal(action, "stop");
          void dispatchRecorder("Stop", { tempFilePath: "/tmp/hidden-reentrant.mp3", duration: 1600, fileSize: 5000 });
          return { ok: false, reason: "native-error", error: new Error("stop callback preceded throw") };
        }
        if (actionOutcome === "start-then-throw") {
          assert.equal(action, "start");
          dispatchRecorder("Start");
          session.phase = "uncertain";
          return { ok: false, reason: "native-error", error: new Error("start callback preceded throw") };
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
          session.detachedTerminalSink = releaseOptions?.terminalSink || session.detachedTerminalSink;
          let stopResult = null;
          if (["starting", "recording", "paused"].includes(session.phase)) {
            stopResult = runAction("stop");
          }
          session.listener = null;
          session.released = true;
          if (stopResult && !stopResult.ok) return { ok: false, reason: "native-error", phase: session.phase, error: stopResult.error };
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
    getEntryRecoveryStatus: () => options.entryRecoveryStatus || "none",
    retryEntryRecovery: options.retryEntryRecovery || (async () => false),
    abandonUnconfirmedRecording: () => { if (activeRecorder) activeRecorder.phase = "idle"; return true; },
  };
  const dispatchRecorder = (event, value) => {
    const session = activeRecorder;
    const terminalEvent = event === "Stop" || event === "Error";
    // release 后协调器只保留终止回调；迟到的 Start/Pause/Resume 不得复活隐藏页。
    if (!terminalEvent && !session?.listener) return undefined;
    assert.ok(
      session?.listener || (terminalEvent && session?.detachedTerminalSink),
      `录音事件 ${event} 必须由页面 listener 或卸载后的 terminal sink 接收`,
    );
    if (event === "Start") session.phase = "recording";
    if (event === "Pause") session.phase = "paused";
    if (event === "Resume") session.phase = "recording";
    if (event === "Stop") session.phase = "idle";
    if (event === "Error") {
      const occupied = /is recording or paused/i.test(value?.errMsg || "");
      const uncertain = occupied || options.unknownErrorsUncertain !== false;
      if (uncertain && session.listener?.onStop) {
        const capturedStop = session.listener.onStop;
        session.detachedTerminalSink = (terminal) => terminal.type === "stop" ? capturedStop(terminal.result) : undefined;
      }
      session.phase = uncertain ? "uncertain" : "idle";
    }
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
      errMsg: operation === "stop" ? "录音停止确认超时，请稍候" : "录音启动确认超时，请稍候",
      code: "RECORDER_OPERATION_TIMEOUT",
      operation,
    });
  };
  recorderHandlers.DrainTimeout = () => {
    if (activeRecorder?.phase === "draining") activeRecorder.phase = "uncertain";
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
    retrySave: requestId => options.pendingRetrySave ? options.pendingRetrySave(requestId, pendingItems) : Promise.resolve(null),
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
      if (options.pendingComplete) return options.pendingComplete(requestId, committed, pendingItems);
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
    "@tarojs/components": Object.fromEntries(["View", "Text", "Image", "Input", "Button", "Slider", "ScrollView", "Swiper", "SwiperItem", "MovableArea", "MovableView", "PageMeta"].map((name) => [name, name])),
    "@tarojs/taro": { __esModule: true, default: taro, ...taro },
    "@/constant": { sharedImage: "share.png" },
    "@/services/cloudCheckIn": {
      getCheckInDetail: async () => options.detail,
      getReadableCloudError: (error) => error.message,
    },
    "@/features/listeningPractice/recorderCoordinator": { getRecorderCoordinator: () => options.recorderCoordinator || recorderCoordinator, isRecorderStateConflictError },
    "@/features/listeningPractice/recordingSessionJournal": { getRecordingSessionJournal: () => recordingSessionJournal },
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
    options.beforeEffects?.();
    effects.splice(0).forEach((effect) => effect());
    return tree;
  };
  const page = {
    render, navigations, navigationMethods, audios, recorderHandlers, recorderActions, permissionChecks, savedRecordings, submittedPending, completedPending,
    modalCalls, actionSheetCalls,
    recorderReleaseCalls, recorderTerminalOutcomes, recordingSessionJournal,
    get acquireAttempts() { return acquireAttempts; },
    setRecorderPhase(phase) { if (activeRecorder) activeRecorder.phase = phase; },
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
  const firstAudioPageIndex = buildBookPracticeBundle("22").practices[0].imageIndex;
  const pageLabel = (practice) => practice.pageLabel || `第 ${practice.pageNumber} 页`;
  const progress22 = (offset) => new RegExp(`^${pageLabel(buildFullBookPracticeBundle("22").practices[firstAudioPageIndex + offset])}$`);
  const practiceSessionSource = read("src/pages/Practice/PracticeSession.tsx");
  const practiceSource = `${read("src/pages/Practice/Practice.tsx")}\n${practiceSessionSource}`;
  assert.doesNotMatch(practiceSource, /SAMPLE_BOOK_(?:ID|TITLE|COVER|PRACTICES)|book3Practice/, "Practice 必须移除固定 CASA 模型，改为实际 router 选择教材");
  assert.doesNotMatch(practiceSource, /DEFAULT_BOOK_ID/, "训练页不得自行猜默认教材");
  assert.match(
    practiceSessionSource,
    /requestPracticeSwitch\(nextIndex, \{ animate: false \}\)/,
    "目录点选必须瞬时切页，不能走翻页滑动",
  );

  const touchTransitionBundle = buildFullBookPracticeBundle("21");
  const touchTransitionPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "21", page: "3" },
  );
  let touchTransitionTree = touchTransitionPage.render();
  touchTransitionTree = touchTransitionPage.render();
  let touchTransitionSwiper = elements(touchTransitionTree).find((node) => node.type === "Swiper");
  assert.equal(
    typeof touchTransitionSwiper.props.onAnimationFinish,
    "function",
    "手势翻页必须等原生动画结束后再提交训练页",
  );
  touchTransitionSwiper.props.onChange({ detail: { current: 4, source: "touch" } });
  touchTransitionTree = touchTransitionPage.render();
  touchTransitionSwiper = elements(touchTransitionTree).find((node) => node.type === "Swiper");
  assert.equal(touchTransitionSwiper.props.current, 4, "onChange 后应立即同步原生 Swiper 的受控页码");
  assert.equal(
    byClass(touchTransitionTree, "practice-book-page__image").props.src,
    touchTransitionBundle.practices[3].imageUrl,
    "原生动画尚未结束时必须保留旧页几何和热点，避免旧页边缘消失后重新出现",
  );
  assert.match(
    textOf(byClass(touchTransitionTree, "practice-header__progress")),
    new RegExp(`^${pageLabel(touchTransitionBundle.practices[3])}$`),
    "原生动画尚未结束时页码不得提前跳到目标页",
  );
  await touchTransitionSwiper.props.onAnimationFinish({
    detail: { current: 4, source: "" },
  });
  touchTransitionTree = touchTransitionPage.render();
  assert.equal(
    byClass(touchTransitionTree, "practice-book-page__image").props.src,
    touchTransitionBundle.practices[3].imageUrl,
    "非触摸 animationfinish 不能冒充当前手势的动画完成事件",
  );
  await touchTransitionSwiper.props.onAnimationFinish({
    detail: { current: 4, source: "touch" },
  });
  await settle();
  touchTransitionTree = touchTransitionPage.render();
  assert.equal(
    byClass(touchTransitionTree, "practice-book-page__image").props.src,
    touchTransitionBundle.practices[4].imageUrl,
    "原生动画结束后应一次性提交目标训练页",
  );
  assert.match(
    textOf(byClass(touchTransitionTree, "practice-header__progress")),
    new RegExp(`^${pageLabel(touchTransitionBundle.practices[4])}$`),
    "原生动画结束后页码应与目标书页一致",
  );
  touchTransitionPage.dispose();

  const interruptedTouchTimers = createFakeTimers();
  const interruptedTouchPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "21", page: "3" },
    {
      setTimeout: interruptedTouchTimers.setTimeout,
      clearTimeout: interruptedTouchTimers.clearTimeout,
    },
  );
  let interruptedTouchTree = interruptedTouchPage.render();
  interruptedTouchTree = interruptedTouchPage.render();
  byClass(interruptedTouchTree, "practice-book-swiper").props.onChange({
    detail: { current: 4, source: "touch" },
  });
  interruptedTouchTree = interruptedTouchPage.render();
  const interruptedDirectory = elements(interruptedTouchTree).find(
    (node) => node.type?.name === "PracticeDirectory",
  );
  await interruptedDirectory.props.onSelect(3);
  await settle();
  interruptedTouchTree = interruptedTouchPage.render();
  assert.equal(
    byClass(interruptedTouchTree, "practice-book-swiper").props.current,
    3,
    "手势动画中从目录选择当前业务页时必须把受控 Swiper 恢复到当前页",
  );
  await byClass(interruptedTouchTree, "practice-book-swiper").props.onAnimationFinish({
    detail: { current: 4, source: "touch" },
  });
  interruptedTouchTree = interruptedTouchPage.render();
  assert.equal(
    byClass(interruptedTouchTree, "practice-book-page__image").props.src,
    touchTransitionBundle.practices[3].imageUrl,
    "被目录取消的迟到手势完成事件不得再提交目标页",
  );
  interruptedTouchPage.dispose();

  const buttonTransitionTimers = createFakeTimers();
  const buttonTransitionPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "21", page: "3" },
    {
      setTimeout: buttonTransitionTimers.setTimeout,
      clearTimeout: buttonTransitionTimers.clearTimeout,
    },
  );
  let buttonTransitionTree = buttonTransitionPage.render();
  buttonTransitionTree = buttonTransitionPage.render();
  const buttonTransition = byClass(
    buttonTransitionTree,
    "practice-navigation__button--primary",
  ).props.onClick();
  buttonTransitionTree = buttonTransitionPage.render();
  assert.equal(
    byClass(buttonTransitionTree, "practice-book-swiper").props.duration,
    0,
    "底部按钮切页必须瞬时换图，不能重现两页横向交叠",
  );
  await buttonTransition;
  await settle();
  buttonTransitionTree = buttonTransitionPage.render();
  assert.equal(
    byClass(buttonTransitionTree, "practice-book-page__image").props.src,
    touchTransitionBundle.practices[4].imageUrl,
    "底部按钮应直接提交目标训练页",
  );
  assert.equal(
    byClass(buttonTransitionTree, "practice-book-swiper").props.duration,
    0,
    "瞬时切页状态必须至少保留一个渲染周期，不能在同一微任务恢复动画",
  );
  buttonTransitionTimers.advance(40);
  const secondButtonTransition = byClass(
    buttonTransitionTree,
    "practice-navigation__button--primary",
  ).props.onClick();
  await secondButtonTransition;
  await settle();
  buttonTransitionTree = buttonTransitionPage.render();
  assert.equal(
    byClass(buttonTransitionTree, "practice-book-page__image").props.src,
    touchTransitionBundle.practices[5].imageUrl,
    "连续按钮切页应提交第二个目标页",
  );
  buttonTransitionTimers.advance(10);
  assert.equal(
    byClass(buttonTransitionPage.render(), "practice-book-swiper").props.duration,
    0,
    "第一次切页的旧定时器不能把第二次瞬时切页提前恢复为动画",
  );
  buttonTransitionTimers.advance(40);
  assert.equal(
    byClass(buttonTransitionPage.render(), "practice-book-swiper").props.duration,
    300,
    "瞬时切页完成后应恢复手势动画时长",
  );
  buttonTransitionPage.dispose();

  const ketPage = createPage("src/pages/Practice/Practice.tsx", { bookId: "9", page: "7" });
  ketPage.render();
  const ketTree = ketPage.render();
  assert.equal(textOf(byClass(ketTree, "practice-header__progress")).trim(), "第 7 页");
  assert.doesNotMatch(textOf(byClass(ketTree, "practice-header__progress")), /跟读训练|\d+\s*\/\s*\d+/);
  ketPage.dispose();

  const ketFrontBlank = createPage("src/pages/Practice/Practice.tsx", { bookId: "9", page: "2" });
  let ketBlankTree = ketFrontBlank.render();
  assert.match(byClass(ketBlankTree, "practice-book-page__image").props.src, /_4\.png(?:\?|$)/,
    "旧链接指向前置空白页时应落到下一张非空页，且不改变源图片索引");
  assert.equal(textOf(byClass(ketBlankTree, "practice-header__progress")).trim(), "第 3 页");
  ketFrontBlank.dispose();

  const ketTrailingBlank = createPage("src/pages/Practice/Practice.tsx", { bookId: "9", page: "188" });
  ketBlankTree = ketTrailingBlank.render();
  assert.match(byClass(ketBlankTree, "practice-book-page__image").props.src, /_188\.png(?:\?|$)/,
    "旧链接指向末尾空白页时应落到上一张非空页");
  assert.equal(textOf(byClass(ketBlankTree, "practice-header__progress")).trim(), "第 187 页");
  ketTrailingBlank.dispose();

  assert.equal(fs.existsSync(path.join(projectRoot, "src/features/listeningPractice/book3Practice.ts")), false, "固定 CASA 死文件应在替换引用后删除");
  for (const bookId of ["3", "22", "25"]) {
    const bundle = buildFullBookPracticeBundle(bookId);
    for (const index of [0, bundle.practices.length - 1]) {
      const page = createPage("src/pages/Practice/Practice.tsx", { bookId, page: String(index) }, { savedFilePath: "/saved/recording.mp3" });
      let tree = page.render();
      const practice = bundle.practices[index];
      assert.equal(textOf(byClass(tree, "practice-header__course")), bundle.book.title);
      assert.equal(textOf(byClass(tree, "practice-header__progress")).trim(), pageLabel(practice));
      assert.doesNotMatch(textOf(byClass(tree, "practice-header__progress")), /跟读训练|\d+\s*\/\s*\d+/);
      assert.equal(byClass(tree, "practice-book-page__image").props.src, practice.imageUrl);
      assert.equal(textOf(byClass(tree, "practice-header__section")), practice.sectionTitle);
      const hotspots = elements(tree).filter((node) => String(node.props?.className || "").split(" ").includes("audio-hotspot"));
      assert.equal(hotspots.length, practice.tracks.length);
      if (practice.tracks.length) {
        assert.deepEqual(hotspots[0].props.style, { left: practice.tracks[0].left, top: practice.tracks[0].top });
        hotspots[0].props.onClick();
        assert.equal(page.audios.at(-1).src, practice.tracks[0].url);
      }
      const directory = elements(tree).find((node) => node.type?.name === "PracticeDirectory");
      assert.deepEqual(directory.props.groups.flatMap((group) => group.items).map((item) => item.id), bundle.practices.map((item) => item.id));
      await directory.props.onSelect(bundle.practices.length);
      await directory.props.onSelect(-1);
      await directory.props.onSelect(0.5);
      assert.equal(textOf(byClass(page.render(), "practice-header__progress")).trim(), pageLabel(practice), "目录越界不能破坏当前训练");
      const navigation = () => elements(page.render()).filter((node) => String(node.props?.className || "").split(" ").includes("practice-navigation__button"));
      const boundaryButton = index === 0 ? 0 : 1;
      assert.match(navigation()[boundaryButton].props.className, /practice-navigation__button--disabled/);
      await navigation()[boundaryButton].props.onClick();
      assert.equal(byClass(page.render(), "practice-book-page__image").props.src, practice.imageUrl, "首尾点击不能夹页或跨教材");
      const bookSwiper = () => elements(page.render()).find((node) => node.type === "Swiper");
      assert.ok(bookSwiper(), "课文区域应使用原生 Swiper 翻页");
      assert.equal(typeof bookSwiper().props.onChange, "function", "Swiper 应把手指翻页交给训练切换");
      const swipeBook = async (nextIndex) => {
        bookSwiper().props.onChange({ detail: { current: nextIndex, source: "touch" } });
        await bookSwiper().props.onAnimationFinish({ detail: { current: nextIndex, source: "touch" } });
      };
      if (index === 0) {
        await swipeBook(-1);
        assert.equal(byClass(page.render(), "practice-book-page__image").props.src, practice.imageUrl, "首页右滑不能夹页");
        await swipeBook(1);
      } else {
        await swipeBook(index + 1);
        assert.equal(byClass(page.render(), "practice-book-page__image").props.src, practice.imageUrl, "末页左滑不能夹页");
        await swipeBook(index - 1);
      }
      const adjacent = index === 0 ? 1 : index - 1;
      assert.equal(byClass(page.render(), "practice-book-page__image").props.src, bundle.practices[adjacent].imageUrl, "左右滑应在当前 bundle 内切换");
      await navigation()[boundaryButton].props.onClick();
      tree = page.render();
      const startButton = elements(tree).find((node) => node.type === "Button" && textOf(node).includes("开始跟读录音"));
      assert.ok(startButton, "录音能力确认后应显示开始按钮");
      await startButton.props.onClick();
      assert.equal(page.recordingSessionJournal.read()?.stage, "starting", "调用原生 start 前必须同步写入起始页录音记录");
      assert.deepEqual(page.permissionChecks, ["scope.record:granted"], "开始录音前必须确认麦克风已授权");
      assert.deepEqual(page.recorderActions[0], {
        action: "start",
        options: { duration: 300000, sampleRate: 16000, numberOfChannels: 1, encodeBitRate: 48000, format: "mp3" },
      }, "点击开始必须把生产录音参数交给 recorder owner");
      page.recorderHandlers.Start();
      assert.equal(page.recordingSessionJournal.read()?.stage, "confirmed", "只有原生 onStart 才能确认会话归属");
      tree = page.render();
      const stopButton = elements(tree).find((node) => node.type === "Button" && textOf(node) === "结束录音");
      assert.ok(stopButton, "原生 Start 回调后应进入录音态");
      stopButton.props.onClick();
      assert.equal(page.recorderActions.at(-1).action, "stop", "结束按钮必须请求原生 stop");
      page.recorderHandlers.Stop({ tempFilePath: "/tmp/recording.mp3", duration: 1200, fileSize: 4096 });
      assert.equal(page.recordingSessionJournal.read()?.stage, "terminal", "停止文件须先记入可恢复记录再异步保存");
      await settle();
      assert.equal(page.recordingSessionJournal.read(), null, "本地保存成功后才可清除录音记录和新录音锁");
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
        recordingSessionId: "00000000000000000000000000000001",
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
  assert.equal(hiddenWhileStarting.savedRecordings.length, 0, "未经 onStart 确认的停止文件可能属于旧录音，不能保存到新页面");

  let appHideHandler = null;
  const appHiddenRecording = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      savedFilePath: "/saved/app-hide-a.mp3",
      taroOverrides: {
        onAppHide(handler) { appHideHandler = handler; },
        offAppHide(handler) { if (appHideHandler === handler) appHideHandler = null; },
      },
    },
  );
  let appHiddenTree = appHiddenRecording.render();
  appHiddenTree = appHiddenRecording.render();
  await byClass(appHiddenTree, "record-button").props.onClick();
  appHiddenRecording.recorderHandlers.Start();
  assert.equal(typeof appHideHandler, "function", "微信右上角关闭须注册 AppHide 收口");
  appHideHandler();
  appHiddenRecording.hide();
  assert.equal(appHiddenRecording.recorderActions.filter(({ action }) => action === "stop").length, 1, "AppHide 与 PageHide 连续触发只能停止一次");
  assert.equal(appHiddenRecording.recorderActions.filter(({ action }) => action === "pause").length, 0, "关闭小程序不能把 A 留在暂停态");
  assert.equal(appHiddenRecording.recorderReleaseCalls.length, 1, "A 页仍挂载时也必须交还全局录音器");
  assert.equal(typeof appHiddenRecording.recorderReleaseCalls[0].terminalSink, "function", "A 页必须保留迟到的停止保存回调");
  await appHiddenRecording.recorderHandlers.Stop({ tempFilePath: "/tmp/app-hide-a.mp3", duration: 2100, fileSize: 5000 });
  await settle();
  assert.equal(appHiddenRecording.savedRecordings[0]?.context.practiceIndex, firstAudioPageIndex, "A 页隐藏后的录音仍归 A 页");
  appHiddenRecording.show();
  appHiddenTree = appHiddenRecording.render();
  appHiddenTree = appHiddenRecording.render();
  assert.equal(appHiddenRecording.acquireAttempts, 2, "A 页再显示时须重新获取录音器");
  await byClass(appHiddenTree, "practice-recorder__retry").props.onClick();
  assert.equal(appHiddenRecording.recorderActions.filter(({ action }) => action === "start").length, 2, "A 页返回后可再次录音");

  const noStopTimers = createFakeTimers();
  const noStopCallbacks = {};
  const noStopNativeCalls = { start: 0, stop: 0 };
  const noStopNative = {
    onStart(callback) { noStopCallbacks.start = callback; },
    onStop(callback) { noStopCallbacks.stop = callback; },
    onError(callback) { noStopCallbacks.error = callback; },
    start() { noStopNativeCalls.start += 1; },
    stop() { noStopNativeCalls.stop += 1; },
  };
  const noStopCoordinator = createRecorderCoordinator({
    getRecorderManager: () => noStopNative,
    scheduler: noStopTimers,
    drainTimeoutMs: 5000,
    abandonQuietWindowMs: 1000,
  });
  let noStopAppHide;
  const noStopPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      recorderCoordinator: noStopCoordinator,
      setTimeout: noStopTimers.setTimeout,
      clearTimeout: noStopTimers.clearTimeout,
      taroOverrides: {
        onAppHide(callback) { noStopAppHide = callback; },
        offAppHide(callback) { if (noStopAppHide === callback) noStopAppHide = null; },
      },
      showModal: async () => ({ confirm: true, cancel: false }),
    },
  );
  let noStopTree = noStopPage.render();
  noStopTree = noStopPage.render();
  await byClass(noStopTree, "record-button").props.onClick();
  assert.equal(noStopNativeCalls.start, 1, "A 页须先发起真实协调器录音");
  noStopCallbacks.start();
  assert.equal(noStopPage.recordingSessionJournal.read()?.stage, "confirmed");
  assert.equal(typeof noStopAppHide, "function");
  noStopAppHide();
  noStopPage.hide();
  assert.equal(noStopNativeCalls.stop, 1, "右上角退出时仅请求一次 stop");
  assert.equal(noStopCoordinator.getPhase(), "draining");
  noStopPage.show();
  noStopTree = noStopPage.render();
  noStopTree = noStopPage.render();
  assert.match(textOf(noStopTree), /正在自动恢复录音设备/, "热返回应进入自动恢复状态");
  assert.equal(byClass(noStopTree, "record-button--check-recovery"), undefined, "热返回自动处理旧录音，不要求用户点入口");
  noStopTimers.advance(1499);
  assert.notEqual(noStopPage.recordingSessionJournal.read(), null, "短暂收尾时仍给旧录音结束回调机会");
  noStopTimers.advance(1);
  assert.equal(noStopPage.recordingSessionJournal.read(), null, "短时无回调后自动放弃旧录音");
  assert.equal(noStopPage.modalCalls.length, 0, "自动放弃不弹确认框");
  noStopTimers.advance(1000);
  noStopTree = noStopPage.render();
  noStopTree = noStopPage.render();
  assert.equal(noStopCoordinator.getPhase(), "idle", "放弃后的短暂隔离应在小程序内结束");
  const noStopRetryButton = byClass(noStopTree, "record-button");
  assert.ok(noStopRetryButton, "用户放弃后，无须重启微信即可再次录音");
  await noStopRetryButton.props.onClick();
  assert.equal(noStopNativeCalls.start, 2, "用户重新点击才启动第二段录音");
  noStopPage.dispose();

  const unconfirmedCloseTimers = createFakeTimers();
  const unconfirmedCloseCallbacks = {};
  const unconfirmedCloseNative = {
    onStart(callback) { unconfirmedCloseCallbacks.start = callback; },
    onStop(callback) { unconfirmedCloseCallbacks.stop = callback; },
    onError(callback) { unconfirmedCloseCallbacks.error = callback; },
    start() {}, stop() {},
  };
  const unconfirmedCloseCoordinator = createRecorderCoordinator({
    getRecorderManager: () => unconfirmedCloseNative,
    scheduler: unconfirmedCloseTimers,
    quietWindowMs: 10,
  });
  let unconfirmedCloseAppHide;
  const unconfirmedClosePage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      recorderCoordinator: unconfirmedCloseCoordinator,
      setTimeout: unconfirmedCloseTimers.setTimeout,
      clearTimeout: unconfirmedCloseTimers.clearTimeout,
      taroOverrides: {
        onAppHide(callback) { unconfirmedCloseAppHide = callback; },
        offAppHide(callback) { if (unconfirmedCloseAppHide === callback) unconfirmedCloseAppHide = null; },
      },
      showModal: async () => ({ confirm: true, cancel: false }),
    },
  );
  let unconfirmedCloseTree = unconfirmedClosePage.render();
  unconfirmedCloseTree = unconfirmedClosePage.render();
  await byClass(unconfirmedCloseTree, "record-button").props.onClick();
  assert.equal(unconfirmedClosePage.recordingSessionJournal.read()?.stage, "starting");
  unconfirmedCloseAppHide();
  unconfirmedClosePage.hide();
  unconfirmedCloseCallbacks.stop({ tempFilePath: "/tmp/old-before-confirm.mp3", duration: 1700, fileSize: 5000 });
  unconfirmedCloseTimers.advance(10);
  assert.equal(unconfirmedCloseCoordinator.getPhase(), "idle");
  unconfirmedClosePage.show();
  unconfirmedCloseTree = unconfirmedClosePage.render();
  unconfirmedCloseTree = unconfirmedClosePage.render();
  assert.equal(byClass(unconfirmedCloseTree, "record-button--check-recovery"), undefined, "热返回后未确认录音由页面自动放弃");
  unconfirmedCloseTimers.advance(1500);
  assert.equal(unconfirmedClosePage.recordingSessionJournal.read(), null);
  assert.equal(unconfirmedClosePage.savedRecordings.length, 0);
  unconfirmedCloseTimers.advance(1000);
  unconfirmedCloseTree = unconfirmedClosePage.render();
  unconfirmedCloseTree = unconfirmedClosePage.render();
  assert.ok(byClass(unconfirmedCloseTree, "record-button"), "放弃无法归属的旧文件后可直接重录");
  unconfirmedClosePage.dispose();

  // 右上角关闭后微信进程仍在时，App.onLaunch 不会再运行：旧 onStop 已到达，
  // 但本地保存未完成，协调器已经 idle。页面上的“尝试保存”必须处理 journal 本身。
  const hotReturnNative = {
    start() {}, stop() {}, onStart() {}, onStop() {}, onError() {},
  };
  const hotReturnCoordinator = createRecorderCoordinator({ getRecorderManager: () => hotReturnNative });
  const hotReturnPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      recorderCoordinator: hotReturnCoordinator,
      savedFilePath: "/saved/hot-return.mp3",
      showModal: async () => ({ confirm: false, cancel: true }),
    },
  );
  const hotReturnPractice = buildFullBookPracticeBundle("22").practices[firstAudioPageIndex];
  const hotReturnSession = hotReturnPage.recordingSessionJournal.begin({
    bookId: "22", bookTitle: buildBookPracticeBundle("22").book.title,
    practiceId: hotReturnPractice.id, practiceIndex: firstAudioPageIndex,
    pageNumber: hotReturnPractice.pageNumber, sectionTitle: hotReturnPractice.sectionTitle,
    imageUrl: hotReturnPractice.imageUrl,
  });
  assert.equal(hotReturnPage.recordingSessionJournal.confirm(hotReturnSession.id), true);
  assert.equal(hotReturnPage.recordingSessionJournal.recordTerminal(hotReturnSession.id, {
    tempFilePath: "/tmp/hot-return.mp3", duration: 2100, fileSize: 5000,
  }), true);
  let hotReturnTree = hotReturnPage.render();
  hotReturnTree = hotReturnPage.render();
  assert.equal(hotReturnCoordinator.getPhase(), "idle", "热返回前原生录音器可能已经结束");
  assert.equal(hotReturnCoordinator.getEntryRecoveryStatus(), "none", "热返回前尚未建立恢复任务");
  hotReturnPage.show();
  await settle();
  hotReturnTree = hotReturnPage.render();
  assert.equal(byClass(hotReturnTree, "record-button--check-recovery"), undefined, "热返回的停止文件由页面自动保存，无手动入口");
  assert.equal(hotReturnPage.savedRecordings.length, 1, "热返回应自动保存已有停止文件");
  assert.equal(hotReturnPage.savedRecordings[0]?.recordingSessionId, hotReturnSession.id);
  assert.equal(hotReturnPage.recordingSessionJournal.read(), null, "旧录音保存成功后必须解除持久录音锁");
  hotReturnPage.dispose();

  const changedWhileModalCoordinator = createRecorderCoordinator({ getRecorderManager: () => hotReturnNative });
  const changedWhileModalPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      recorderCoordinator: changedWhileModalCoordinator,
      savedFilePath: "/saved/new-modal.mp3",
    },
  );
  const oldModalSession = changedWhileModalPage.recordingSessionJournal.begin(hotReturnSession.context);
  changedWhileModalPage.recordingSessionJournal.confirm(oldModalSession.id);
  changedWhileModalPage.recordingSessionJournal.recordTerminal(oldModalSession.id, {
    tempFilePath: "/tmp/old-modal.mp3", duration: 2100, fileSize: 5000,
  });
  changedWhileModalPage.recordingSessionJournal.clear(oldModalSession.id);
  const newerSession = changedWhileModalPage.recordingSessionJournal.begin(hotReturnSession.context);
  changedWhileModalPage.recordingSessionJournal.confirm(newerSession.id);
  changedWhileModalPage.recordingSessionJournal.recordTerminal(newerSession.id, {
    tempFilePath: "/tmp/new-modal.mp3", duration: 2200, fileSize: 5100,
  });
  changedWhileModalPage.render();
  changedWhileModalPage.render();
  changedWhileModalPage.show();
  await settle();
  assert.equal(changedWhileModalPage.savedRecordings.length, 1, "自动恢复只保存显示时最新的停止文件");
  assert.equal(changedWhileModalPage.savedRecordings[0].tempFilePath, "/tmp/new-modal.mp3");
  assert.equal(changedWhileModalPage.savedRecordings[0].recordingSessionId, newerSession.id);
  assert.equal(changedWhileModalPage.recordingSessionJournal.read(), null);
  assert.equal(byClass(changedWhileModalPage.render(), "record-button--check-recovery"), undefined);
  changedWhileModalPage.dispose();

  const busyOnReturn = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { acquireSequence: ["ok", "busy", "ok"], savedFilePath: "/saved/busy-on-return.mp3" },
  );
  let busyOnReturnTree = busyOnReturn.render();
  busyOnReturnTree = busyOnReturn.render();
  await byClass(busyOnReturnTree, "record-button").props.onClick();
  busyOnReturn.recorderHandlers.Start();
  busyOnReturnTree = busyOnReturn.render();
  byClass(busyOnReturnTree, "record-button--stop").props.onClick();
  await busyOnReturn.recorderHandlers.Stop({ tempFilePath: "/tmp/busy-on-return.mp3", duration: 1500, fileSize: 5000 });
  busyOnReturn.hide();
  busyOnReturn.show();
  busyOnReturnTree = busyOnReturn.render();
  busyOnReturnTree = busyOnReturn.render();
  assert.equal(busyOnReturn.acquireAttempts, 2);
  assert.equal(byClass(busyOnReturnTree, "practice-recorder__retry").props["aria-disabled"], true, "B 占有空闲录音器时，返回的 A 页重录按钮也必须锁住");
  assert.match(textOf(busyOnReturnTree), /正在自动恢复录音设备/);

  const pausedAppHide = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { savedFilePath: "/saved/paused-app-hide.mp3" },
  );
  let pausedAppHideTree = pausedAppHide.render();
  pausedAppHideTree = pausedAppHide.render();
  await byClass(pausedAppHideTree, "record-button").props.onClick();
  pausedAppHide.recorderHandlers.Start();
  pausedAppHideTree = pausedAppHide.render();
  byClass(pausedAppHideTree, "record-button--pause").props.onClick();
  pausedAppHide.recorderHandlers.Pause();
  pausedAppHide.hide();
  assert.equal(pausedAppHide.recorderActions.at(-1).action, "stop", "已暂停的 A 录音在关闭小程序时也须结束");
  assert.equal(pausedAppHide.recorderReleaseCalls.length, 1, "已暂停录音也要交还 owner");
  await pausedAppHide.recorderHandlers.Stop({ tempFilePath: "/tmp/paused-app-hide.mp3", duration: 1600, fileSize: 5000 });
  assert.equal(pausedAppHide.savedRecordings[0]?.context.practiceIndex, firstAudioPageIndex);

  const idleAppHide = createPage("src/pages/Practice/Practice.tsx", { bookId: "22", practice: "0" });
  idleAppHide.render();
  idleAppHide.render();
  idleAppHide.hide();
  assert.equal(idleAppHide.recorderReleaseCalls.length, 1, "A 页没有录音也不能占住 B 的录音器");
  idleAppHide.show();
  idleAppHide.render();
  assert.equal(idleAppHide.acquireAttempts, 2, "空闲的 A 页再显示时也能重新获取 owner");

  const hiddenStopReentrant = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      recorderCapabilities: { canRecord: true, canPause: false, canResume: false, canInterrupt: false },
      recorderActionOutcomes: { stop: ["stop-then-throw"] },
      savedFilePath: "/saved/hidden-reentrant.mp3",
    },
  );
  let hiddenReentrantTree = hiddenStopReentrant.render();
  hiddenReentrantTree = hiddenStopReentrant.render();
  await byClass(hiddenReentrantTree, "record-button").props.onClick();
  hiddenStopReentrant.recorderHandlers.Start();
  hiddenStopReentrant.hide();
  await settle();
  assert.equal(hiddenStopReentrant.savedRecordings.length, 1, "后台同步 Stop 回调仍须保存录音");
  assert.equal(
    hiddenStopReentrant.stateValues().find((value) => value?.sessionId === 1 && value.capabilities?.canRecord)?.state,
    "recorded",
    "stop 先回调后报错时，不能把已完成录音的状态回退成 recording",
  );

  const hiddenUncertainTimers = createFakeTimers();
  const hiddenUncertainPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      recorderCapabilities: { canRecord: true, canPause: false, canResume: false, canInterrupt: false },
      recorderActionOutcomes: { stop: ["throw-uncertain"] },
      acquireSequence: ["ok", "uncertain"],
      savedFilePath: "/saved/hidden-uncertain.mp3",
      setTimeout: hiddenUncertainTimers.setTimeout,
      clearTimeout: hiddenUncertainTimers.clearTimeout,
    },
  );
  let hiddenUncertainTree = hiddenUncertainPage.render();
  hiddenUncertainTree = hiddenUncertainPage.render();
  await byClass(hiddenUncertainTree, "record-button").props.onClick();
  hiddenUncertainPage.recorderHandlers.Start();
  hiddenUncertainPage.hide();
  assert.equal(hiddenUncertainTimers.size, 1, "协调器 uncertain 后仅保留短暂的退出收尾计时，不再安排 stop 重试");
  assert.equal(hiddenUncertainPage.recorderActions.filter(({ action }) => action === "stop").length, 1);
  hiddenUncertainPage.show();
  hiddenUncertainTree = hiddenUncertainPage.render();
  assert.match(textOf(hiddenUncertainTree), /正在自动恢复录音设备/, "后台 stop 原生状态不明时，回前台必须显示自动恢复态");
  assert.equal(byClass(hiddenUncertainTree, "record-button--check-recovery"), undefined, "热返回时无需手动处理入口");
  assert.equal(byClass(hiddenUncertainTree, "record-button--stop"), undefined, "不确定状态不能继续显示结束录音按钮");
  await hiddenUncertainPage.recorderHandlers.Stop({ tempFilePath: "/tmp/hidden-uncertain.mp3", duration: 1900, fileSize: 5000 });
  assert.equal(hiddenUncertainPage.savedRecordings[0]?.context.practiceIndex, firstAudioPageIndex, "迟到 onStop 必须保存到原录音页");

  const recordingAcrossPages = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { savedFilePath: "/saved/across-pages.mp3" },
  );
  let recordingAcrossPagesTree = recordingAcrossPages.render();
  recordingAcrossPagesTree = recordingAcrossPages.render();
  await byClass(recordingAcrossPagesTree, "record-button").props.onClick();
  recordingAcrossPages.recorderHandlers.Start();
  recordingAcrossPagesTree = recordingAcrossPages.render();
  await byClass(recordingAcrossPagesTree, "practice-navigation__button--primary").props.onClick();
  recordingAcrossPagesTree = recordingAcrossPages.render();
  assert.match(textOf(byClass(recordingAcrossPagesTree, "practice-header__progress")), progress22(1), "录音中允许翻页");
  assert.doesNotMatch(textOf(recordingAcrossPagesTree), /归属|开始录音的页面/, "跨页录音不向用户展示内部归属规则");
  byClass(recordingAcrossPagesTree, "record-button--pause").props.onClick();
  recordingAcrossPages.recorderHandlers.Pause();
  recordingAcrossPagesTree = recordingAcrossPages.render();
  assert.doesNotMatch(textOf(recordingAcrossPagesTree), /归属|开始录音的页面/, "跨页暂停也不展示内部归属规则");
  byClass(recordingAcrossPagesTree, "record-button--resume").props.onClick();
  recordingAcrossPages.recorderHandlers.Resume();
  recordingAcrossPagesTree = recordingAcrossPages.render();
  byClass(recordingAcrossPagesTree, "record-button--stop").props.onClick();
  await recordingAcrossPages.recorderHandlers.Stop({
    tempFilePath: "/tmp/across-pages.mp3",
    duration: 2400,
    fileSize: 5000,
  });
  await settle();
  assert.equal(recordingAcrossPages.savedRecordings.length, 1);
  assert.equal(
    recordingAcrossPages.savedRecordings[0].context.practiceIndex,
    firstAudioPageIndex,
    "跨页录音必须保存到开始录音的训练页",
  );
  recordingAcrossPagesTree = recordingAcrossPages.render();
  assert.ok(byClass(recordingAcrossPagesTree, "check-in-button"), "跨页录音保存后，当前页应保留完成练习入口");
  assert.ok(
    elements(recordingAcrossPagesTree).some((node) => node.type === "Button" && textOf(node) === "重新录制"),
    "跨页录音保存后，当前页应保留重新录制入口",
  );
  assert.ok(
    elements(recordingAcrossPagesTree).some((node) => node.type === "Button" && textOf(node) === "删除录音"),
    "跨页录音保存后，当前页应保留删除录音入口",
  );

  const reentrantStartPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { recorderActionOutcomes: { start: ["start-then-throw"] }, savedFilePath: "/saved/start-then-throw.mp3" },
  );
  reentrantStartPage.render();
  let reentrantStartTree = reentrantStartPage.render();
  await byClass(reentrantStartTree, "record-button").props.onClick();
  reentrantStartTree = reentrantStartPage.render();
  assert.equal(byClass(reentrantStartTree, "record-button--stop"), undefined, "原生 stop 尚未确认时不得显示不可用的结束按钮");
  assert.match(textOf(reentrantStartTree), /正在自动恢复录音设备/, "start 重入失败后应提示自动等待原生录音器收口");
  await byClass(reentrantStartTree, "practice-navigation__button--primary").props.onClick();
  reentrantStartTree = reentrantStartPage.render();
  await reentrantStartPage.recorderHandlers.Stop({
    tempFilePath: "/tmp/start-then-throw.mp3", duration: 1800, fileSize: 4200,
  });
  assert.equal(reentrantStartPage.savedRecordings[0]?.context.practiceIndex, firstAudioPageIndex, "start 同步确认后抛错与翻页并发时仍归起始页");

  const remountedWhileRecording = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { savedFilePath: "/saved/remount.mp3" },
  );
  let remountedTree = remountedWhileRecording.render();
  remountedTree = remountedWhileRecording.render();
  await byClass(remountedTree, "record-button").props.onClick();
  remountedWhileRecording.recorderHandlers.Start();
  remountedWhileRecording.setRoute({ bookId: "22", practice: "1" });
  assert.equal(typeof remountedWhileRecording.recorderReleaseCalls[0]?.terminalSink, "function", "训练组件重挂必须保留旧录音终止回调");
  await remountedWhileRecording.recorderReleaseCalls[0].terminalSink({
    type: "stop",
    result: { tempFilePath: "/tmp/remount.mp3", duration: 2200, fileSize: 4900 },
  });
  assert.equal(remountedWhileRecording.savedRecordings[0]?.context.practiceIndex, firstAudioPageIndex, "组件重挂后的录音仍归属旧页");

  const remountStopError = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { recorderActionOutcomes: { stop: ["throw-uncertain"] }, savedFilePath: "/saved/remount-stop-error.mp3" },
  );
  remountStopError.render();
  let remountStopErrorTree = remountStopError.render();
  await byClass(remountStopErrorTree, "record-button").props.onClick();
  remountStopError.recorderHandlers.Start();
  remountStopError.setRoute({ bookId: "22", practice: "1" });
  const remountStopSink = remountStopError.recorderReleaseCalls[0]?.terminalSink;
  assert.equal(typeof remountStopSink, "function", "stop 同步抛错时协调器仍应保留旧录音保存回调");
  await remountStopSink({ type: "stop", result: {
    tempFilePath: "/tmp/remount-stop-error.mp3", duration: 2200, fileSize: 4900,
  } });
  assert.equal(remountStopError.savedRecordings[0]?.context.practiceIndex, firstAudioPageIndex, "release 返回错误但仍等待 onStop 时不得 dispose 原状态");

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
  assert.equal(hiddenPauseFailure.recorderActions.at(-1).action, "stop", "页面隐藏必须直接 stop");
  assert.equal(hiddenPauseFailure.recorderActions.filter(({ action }) => action === "pause").length, 0, "隐藏后不应留下暂停的录音器");
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
  assert.equal(
    hiddenStartFailure.recorderActions.filter(({ action }) => action === "stop").length,
    2,
    "首次 stop 失败时释放 owner 仍应尝试安全停止",
  );
  assert.equal(hiddenStartRetryTimers.size, 1, "释放 owner 后只保留退出收尾计时，不再安排额外 stop 重试");
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
    2,
    "隐藏页停止失败后立即交给协调器，页面不能无限重试",
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
  assert.equal(unloadRetryTimers.size, 1, "页面隐藏后 owner 已交由协调器，仅保留退出收尾计时");
  unloadRetryPage.unload();
  const unloadActionCount = unloadRetryPage.recorderActions.length;
  assert.equal(unloadRetryTimers.size, 2, "隐藏和卸载各保留幂等退出收尾计时，不再安排隐藏页 stop 重试");
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
  assert.equal(hiddenWhileResuming.recorderActions.at(-1).action, "stop", "隐藏后迟到的 Resume 确认不能重新暂停");

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
  const stopCountBeforeLateResume = hiddenResumeFailure.recorderActions.filter(({ action }) => action === "stop").length;
  hiddenResumeFailure.recorderHandlers.Resume();
  assert.equal(hiddenResumeFailure.recorderActions.at(-1).action, "stop", "隐藏后迟到 onResume 不能发出 pause");
  assert.equal(hiddenResumeFailure.recorderActions.filter(({ action }) => action === "stop").length, stopCountBeforeLateResume, "迟到 onResume 也不能重复停止");
  assert.equal(hiddenResumeRetryTimers.size, 1, "原生状态不确定时仅保留退出收尾计时，没有额外 stop 重试");
  hiddenResumeRetryTimers.advance(5000);
  assert.equal(
    hiddenResumeFailure.recorderActions.filter(({ action }) => action === "stop").length,
    stopCountBeforeLateResume,
    "释放 owner 后页面不得再对旧录音发 stop",
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
  assert.match(textOf(busyTree), /正在自动恢复录音设备/, "busy 应保持检测态并解释正在恢复，不能误报设备不支持");
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

  const hiddenBusyTimers = createFakeTimers();
  const hiddenBusyPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { acquireSequence: ["busy", "ok"], setTimeout: hiddenBusyTimers.setTimeout, clearTimeout: hiddenBusyTimers.clearTimeout },
  );
  hiddenBusyPage.render();
  hiddenBusyPage.render();
  hiddenBusyPage.hide();
  hiddenBusyTimers.advance(300);
  hiddenBusyPage.render();
  assert.equal(hiddenBusyPage.acquireAttempts, 1, "隐藏的 A 页不能靠 busy 重试抢走 B 页 owner");
  hiddenBusyPage.show();
  hiddenBusyPage.render();
  assert.equal(hiddenBusyPage.acquireAttempts, 2, "A 页重新显示后才可恢复 acquire");

  const uncertainTimers = createFakeTimers();
  const uncertainPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      acquireSequence: ["uncertain"],
      setTimeout: uncertainTimers.setTimeout,
      clearTimeout: uncertainTimers.clearTimeout,
    },
  );
  uncertainPage.render();
  const uncertainTree = uncertainPage.render();
  assert.match(textOf(uncertainTree), /正在自动恢复录音设备/, "原生状态未知时应给出自动恢复说明");
  assert.equal(byClass(uncertainTree, "record-button"), undefined, "原生状态未知时不能开放录音按钮");
  uncertainPage.dispose();

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

  const occupiedPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
  );
  occupiedPage.render();
  let occupiedTree = occupiedPage.render();
  await byClass(occupiedTree, "record-button").props.onClick();
  occupiedPage.recorderHandlers.Error({ errMsg: "operateRecorder:fail is recording or paused" });
  occupiedTree = occupiedPage.render();
  assert.match(occupiedPage.modalCalls.at(-1).content, /结束微信通话或其他录音/, "弹窗应说明原生占用的解决方法");
  assert.match(textOf(occupiedTree), /结束微信通话或其他录音/, "页面应显示原生占用的解决方法");
  assert.doesNotMatch(occupiedPage.modalCalls.at(-1).content, /operateRecorder:/, "用户弹窗不应展示微信底层英文错误");
  assert.doesNotMatch(textOf(occupiedTree), /operateRecorder:/, "页面应使用中文解释录音器状态");
  assert.equal(
    elements(occupiedTree).some((node) => node.type === "Button" && textOf(node) === "重新尝试录音"),
    false,
    "原生录音仍被占用时不能显示无效的重试按钮",
  );
  assert.equal(byClass(occupiedTree, "record-button--check-recovery"), undefined, "原生占用时不要求手动放弃旧录音");
  assert.equal(occupiedPage.recorderActions.filter(({ action }) => action === "start").length, 1);
  occupiedPage.dispose();

  const automaticRecoveryTimers = createFakeTimers();
  const automaticRecoveryPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { setTimeout: automaticRecoveryTimers.setTimeout, clearTimeout: automaticRecoveryTimers.clearTimeout },
  );
  automaticRecoveryPage.render();
  let automaticRecoveryTree = automaticRecoveryPage.render();
  await byClass(automaticRecoveryTree, "record-button").props.onClick();
  automaticRecoveryPage.recorderHandlers.Error({ errMsg: "operateRecorder:fail is recording or paused" });
  automaticRecoveryTree = automaticRecoveryPage.render();
  assert.equal(byClass(automaticRecoveryTree, "record-button--check-recovery"), undefined);
  await automaticRecoveryPage.recorderHandlers.Stop({ tempFilePath: "", duration: 0, fileSize: 0 });
  automaticRecoveryTimers.advance(500);
  automaticRecoveryTree = automaticRecoveryPage.render();
  assert.ok(byClass(automaticRecoveryTree, "record-button"), "原生 onStop 收口后应自动解除错误页锁，无须用户反复点检查");
  assert.equal(automaticRecoveryPage.recorderActions.filter(({ action }) => action === "start").length, 1, "自动恢复不能自动开麦");

  const unknownErrorPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { savedFilePath: "/saved/unknown-error.mp3", unknownErrorsUncertain: true },
  );
  unknownErrorPage.render();
  let unknownErrorTree = unknownErrorPage.render();
  await byClass(unknownErrorTree, "record-button").props.onClick();
  unknownErrorPage.recorderHandlers.Start();
  unknownErrorPage.recorderHandlers.Error(new Error("microphone hiccup"));
  unknownErrorTree = unknownErrorPage.render();
  assert.equal(byClass(unknownErrorTree, "record-button--check-recovery"), undefined, "原生错误后等待自动恢复，不要求手动放弃");
  assert.equal(byClass(unknownErrorTree, "record-button"), undefined);
  await unknownErrorPage.recorderHandlers.Stop({ tempFilePath: "/tmp/unknown-error.mp3", duration: 2100, fileSize: 5000 });
  assert.equal(unknownErrorPage.savedRecordings.length, 1, "未知错误后迟到的录音也要保存到原页");
  unknownErrorPage.dispose();

  const pendingControlToasts = [];
  const pendingControlsPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { showToast: value => pendingControlToasts.push(value) },
  );
  pendingControlsPage.render();
  let pendingControlsTree = pendingControlsPage.render();
  await byClass(pendingControlsTree, "record-button").props.onClick();
  pendingControlsPage.recorderHandlers.Start();
  pendingControlsTree = pendingControlsPage.render();
  byClass(pendingControlsTree, "record-button--pause").props.onClick();
  pendingControlsTree = pendingControlsPage.render();
  assert.equal(byClass(pendingControlsTree, "record-button--pause").props["aria-disabled"], true, "等待暂停确认时暂停按钮必须锁定");
  assert.equal(byClass(pendingControlsTree, "record-button--stop").props["aria-disabled"], true, "等待暂停确认时结束按钮必须锁定");
  byClass(pendingControlsTree, "record-button--pause").props.onClick();
  byClass(pendingControlsTree, "record-button--stop").props.onClick();
  assert.deepEqual(pendingControlToasts.map(item => item.title), ["录音正在处理，请稍候", "录音正在处理，请稍候"], "点击锁定的录音操作应有反馈");
  pendingControlsPage.recorderHandlers.Pause();
  pendingControlsTree = pendingControlsPage.render();
  byClass(pendingControlsTree, "record-button--resume").props.onClick();
  pendingControlsTree = pendingControlsPage.render();
  assert.equal(byClass(pendingControlsTree, "record-button--resume").props["aria-disabled"], true, "等待继续确认时继续按钮必须锁定");
  assert.equal(byClass(pendingControlsTree, "record-button--stop").props["aria-disabled"], true, "等待继续确认时结束按钮必须锁定");
  byClass(pendingControlsTree, "record-button--resume").props.onClick();
  byClass(pendingControlsTree, "record-button--stop").props.onClick();
  assert.equal(pendingControlToasts.length, 4, "继续录音等待期间再次点击也应提示");
  assert.deepEqual(
    pendingControlsPage.recorderActions.map(({ action }) => action),
    ["start", "pause", "resume"],
    "锁定时不得额外发送原生命令",
  );
  pendingControlsPage.dispose();

  const occupiedAfterStartPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { savedFilePath: "/saved/occupied-after-start.mp3" },
  );
  occupiedAfterStartPage.render();
  let occupiedAfterStartTree = occupiedAfterStartPage.render();
  await byClass(occupiedAfterStartTree, "record-button").props.onClick();
  occupiedAfterStartPage.recorderHandlers.Start();
  occupiedAfterStartPage.recorderHandlers.Error({ errMsg: "operateRecorder:fail is recording or paused" });
  await occupiedAfterStartPage.recorderHandlers.Stop({
    tempFilePath: "/tmp/occupied-after-start.mp3",
    duration: 1000,
    fileSize: 4096,
  });
  assert.equal(occupiedAfterStartPage.savedRecordings.length, 1, "占用错误后迟到的 onStop 仍须保存已录内容");
  assert.equal(
    occupiedAfterStartPage.savedRecordings[0].context.practiceId,
    buildBookPracticeBundle("22").practices[0].id,
    "占用错误后的录音必须保存到原训练页",
  );
  occupiedAfterStartPage.dispose();

  const occupiedSwitchPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { savedFilePath: "/saved/occupied-switch.mp3" },
  );
  occupiedSwitchPage.render();
  let occupiedSwitchTree = occupiedSwitchPage.render();
  await byClass(occupiedSwitchTree, "record-button").props.onClick();
  occupiedSwitchPage.recorderHandlers.Start();
  occupiedSwitchPage.recorderHandlers.Error({ errMsg: "operateRecorder:fail is recording or paused" });
  occupiedSwitchTree = occupiedSwitchPage.render();
  await byClass(occupiedSwitchTree, "practice-navigation__button--primary").props.onClick();
  occupiedSwitchPage.render();
  await occupiedSwitchPage.recorderHandlers.Stop({
    tempFilePath: "/tmp/occupied-switch.mp3",
    duration: 1000,
    fileSize: 4096,
  });
  assert.equal(occupiedSwitchPage.savedRecordings.length, 1, "占用错误后切页仍须保存迟到的录音");
  assert.equal(occupiedSwitchPage.savedRecordings[0].context.practiceIndex, firstAudioPageIndex, "迟到录音不得误归到新训练页");
  occupiedSwitchPage.dispose();

  const occupiedUnloadPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { savedFilePath: "/saved/occupied-unload.mp3" },
  );
  occupiedUnloadPage.render();
  let occupiedUnloadTree = occupiedUnloadPage.render();
  await byClass(occupiedUnloadTree, "record-button").props.onClick();
  occupiedUnloadPage.recorderHandlers.Start();
  occupiedUnloadPage.recorderHandlers.Error({ errMsg: "operateRecorder:fail is recording or paused" });
  occupiedUnloadPage.unload();
  await occupiedUnloadPage.recorderHandlers.Stop({
    tempFilePath: "/tmp/occupied-unload.mp3",
    duration: 1000,
    fileSize: 4096,
  });
  assert.equal(occupiedUnloadPage.savedRecordings.length, 1, "页面卸载后仍须保存占用错误前录到的文件");
  assert.equal(occupiedUnloadPage.savedRecordings[0].context.practiceIndex, firstAudioPageIndex, "卸载后的迟到录音须归属原训练页");
  occupiedUnloadPage.dispose();

  const synchronousOccupiedPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { recorderActionOutcomes: { start: ["throw-busy"] } },
  );
  synchronousOccupiedPage.render();
  let synchronousOccupiedTree = synchronousOccupiedPage.render();
  await byClass(synchronousOccupiedTree, "record-button").props.onClick();
  synchronousOccupiedTree = synchronousOccupiedPage.render();
  assert.match(synchronousOccupiedPage.modalCalls.at(-1).content, /结束微信通话或其他录音/, "同步占用错误应立即说明恢复方法");
  assert.equal(byClass(synchronousOccupiedTree, "record-button"), undefined, "同步占用错误后不应显示立即重试入口");
  assert.equal(byClass(synchronousOccupiedTree, "record-button--check-recovery"), undefined, "热态占用错误不要求用户手动放弃旧录音");
  assert.equal(synchronousOccupiedPage.recorderActions.filter(({ action }) => action === "start").length, 1);
  synchronousOccupiedPage.dispose();

  const synchronousStopOccupiedPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { recorderActionOutcomes: { stop: ["throw-busy"] }, savedFilePath: "/saved/stop-occupied.mp3" },
  );
  synchronousStopOccupiedPage.render();
  let synchronousStopOccupiedTree = synchronousStopOccupiedPage.render();
  await byClass(synchronousStopOccupiedTree, "record-button").props.onClick();
  synchronousStopOccupiedPage.recorderHandlers.Start();
  synchronousStopOccupiedTree = synchronousStopOccupiedPage.render();
  byClass(synchronousStopOccupiedTree, "record-button--stop").props.onClick();
  synchronousStopOccupiedTree = synchronousStopOccupiedPage.render();
  assert.equal(byClass(synchronousStopOccupiedTree, "record-button--stop"), undefined, "同步停止占用错误后不应继续提供无效停止按钮");
  await synchronousStopOccupiedPage.recorderHandlers.Stop({
    tempFilePath: "/tmp/stop-occupied.mp3",
    duration: 1000,
    fileSize: 4096,
  });
  assert.equal(synchronousStopOccupiedPage.savedRecordings.length, 1, "同步停止占用错误后的迟到结果仍须保存");
  synchronousStopOccupiedPage.dispose();

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

  const reentrantReplacement = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      pendingItems: [oldPending],
      recorderActionOutcomes: { start: ["start-then-throw"] },
      savedFilePath: "/saved/reentrant-replacement.mp3",
    },
  );
  reentrantReplacement.render();
  reentrantReplacement.render();
  await settle();
  let reentrantReplacementTree = reentrantReplacement.render();
  const reRecord = elements(reentrantReplacementTree).find((node) => node.type === "Button" && textOf(node) === "重新录制");
  assert.ok(reRecord, "已有录音时应提供重录入口");
  await reRecord.props.onClick();
  reentrantReplacementTree = reentrantReplacement.render();
  assert.equal(byClass(reentrantReplacementTree, "record-button--stop"), undefined, "onStart 后抛错要进入等待态，不能显示无效结束按钮");
  assert.match(textOf(reentrantReplacementTree), /正在自动恢复录音设备/, "旧录音仍在时重入异常应告知用户自动恢复");
  await byClass(reentrantReplacementTree, "practice-navigation__button--primary").props.onClick();
  reentrantReplacementTree = reentrantReplacement.render();
  await reentrantReplacement.recorderHandlers.Stop({
    tempFilePath: "/tmp/reentrant-replacement.mp3", duration: 1900, fileSize: 4300,
  });
  assert.equal(reentrantReplacement.savedRecordings[0]?.context.practiceIndex, firstAudioPageIndex, "有旧录音时重入 start 的新文件仍须归原页");

  const recordedLockTimers = createFakeTimers();
  const recordedLockToasts = [];
  const recordedLockPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      pendingItems: [oldPending],
      recorderActionOutcomes: { start: ["throw-busy", "throw-busy"] },
      showToast: value => recordedLockToasts.push(value),
      setTimeout: recordedLockTimers.setTimeout,
      clearTimeout: recordedLockTimers.clearTimeout,
    },
  );
  recordedLockPage.render();
  recordedLockPage.render();
  await settle();
  let recordedLockTree = recordedLockPage.render();
  const firstRetry = elements(recordedLockTree).find((node) => node.type === "Button" && textOf(node) === "重新录制");
  await firstRetry.props.onClick();
  recordedLockTree = recordedLockPage.render();
  const lockedRetry = elements(recordedLockTree).find((node) => node.type === "Button" && textOf(node) === "重新录制");
  assert.equal(lockedRetry.props["aria-disabled"], true, "原生录音器状态未确认时，应锁住已有录音的重录按钮");
  await lockedRetry.props.onClick();
  assert.equal(recordedLockToasts.at(-1)?.title, "正在自动恢复录音设备，请稍候…", "锁住重录时说明正在自动恢复");
  assert.match(textOf(recordedLockTree), /正在自动恢复录音设备/);
  recordedLockPage.setRecorderPhase("idle");
  recordedLockTimers.advance(300);
  recordedLockTree = recordedLockPage.render();
  assert.equal(
    elements(recordedLockTree).find((node) => node.type === "Button" && textOf(node) === "重新录制").props["aria-disabled"],
    true,
    "未确认结束的持久录音记录不能仅凭协调器 idle 自动解除重录锁",
  );
  assert.equal(recordedLockPage.recordingSessionJournal.read()?.stage, "starting", "原生 start 未确认时必须保留持久归属记录");
  await byClass(recordedLockTree, "practice-navigation__button--primary").props.onClick();
  recordedLockTree = recordedLockPage.render();
  const crossPageLockedRetry = elements(recordedLockTree).find((node) => node.type === "Button" && textOf(node) === "重新录制");
  assert.equal(crossPageLockedRetry?.props["aria-disabled"], true, "翻到 B 页后仍须锁住未完成录音的重录入口");
  await crossPageLockedRetry.props.onClick();
  assert.equal(recordedLockToasts.at(-1)?.title, "正在自动恢复录音设备，请稍候…", "点击锁定的重录按钮应给出操作提示");
  assert.match(textOf(recordedLockTree), /正在自动恢复录音设备/, "B 页不得出现可点但无反应的录音按钮");
  recordedLockPage.setRecorderPhase("idle");
  recordedLockTimers.advance(300);
  recordedLockTree = recordedLockPage.render();
  assert.equal(
    elements(recordedLockTree).find((node) => node.type === "Button" && textOf(node) === "重新录制")?.props["aria-disabled"],
    true,
    "B 页必须等待旧会话确认结束或用户明确放弃后重启",
  );
  recordedLockPage.dispose();

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
    progress22(0),
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

  let pageTurnRemovalCalls = 0;
  const switchingRemovalPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      pendingItems: [oldPending],
      pendingRemove: async () => {
        pageTurnRemovalCalls += 1;
        return true;
      },
    },
  );
  let switchingRemovalTree = switchingRemovalPage.render();
  switchingRemovalTree = switchingRemovalPage.render();
  await settle();
  switchingRemovalTree = switchingRemovalPage.render();
  await byClass(
    switchingRemovalTree,
    "practice-navigation__button--primary",
  ).props.onClick();
  switchingRemovalTree = switchingRemovalPage.render();
  assert.equal(pageTurnRemovalCalls, 0, "翻页应保留当前录音，不得删除旧 pending");
  assert.match(
    textOf(byClass(switchingRemovalTree, "practice-header__progress")),
    progress22(1),
    "翻页应直接落到目标训练",
  );
  const recordingDuringSwitch = elements(switchingRemovalTree).find(
    (node) => node.type === "Button" && textOf(node) === "重新录制",
  );
  assert.ok(recordingDuringSwitch, "B 页应保留 A 页未完成录音的重录入口");
  assert.equal(
    elements(switchingRemovalTree).some((node) => node.type === "Button" && textOf(node) === "回听录音"),
    true,
    "B 页应保留 A 页未完成录音的回听入口",
  );
  assert.ok(byClass(switchingRemovalTree, "check-in-button"), "B 页应保留完成 A 页练习的入口");
  await byClass(switchingRemovalTree, "check-in-button").props.onClick();
  assert.equal(switchingRemovalPage.completedPending[0]?.requestId, oldPending.requestId, "B 页完成的仍是 A 页录音");
  switchingRemovalTree = switchingRemovalPage.render();
  const newPageRecord = byClass(switchingRemovalTree, "record-button");
  assert.ok(newPageRecord, "完成 A 页录音后，B 页应展示自己的首次录音入口");
  await newPageRecord.props.onClick();
  assert.equal(
    switchingRemovalPage.recorderActions.length,
    1,
    "B 页可独立开始录音",
  );
  switchingRemovalPage.recorderHandlers.Start();
  switchingRemovalTree = switchingRemovalPage.render();
  byClass(switchingRemovalTree, "record-button--stop").props.onClick();
  await switchingRemovalPage.recorderHandlers.Stop({
    tempFilePath: "/tmp/page-b.mp3", duration: 1700, fileSize: 3200,
  });
  assert.equal(switchingRemovalPage.savedRecordings[0]?.context.practiceIndex, firstAudioPageIndex + 1);
  assert.equal(pageTurnRemovalCalls, 0, "B 页新录音不能把 A 页已完成录音作为替换备份删除");
  switchingRemovalTree = switchingRemovalPage.render();
  await byClass(switchingRemovalTree, "practice-navigation__button").props.onClick();
  switchingRemovalPage.render();
  await settle();
  switchingRemovalTree = switchingRemovalPage.render();
  assert.match(textOf(byClass(switchingRemovalTree, "practice-header__progress")), progress22(0));
  assert.equal(
    switchingRemovalPage.stateValues().some((value) => value?.requestId === oldPending.requestId && value.localPath === oldPending.localPath),
    false,
    "完成后的 A 页录音不应重新变成未完成草稿",
  );

  let removalDuringSwitch = 0;
  const submitDuringSwitchPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      pendingItems: [oldPending],
      pendingRemove: async () => { removalDuringSwitch += 1; return true; },
    },
  );
  let submitDuringSwitchTree = submitDuringSwitchPage.render();
  submitDuringSwitchTree = submitDuringSwitchPage.render();
  await settle();
  submitDuringSwitchTree = submitDuringSwitchPage.render();
  await byClass(
    submitDuringSwitchTree,
    "practice-navigation__button--primary",
  ).props.onClick();
  await settle();
  submitDuringSwitchTree = submitDuringSwitchPage.render();
  assert.ok(byClass(submitDuringSwitchTree, "check-in-button"), "B 页应保留完成 A 页录音的入口");
  await byClass(submitDuringSwitchTree, "check-in-button").props.onClick();
  assert.equal(submitDuringSwitchPage.completedPending[0]?.requestId, oldPending.requestId, "跨页完成须保存 A 页录音的完成状态");
  assert.equal(
    submitDuringSwitchPage.submittedPending.length,
    0,
    "跨页完成练习不得发起云端提交",
  );
  assert.equal(removalDuringSwitch, 0, "翻页不能删除 A 页录音");

  for (const failure of ["invalid-result", "save-error"]) {
    const removedIds = [];
    const failedReplacementAcrossPages = createPage(
      "src/pages/Practice/Practice.tsx",
      { bookId: "22", practice: "0" },
      {
        pendingItems: [oldPending],
        savedFilePath: `/saved/b-after-${failure}.mp3`,
        pendingRemove: async (requestId) => { removedIds.push(requestId); return true; },
        ...(failure === "save-error" ? {
          saveRecording: async (input) => {
            if (input.context.practiceIndex === firstAudioPageIndex) throw new Error("A 页保存失败");
            return {
              item: {
                ...oldPending,
                requestId: "newpageb0123456789abcdef01234567",
                localPath: `/saved/b-after-${failure}.mp3`,
                context: input.context,
              },
              persisted: true,
              message: "",
            };
          },
        } : {}),
      },
    );
    failedReplacementAcrossPages.render();
    failedReplacementAcrossPages.render();
    await settle();
    let failureTree = failedReplacementAcrossPages.render();
    await elements(failureTree).find((node) => node.type === "Button" && textOf(node) === "重新录制").props.onClick();
    failedReplacementAcrossPages.recorderHandlers.Start();
    failureTree = failedReplacementAcrossPages.render();
    await byClass(failureTree, "practice-navigation__button--primary").props.onClick();
    failureTree = failedReplacementAcrossPages.render();
    byClass(failureTree, "record-button--stop").props.onClick();
    await failedReplacementAcrossPages.recorderHandlers.Stop({
      ...(failure === "save-error" ? { tempFilePath: "/tmp/a-save-error.mp3" } : {}),
      duration: 1800, fileSize: 3900,
    });
    failureTree = failedReplacementAcrossPages.render();
    assert.equal(failedReplacementAcrossPages.recordingSessionJournal.read(), null, `A 页重录 ${failure} 后应清理失败的新录音状态`);
    assert.ok(byClass(failureTree, "check-in-button"), `A 页重录 ${failure} 后，B 页应保留旧录音的完成入口`);
    assert.ok(
      elements(failureTree).some((node) => node.type === "Button" && textOf(node) === "重新录制"),
      `A 页重录 ${failure} 后，B 页应保留旧录音的重录入口`,
    );
    assert.ok(
      elements(failureTree).some((node) => node.type === "Button" && textOf(node) === "删除录音"),
      `A 页重录 ${failure} 后，B 页应保留旧录音的删除入口`,
    );
    assert.equal(
      failedReplacementAcrossPages.stateValues().some((value) => value?.requestId === oldPending.requestId),
      true,
      `A 页重录 ${failure} 后，B 页显示的仍应是 A 页旧文件`,
    );
    assert.deepEqual(removedIds, [], `A 页重录 ${failure} 后不得删除仍可恢复的旧录音`);
  }

  const bPractice = buildFullBookPracticeBundle("22").practices[firstAudioPageIndex + 1];
  const pendingOnB = {
    ...oldPending,
    requestId: "existingb0123456789abcdef01234567",
    localPath: "/saved/b-existing.mp3",
    context: {
      ...oldPending.context,
      practiceId: bPractice.id,
      practiceIndex: firstAudioPageIndex + 1,
      pageNumber: bPractice.pageNumber,
      sectionTitle: bPractice.sectionTitle,
      imageUrl: bPractice.imageUrl,
    },
  };
  const returnBeforeLateStop = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    { pendingItems: [pendingOnB], savedFilePath: "/saved/a-late-return.mp3" },
  );
  returnBeforeLateStop.render();
  let returnBeforeLateStopTree = returnBeforeLateStop.render();
  await byClass(returnBeforeLateStopTree, "record-button").props.onClick();
  returnBeforeLateStop.recorderHandlers.Start();
  returnBeforeLateStopTree = returnBeforeLateStop.render();
  await byClass(returnBeforeLateStopTree, "practice-navigation__button--primary").props.onClick();
  returnBeforeLateStop.recorderHandlers.Error(new Error("A 页原生停止状态不明"));
  returnBeforeLateStop.render();
  await settle();
  returnBeforeLateStopTree = returnBeforeLateStop.render();
  assert.equal(
    returnBeforeLateStop.stateValues().some((value) => value?.localPath === pendingOnB.localPath),
    true,
    "等待 A 页迟到 onStop 时，B 页原有录音仍应可见",
  );
  await byClass(returnBeforeLateStopTree, "practice-navigation__button").props.onClick();
  returnBeforeLateStopTree = returnBeforeLateStop.render();
  assert.match(textOf(byClass(returnBeforeLateStopTree, "practice-header__progress")), progress22(0));
  await returnBeforeLateStop.recorderHandlers.Stop({
    tempFilePath: "/tmp/a-late-return.mp3", duration: 2000, fileSize: 4100,
  });
  returnBeforeLateStopTree = returnBeforeLateStop.render();
  assert.equal(returnBeforeLateStop.savedRecordings[0]?.context.practiceIndex, firstAudioPageIndex);
  assert.equal(
    returnBeforeLateStop.stateValues().some((value) => value?.localPath === pendingOnB.localPath),
    true,
    "返回 A 页后才到达的 onStop，应保留正在显示的 B 页未完成录音",
  );
  assert.equal(
    returnBeforeLateStop.savedRecordings.some((value) => value.context.practiceId === bPractice.id),
    false,
    "迟到 A 页文件不得覆盖 B 页录音",
  );

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
    progress22(0),
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
  assert.equal(byClass(discardedStopErrorTree, "record-button"), undefined, "未知错误后仍须等待旧会话 onStop，不能立即开新录音");
  await discardedStopErrorPage.recorderHandlers.Stop({
    tempFilePath: "/tmp/old-after-error.mp3",
    duration: 1500,
    fileSize: 4700,
  });
  await settle();
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
    2,
    "训练 A 的未知错误收口后，训练 B 的新录音仍必须正常保存",
  );
  assert.equal(
    discardedStopErrorPage.savedRecordings[0].context.practiceIndex,
    firstAudioPageIndex,
    "旧录音迟到结果必须留在训练 A",
  );
  assert.equal(
    discardedStopErrorPage.savedRecordings[1].context.practiceIndex,
    firstAudioPageIndex + 1,
    "旧 stop 错误不能让训练 B 的录音误贴或丢失",
  );

  const discardedStopTimeoutTimers = createFakeTimers();
  const discardedStopTimeoutPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      savedFilePath: "/saved/after-discard-timeout.mp3",
      setTimeout: discardedStopTimeoutTimers.setTimeout,
      clearTimeout: discardedStopTimeoutTimers.clearTimeout,
    },
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
  assert.equal(byClass(discardedStopTimeoutTree, "record-button"), undefined, "原生 stop 未确认时不能再次录音");
  assert.equal(byClass(discardedStopTimeoutTree, "record-button--check-recovery"), undefined, "超时旧录音由页面自动放弃");
  discardedStopTimeoutTimers.advance(1500);
  assert.equal(discardedStopTimeoutPage.recordingSessionJournal.read(), null, "超时后自动清除旧录音记录");
  assert.equal(discardedStopTimeoutPage.recorderActions.filter(({ action }) => action === "start").length, 1, "没有终止回调就不能向原生发出新 start");

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
    { pendingItems: [oldPending], capacityCheck: async () => ({ allowed: false, reason: "local-recordings-full", message: "本地录音空间不足，请到“我的录音”删除不需要的本地录音后重试" }) },
  );
  let insufficientTree = insufficientPage.render();
  insufficientTree = insufficientPage.render();
  await settle();
  insufficientTree = insufficientPage.render();
  await elements(insufficientTree).find((node) => node.type === "Button" && textOf(node) === "重新录制").props.onClick();
  assert.equal(insufficientPage.recorderActions.length, 0, "容量不足不得开麦");
  assert.equal(insufficientPage.permissionChecks.length, 0, "容量不足无需请求麦克风权限");
  assert.equal(insufficientPage.stateValues().some((value) => value?.requestId === oldPending.requestId), true, "容量不足必须保留旧录音");
  assert.equal(insufficientPage.modalCalls.at(-1).confirmText, "整理录音", "容量不足应提供直接整理入口");
  assert.equal(insufficientPage.navigations.at(-1), "/pages/MyCheckIns/MyCheckIns");
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
      progress22(1),
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
  await settle();
  assert.match(leavingPage.modalCalls.at(-1)?.content || "", /结束并保存/, "离页提示必须说明录音会保存到本地");
  assert.equal(leavingPage.navigationMethods.at(-1), "reLaunch", "活动录音点击房子必须离开到首页");
  assert.equal(leavingPage.navigations.at(-1), "/pages/Home/Home");
  assert.equal(leavingPage.recorderActions.at(-1).action, "stop", "确认离开后应先停止活动录音");
  const actionsBeforeHide = leavingPage.recorderActions.length;
  leavingPage.hide();
  assert.equal(leavingPage.recorderActions.length, actionsBeforeHide, "已进入停止流程时页面隐藏不得重复暂停或停止");
  leavingPage.unload();
  assert.equal(leavingPage.recorderActions.at(-1).action, "stop", "页面真正卸载前必须维持停止收口");
  assert.equal(leavingPage.recorderReleaseCalls.length, 1, "卸载时必须立即把 owner 交还给全局协调器");
  assert.equal(
    typeof leavingPage.recorderReleaseCalls[0]?.terminalSink,
    "function",
    "卸载活动录音时必须托管一次 terminal sink",
  );
  assert.equal(leavingTimers.size, 2, "隐藏和卸载各安排幂等退出收尾计时，不再额外调用 stop");
  leavingTimers.advance(9000);
  assert.equal(leavingPage.recordingSessionJournal.read(), null, "退出后长期无结束回调应放弃未完成录音并清除锁");
  assert.equal(leavingPage.savedRecordings.length, 0, "没有原生结束文件时不可凭空保存录音");

  const lateExitTimers = createFakeTimers();
  const lateExitCallbacks = {};
  const lateExitNative = {
    onStart(callback) { lateExitCallbacks.start = callback; },
    onStop(callback) { lateExitCallbacks.stop = callback; },
    onError(callback) { lateExitCallbacks.error = callback; },
    start() {}, stop() {},
  };
  const lateExitCoordinator = createRecorderCoordinator({
    getRecorderManager: () => lateExitNative,
    scheduler: lateExitTimers,
    quietWindowMs: 10,
    abandonQuietWindowMs: 10,
  });
  const lateExitPage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      recorderCoordinator: lateExitCoordinator,
      setTimeout: lateExitTimers.setTimeout,
      clearTimeout: lateExitTimers.clearTimeout,
    },
  );
  let lateExitTree = lateExitPage.render();
  lateExitTree = lateExitPage.render();
  await byClass(lateExitTree, "record-button").props.onClick();
  lateExitCallbacks.start();
  lateExitTree = lateExitPage.render();
  await byClass(lateExitTree, "check-in-navigation__home").props.onClick();
  lateExitPage.hide();
  lateExitPage.unload();
  lateExitTimers.advance(9000);
  assert.equal(lateExitPage.recordingSessionJournal.read(), null, "录音器长期无结束回调后要清除旧录音锁");
  lateExitCallbacks.stop({ tempFilePath: "/tmp/late-exit.mp3", duration: 2300, fileSize: 8192 });
  await settle();
  assert.equal(lateExitPage.savedRecordings.length, 0, "超时后经协调器到达的旧 onStop 不得再保存录音");

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
  assert.equal(pausedLeavingPage.savedRecordings[0].context.practiceIndex, firstAudioPageIndex);

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
    overrides: { "@/features/listeningPractice/bookPractice": { buildFullBookPracticeBundle() { throw new Error("教材 22 第 2 页：缺少图片"); } } },
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
  await testHistory({ bookId: "book &1", practiceIndex: 0 }, true, { "@/features/listeningPractice/bookPractice": { buildBookPracticeBundle: () => buildBookPracticeBundle("22"), buildFullBookPracticeBundle: () => buildFullBookPracticeBundle("22") } });
  await testHistory({ bookId: "22", practiceIndex: 0 }, false, { "@/features/listeningPractice/bookPractice": { buildFullBookPracticeBundle() { throw new Error("损坏教材"); } } });
  const { BOOKS, resolveBookAction } = load("src/features/bookLibrary/bookCatalog.ts");
  for (const book of BOOKS.filter((item) => item.seriesId !== "think")) {
    assert.equal(resolveBookAction(book).url, `/pages/Practice/Practice?bookId=${encodeURIComponent(book.id)}&page=0`);
  }
  for (const book of BOOKS.filter((item) => item.seriesId === "think")) {
    assert.equal(resolveBookAction(book).url, `/pages/ThinkBookReader/ThinkBookReader?bookId=${encodeURIComponent(book.id)}&page=0`);
  }
  assert.equal(resolveBookAction({ ...BOOKS[0], id: "book &1" }).url, "/pages/Practice/Practice?bookId=book%20%261&page=0");
  console.log("教材路由测试通过：真实路由、首尾边界、恢复页、教材内容、打卡与历史回跳正确。");
}

async function testHistory(fields, valid, overrides = {}) {
  // 最早只有旧音频索引的记录仍可解析；带稳定坐标的记录另由专门回归覆盖。
  const detail = { id: "record", bookTitle: "历史书名", sectionTitle: "历史章节", durationMs: 1000, createdAt: 0, recordingUrl: "record.mp3", shareToken: "token", isOwner: true, ...fields };
  const page = createPage("src/pages/CheckInDetail/CheckInDetail.tsx", { id: "record" }, { detail, overrides });
  page.render();
  await settle();
  const tree = page.render();
  const button = byClass(tree, "check-in-actions__practice");
  assert.equal(textOf(button), valid ? "我也来跟读" : "选择教材", JSON.stringify(fields));
  button.props.onClick();
  const expectedPage = valid ? (buildBookPracticeBundle(fields.bookId) ?? buildBookPracticeBundle("22")).practices[fields.practiceIndex].imageIndex : null;
  assert.equal(page.navigations.at(-1), valid ? `/pages/Practice/Practice?bookId=${encodeURIComponent(fields.bookId)}&page=${expectedPage}` : "/pages/BookLibrary/BookLibrary");
}

module.exports = { createPage, createFakeTimers, elements, textOf, byClass, buildBookPracticeBundle, load };
if (require.main === module) {
  testRoutes()
    .catch((error) => { console.error(error); process.exitCode = 1; })
    .finally(() => {
      // 无论断言成功或失败都卸载测试页，验证真实 interval/timeout 不会拖住 Node 进程。
      for (const page of [...livePages]) page.dispose();
    });
}
