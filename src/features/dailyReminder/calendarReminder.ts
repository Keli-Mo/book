import Taro from "@tarojs/taro";

export const DAILY_CALENDAR_REMINDER_KEY = "haisha:daily-calendar-reminder:v1";
export const DEFAULT_DAILY_REMINDER_TIME = "09:00";

type ReminderRecord = {
  version: 1;
  time: string;
  state: "pending" | "active";
  createdAt: number;
};

export type CalendarReminderStatus =
  | { status: "none" }
  | { status: "active" | "pending"; time: string }
  | { status: "storage-unavailable" };

export type AddCalendarReminderResult =
  | { status: "added" | "already-added"; time: string }
  | { status: "manual-change" | "pending-check"; time: string }
  | { status: "failed"; detail: string }
  | { status: "invalid-time" | "unsupported" | "permission-denied" | "privacy-undeclared" | "storage-unavailable" };

const parseTime = (time: string): { hour: number; minute: number } | null => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
};

const isRecord = (value: unknown): value is ReminderRecord => {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.version === 1 && typeof item.time === "string" && parseTime(item.time) !== null
    && (item.state === "pending" || item.state === "active")
    && typeof item.createdAt === "number" && Number.isFinite(item.createdAt);
};

const readRecord = (): { record: ReminderRecord | null; unavailable: boolean } => {
  try {
    const stored: unknown = Taro.getStorageSync(DAILY_CALENDAR_REMINDER_KEY);
    if (stored === undefined || stored === null || stored === "") return { record: null, unavailable: false };
    return isRecord(stored)
      ? { record: stored, unavailable: false }
      : { record: null, unavailable: true };
  } catch {
    return { record: null, unavailable: true };
  }
};

export function getCalendarReminderStatus(): CalendarReminderStatus {
  const { record, unavailable } = readRecord();
  if (unavailable) return { status: "storage-unavailable" };
  if (!record) return { status: "none" };
  return { status: record.state, time: record.time };
}

export function nextCalendarOccurrence(time: string, now: Date): number | null {
  const parsed = parseTime(time);
  if (!parsed || !Number.isFinite(now.getTime())) return null;
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parsed.hour, parsed.minute);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return Math.floor(target.getTime() / 1000);
}

const getCalendarErrorDetail = (error: unknown): string => {
  if (error && typeof error === "object") {
    const value = error as { errMsg?: unknown; message?: unknown; errCode?: unknown; errno?: unknown };
    const code = value.errCode ?? value.errno;
    const message = value.errMsg ?? value.message;
    const detail = [code == null ? "" : `错误码 ${String(code)}`, typeof message === "string" ? message : ""]
      .filter(Boolean).join("，");
    return detail.slice(0, 180) || "未知错误";
  }
  return String(error).slice(0, 180);
};

const isPermissionError = (detail: string): boolean =>
  /auth\s*deny|authorize|permission|scope\.addPhoneCalendar/i.test(detail);

let inFlight: Promise<AddCalendarReminderResult> | null = null;

async function addReminder(time: string, now: Date): Promise<AddCalendarReminderResult> {
  if (!parseTime(time)) return { status: "invalid-time" };

  const { record, unavailable } = readRecord();
  if (unavailable) return { status: "storage-unavailable" };
  if (record?.state === "pending") return { status: "pending-check", time: record.time };
  if (record?.state === "active") return record.time === time
    ? { status: "already-added", time }
    : { status: "manual-change", time: record.time };

  if (typeof Taro.addPhoneRepeatCalendar !== "function") return { status: "unsupported" };
  try {
    if (typeof Taro.canIUse === "function" && !Taro.canIUse("addPhoneRepeatCalendar")) {
      return { status: "unsupported" };
    }
  } catch {
    return { status: "unsupported" };
  }

  const startTime = nextCalendarOccurrence(time, now);
  if (startTime === null) return { status: "invalid-time" };
  const pending: ReminderRecord = { version: 1, time, state: "pending", createdAt: now.getTime() };
  try {
    Taro.setStorageSync(DAILY_CALENDAR_REMINDER_KEY, pending);
  } catch {
    return { status: "storage-unavailable" };
  }

  try {
    await Taro.addPhoneRepeatCalendar({
      title: "海沙牛娃 · 每日英语练习",
      description: "打开海沙牛娃，继续今天的英语听力与跟读练习。",
      startTime,
      alarm: true,
      alarmOffset: 0,
      repeatInterval: "day",
    });
  } catch (error) {
    console.error("添加每日重复日历提醒失败", error);
    try {
      Taro.removeStorageSync(DAILY_CALENDAR_REMINDER_KEY);
    } catch {
      return { status: "pending-check", time };
    }
    const detail = getCalendarErrorDetail(error);
    if (/^错误码 112(?:，|$)|api scope is not declared in the privacy agreement/i.test(detail)) {
      return { status: "privacy-undeclared" };
    }
    return isPermissionError(detail)
      ? { status: "permission-denied" }
      : { status: "failed", detail };
  }

  try {
    Taro.setStorageSync(DAILY_CALENDAR_REMINDER_KEY, { ...pending, state: "active" });
    return { status: "added", time };
  } catch {
    // 事件可能已经在系统日历中；保留 pending 标记，避免重试时添加第二条。
    return { status: "pending-check", time };
  }
}

/** 只能从用户点击的处理函数中调用。日历 API 自行请求系统权限。 */
export function addDailyCalendarReminder(
  time = DEFAULT_DAILY_REMINDER_TIME,
  now = new Date(),
): Promise<AddCalendarReminderResult> {
  if (inFlight) return inFlight;
  inFlight = addReminder(time, now).finally(() => { inFlight = null; });
  return inFlight;
}
