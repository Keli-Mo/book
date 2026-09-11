export type RecorderNativeStopResult = { duration?: number; fileSize?: number; tempFilePath?: string; [key: string]: unknown };
export type RecorderNativeManager = {
  start(options: unknown): void; stop(): void; pause?: () => void; resume?: () => void;
  onStart?: (fn: () => void) => void; onPause?: (fn: () => void) => void; onResume?: (fn: () => void) => void;
  onStop?: (fn: (result: RecorderNativeStopResult) => void) => void; onError?: (fn: (error: unknown) => void) => void;
  onInterruptionBegin?: (fn: () => void) => void; onInterruptionEnd?: (fn: () => void) => void;
};
export type RecordingCapabilities = { canRecord: boolean; canPause: boolean; canResume: boolean; canInterrupt: boolean };
export type RecorderCoordinatorPhase = "idle" | "starting" | "recording" | "paused" | "stopping" | "draining";
export type RecorderOwnerListener = {
  onStart?: () => void; onPause?: () => void; onResume?: () => void;
  onStop?: (result: RecorderNativeStopResult) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
  onInterruptionBegin?: () => void; onInterruptionEnd?: () => void;
};
export type RecorderTerminalEvent =
  | { type: "stop"; result: RecorderNativeStopResult }
  | { type: "error"; error: unknown };
export type RecorderTerminalSink = (event: RecorderTerminalEvent) => void | Promise<void>;
export type RecorderReleaseOptions = { terminalSink?: RecorderTerminalSink };
export type RecorderOperationResult = { ok: true } | { ok: false; reason: "released" | "busy" | "invalid-phase" | "unsupported" | "native-error"; phase?: RecorderCoordinatorPhase; capability?: "pause" | "resume"; error?: unknown };
export type RecorderReleaseResult = { ok: true; phase: "idle" | "draining" } | { ok: false; reason: "released" | "native-error"; phase?: RecorderCoordinatorPhase; error?: unknown };
export type RecorderSubscriptionResult = { ok: true; unsubscribe: () => void } | { ok: false; reason: "released" };
export type RecorderOwner = { start(options: unknown): RecorderOperationResult; pause(): RecorderOperationResult; resume(): RecorderOperationResult; stop(): RecorderOperationResult; release(options?: RecorderReleaseOptions): RecorderReleaseResult; subscribe(listener: RecorderOwnerListener): RecorderSubscriptionResult };
export type RecorderAcquireResult = { ok: true; owner: RecorderOwner; capabilities: RecordingCapabilities } | { ok: false; reason: "unavailable" | "busy"; phase?: RecorderCoordinatorPhase };
export type RecorderCoordinator = { acquire(): RecorderAcquireResult; getPhase(): RecorderCoordinatorPhase };
export type RecorderScheduler = { setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(handle: unknown): void };
export type RecorderCoordinatorOptions = { getRecorderManager?: () => RecorderNativeManager | null | undefined; scheduler?: RecorderScheduler; quietWindowMs?: number; operationTimeoutMs?: number; startTimeoutMs?: number; stopTimeoutMs?: number; drainTimeoutMs?: number };
type Owner = { token: symbol; released: boolean; listeners: Set<RecorderOwnerListener> };
type EventName = "start" | "pause" | "resume" | "stop" | "error" | "interruptionBegin" | "interruptionEnd";

const runtimeManager = () => (globalThis as unknown as { wx?: { getRecorderManager?: () => RecorderNativeManager } }).wx?.getRecorderManager?.();
const fallbackScheduler: RecorderScheduler = {
  setTimeout(callback, delay) { const timer = (globalThis as unknown as { setTimeout?: (fn: () => void, ms: number) => unknown }).setTimeout; if (timer) return timer(callback, delay); callback(); return null; },
  clearTimeout(handle) { const clear = (globalThis as unknown as { clearTimeout?: (id: unknown) => void }).clearTimeout; clear?.(handle); },
};

/**
 * RecorderManager 没有 off API；同一实例的成功绑定记账后绝不重复注册。
 * 仅保证最后一个 terminal 后连续静默 quietWindowMs 内的隔离；窗口外原生无 session ID，
 * 协调器无法绝对区分无限迟到旧 terminal 与新会话真实 terminal。
 */
