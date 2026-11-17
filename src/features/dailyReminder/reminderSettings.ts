import Taro from "@tarojs/taro";
import { CLOUD_ENV_ID } from "@/cloud";
import { DEFAULT_DAILY_REMINDER_TIME } from "./calendarReminder";

// 同一个上传包可成为体验版或正式版，按微信运行时版本判断。
export const getReminderFunction = (): "dailyReminderTrial" | null => {
  try {
    const version = wx.getAccountInfoSync().miniProgram.envVersion;
    return version === "develop" || version === "trial" ? "dailyReminderTrial" : null;
  } catch { return null; }
};

const CACHE_KEY = "haisha:trial:wechat-reminder-settings:v1";
let accountVerified = false;
export const isReminderAccountVerified = () => accountVerified && Boolean(getReminderFunction());
const VALID_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const VALID_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const getReminderChoiceDate = (offset: 0 | 1, now = Date.now()): string =>
  new Date(now + (8 + offset * 24) * 3600000).toISOString().slice(0, 10);
export const isReminderTimeInFuture = (date: string, time: string, now = Date.now()): boolean =>
  VALID_DATE.test(date) && VALID_TIME.test(time) && Date.parse(`${date}T${time}:00+08:00`) > now;
const SETTINGS_TTL_MS = 60_000;
let settingsMutationRevision = 0;
let pendingSettings: { promise: Promise<ReminderSettingsResult>; isWrite: boolean } | undefined;
let lastWriteRevision = 0;
let recentSettings: { result: ReminderSettingsResult; expiresAt: number } | undefined;

export type ReminderNextStatus = "off" | "needsConsent" | "scheduled";

export interface ReminderSettingsState {
  enabled: boolean;
  time: string;
  nextStatus: ReminderNextStatus;
  nextDate?: string;
  scheduledTime?: string;
  earlierAvailableDate?: string;
  tomorrowScheduledDate?: string;
  selectedDate?: string;
  movableDate?: string;
  lastSendStatus?: "sent" | "failed" | "unknown";
  lastSendCode?: number | string;
}

/** 设置已有可重排的授权时，确认时间不必再次调起微信授权。 */
export function canReuseNextSettingsReservation(
  settings: ReminderSettingsState, time: string, now = Date.now(), targetDate?: string,
): boolean {
  if (!settings.enabled || settings.nextStatus !== "scheduled" || !settings.nextDate) return false;
  if (targetDate) {
    if (!isReminderTimeInFuture(targetDate, time, now)) return false;
    return settings.nextDate === targetDate || settings.tomorrowScheduledDate === targetDate
      || Boolean(settings.movableDate);
  }
  const bookedAt = Date.parse(`${settings.nextDate}T${settings.scheduledTime || settings.time}:00+08:00`);
  if (!(bookedAt > now)) return false;
  // 已为练习保留明日的额度时，若今天还有更早的可选时段，需另约今天。
  return !settings.earlierAvailableDate
    || Date.parse(`${settings.earlierAvailableDate}T${time}:00+08:00`) <= now;
}

export interface ReminderSettingsResult {
  ok: boolean;
  settings?: ReminderSettingsState;
  reason?: string;
}

const defaultSettings = (): ReminderSettingsState => ({
  enabled: false,
  time: DEFAULT_DAILY_REMINDER_TIME,
  nextStatus: "off",
});

const parseSettings = (value: unknown): ReminderSettingsState | null => {
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<ReminderSettingsState>;
  if (typeof state.enabled !== "boolean" || typeof state.time !== "string"
    || !VALID_TIME.test(state.time)
    || !["off", "needsConsent", "scheduled"].includes(state.nextStatus || "")) return null;
  return {
    enabled: state.enabled,
    time: state.time,
    nextStatus: state.nextStatus as ReminderNextStatus,
    ...(typeof state.nextDate === "string" ? { nextDate: state.nextDate } : {}),
    ...(typeof state.scheduledTime === "string" && VALID_TIME.test(state.scheduledTime)
      ? { scheduledTime: state.scheduledTime } : {}),
    ...(typeof state.earlierAvailableDate === "string" ? { earlierAvailableDate: state.earlierAvailableDate } : {}),
    ...(typeof state.tomorrowScheduledDate === "string" ? { tomorrowScheduledDate: state.tomorrowScheduledDate } : {}),
    ...(typeof state.selectedDate === "string" && VALID_DATE.test(state.selectedDate) ? { selectedDate: state.selectedDate } : {}),
    ...(typeof state.movableDate === "string" && VALID_DATE.test(state.movableDate) ? { movableDate: state.movableDate } : {}),
    ...(["sent", "failed", "unknown"].includes(state.lastSendStatus || "")
      ? { lastSendStatus: state.lastSendStatus as "sent" | "failed" | "unknown" } : {}),
    ...(typeof state.lastSendCode === "number" || typeof state.lastSendCode === "string"
      ? { lastSendCode: state.lastSendCode } : {}),
  };
};

