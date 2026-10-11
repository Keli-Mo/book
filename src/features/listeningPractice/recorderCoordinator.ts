export type RecorderNativeStopResult = { duration?: number; fileSize?: number; tempFilePath?: string; [key: string]: unknown };
export type RecorderNativeManager = {
  start(options: unknown): void; stop(): void; pause?: () => void; resume?: () => void;
  onStart?: (fn: () => void) => void; onPause?: (fn: () => void) => void; onResume?: (fn: () => void) => void;
  onStop?: (fn: (result: RecorderNativeStopResult) => void) => void; onError?: (fn: (error: unknown) => void) => void;
  onInterruptionBegin?: (fn: () => void) => void; onInterruptionEnd?: (fn: () => void) => void;
};
export type RecordingCapabilities = { canRecord: boolean; canPause: boolean; canResume: boolean; canInterrupt: boolean };
export type RecorderCoordinatorPhase = "idle" | "starting" | "recording" | "paused" | "stopping" | "draining" | "uncertain";
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
export type RecorderReleaseResult = { ok: true; phase: "idle" | "draining" | "uncertain" } | { ok: false; reason: "released" | "native-error"; phase?: RecorderCoordinatorPhase; error?: unknown };
export type RecorderSubscriptionResult = { ok: true; unsubscribe: () => void } | { ok: false; reason: "released" };
export type RecorderOwner = { start(options: unknown): RecorderOperationResult; pause(): RecorderOperationResult; resume(): RecorderOperationResult; stop(): RecorderOperationResult; release(options?: RecorderReleaseOptions): RecorderReleaseResult; subscribe(listener: RecorderOwnerListener): RecorderSubscriptionResult };
export type RecorderAcquireResult = { ok: true; owner: RecorderOwner; capabilities: RecordingCapabilities } | { ok: false; reason: "unavailable" | "busy"; phase?: RecorderCoordinatorPhase };
export type RecorderEntryRecoveryStatus = "none" | "waiting" | "saving" | "failed";
export type RecorderEntryRecovery = {
  terminalResult?: RecorderNativeStopResult;
  recover(result: RecorderNativeStopResult): Promise<boolean> | boolean;
};
export type RecorderCoordinator = {
  acquire(): RecorderAcquireResult;
  getPhase(): RecorderCoordinatorPhase;
  beginEntryRecovery(recovery: RecorderEntryRecovery): boolean;
  retryEntryRecovery(): Promise<boolean>;
  abandonUnconfirmedRecording(options?: { force?: boolean }): boolean;
  getEntryRecoveryStatus(): RecorderEntryRecoveryStatus;
};
export type RecorderScheduler = { setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(handle: unknown): void };
export type RecorderCoordinatorOptions = { getRecorderManager?: () => RecorderNativeManager | null | undefined; scheduler?: RecorderScheduler; quietWindowMs?: number; abandonQuietWindowMs?: number; operationTimeoutMs?: number; startTimeoutMs?: number; stopTimeoutMs?: number; drainTimeoutMs?: number };
type Owner = { token: symbol; released: boolean; listeners: Set<RecorderOwnerListener> };
type EventName = "start" | "pause" | "resume" | "stop" | "error" | "interruptionBegin" | "interruptionEnd";

