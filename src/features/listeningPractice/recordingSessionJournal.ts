import type { CheckInContext } from "./pendingCheckInStore";

/** 写在原生 start() 之前；冷启动时据此隔离上一次未确认结束的录音。 */
export const RECORDING_SESSION_JOURNAL_KEY = "active-recording-session-v1";

export type RecordingSessionTerminal = {
  tempFilePath: string;
  durationMs: number;
  fileSizeBytes: number;
};

export type RecordingSessionEntry = {
  version: 1;
  id: string;
  context: CheckInContext;
  startedAtMs: number;
} & (
  | { stage: "starting" | "confirmed" | "abandoned"; terminal?: never }
  | { stage: "terminal"; terminal: RecordingSessionTerminal }
);

export type RecordingSessionStorage = {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
};

export type RecordingSessionJournal = {
  /** 缺失返回 null；读取失败或非空损坏数据抛错，调用方必须保持录音锁。 */
  read(): RecordingSessionEntry | null;
  /** 先同步写入 starting，写入失败时不得调用原生 start()。 */
  begin(context: CheckInContext): RecordingSessionEntry;
  /** 仅 onStart 确认本会话后，才可把后续 onStop 文件归给本页。 */
  confirm(id: string): boolean;
  /** 仅已确认开始的会话可记录原生停止文件；无效结果返回 false。 */
  recordTerminal(id: string, result: unknown): boolean;
  /** 用户选择放弃时先记下决定；若随后清理中断，下次启动可继续清除。 */
  markAbandoned(id: string): boolean;
  /** 按会话 id 清除，迟到旧回调不能清掉新会话。 */
  clear(id: string): boolean;
  /** 仅供用户明确放弃无法读取的旧记录后使用；清理失败仍须保持锁。 */
  discardUnreadable(): void;
};

export type RecordingSessionJournalOptions = {
  storage: RecordingSessionStorage;
  clock: { now(): number };
  random: { hex(): string };
};

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isRequestId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{32}$/i.test(value);

const isContext = (value: unknown): value is CheckInContext => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const context = value as Partial<CheckInContext>;
  return isText(context.bookId) && isText(context.bookTitle) &&
    isText(context.practiceId) && isNonNegativeInteger(context.practiceIndex) &&
    isNonNegativeInteger(context.pageNumber) && isText(context.imageUrl) &&
    isText(context.sectionTitle);
};

const parseTerminal = (result: unknown): RecordingSessionTerminal | null => {
  if (!result || typeof result !== "object") return null;
  const native = result as { tempFilePath?: unknown; duration?: unknown; fileSize?: unknown };
  if (!isText(native.tempFilePath) || typeof native.duration !== "number" ||
    !Number.isFinite(native.duration) || native.duration < 500 || !isPositiveInteger(native.fileSize)) return null;
  return { tempFilePath: native.tempFilePath, durationMs: native.duration, fileSizeBytes: native.fileSize };
};

const isStoredTerminal = (value: unknown): value is RecordingSessionTerminal => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const terminal = value as Partial<RecordingSessionTerminal>;
  return isText(terminal.tempFilePath) && typeof terminal.durationMs === "number" &&
    Number.isFinite(terminal.durationMs) && terminal.durationMs >= 500 && isPositiveInteger(terminal.fileSizeBytes);
};

const parseEntry = (value: unknown): RecordingSessionEntry => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("录音会话记录损坏");
  const entry = value as Partial<RecordingSessionEntry>;
  if (entry.version !== 1 || !isRequestId(entry.id) || !isContext(entry.context) ||
    !isNonNegativeInteger(entry.startedAtMs)) throw new Error("录音会话记录损坏");
  if (entry.stage === "terminal") {
    if (!isStoredTerminal(entry.terminal)) throw new Error("录音会话记录损坏");
    return { version: 1, id: entry.id, context: { ...entry.context },
      startedAtMs: entry.startedAtMs, stage: "terminal", terminal: { ...entry.terminal } };
  }
  if (entry.stage !== "starting" && entry.stage !== "confirmed" && entry.stage !== "abandoned") {
    throw new Error("录音会话记录损坏");
  }
  return { version: 1, id: entry.id, context: { ...entry.context },
    startedAtMs: entry.startedAtMs, stage: entry.stage };
};

export const createRecordingSessionJournal = ({ storage, clock, random }: RecordingSessionJournalOptions): RecordingSessionJournal => {
  const read = (): RecordingSessionEntry | null => {
    const value = storage.get(RECORDING_SESSION_JOURNAL_KEY);
    // 微信 getStorageSync 在 key 不存在时通常返回空字符串。
    return value === undefined || value === null || value === "" ? null : parseEntry(value);
  };
  const write = (entry: RecordingSessionEntry | null) => {
    storage.set(RECORDING_SESSION_JOURNAL_KEY, entry);
    // 存储适配器意外静默失败时，不能在未持久锁定的情况下开始新录音。
    const verified = read();
    if (entry === null ? verified !== null : verified?.id !== entry.id || verified.stage !== entry.stage) {
      throw new Error("录音会话记录写入失败");
    }
  };
  return {
    read,
    begin(context) {
      if (read()) throw new Error("上次录音仍待处理");
      if (!isContext(context)) throw new Error("录音页面信息不完整");
      const id = random.hex();
      const startedAtMs = clock.now();
      if (!isRequestId(id) || !isNonNegativeInteger(startedAtMs)) throw new Error("无法生成录音会话编号");
      const entry: RecordingSessionEntry = { version: 1, id, stage: "starting",
        context: { ...context }, startedAtMs };
      write(entry);
      return parseEntry(entry);
    },
    confirm(id) {
      const entry = read();
      if (!entry || entry.id !== id) return false;
      if (entry.stage === "confirmed") return true;
      if (entry.stage !== "starting") return false;
      write({ ...entry, stage: "confirmed" });
      return true;
    },
    recordTerminal(id, result) {
      const entry = read();
      if (!entry || entry.id !== id) return false;
      if (entry.stage === "terminal") return true;
      if (entry.stage !== "confirmed") return false;
      const terminal = parseTerminal(result);
      if (!terminal) return false;
      write({ ...entry, stage: "terminal", terminal });
      return true;
    },
    markAbandoned(id) {
      const entry = read();
      if (!entry || entry.id !== id) return false;
      if (entry.stage === "abandoned") return true;
      write({ version: 1, id, stage: "abandoned", context: { ...entry.context },
        startedAtMs: entry.startedAtMs });
      return true;
    },
    clear(id) {
      const entry = read();
      if (!entry || entry.id !== id) return false;
      write(null);
      return true;
    },
    discardUnreadable() {
      // 不先 read()：旧记录可能已损坏；写后读回仍失败时必须让调用方保持锁。
      write(null);
    },
  };
};

const createRequestId = () =>
  Array.from({ length: 4 }, () => Math.floor(Math.random() * 0x100000000)
    .toString(16).padStart(8, "0")).join("");

let runtimeJournal: RecordingSessionJournal | null = null;
/** 小程序所有页面共用一个同步日记；导入模块本身不会访问 wx。 */
export const getRecordingSessionJournal = () => {
  if (!runtimeJournal) runtimeJournal = createRecordingSessionJournal({
    storage: { get: (key) => wx.getStorageSync(key), set: (key, value) => wx.setStorageSync(key, value) },
    clock: { now: () => Date.now() }, random: { hex: createRequestId },
  });
  return runtimeJournal;
};