export const readCachedReminderSettings = (): ReminderSettingsState => {
  if (!getReminderFunction()) return defaultSettings();
  try { return parseSettings(Taro.getStorageSync(CACHE_KEY)) || defaultSettings(); }
  catch { return defaultSettings(); }
};

export const isReminderExplicitlyOff = (): boolean => {
  try {
    const state = parseSettings(Taro.getStorageSync(CACHE_KEY));
    return state !== null && !state.enabled;
  } catch {
    return false;
  }
};

const cacheSettings = (settings: ReminderSettingsState): void => {
  try { Taro.setStorageSync(CACHE_KEY, settings); }
  catch { /* 云端保存结果不受本机缓存故障影响。 */ }
};

const invokeSettings = async (
  data: Record<string, unknown>,
  revision: number,
): Promise<ReminderSettingsResult> => {
  const functionName = getReminderFunction();
  if (!functionName || !wx.cloud) return { ok: false, reason: "CLOUD_UNAVAILABLE" };
  try {
    const response = await wx.cloud.callFunction({
      name: functionName,
      config: { env: CLOUD_ENV_ID },
      data,
    });
    const result = response.result as {
      ok?: boolean;
      code?: string;
      data?: unknown;
    } | undefined;
    const currentRevision = data.action === "setSettings" ? lastWriteRevision : settingsMutationRevision;
    if (revision !== currentRevision) {
      return { ok: false, reason: "STALE_RESPONSE" };
    }
    if (!result?.ok) {
      if (result?.code === "TEST_ACCOUNT_REQUIRED") {
        accountVerified = false;
        cacheSettings(defaultSettings());
      }
      return { ok: false, reason: result?.code || "CLOUD_ERROR" };
    }
    const settings = parseSettings(result.data);
    if (!settings) return { ok: false, reason: "INVALID_SERVER_RESPONSE" };
    accountVerified = true;
    cacheSettings(settings);
    return { ok: true, settings };
  } catch {
    return { ok: false, reason: "CLOUD_ERROR" };
  }
};

export const invalidateReminderSettings = (): void => {
  settingsMutationRevision += 1;
  recentSettings = undefined;
  // 即使并行的预约登记使读取失效，仍应等到用户刚提交的开关或时间更改完成。
  if (!pendingSettings?.isWrite) pendingSettings = undefined;
};

const requestSettings = (data: Record<string, unknown>): Promise<ReminderSettingsResult> => {
  const revision = settingsMutationRevision;
  const startedAt = Date.now();
  const request = invokeSettings(data, revision).then(result => {
    if (revision === settingsMutationRevision && (result.ok || result.reason === "TEST_ACCOUNT_REQUIRED")) {
      const next = result.settings;
      const dueAt = next?.nextDate && next.scheduledTime
        ? Date.parse(`${next.nextDate}T${next.scheduledTime}:00+08:00`) : 0;
      const expiresAt = Math.min(startedAt + SETTINGS_TTL_MS, dueAt > startedAt ? dueAt : Infinity);
      recentSettings = { result, expiresAt };
    }
    return result;
  }).finally(() => {
    if (pendingSettings?.promise === request) pendingSettings = undefined;
  });
  pendingSettings = { promise: request, isWrite: data.action === "setSettings" };
  return request;
};

export const getReminderSettings = (): Promise<ReminderSettingsResult> => {
  if (!getReminderFunction()) return Promise.resolve({ ok: false, reason: "CLOUD_UNAVAILABLE" });
  if (pendingSettings) return pendingSettings.promise;
  if (recentSettings && Date.now() < recentSettings.expiresAt) return Promise.resolve(recentSettings.result);
  return requestSettings({ action: "getSettings" });
};

export const setReminderSettings = (enabled: boolean, time: string, targetDate?: string): Promise<ReminderSettingsResult> => {
  if (typeof enabled !== "boolean" || !VALID_TIME.test(time)) {
    return Promise.resolve({ ok: false, reason: "INVALID_ARGUMENT" });
  }
  if (targetDate !== undefined) {
    const now = Date.now();
    if (targetDate !== getReminderChoiceDate(0, now) && targetDate !== getReminderChoiceDate(1, now)) {
      return Promise.resolve({ ok: false, reason: "INVALID_TARGET_DATE" });
    }
    if (!isReminderTimeInFuture(targetDate, time, now)) {
      return Promise.resolve({ ok: false, reason: "REMINDER_TIME_PASSED" });
    }
  }
  invalidateReminderSettings();
  lastWriteRevision = settingsMutationRevision;
  return requestSettings({
    action: "setSettings", enabled, time, ...(enabled ? { reserveNext: true } : {}),
    ...(targetDate ? { targetDate } : {}),
  });
};
