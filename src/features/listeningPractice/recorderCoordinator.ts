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
  onStart?: () => void; onPause?: () => void; onResume?: () => void; onStop?: (result: RecorderNativeStopResult) => void;
  onError?: (error: unknown) => void; onInterruptionBegin?: () => void; onInterruptionEnd?: () => void;
};
export type RecorderOperationResult = { ok: true } | { ok: false; reason: "released" | "busy" | "invalid-phase" | "unsupported" | "native-error"; phase?: RecorderCoordinatorPhase; capability?: "pause" | "resume"; error?: unknown };
export type RecorderReleaseResult = { ok: true; phase: "idle" | "draining" } | { ok: false; reason: "released" | "native-error"; phase?: RecorderCoordinatorPhase; error?: unknown };
export type RecorderSubscriptionResult = { ok: true; unsubscribe: () => void } | { ok: false; reason: "released" };
export type RecorderOwner = { start(options: unknown): RecorderOperationResult; pause(): RecorderOperationResult; resume(): RecorderOperationResult; stop(): RecorderOperationResult; release(): RecorderReleaseResult; subscribe(listener: RecorderOwnerListener): RecorderSubscriptionResult };
export type RecorderAcquireResult = { ok: true; owner: RecorderOwner; capabilities: RecordingCapabilities } | { ok: false; reason: "unavailable" | "busy"; phase?: RecorderCoordinatorPhase };
export type RecorderCoordinator = { acquire(): RecorderAcquireResult; getPhase(): RecorderCoordinatorPhase };
export type RecorderScheduler = { setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(handle: unknown): void };
export type RecorderCoordinatorOptions = { getRecorderManager?: () => RecorderNativeManager | null | undefined; scheduler?: RecorderScheduler; quietWindowMs?: number };
type Owner = { token: symbol; released: boolean; listeners: Set<RecorderOwnerListener> };
type EventName = "start" | "pause" | "resume" | "stop" | "error" | "interruptionBegin" | "interruptionEnd";

const runtimeManager = () => (globalThis as unknown as { wx?: { getRecorderManager?: () => RecorderNativeManager } }).wx?.getRecorderManager?.();
const fallbackScheduler: RecorderScheduler = {
  setTimeout(callback, delay) { const timer = (globalThis as unknown as { setTimeout?: (fn: () => void, ms: number) => unknown }).setTimeout; if (timer) return timer(callback, delay); callback(); return null; },
  clearTimeout(handle) { const clear = (globalThis as unknown as { clearTimeout?: (id: unknown) => void }).clearTimeout; clear?.(handle); },
};