const runtimeManager = () => (globalThis as unknown as { wx?: { getRecorderManager?: () => RecorderNativeManager } }).wx?.getRecorderManager?.();
export const isRecorderStateConflictError = (error: unknown): boolean => {
  const detail = error && typeof error === "object" ? error as { errMsg?: unknown; message?: unknown } : null;
  const message = typeof error === "string" ? error : typeof detail?.errMsg === "string" ? detail.errMsg : typeof detail?.message === "string" ? detail.message : "";
  const normalized = message.toLowerCase();
  return normalized.includes("is recording or paused") || normalized.includes("audio is recording");
};
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
  let uncertainStopRetryTimer: unknown = null;
  let detachedTerminalSink: RecorderTerminalSink | null = null;
  let drainSinkSettling = false;
  let stopConfirmed = false;
  let unconfirmedStart = false;
  let abandonedDrain = false;
  let operationGeneration = 0;
  let drainGeneration = 0;
  let entryRecovery: (RecorderEntryRecovery & {
    result: RecorderNativeStopResult | null;
    status: Exclude<RecorderEntryRecoveryStatus, "none">;
    proceedApproved: boolean;
    stopRequested: boolean;
    attempt: Promise<boolean> | null;
  }) | null = null;
  const scheduler = options.scheduler ?? fallbackScheduler;
  const quietWindowMs = options.quietWindowMs ?? 80;
  const abandonQuietWindowMs = options.abandonQuietWindowMs ?? 1000;
  const operationTimeoutMs = options.operationTimeoutMs ?? 1000;
  const startTimeoutMs = options.startTimeoutMs ?? 10000;
  const stopTimeoutMs = options.stopTimeoutMs ?? 5000;
  const drainTimeoutMs = options.drainTimeoutMs ?? 5000;
  const current = (value: Owner) => !value.released && owner?.token === value.token;
  const isPhase = (value: RecorderCoordinatorPhase) => phase === value;
  const notify = (key: keyof RecorderOwnerListener, value?: unknown) => {
    if (!owner || owner.released) return;
    owner.listeners.forEach((listener) => {
      const callback = listener[key] as ((arg?: unknown) => void | Promise<void>) | undefined;
      try {
        const outcome = callback?.(value);
        if (outcome && typeof outcome.then === "function") Promise.resolve(outcome).then(() => undefined, () => undefined);
      } catch (_error) { /* 页面 listener 不得破坏其它订阅或 native 命令。 */ }
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
  const clearUncertainStopRetry = () => {
    if (uncertainStopRetryTimer !== null) scheduler.clearTimeout(uncertainStopRetryTimer);
    uncertainStopRetryTimer = null;
  };
  const scheduleUncertainStopRetry = () => {
    clearUncertainStopRetry();
    uncertainStopRetryTimer = scheduler.setTimeout(() => {
      uncertainStopRetryTimer = null;
      if (phase !== "uncertain") return;
      // 只补发一次 stop；无 onStop 仍保持锁定，不能根据 stop() 返回值猜测已结束。
      try { native?.stop(); } catch (_error) { /* 等待原生回调或用户选择放弃本段。 */ }
    }, 1000);
  };
  const armDrainWatchdog = () => {
    clearDrainWatchdog();
    const generation = drainGeneration;
    drainTimer = scheduler.setTimeout(() => {
      if (generation !== drainGeneration || phase !== "draining") return;
      // 没有 onStop 就无法确认原生已结束；保留 sink 等待迟到结果，禁止新录音覆盖临时文件。
      drainTimer = null;
      if (quietTimer !== null) scheduler.clearTimeout(quietTimer);
      quietTimer = null;
      phase = "uncertain";
      if (!drainSinkSettling) scheduleUncertainStopRetry();
    }, drainTimeoutMs);
  };
  const beginQuiet = () => {
    clearDrainWatchdog();
    if (quietTimer !== null) scheduler.clearTimeout(quietTimer);
    const generation = drainGeneration;
    quietTimer = scheduler.setTimeout(() => { if (generation === drainGeneration && phase === "draining") { quietTimer = null; phase = "idle"; abandonedDrain = false; } }, abandonedDrain ? abandonQuietWindowMs : quietWindowMs);
  };
  const beginDraining = (terminalSink: RecorderTerminalSink | null = null) => {
    clearPending();
    clearUncertainStopRetry();
    drainGeneration += 1;
    phase = "draining";
    abandonedDrain = false;
    // 没有收到本次 onStart 时，原生 onStop 可能属于上次被放弃的录音。
    detachedTerminalSink = unconfirmedStart ? null : terminalSink;
    drainSinkSettling = false;
    if (quietTimer !== null) scheduler.clearTimeout(quietTimer);
    quietTimer = null;
    armDrainWatchdog();
  };
  const recoverEntryResult = (): Promise<boolean> => {
    const recovery = entryRecovery;
    if (!recovery || !recovery.result) return Promise.resolve(false);
    if (recovery.attempt) return recovery.attempt;
    recovery.status = "saving";
    phase = "draining";
    const result = recovery.result;
    const attempt = Promise.resolve().then(() => recovery.recover(result)).then(
      (saved) => Boolean(saved),
      () => false,
    ).then((saved) => {
      if (entryRecovery !== recovery) return false;
      recovery.attempt = null;
      if (saved) {
        entryRecovery = null;
        drainGeneration += 1;
        phase = "draining";
        beginQuiet();
      } else {
        // 文件未可靠保存时仍保留入口锁；用户可重试保存或明确放弃本段。
        recovery.status = "failed";
        phase = "uncertain";
      }
      return saved;
    });
    recovery.attempt = attempt;
    return attempt;
  };
  const tryStopEntryRecording = () => {
    if (!entryRecovery || !entryRecovery.proceedApproved || entryRecovery.result || entryRecovery.stopRequested) return;
    const ready = ensure();
    if (!ready) return;
    entryRecovery.stopRequested = true;
    try { ready.manager.stop(); } catch (_error) {
      // stop() 的异常和返回都无法证明原生录音是否已结束，保留入口锁等待回调。
    }
  };
  const settleDetachedTerminal = (event: RecorderTerminalEvent) => {
    if (drainSinkSettling) return;
    if (event.type === "stop") stopConfirmed = true;
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
      if (generation !== drainGeneration || (phase !== "draining" && phase !== "uncertain") || !drainSinkSettling) return;
      drainSinkSettling = false;
      phase = "draining";
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
  const enterUncertain = (previousPhase: RecorderCoordinatorPhase, error?: unknown, reportError = false) => {
    if (stopConfirmed) return;
    const active = previousPhase !== "draining" && previousPhase !== "uncertain";
    if (active) {
      unconfirmedStart = unconfirmedStart || previousPhase === "starting";
      detachedTerminalSink = unconfirmedStart ? null : createActiveTerminalSink("onStop");
    }
    clearPending();
    clearDrainWatchdog();
    clearUncertainStopRetry();
    if (quietTimer !== null) scheduler.clearTimeout(quietTimer);
    quietTimer = null;
    phase = "uncertain";
    if (reportError && active) notify("onError", error);
    // 首次启动也可能撞上前一段尚在录制的原生会话；只请求一次 stop，等待真实 onStop。
    if (active && previousPhase !== "stopping" && phase === "uncertain") {
      try { native?.stop(); } catch (_error) { /* 原生状态仍未知，等待回调或用户明确放弃。 */ }
    }
    if (phase === "uncertain") scheduleUncertainStopRetry();
  };
  const consumeTerminal = (key: "onStop" | "onError", value: unknown) => {
    if (entryRecovery) {
      if (key === "onStop" && !entryRecovery.result) {
        clearPending();
        clearUncertainStopRetry();
        stopConfirmed = true;
        entryRecovery.result = value as RecorderNativeStopResult;
        if (entryRecovery.proceedApproved) void recoverEntryResult();
      }
      return;
    }
    if (key === "onError") {
      if (abandonedDrain) return;
      if (phase === "idle") return;
      if (stopConfirmed) {
        // onStop 已证实录音结束；保存或静默期间的迟到错误只延长隔离时间。
        if (phase === "draining" && quietTimer !== null) beginQuiet();
        return;
      }
      if (phase === "uncertain") return;
      // onError 仅报告错误，没有证明原生已经停止；所有错误都必须等待 onStop。
      enterUncertain(phase, value, phase !== "draining");
      return;
    }
    if (phase === "uncertain") {
      if (stopConfirmed) return;
      clearUncertainStopRetry();
      phase = "draining";
      settleDetachedTerminal({ type: "stop", result: value as RecorderNativeStopResult });
      return;
    }
    if (phase === "starting") {
      // 新录音尚未收到 onStart：忽略可能来自上一段的迟到结果，保留本次启动等待。
      // 若 onStart 一直缺失，启动看门狗会处理超时。
      return;
    }
    if (unconfirmedStart && phase !== "idle") {
      // 已请求停止或进入未知态时，以这次 onStop 收口原生状态，但不能归给尚未确认启动的新录音。
      clearPending();
      if (phase !== "draining") beginDraining();
      detachedTerminalSink = null;
      settleDetachedTerminal({ type: "stop", result: value as RecorderNativeStopResult });
      return;
    }
    clearPending();
    const event: RecorderTerminalEvent = { type: "stop", result: value as RecorderNativeStopResult };
    // 无 session id：仅 drain/连续静默窗内的一切 terminal 可归旧代次，绝不贴给等待 owner。
    if (phase === "draining") {
      if (stopConfirmed) { if (quietTimer !== null) beginQuiet(); return; }
      settleDetachedTerminal(event);
      return;
    }
    if (phase === "idle") return;
    // 正常页面的异步 onStop 与卸载后的 terminalSink 共用同一套 draining 保护。
    beginDraining(createActiveTerminalSink("onStop"));
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
        if (expected === "start") unconfirmedStart = true;
        beginDraining(expected === "stop" ? createActiveTerminalRouter() : null);
        notify("onError", {
          errMsg: expected === "start" ? "录音启动确认超时，请稍候" : "录音停止确认超时，请稍候",
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
      // stop/离页后才到的 onStart 没有会话编号；不据此把后续文件归给已关闭的页面。
      if (phase !== "starting") return;
      phase = "recording";
      unconfirmedStart = false;
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
      if (phase === "paused" && !pausePending && !resumePending && !systemPausePending) {
        notify("onInterruptionBegin");
        return;
      }
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
    const call = (action: () => void, before: RecorderCoordinatorPhase): RecorderOperationResult => {
      phase = before;
      try { action(); return { ok: true }; } catch (error) {
        // 同步 throw 也可能发生在原生已接收命令后；除非 onStop 已到达，否则保持未知锁。
        if (phase === before || (before === "starting" && phase === "recording")) enterUncertain(phase);
        return { ok: false, reason: "native-error", error };
      }
    };
    return {
      start(recordingOptions) { if (!current(state)) return fail("released"); if (phase === "draining" || phase === "uncertain") return fail("busy"); if (phase !== "idle") return fail("invalid-phase"); stopConfirmed = false; unconfirmedStart = true; const result = call(() => manager.start(recordingOptions), "starting"); if (result.ok && isPhase("starting") && !systemPausePending) armOperationWatchdog("start", manager); return result; },
      pause() { if (!current(state)) return fail("released"); if (!caps.canPause) return { ok: false, reason: "unsupported", capability: "pause" }; if (phase !== "recording") return fail("invalid-phase"); pausePending = true; const result = call(() => manager.pause!(), "paused"); if (!result.ok) clearPending(); else if (pausePending) armOperationWatchdog("pause", manager); return result; },
      resume() { if (!current(state)) return fail("released"); if (!caps.canResume) return { ok: false, reason: "unsupported", capability: "resume" }; if (phase !== "paused") return fail("invalid-phase"); resumePending = true; const result = call(() => manager.resume!(), "recording"); if (!result.ok) clearPending(); else if (resumePending) armOperationWatchdog("resume", manager); return result; },
      stop() { if (!current(state)) return fail("released"); if (!["starting", "recording", "paused"].includes(phase)) return fail("invalid-phase"); clearPending(); const result = call(() => manager.stop(), "stopping"); if (result.ok && isPhase("stopping")) armOperationWatchdog("stop", manager); return result; },
      release(releaseOptions = {}) {
        if (!current(state)) return { ok: false, reason: "released" };
        const terminalSink = releaseOptions.terminalSink ?? null;
        const wasUncertain = phase === "uncertain";
        const retainedSink = detachedTerminalSink;
        state.released = true; state.listeners.clear(); owner = null;
        clearPending();
        if (phase === "idle") return { ok: true, phase: "idle" };
        if (phase === "draining") return { ok: true, phase: "draining" };
        if (wasUncertain) {
          // 占用错误时已请求 stop（或原本就在等 stop）；离页只能转交回调，重复 stop 可能产生误导性的 onError。
          if (!drainSinkSettling && !retainedSink && !unconfirmedStart) detachedTerminalSink = terminalSink;
          return { ok: true, phase: "uncertain" };
        }
        if (phase === "stopping") { beginDraining(terminalSink); return { ok: true, phase: "draining" }; }
        beginDraining(terminalSink);
        try { manager.stop(); return { ok: true, phase: isPhase("uncertain") ? "uncertain" : isPhase("idle") ? "idle" : "draining" }; } catch (error) {
          // 抛错并不证明 stop 未入队；若已同步收到 onStop，仍按其保存与静默状态收口。
          if (!stopConfirmed && isPhase("draining")) enterUncertain("draining");
          return { ok: false, reason: "native-error", phase, error };
        }
      },
      subscribe(listener) { if (!current(state)) return { ok: false, reason: "released" }; state.listeners.add(listener); return { ok: true, unsubscribe: () => state.listeners.delete(listener) }; },
    };
  };
  return {
    acquire() {
      if (entryRecovery) {
        if (entryRecovery.proceedApproved) tryStopEntryRecording();
        return { ok: false, reason: "busy", phase: entryRecovery.status === "saving" ? "draining" : "uncertain" };
      }
      const ready = ensure();
      if (!ready) return { ok: false, reason: "unavailable" };
      // draining 期间不创建“等待 owner”，让页面统一按 busy 契约重试，避免按钮看似可用却无法开始。
      if (phase === "draining" || phase === "uncertain" || (owner && !owner.released)) return { ok: false, reason: "busy", phase };
      const state: Owner = { token: Symbol("recorder-owner"), released: false, listeners: new Set() };
      owner = state;
      return { ok: true, owner: makeOwner(state, ready.manager, ready.caps), capabilities: ready.caps };
    },
    getPhase: () => phase,
    beginEntryRecovery(recovery) {
      if (entryRecovery || phase !== "idle" || owner) return false;
      entryRecovery = {
        ...recovery,
        result: recovery.terminalResult ?? null,
        status: "waiting",
        proceedApproved: false,
        stopRequested: false,
        attempt: null,
      };
      phase = "uncertain";
      // 冷启动只能确认存在未完成记录；先绑定回调并锁住新录音，等用户选择保存或放弃。
      ensure();
      return true;
    },
    retryEntryRecovery() {
      if (!entryRecovery) return Promise.resolve(true);
      entryRecovery.proceedApproved = true;
      if (entryRecovery.result) return recoverEntryResult();
      tryStopEntryRecording();
      return Promise.resolve(false);
    },
    abandonUnconfirmedRecording(options = {}) {
      if ((entryRecovery?.status === "saving" || drainSinkSettling) && !options.force) return false;
      // 页面切换遗留的 idle owner 同样会挡住新页面 acquire；仅此时可安全撤销所有权。
      if (!entryRecovery && phase !== "draining" && phase !== "uncertain" && !(phase === "idle" && owner)) return false;
      entryRecovery = null;
      if (owner) { owner.released = true; owner.listeners.clear(); owner = null; }
      clearPending();
      clearDrainWatchdog();
      clearUncertainStopRetry();
      if (quietTimer !== null) scheduler.clearTimeout(quietTimer);
      quietTimer = null;
      detachedTerminalSink = null;
      drainSinkSettling = false;
      drainGeneration += 1;
      phase = "draining";
      abandonedDrain = true;
      stopConfirmed = false;
      unconfirmedStart = false;
      try { native?.stop(); } catch (_error) { /* 放弃后仍可在当前小程序内重新尝试录音。 */ }
      if (phase === "draining") beginQuiet();
      return true;
    },
    getEntryRecoveryStatus: () => entryRecovery?.status ?? "none",
  };
};
let singleton: RecorderCoordinator | null = null;
export const getRecorderCoordinator = () => (singleton ??= createRecorderCoordinator());
