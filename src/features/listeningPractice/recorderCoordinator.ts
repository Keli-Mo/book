export type RecorderNativeStopResult = {
  duration?: number;
  fileSize?: number;
  tempFilePath?: string;
  [key: string]: unknown;
};

export type RecorderNativeManager = {
  start(options: unknown): void;
  stop(): void;
  pause?: () => void;
  resume?: () => void;
  onStart?: (listener: () => void) => void;
  onPause?: (listener: () => void) => void;
  onResume?: (listener: () => void) => void;
  onStop?: (listener: (result: RecorderNativeStopResult) => void) => void;
  onError?: (listener: (error: unknown) => void) => void;
  onInterruptionBegin?: (listener: () => void) => void;
  onInterruptionEnd?: (listener: () => void) => void;
};

export type RecorderCoordinatorPhase =
  | "idle"
  | "starting"
  | "recording"
  | "paused"
  | "stopping"
  | "draining";

export type RecorderOwnerListener = {
  onStart?: () => void;
  onPause?: () => void;
  onResume?: () => void;
  onStop?: (result: RecorderNativeStopResult) => void;
  onError?: (error: unknown) => void;
  onInterruptionBegin?: () => void;
  onInterruptionEnd?: () => void;
};

export type RecorderOperationResult =
  | { ok: true }
  | {
      ok: false;
      reason: "released" | "busy" | "invalid-phase" | "unsupported" | "native-error";
      phase?: RecorderCoordinatorPhase;
      capability?: "pause" | "resume";
      error?: unknown;
    };

export type RecorderReleaseResult =
  | { ok: true; phase: "idle" | "draining" }
  | { ok: false; reason: "released" | "native-error"; phase?: RecorderCoordinatorPhase; error?: unknown };

export type RecorderSubscriptionResult =
  | { ok: true; unsubscribe: () => void }
  | { ok: false; reason: "released" };

export type RecorderOwner = {
  start(options: unknown): RecorderOperationResult;
  pause(): RecorderOperationResult;
  resume(): RecorderOperationResult;
  stop(): RecorderOperationResult;
  release(): RecorderReleaseResult;
  subscribe(listener: RecorderOwnerListener): RecorderSubscriptionResult;
};

export type RecorderAcquireResult =
  | { ok: true; owner: RecorderOwner }
  | { ok: false; reason: "unavailable" | "busy"; phase?: RecorderCoordinatorPhase };

export type RecorderCoordinator = {
  acquire(): RecorderAcquireResult;
  getPhase(): RecorderCoordinatorPhase;
};

export type RecorderCoordinatorOptions = {
  /** 注入点用于单测；省略时只会在 acquire 时惰性读取运行时 wx。 */
  getRecorderManager?: () => RecorderNativeManager | null | undefined;
};

type OwnerState = {
  token: symbol;
  released: boolean;
  listeners: Set<RecorderOwnerListener>;
};

const getRuntimeRecorderManager = (): RecorderNativeManager | undefined => {
  const runtime = globalThis as unknown as {
    wx?: { getRecorderManager?: () => RecorderNativeManager };
  };
  return runtime.wx?.getRecorderManager?.();
};

/**
 * 小程序的 RecorderManager 没有 off API，因此一个 coordinator 实例只能对每种原生
 * 事件注册一次。页面通过 owner token 订阅，回调始终从当前 owner 的 listeners 转发。
 */