/** RecorderManager 没有 off API；同一实例的成功绑定记账后绝不重复注册。 */
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
  const scheduler = options.scheduler ?? fallbackScheduler;
  const quietWindowMs = options.quietWindowMs ?? 80;
  const current = (value: Owner) => !value.released && owner?.token === value.token;
  const notify = (key: keyof RecorderOwnerListener, value?: unknown) => {
    if (!owner || owner.released) return;
    owner.listeners.forEach((listener) => {
      const callback = listener[key] as ((arg?: unknown) => void) | undefined;
      try { callback?.(value); } catch (_error) { /* 页面 listener 不得破坏其它订阅或 native 命令。 */ }
    });
  };
  const clearPending = () => { systemPausePending = false; pausePending = false; resumePending = false; };
  const beginQuiet = () => {
    if (quietTimer !== null) scheduler.clearTimeout(quietTimer);
    quietTimer = scheduler.setTimeout(() => { quietTimer = null; if (phase === "draining") phase = "idle"; }, quietWindowMs);
  };
  const consumeTerminal = (key: "onStop" | "onError", value: unknown) => {
    clearPending();
    // 无 session id：drain 和静默窗内的一切 terminal 都归旧代次，绝不贴给等待 owner。
    if (phase === "draining") { beginQuiet(); return; }
    if (phase === "idle") return;
    phase = "idle";
    notify(key, value);
  };
  const ensure = (): { manager: RecorderNativeManager; caps: RecordingCapabilities } | null => {
    let candidate = pendingNative;
    if (!candidate) { try { candidate = options.getRecorderManager?.() ?? runtimeManager() ?? null; } catch (_error) { return null; } }
    if (!candidate || typeof candidate.start !== "function" || typeof candidate.stop !== "function" || typeof candidate.onStart !== "function" || typeof candidate.onStop !== "function" || typeof candidate.onError !== "function") return null;
    pendingNative = candidate;
    const add = (name: EventName, listener: (value?: unknown) => void) => {
      if (bound.has(name)) return true;
      const method = candidate![`on${name[0].toUpperCase()}${name.slice(1)}` as keyof RecorderNativeManager];
      if (typeof method !== "function") return false;
      try { (method as (fn: (value?: unknown) => void) => void)(listener); bound.add(name); return true; } catch (_error) { return false; }
    };
    const core = add("start", () => { if (phase === "starting") { phase = "recording"; notify("onStart"); } })
      && add("stop", (result) => consumeTerminal("onStop", result))
      && add("error", (error) => consumeTerminal("onError", error));
    if (!core) return null;
    const pause = add("pause", () => { if (!pausePending && !systemPausePending) return; clearPending(); phase = "paused"; notify("onPause"); });
    const resume = add("resume", () => { if (!resumePending) return; resumePending = false; phase = "recording"; notify("onResume"); });
    const begin = add("interruptionBegin", () => { if (phase === "recording" || phase === "starting" || phase === "paused") { systemPausePending = true; notify("onInterruptionBegin"); } });
    const end = add("interruptionEnd", () => { if (phase !== "idle" && phase !== "draining") notify("onInterruptionEnd"); });
    capabilities = { canRecord: true, canPause: typeof candidate.pause === "function" && pause, canResume: typeof candidate.resume === "function" && resume, canInterrupt: begin && end };
    native = candidate; pendingNative = null;
    return { manager: candidate, caps: capabilities };
  };
  const makeOwner = (state: Owner, manager: RecorderNativeManager, caps: RecordingCapabilities): RecorderOwner => {
    const fail = (reason: "released" | "busy" | "invalid-phase"): RecorderOperationResult => ({ ok: false, reason, phase });
    const call = (action: () => void, before: RecorderCoordinatorPhase, after: RecorderCoordinatorPhase): RecorderOperationResult => { phase = before; try { action(); return { ok: true }; } catch (error) { if (phase === before) phase = after; return { ok: false, reason: "native-error", error }; } };
    return {
      start(recordingOptions) { if (!current(state)) return fail("released"); if (phase === "draining") return fail("busy"); if (phase !== "idle") return fail("invalid-phase"); return call(() => manager.start(recordingOptions), "starting", "idle"); },
      pause() { if (!current(state)) return fail("released"); if (!caps.canPause) return { ok: false, reason: "unsupported", capability: "pause" }; if (phase !== "recording") return fail("invalid-phase"); pausePending = true; return call(() => manager.pause!(), "paused", "recording"); },
      resume() { if (!current(state)) return fail("released"); if (!caps.canResume) return { ok: false, reason: "unsupported", capability: "resume" }; if (phase !== "paused") return fail("invalid-phase"); resumePending = true; return call(() => manager.resume!(), "recording", "paused"); },
      stop() { if (!current(state)) return fail("released"); if (!["starting", "recording", "paused"].includes(phase)) return fail("invalid-phase"); return call(() => manager.stop(), "stopping", phase); },
      release() {
        if (!current(state)) return { ok: false, reason: "released" };
        state.released = true; state.listeners.clear(); owner = null;
        if (phase === "idle") return { ok: true, phase: "idle" };
        if (phase === "draining") return { ok: true, phase: "draining" };
        if (phase === "stopping") { phase = "draining"; return { ok: true, phase: "draining" }; }
        phase = "draining";
        try { manager.stop(); return { ok: true, phase: "draining" }; } catch (error) { phase = "idle"; return { ok: false, reason: "native-error", phase, error }; }
      },
      subscribe(listener) { if (!current(state)) return { ok: false, reason: "released" }; state.listeners.add(listener); return { ok: true, unsubscribe: () => state.listeners.delete(listener) }; },
    };
  };
  return { acquire() { const ready = native && capabilities ? { manager: native, caps: capabilities } : ensure(); if (!ready) return { ok: false, reason: "unavailable" }; if (owner && !owner.released) return { ok: false, reason: "busy", phase }; const state: Owner = { token: Symbol("recorder-owner"), released: false, listeners: new Set() }; owner = state; return { ok: true, owner: makeOwner(state, ready.manager, ready.caps), capabilities: ready.caps }; }, getPhase: () => phase };
};
let singleton: RecorderCoordinator | null = null;
export const getRecorderCoordinator = () => (singleton ??= createRecorderCoordinator());