export const createRecorderCoordinator = (options: RecorderCoordinatorOptions = {}): RecorderCoordinator => {
  let native: RecorderNativeManager | null = null;
  let pendingNative: RecorderNativeManager | null = null;
  let phase: RecorderCoordinatorPhase = "idle";
  let owner: Owner | null = null;
  let capabilities: RecordingCapabilities | null = null;
  let bound = new Set<EventName>();
  let systemPausePending = false;
  let pausePending = false;
  let resumePending = false;
  let quietTimer: unknown = null;
  let operationTimer: unknown = null;
  let drainTimer: unknown = null;
  let detachedTerminalSink: RecorderTerminalSink | null = null;
  let drainSinkSettling = false;
  let operationGeneration = 0;
  let drainGeneration = 0;
  const scheduler = options.scheduler ?? fallbackScheduler;
  const quietWindowMs = options.quietWindowMs ?? 80;
  const operationTimeoutMs = options.operationTimeoutMs ?? 1000;
  const startTimeoutMs = options.startTimeoutMs ?? 10000;
  const stopTimeoutMs = options.stopTimeoutMs ?? 30000;
  const drainTimeoutMs = options.drainTimeoutMs ?? 30000;
  const current = (value: Owner) => !value.released && owner?.token === value.token;
  const isPhase = (value: RecorderCoordinatorPhase) => phase === value;
  const notify = (key: keyof RecorderOwnerListener, value?: unknown) => {
    if (!owner || owner.released) return;
    owner.listeners.forEach((listener) => {
      const callback = listener[key] as ((arg?: unknown) => void) | undefined;
      try { callback?.(value); } catch (_error) { /* 页面 listener 不得破坏其它订阅或 native 命令。 */ }
    });
  };
  const clearOperationWatchdog = () => {
    operationGeneration += 1;
    if (operationTimer !== null) scheduler.clearTimeout(operationTimer);
    operationTimer = null;
  };
  const clearPending = () => {
    systemPausePending = false; pausePending = false; resumePending = false;
    clearOperationWatchdog();
  };
  const clearDrainWatchdog = () => {
    if (drainTimer !== null) scheduler.clearTimeout(drainTimer);
    drainTimer = null;
  };
  const armDrainWatchdog = () => {
    clearDrainWatchdog();
    const generation = drainGeneration;
    drainTimer = scheduler.setTimeout(() => {
      if (generation !== drainGeneration || phase !== "draining") return;
      // RecorderManager 不提供会话编号；终止事件永久缺失时只能有限隔离后解锁，避免后续页面永远不可录音。
      drainTimer = null;
      detachedTerminalSink = null;
      drainSinkSettling = false;
      drainGeneration += 1;
      if (quietTimer !== null) scheduler.clearTimeout(quietTimer);
      quietTimer = null;
      phase = "idle";
    }, drainTimeoutMs);
  };
  const beginQuiet = () => {
    clearDrainWatchdog();
    if (quietTimer !== null) scheduler.clearTimeout(quietTimer);
    const generation = drainGeneration;
    quietTimer = scheduler.setTimeout(() => { if (generation === drainGeneration && phase === "draining") { quietTimer = null; phase = "idle"; } }, quietWindowMs);
  };
  const beginDraining = (terminalSink: RecorderTerminalSink | null = null) => {
    clearPending();
    drainGeneration += 1;
    phase = "draining";
    detachedTerminalSink = terminalSink;
    drainSinkSettling = false;
    if (quietTimer !== null) scheduler.clearTimeout(quietTimer);
    quietTimer = null;
    armDrainWatchdog();
  };
  const settleDetachedTerminal = (event: RecorderTerminalEvent) => {
    if (drainSinkSettling) return;
    const sink = detachedTerminalSink;
    detachedTerminalSink = null;
    if (!sink) {
      beginQuiet();
      return;
    }

    drainSinkSettling = true;
    const generation = drainGeneration;
    let outcome: unknown;
    try {
      outcome = sink(event);
    } catch (_error) {
      outcome = undefined;
    }
    const finish = () => {
      if (generation !== drainGeneration || phase !== "draining" || !drainSinkSettling) return;
      drainSinkSettling = false;
      beginQuiet();
    };
    if (outcome && typeof (outcome as PromiseLike<void>).then === "function") {
      // 本地 saveFile/元数据写入完成前保持 draining，防止新会话覆盖唯一的临时录音文件。
      armDrainWatchdog();
      Promise.resolve(outcome).then(finish, finish);
    } else {
      finish();
    }
  };
  const createActiveTerminalSink = (key: "onStop" | "onError"): RecorderTerminalSink | null => {
    if (!owner || owner.released) return null;
    const callbacks = [...owner.listeners]
      .map((listener) => listener[key] as ((value: unknown) => void | Promise<void>) | undefined)
      .filter((callback): callback is (value: unknown) => void | Promise<void> => Boolean(callback));
    if (callbacks.length === 0) return null;

    return (event) => {
      const value = event.type === "stop" ? event.result : event.error;
      const pending: Promise<void>[] = [];
      callbacks.forEach((callback) => {
        try {
          const outcome = callback(value);
          if (outcome && typeof outcome.then === "function") {
            // 每个 listener 独立吞掉失败，并等待其余落盘完成，避免一个拒绝让其它保存任务提前失去保护。
            pending.push(Promise.resolve(outcome).then(() => undefined, () => undefined));
          }
        } catch (_error) { /* 同步 listener 失败不能阻断其它订阅或 draining 收口。 */ }
      });
      return pending.length > 0 ? Promise.all(pending).then(() => undefined) : undefined;
    };
  };
  const createActiveTerminalRouter = (): RecorderTerminalSink | null => {
    const stopSink = createActiveTerminalSink("onStop");
    const errorSink = createActiveTerminalSink("onError");
    if (!stopSink && !errorSink) return null;
    return (event) => event.type === "stop" ? stopSink?.(event) : errorSink?.(event);
  };
  const consumeTerminal = (key: "onStop" | "onError", value: unknown) => {
    clearPending();
    const event: RecorderTerminalEvent = key === "onStop"
      ? { type: "stop", result: value as RecorderNativeStopResult }
      : { type: "error", error: value };
    // 无 session id：仅 drain/连续静默窗内的一切 terminal 可归旧代次，绝不贴给等待 owner。
    if (phase === "draining") {
      settleDetachedTerminal(event);
      return;
    }
    if (phase === "idle") return;
    // 正常页面的异步 onStop/onError 与卸载后的 terminalSink 共用同一套 draining 保护。
    beginDraining(createActiveTerminalSink(key));
    settleDetachedTerminal(event);
  };
  const armOperationWatchdog = (expected: "start" | "pause" | "resume" | "system-pause" | "stop", manager: RecorderNativeManager) => {
    clearOperationWatchdog();
    const generation = operationGeneration;
    operationTimer = scheduler.setTimeout(() => {
      if (generation !== operationGeneration) return;
      operationTimer = null;
      const stillPending = expected === "start"
        ? phase === "starting" && !systemPausePending
        : expected === "pause"
          ? pausePending && phase === "paused"
          : expected === "resume"
            ? resumePending && phase === "recording"
            : expected === "system-pause"
              ? systemPausePending && ["starting", "recording", "paused"].includes(phase)
              : phase === "stopping";
      if (!stillPending) return;

      if (expected === "start" || expected === "stop") {
        // 启停回调缺失时先让页面退出 pending，再隔离旧会话；停止结果仍交给超时前捕获的原会话保存。
        beginDraining(expected === "stop" ? createActiveTerminalRouter() : null);
        notify("onError", {
          errMsg: expected === "start" ? "录音启动确认超时，请重试" : "录音停止确认超时，请重试",
          code: "RECORDER_OPERATION_TIMEOUT",
          operation: expected,
        });
        if (expected === "start") {
          try { manager.stop(); } catch (_error) { /* 已进入有限 draining，原生同步失败不再破坏隔离。 */ }
        }
        return;
      }

      // 原生 pause/resume/系统中断偶尔不回调；超时后强制 stop，让 onStop 仍有机会保存录音。
      clearPending();
      phase = "stopping";
      try {
        manager.stop();
        if (phase === "stopping") armOperationWatchdog("stop", manager);
      } catch (error) { consumeTerminal("onError", error); }
    }, expected === "start" ? startTimeoutMs : expected === "stop" ? stopTimeoutMs : operationTimeoutMs);
  };
  const ensure = (): { manager: RecorderNativeManager; caps: RecordingCapabilities } | null => {
    let candidate = pendingNative ?? native;
    if (!candidate) { try { candidate = options.getRecorderManager?.() ?? runtimeManager() ?? null; } catch (_error) { return null; } }
    if (!candidate || typeof candidate.start !== "function" || typeof candidate.stop !== "function" || typeof candidate.onStart !== "function" || typeof candidate.onStop !== "function" || typeof candidate.onError !== "function") return null;
    pendingNative = candidate;
    const add = (name: EventName, listener: (value?: unknown) => void) => {
      if (bound.has(name)) return true;
      const method = candidate![`on${name[0].toUpperCase()}${name.slice(1)}` as keyof RecorderNativeManager];
      if (typeof method !== "function") return false;
      try { (method as (fn: (value?: unknown) => void) => void).call(candidate, listener); bound.add(name); return true; } catch (_error) { return false; }
    };
    const core = add("start", () => {
      if (phase !== "starting") return;
      phase = "recording";
      // start 确认不能清除更晚发生的系统中断保护。
      if (!systemPausePending) clearOperationWatchdog();
      notify("onStart");
    })
      && add("stop", (result) => consumeTerminal("onStop", result))
      && add("error", (error) => consumeTerminal("onError", error));
    if (!core) return null;
    const pause = add("pause", () => { if ((phase !== "paused" && phase !== "recording" && phase !== "starting") || (!pausePending && !systemPausePending)) return; clearPending(); phase = "paused"; notify("onPause"); });
    const resume = add("resume", () => {
      if (phase !== "recording" || !resumePending) return;
      resumePending = false;
      // 系统中断比更早发出的 resume 优先；迟到确认不能清除中断 watchdog，也不能向页面宣告已恢复。
      if (systemPausePending) return;
      clearPending();
      notify("onResume");
    });
    const begin = add("interruptionBegin", () => {
      if (!capabilities?.canInterrupt || !["recording", "starting", "paused"].includes(phase)) return;
      systemPausePending = true;
      notify("onInterruptionBegin");
      if (systemPausePending) armOperationWatchdog("system-pause", candidate!);
    });
    const end = add("interruptionEnd", () => { if (phase !== "idle" && phase !== "draining") notify("onInterruptionEnd"); });
    capabilities = { canRecord: true, canPause: typeof candidate.pause === "function" && pause, canResume: typeof candidate.resume === "function" && resume, canInterrupt: pause && begin && end };
    native = candidate; pendingNative = null;
    return { manager: candidate, caps: capabilities };
  };
  const makeOwner = (state: Owner, manager: RecorderNativeManager, caps: RecordingCapabilities): RecorderOwner => {
    const fail = (reason: "released" | "busy" | "invalid-phase"): RecorderOperationResult => ({ ok: false, reason, phase });
    const call = (action: () => void, before: RecorderCoordinatorPhase, after: RecorderCoordinatorPhase): RecorderOperationResult => { phase = before; try { action(); return { ok: true }; } catch (error) { if (phase === before) phase = after; return { ok: false, reason: "native-error", error }; } };
    return {
      start(recordingOptions) { if (!current(state)) return fail("released"); if (phase === "draining") return fail("busy"); if (phase !== "idle") return fail("invalid-phase"); const result = call(() => manager.start(recordingOptions), "starting", "idle"); if (result.ok && isPhase("starting") && !systemPausePending) armOperationWatchdog("start", manager); return result; },
      pause() { if (!current(state)) return fail("released"); if (!caps.canPause) return { ok: false, reason: "unsupported", capability: "pause" }; if (phase !== "recording") return fail("invalid-phase"); pausePending = true; const result = call(() => manager.pause!(), "paused", "recording"); if (!result.ok) clearPending(); else if (pausePending) armOperationWatchdog("pause", manager); return result; },
      resume() { if (!current(state)) return fail("released"); if (!caps.canResume) return { ok: false, reason: "unsupported", capability: "resume" }; if (phase !== "paused") return fail("invalid-phase"); resumePending = true; const result = call(() => manager.resume!(), "recording", "paused"); if (!result.ok) clearPending(); else if (resumePending) armOperationWatchdog("resume", manager); return result; },
      stop() { if (!current(state)) return fail("released"); if (!["starting", "recording", "paused"].includes(phase)) return fail("invalid-phase"); clearPending(); const previous = phase; const result = call(() => manager.stop(), "stopping", previous); if (result.ok && isPhase("stopping")) armOperationWatchdog("stop", manager); return result; },
      release(releaseOptions = {}) {
        if (!current(state)) return { ok: false, reason: "released" };
        const terminalSink = releaseOptions.terminalSink ?? null;
        state.released = true; state.listeners.clear(); owner = null;
        clearPending();
        if (phase === "idle") return { ok: true, phase: "idle" };
        if (phase === "draining") return { ok: true, phase: "draining" };
        if (phase === "stopping") { beginDraining(terminalSink); return { ok: true, phase: "draining" }; }
        beginDraining(terminalSink);
        try { manager.stop(); return { ok: true, phase: "draining" }; } catch (error) {
          if (terminalSink) {
            settleDetachedTerminal({ type: "error", error });
          } else {
            // 纯同步 throw 表示没有终止回调，可立即解除本次未入队的 drain。
            clearDrainWatchdog();
            drainGeneration += 1;
            phase = "idle";
          }
          return { ok: false, reason: "native-error", phase, error };
        }
      },
      subscribe(listener) { if (!current(state)) return { ok: false, reason: "released" }; state.listeners.add(listener); return { ok: true, unsubscribe: () => state.listeners.delete(listener) }; },
    };
  };
  return {
    acquire() {
      const ready = ensure();
      if (!ready) return { ok: false, reason: "unavailable" };
      // draining 期间不创建“等待 owner”，让页面统一按 busy 契约重试，避免按钮看似可用却无法开始。
      if (phase === "draining" || (owner && !owner.released)) return { ok: false, reason: "busy", phase };
      const state: Owner = { token: Symbol("recorder-owner"), released: false, listeners: new Set() };
      owner = state;
      return { ok: true, owner: makeOwner(state, ready.manager, ready.caps), capabilities: ready.caps };
    },
    getPhase: () => phase,
  };
};
let singleton: RecorderCoordinator | null = null;
export const getRecorderCoordinator = () => (singleton ??= createRecorderCoordinator());