export const createRecorderCoordinator = (
  options: RecorderCoordinatorOptions = {},
): RecorderCoordinator => {
  let manager: RecorderNativeManager | null | undefined;
  let phase: RecorderCoordinatorPhase = "idle";
  let currentOwner: OwnerState | null = null;

  const isCurrent = (owner: OwnerState) =>
    !owner.released && currentOwner?.token === owner.token;

  const notifyCurrent = <Key extends keyof RecorderOwnerListener>(
    key: Key,
    ...args: Parameters<NonNullable<RecorderOwnerListener[Key]>>
  ) => {
    const owner = currentOwner;
    if (!owner || owner.released) return;
    owner.listeners.forEach((listener) => {
      const callback = listener[key] as ((...values: unknown[]) => void) | undefined;
      callback?.(...args);
    });
  };

  const bindNativeEvents = (native: RecorderNativeManager) => {
    // draining 中收到的是已释放 session 的终止事件，绝不能转交给下一页 owner。
    native.onStart?.(() => {
      if (phase !== "starting") return;
      phase = "recording";
      notifyCurrent("onStart");
    });
    native.onPause?.(() => {
      if (phase !== "paused") return;
      notifyCurrent("onPause");
    });
    native.onResume?.(() => {
      if (phase !== "recording") return;
      notifyCurrent("onResume");
    });
    native.onStop?.((result) => {
      if (phase === "draining") {
        phase = "idle";
        return;
      }
      if (phase === "idle") return;
      phase = "idle";
      notifyCurrent("onStop", result);
    });
    native.onError?.((error) => {
      if (phase === "draining") {
        phase = "idle";
        return;
      }
      if (phase === "idle") return;
      phase = "idle";
      notifyCurrent("onError", error);
    });
    native.onInterruptionBegin?.(() => {
      if (phase !== "draining" && phase !== "idle") notifyCurrent("onInterruptionBegin");
    });
    native.onInterruptionEnd?.(() => {
      if (phase !== "draining" && phase !== "idle") notifyCurrent("onInterruptionEnd");
    });
  };

  const getManager = () => {
    if (manager !== undefined) return manager;
    try {
      manager = options.getRecorderManager?.() ?? getRuntimeRecorderManager() ?? null;
    } catch (_error) {
      manager = null;
    }
    if (manager) bindNativeEvents(manager);
    return manager;
  };

  const createOwner = (owner: OwnerState, native: RecorderNativeManager): RecorderOwner => {
    const rejected = (reason: "released" | "busy" | "invalid-phase") =>
      reason === "busy"
        ? ({ ok: false, reason, phase } as RecorderOperationResult)
        : ({ ok: false, reason, phase } as RecorderOperationResult);

    return {
      start(recordingOptions) {
        if (!isCurrent(owner)) return rejected("released");
        if (phase === "draining") return rejected("busy");
        if (phase !== "idle") return rejected("invalid-phase");
        phase = "starting";
        try {
          native.start(recordingOptions);
          return { ok: true };
        } catch (error) {
          if (phase === "starting") phase = "idle";
          return { ok: false, reason: "native-error", error };
        }
      },
      pause() {
        if (!isCurrent(owner)) return rejected("released");
        if (typeof native.pause !== "function") {
          return { ok: false, reason: "unsupported", capability: "pause" };
        }
        if (phase !== "recording") return rejected("invalid-phase");
        phase = "paused";
        try {
          native.pause();
          return { ok: true };
        } catch (error) {
          if (phase === "paused") phase = "recording";
          return { ok: false, reason: "native-error", error };
        }
      },
      resume() {
        if (!isCurrent(owner)) return rejected("released");
        if (typeof native.resume !== "function") {
          return { ok: false, reason: "unsupported", capability: "resume" };
        }
        if (phase !== "paused") return rejected("invalid-phase");
        phase = "recording";
        try {
          native.resume();
          return { ok: true };
        } catch (error) {
          if (phase === "recording") phase = "paused";
          return { ok: false, reason: "native-error", error };
        }
      },
      stop() {
        if (!isCurrent(owner)) return rejected("released");
        if (phase !== "starting" && phase !== "recording" && phase !== "paused") {
          return rejected("invalid-phase");
        }
        const previousPhase = phase;
        phase = "stopping";
        try {
          native.stop();
          return { ok: true };
        } catch (error) {
          if (phase === "stopping") phase = previousPhase;
          return { ok: false, reason: "native-error", error };
        }
      },
      release() {
        if (!isCurrent(owner)) return { ok: false, reason: "released" };
        owner.released = true;
        owner.listeners.clear();
        currentOwner = null;

        if (phase === "idle") return { ok: true, phase: "idle" };
        if (phase === "stopping") return { ok: true, phase: "draining" };

        // 释放活动 owner 后必须阻止新 start，直到旧 session 的终止事件被消费。
        phase = "draining";
        try {
          native.stop();
          return { ok: true, phase: "draining" };
        } catch (error) {
          // 同步失败意味着 stop 没有进入原生队列，不能永久卡住下一位 owner。
          phase = "idle";
          return { ok: false, reason: "native-error", phase, error };
        }
      },
      subscribe(listener) {
        if (!isCurrent(owner)) return { ok: false, reason: "released" };
        owner.listeners.add(listener);
        return {
          ok: true,
          unsubscribe: () => owner.listeners.delete(listener),
        };
      },
    };
  };

  return {
    acquire() {
      const native = getManager();
      if (!native) return { ok: false, reason: "unavailable" };
      if (currentOwner && !currentOwner.released) {
        return { ok: false, reason: "busy", phase };
      }
      const owner: OwnerState = { token: Symbol("recorder-owner"), released: false, listeners: new Set() };
      currentOwner = owner;
      return { ok: true, owner: createOwner(owner, native) };
    },
    getPhase: () => phase,
  };
};

let singleton: RecorderCoordinator | null = null;

/** 仅调用该 accessor 后才会在 acquire 阶段读取 wx，避免 H5/单测模块导入副作用。 */
export const getRecorderCoordinator = (): RecorderCoordinator => {
  if (!singleton) singleton = createRecorderCoordinator();
  return singleton;
};
