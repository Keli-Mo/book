import Taro from "@tarojs/taro";
import { CLOUD_ENV_ID } from "@/cloud";
import { getReminderFunction, invalidateReminderSettings, isReminderAccountVerified, isReminderExplicitlyOff, isReminderTimeInFuture, readCachedReminderSettings } from "./reminderSettings";

const SUBSCRIPTION_ATTEMPT_KEY = "haisha:trial:tomorrow-subscribe-attempt:v1";
const PENDING_REGISTRATION_KEY = "haisha:trial:tomorrow-reminder-registration:v1";
const HOME_PENDING_REGISTRATION_KEY = "haisha:trial:home-tomorrow-reminder-registration:v1";
const SCHEDULED_STATUS_KEY = "haisha:trial:tomorrow-reminder-scheduled:v1";
const LEARNING_START_KEY = "haisha:trial:learning-start-reminders:v1";
const PREVIOUS_COMPLETION_KEY = "haisha:trial:previous-completion:v1";

type SavedAttempt = {
  version: 1;
  chinaDate: string;
  templateId: string;
  status: "accepted" | "declined";
};

type PendingRegistration = {
  version: 1;
  chinaDate: string;
  accepted: boolean;
  templateId: string;
  reminderTime: string;
};

type HomePendingRegistrationBase = {
  requestChinaDate: string;
  templateId: string;
  reminderTime: string;
};

type HomePendingRegistration =
  | (HomePendingRegistrationBase & { version: 1 })
  | (HomePendingRegistrationBase & { version: 2; requestId: string; nearestOnly?: true; targetDate?: string });

type LearningStart = HomePendingRegistrationBase & {
  status: "granted" | "pending" | "handled" | "declined";
};

type ScheduledStatus = {
  version: 1;
  requestChinaDate: string;
  templateId: string;
};

export type TomorrowSubscriptionDecision =
  | { status: "accepted"; templateId: string }
  | { status: "declined" | "unavailable" | "not-configured" | "disabled" | "already-scheduled" };

export interface CompletedReminderResult {
  todayRecorded: boolean;
  tomorrowScheduled: boolean;
  reason?: string;
}

export interface HomeReminderResult {
  requestProcessed: boolean;
  nextScheduled?: boolean;
  tomorrowScheduled?: boolean;
  reason?: string;
}

const templateId = () => (process.env.TARO_APP_DAILY_REMINDER_TEMPLATE_ID || "").trim();
export const isWechatReminderConfigured = () => Boolean(getReminderFunction()) && templateId().length > 0;
const CHINA_OFFSET_MS = 8 * 3600000;
const DAY_MS = 86400000;
const MIDNIGHT_GRACE_MS = 5 * 60000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;
let homeRequestSequence = 0;
const createHomeRequestId = () => {
  homeRequestSequence += 1;
  return `home_${Date.now().toString(36)}_${homeRequestSequence.toString(36)}_${Math.random().toString(36).slice(2).padEnd(10, "0")}`;
};
const chinaDayKey = (now = Date.now()) => new Date(now + CHINA_OFFSET_MS).toISOString().slice(0, 10);
const canRetryDate = (day: string, now = Date.now()) => day === chinaDayKey(now)
  || (day === chinaDayKey(now - DAY_MS) && (now + CHINA_OFFSET_MS) % DAY_MS < MIDNIGHT_GRACE_MS);
export const currentChinaDayKey = () => chinaDayKey();
const hasTomorrowReservation = (settings: ReturnType<typeof readCachedReminderSettings>, day: string) => {
  const tomorrow = chinaDayKey(Date.parse(`${day}T00:00:00+08:00`) + DAY_MS);
  return settings.tomorrowScheduledDate === tomorrow
    || (settings.nextStatus === "scheduled" && settings.nextDate === tomorrow);
};
const registrationKey = (item: PendingRegistration) =>
  `${item.chinaDate}:${item.accepted}:${item.templateId}:${item.reminderTime}`;
const registrationFlights = new Map<string, Promise<CompletedReminderResult>>();
const homeRegistrationFlights = new Map<string, Promise<HomeReminderResult>>();

const markTomorrowScheduled = (requestChinaDate: string, id: string): void => {
  try {
    const previous = Taro.getStorageSync(SCHEDULED_STATUS_KEY) as Partial<ScheduledStatus> | undefined;
    if (previous?.version === 1 && previous.templateId === id
      && typeof previous.requestChinaDate === "string"
      && previous.requestChinaDate > requestChinaDate) return;
    Taro.setStorageSync(SCHEDULED_STATUS_KEY, {
      version: 1, requestChinaDate, templateId: id,
    } satisfies ScheduledStatus);
  } catch { /* 云端登记结果仍有效；仅本地状态无法保留。 */ }
};

export const isTomorrowWechatReminderScheduled = (): boolean => {
  try {
    const value: unknown = Taro.getStorageSync(SCHEDULED_STATUS_KEY);
    if (!value || typeof value !== "object") return false;
    const status = value as Partial<ScheduledStatus>;
    return status.version === 1 && status.requestChinaDate === chinaDayKey()
      && status.templateId === templateId();
  } catch {
    return false;
  }
};

const readPendingRegistration = (storageKey = PENDING_REGISTRATION_KEY): PendingRegistration | null => {
  try {
    const value: unknown = Taro.getStorageSync(storageKey);
    if (!value || typeof value !== "object") return null;
    const item = value as Partial<PendingRegistration>;
    return item.version === 1 && typeof item.chinaDate === "string"
      && /^\d{4}-\d{2}-\d{2}$/.test(item.chinaDate)
      && typeof item.accepted === "boolean" && typeof item.templateId === "string"
      && typeof item.reminderTime === "string"
      && /^([01]\d|2[0-3]):[0-5]\d$/.test(item.reminderTime)
      ? item as PendingRegistration : null;
  } catch {
    return null;
  }
};

const savePendingRegistration = (item: PendingRegistration, storageKey = PENDING_REGISTRATION_KEY): void => {
  try { Taro.setStorageSync(storageKey, item); }
  catch { /* 网络请求仍继续；本机存储不可用时无法自动重试。 */ }
};

const clearPendingRegistration = (item: PendingRegistration, storageKey = PENDING_REGISTRATION_KEY): void => {
  const current = readPendingRegistration(storageKey);
  if (!current || registrationKey(current) !== registrationKey(item)) return;
  try { Taro.removeStorageSync(storageKey); }
  catch { /* 下次会按日期过滤，避免跨日误登记。 */ }
};

const readAttempt = (id: string, day: string): SavedAttempt | null => {
  try {
    const value: unknown = Taro.getStorageSync(SUBSCRIPTION_ATTEMPT_KEY);
    if (!value || typeof value !== "object") return null;
    const item = value as Partial<SavedAttempt>;
    return item.version === 1 && item.chinaDate === day && item.templateId === id
      && (item.status === "accepted" || item.status === "declined")
      ? item as SavedAttempt : null;
  } catch {
    return null;
  }
};

const saveAttempt = (id: string, status: SavedAttempt["status"], day: string): void => {
  try {
    Taro.setStorageSync(SUBSCRIPTION_ATTEMPT_KEY, {
      version: 1, chinaDate: day, templateId: id, status,
    } satisfies SavedAttempt);
  } catch { /* 存储不可用时仍以微信授权结果为准。 */ }
};

/** Call directly from the child's tap handler: WeChat requires a user gesture. */
export function requestTomorrowSubscription(forceNewRequest = false): Promise<TomorrowSubscriptionDecision> {
  const requestDay = chinaDayKey();
  const id = templateId();
  if (!isWechatReminderConfigured()) return Promise.resolve({ status: "not-configured" });
  const settings = readCachedReminderSettings();
  if (!isReminderAccountVerified() || (!forceNewRequest && !settings.enabled)) {
    return Promise.resolve({ status: "disabled" });
  }
  if (!forceNewRequest && hasTomorrowReservation(settings, requestDay)) {
    return Promise.resolve({ status: "already-scheduled" });
  }
  const previous = readAttempt(id, requestDay);
  if (previous && !forceNewRequest) return Promise.resolve(previous.status === "accepted"
    ? { status: "accepted", templateId: id }
    : { status: "declined" });
  if (process.env.TARO_ENV !== "weapp" || typeof Taro.requestSubscribeMessage !== "function") {
    return Promise.resolve({ status: "unavailable" });
  }
  try {
    // This call must happen before any await in the originating click handler.
    // Taro 4.0.12 incorrectly requires Alipay-only entityIds in this shared type.
    return Taro.requestSubscribeMessage({ tmplIds: [id] } as Parameters<typeof Taro.requestSubscribeMessage>[0])
      .then(result => {
        const status = result[id] === "accept" ? "accepted" : "declined";
        if (!forceNewRequest) saveAttempt(id, status, requestDay);
        return status === "accepted"
          ? { status: "accepted", templateId: id } as const
          : { status: "declined" } as const;
      })
      .catch(() => ({ status: "unavailable" } as const));
  } catch {
    return Promise.resolve({ status: "unavailable" });
  }
}

const sendRegistration = (item: PendingRegistration, storageKey = PENDING_REGISTRATION_KEY): Promise<CompletedReminderResult> => {
  const key = storageKey + registrationKey(item);
  const existing = registrationFlights.get(key);
  if (existing) return existing;
  const promise = invokeCloudRegistration(item).then((result) => {
    // 响应丢失时云端也可能已写入预约，下一次读取必须核对服务器状态。
    invalidateReminderSettings();
    // 云端已处理该次完成请求；模板配置错误等明确拒绝也不靠重复请求解决。
    if (result.todayRecorded) clearPendingRegistration(item, storageKey);
    if (result.tomorrowScheduled && item.templateId) markTomorrowScheduled(item.chinaDate, item.templateId);
    return result;
  }).finally(() => {
    if (registrationFlights.get(key) === promise) registrationFlights.delete(key);
  });
  registrationFlights.set(key, promise);
  return promise;
};

const readHomePendingRegistration = (): HomePendingRegistration | null => {
  try {
    const value: unknown = Taro.getStorageSync(HOME_PENDING_REGISTRATION_KEY);
    if (!value || typeof value !== "object") return null;
    const item = value as Partial<HomePendingRegistration>;
    const validBase = (item.version === 1 || item.version === 2) && typeof item.requestChinaDate === "string"
      && /^\d{4}-\d{2}-\d{2}$/.test(item.requestChinaDate)
      && typeof item.templateId === "string" && typeof item.reminderTime === "string"
      && /^([01]\d|2[0-3]):[0-5]\d$/.test(item.reminderTime);
    if (!validBase) return null;
    if (item.version === 2 && item.targetDate !== undefined
      && (typeof item.targetDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item.targetDate))) return null;
    if (item.version === 1 || ("requestId" in item && typeof item.requestId === "string"
      && REQUEST_ID_PATTERN.test(item.requestId))) {
      return item as HomePendingRegistration;
    }
    // Upgrade an earlier local draft once so retries of the same grant share one ID.
    const upgraded = { ...item, version: 2, requestId: createHomeRequestId() } as HomePendingRegistration;
    Taro.setStorageSync(HOME_PENDING_REGISTRATION_KEY, upgraded);
    return upgraded;
  } catch {
    return null;
  }
};

const homeRegistrationKey = (item: HomePendingRegistration) =>
  `${item.version}:${item.requestChinaDate}:${item.templateId}:${item.reminderTime}:${item.version === 2 ? item.requestId : ""}`;

const clearHomePendingRegistration = (item: HomePendingRegistration): void => {
  const current = readHomePendingRegistration();
  if (!current || homeRegistrationKey(current) !== homeRegistrationKey(item)) return;
  try { Taro.removeStorageSync(HOME_PENDING_REGISTRATION_KEY); }
  catch { /* 下次重试仍由云端幂等处理。 */ }
};

/** 关闭提醒后丢弃尚未确认的旧登记，避免回开时使用旧的点击授权。 */
export const discardPendingReminderRegistrations = (): void => {
  learningEpoch++;
  learningStarts = [];
  learningFlights.clear();
  learningConsentFlights.clear();
  const home = readHomePendingRegistration();
  if (home) clearHomePendingRegistration(home);
  const practice = readPendingRegistration();
  if (practice) clearPendingRegistration(practice);
  try {
    Taro.removeStorageSync(LEARNING_START_KEY);
    Taro.removeStorageSync(PREVIOUS_COMPLETION_KEY);
    Taro.removeStorageSync(SUBSCRIPTION_ATTEMPT_KEY);
    Taro.removeStorageSync(SCHEDULED_STATUS_KEY);
  } catch { /* 云端开关仍决定是否发送。 */ }
};

const invokeHomeRegistration = async (item: HomePendingRegistration, source?: "learningStart"): Promise<HomeReminderResult> => {
  const functionName = getReminderFunction();
  if (!functionName || !wx.cloud || !isReminderAccountVerified()) {
    return { requestProcessed: false, nextScheduled: false, tomorrowScheduled: false, reason: "CLOUD_UNAVAILABLE" };
  }
  try {
    const isNext = item.version === 2;
    const response = await wx.cloud.callFunction({
      name: functionName,
      config: { env: CLOUD_ENV_ID },
      data: {
        action: isNext ? "subscribeNext" : "subscribeTomorrow",
        settingsVersion: 1,
        requestChinaDate: item.requestChinaDate,
        accepted: true,
        templateId: item.templateId,
        reminderTime: item.reminderTime,
        ...(source ? { source } : {}),
        ...(item.version === 2 ? { requestId: item.requestId } : {}),
        ...(item.version === 2 && item.nearestOnly ? { nearestOnly: true } : {}),
        ...(item.version === 2 && item.targetDate ? { targetDate: item.targetDate } : {}),
      },
    });
    const result = response.result as {
      ok?: boolean;
      code?: string;
      data?: { requestProcessed?: boolean; nextScheduled?: boolean; tomorrowScheduled?: boolean; reason?: string };
    } | undefined;
    if (!result?.ok) return {
      requestProcessed: false,
      nextScheduled: false,
      tomorrowScheduled: false,
      reason: result?.code || "CLOUD_ERROR",
    };
    return {
      requestProcessed: result.data?.requestProcessed === true,
      ...(isNext
        ? { nextScheduled: result.data?.nextScheduled === true }
        : { tomorrowScheduled: result.data?.tomorrowScheduled === true }),
      reason: result.data?.reason,
    };
  } catch {
    return { requestProcessed: false, nextScheduled: false, tomorrowScheduled: false, reason: "CLOUD_ERROR" };
  }
};

const sendHomeRegistration = (item: HomePendingRegistration): Promise<HomeReminderResult> => {
  const key = homeRegistrationKey(item);
  const existing = homeRegistrationFlights.get(key);
  if (existing) return existing;
  const promise = invokeHomeRegistration(item).then((result) => {
    invalidateReminderSettings();
    if (result.requestProcessed || (item.version === 2 && item.targetDate
      && ["INVALID_TARGET_DATE", "REMINDER_TIME_PASSED", "RESERVATION_CHANGED"].includes(result.reason || ""))) {
      clearHomePendingRegistration(item);
    }
    if (result.tomorrowScheduled) markTomorrowScheduled(item.requestChinaDate, item.templateId);
    return result;
  }).finally(() => {
    if (homeRegistrationFlights.get(key) === promise) homeRegistrationFlights.delete(key);
  });
  homeRegistrationFlights.set(key, promise);
  return promise;
};

// 今日的授权与跨午夜宽限内的昨日授权独立保存，开关预约使用自己的回执。
let learningStarts: LearningStart[] | undefined;
let learningEpoch = 0;
const learningFlights = new Map<string, Promise<HomeReminderResult | null>>();
const learningConsentFlights = new Map<string, Promise<void>>();
const currentLearningStarts = (): LearningStart[] => {
  if (!learningStarts) {
    try {
      const saved: unknown = Taro.getStorageSync(LEARNING_START_KEY);
      learningStarts = Array.isArray(saved) ? saved.filter(item => item
        && typeof item.requestChinaDate === "string" && typeof item.templateId === "string"
        && /^([01]\d|2[0-3]):[0-5]\d$/.test(item.reminderTime)
        && ["granted", "pending", "handled", "declined"].includes(item.status)) : [];
    } catch { learningStarts = []; }
  }
  return learningStarts.filter(item => item.templateId === templateId() && canRetryDate(item.requestChinaDate));
};

const rememberLearningStart = (item: LearningStart): void => {
  learningStarts = currentLearningStarts().filter(old => old.requestChinaDate !== item.requestChinaDate);
  if (canRetryDate(item.requestChinaDate)) learningStarts.push(item);
  try { Taro.setStorageSync(LEARNING_START_KEY, learningStarts); }
  catch { /* 本次运行仍可使用同一条授权。 */ }
};

const canReserveOnStart = () => isWechatReminderConfigured() && isReminderAccountVerified()
  && readCachedReminderSettings().enabled;

// 开始跟读和完成录音共用当日微信授权。已授权但录音未保存时，不会自动提交预约。
const prepareLearningConsent = (day: string): Promise<void> => {
  const inFlight = learningConsentFlights.get(day);
  if (inFlight) return inFlight;
  if (currentLearningStarts().some(item => item.requestChinaDate === day)) return Promise.resolve();
  const settings = readCachedReminderSettings();
  if (hasTomorrowReservation(settings, day)) return Promise.resolve();
  for (const key of [PENDING_REGISTRATION_KEY, PREVIOUS_COMPLETION_KEY]) {
    const queued = readPendingRegistration(key);
    if (queued?.chinaDate === day && queued.accepted && queued.templateId === templateId()) {
      return Promise.resolve();
    }
  }
  const epoch = learningEpoch;
  const request = requestTomorrowSubscription(true).then(decision => {
    if (epoch !== learningEpoch || !canReserveOnStart() || !canRetryDate(day)
      || (decision.status !== "accepted" && decision.status !== "declined")) return;
    rememberLearningStart({
      requestChinaDate: day, templateId: templateId(), reminderTime: settings.time,
      status: decision.status === "accepted" ? "granted" : "declined",
    });
  }).finally(() => {
    if (learningConsentFlights.get(day) === request) learningConsentFlights.delete(day);
  });
  learningConsentFlights.set(day, request);
  return request;
};

const sendLearningStart = async (item: LearningStart): Promise<HomeReminderResult> => {
  const epoch = learningEpoch;
  const result = await invokeHomeRegistration({ ...item, version: 1 }, "learningStart");
  if (epoch === learningEpoch) {
    invalidateReminderSettings();
    if (result.requestProcessed || ["EXPIRED_REQUEST_DATE", "REMINDER_TIME_PASSED",
      "REMINDERS_DISABLED", "TEST_ACCOUNT_REQUIRED"].includes(result.reason || "")) {
      rememberLearningStart({ ...item, status: "handled" });
    }
  }
  return result;
};

const runLearningStart = (day: string, work: () => Promise<HomeReminderResult | null>) => {
  const existing = learningFlights.get(day);
  if (existing) return existing;
  // work 立即执行，首次申请必须保留原始点击手势。
  const flight = work().finally(() => {
    if (learningFlights.get(day) === flight) learningFlights.delete(day);
  });
  learningFlights.set(day, flight);
  return flight;
};

export function reserveTomorrowOnLearningStart(): Promise<HomeReminderResult | null> {
  if (!canReserveOnStart()) return Promise.resolve(null);
  const day = chinaDayKey();
  const epoch = learningEpoch;
  return runLearningStart(day, async () => {
    await prepareLearningConsent(day);
    if (epoch !== learningEpoch || !canReserveOnStart()) return null;
    const item = currentLearningStarts().find(candidate => candidate.requestChinaDate === day);
    if (item?.status === "pending") return sendLearningStart(item);
    if (item?.status !== "granted") return null;
    if (hasTomorrowReservation(readCachedReminderSettings(), day)) return null;
    const pending: LearningStart = { ...item, status: "pending" };
    rememberLearningStart(pending);
    return sendLearningStart(pending);
  });
}

export async function retryPendingLearningStartReminder(): Promise<HomeReminderResult | null> {
  if (!canReserveOnStart()) return null;
  const pending = currentLearningStarts().filter(item => item.status === "pending");
  const results = await Promise.all(pending.map(item =>
    runLearningStart(item.requestChinaDate, () => sendLearningStart(item))));
  return results.find(result => result !== null) || null;
}

/** 首页按钮得到微信授权后登记明日提醒，不会将今天标为已完成。 */
export function subscribeTomorrowFromHome(
  decision: Extract<TomorrowSubscriptionDecision, { status: "accepted" }>,
  requestChinaDate = chinaDayKey(),
  reminderTime = readCachedReminderSettings().time,
): Promise<HomeReminderResult> {
  const item: HomePendingRegistration = {
    version: 1,
    requestChinaDate,
    templateId: decision.templateId,
    reminderTime,
  };
  try { Taro.setStorageSync(HOME_PENDING_REGISTRATION_KEY, item); }
  catch { /* 当前请求仍继续；本地存储不可用时无法自动重试。 */ }
  return sendHomeRegistration(item);
}

/** 设置确认获得的授权只用于选定的日期，自动模式沿用最近一次未来提醒。 */
export function subscribeNextFromHome(
  decision: Extract<TomorrowSubscriptionDecision, { status: "accepted" }>,
  requestChinaDate = chinaDayKey(),
  reminderTime = readCachedReminderSettings().time,
  targetDate?: string,
): Promise<HomeReminderResult> {
  const item: HomePendingRegistration = {
    version: 2,
    nearestOnly: true,
    requestChinaDate,
    templateId: decision.templateId,
    reminderTime,
    requestId: createHomeRequestId(),
    ...(targetDate ? { targetDate } : {}),
  };
  try { Taro.setStorageSync(HOME_PENDING_REGISTRATION_KEY, item); }
  catch { /* 当前请求仍继续；本地存储不可用时无法自动重试。 */ }
  return sendHomeRegistration(item);
}

/** 首页重试仅针对手动订阅，和完成练习登记分开保存。 */
export function retryPendingHomeReminder(): Promise<HomeReminderResult | null> {
  if (!isReminderAccountVerified()) return Promise.resolve(null);
  if (isReminderExplicitlyOff()) {
    discardPendingReminderRegistrations();
    return Promise.resolve(null);
  }
  const pending = readHomePendingRegistration();
  if (!pending) return Promise.resolve(null);
  const now = Date.now();
  // 指定明天的授权跨午夜仍属于同一场提醒；只要所选时刻未过即可重试。
  const eligible = pending.version === 2 && pending.targetDate
    ? (pending.requestChinaDate === chinaDayKey(now)
      || (pending.requestChinaDate === chinaDayKey(now - DAY_MS) && pending.targetDate === chinaDayKey(now)))
      && isReminderTimeInFuture(pending.targetDate, pending.reminderTime, now)
    : canRetryDate(pending.requestChinaDate, now);
  if (!eligible) {
    clearHomePendingRegistration(pending);
    return Promise.resolve(null);
  }
  return sendHomeRegistration(pending);
}

const invokeCloudRegistration = async (item: PendingRegistration): Promise<CompletedReminderResult> => {
  const functionName = getReminderFunction();
  if (!functionName || !wx.cloud || !isReminderAccountVerified()) {
    return { todayRecorded: false, tomorrowScheduled: false, reason: "CLOUD_UNAVAILABLE" };
  }
  try {
    const response = await wx.cloud.callFunction({
      name: functionName,
      config: { env: CLOUD_ENV_ID },
      data: {
        action: "completeToday",
        settingsVersion: 1,
        completionChinaDate: item.chinaDate,
        accepted: item.accepted,
        templateId: item.templateId,
        reminderTime: item.reminderTime,
      },
    });
    const result = response.result as {
      ok?: boolean;
      code?: string;
      data?: { todayRecorded?: boolean; tomorrowScheduled?: boolean; reason?: string };
    } | undefined;
    if (!result?.ok) return {
      todayRecorded: false,
      tomorrowScheduled: false,
      reason: result?.code || "CLOUD_ERROR",
    };
    return {
      todayRecorded: result.data?.todayRecorded === true,
      tomorrowScheduled: result.data?.tomorrowScheduled === true,
      reason: result.data?.reason,
    };
  } catch {
    return { todayRecorded: false, tomorrowScheduled: false, reason: "CLOUD_ERROR" };
  }
};

/** 录音落盘后立即调用；返回 Promise 前同步保存待登记记录。 */
export function recordCompletedTaskAndTomorrowReminder(
  decision: TomorrowSubscriptionDecision,
  reminderTime = readCachedReminderSettings().time,
  completionChinaDate = chinaDayKey(),
): Promise<CompletedReminderResult> {
  const item: PendingRegistration = {
    version: 1,
    chinaDate: completionChinaDate,
    accepted: decision.status === "accepted",
    templateId: decision.status === "accepted" ? decision.templateId : "",
    reminderTime,
  };
  if (decision.status !== "not-configured") savePendingRegistration(item);
  return sendRegistration(item);
}

/** 保存完成后把今日核销和可用的明日授权放进同一条可重试记录。 */
export function recordLearningCompletion(completionChinaDate: string, grantedTemplateId?: string): Promise<CompletedReminderResult | null> {
  if (!canReserveOnStart() || !canRetryDate(completionChinaDate)) return Promise.resolve(null);
  const previous = readPendingRegistration();
  const older = readPendingRegistration(PREVIOUS_COMPLETION_KEY);
  const existing = previous?.chinaDate === completionChinaDate ? previous
    : older?.chinaDate === completionChinaDate ? older : null;
  const useMainSlot = existing ? existing === previous : completionChinaDate === chinaDayKey();
  const storageKey = useMainSlot ? PENDING_REGISTRATION_KEY : PREVIOUS_COMPLETION_KEY;
  if (existing && (existing.accepted || !grantedTemplateId)) return sendRegistration(existing, storageKey);
  if (!existing && useMainSlot && previous && canRetryDate(previous.chinaDate)) {
    savePendingRegistration(previous, PREVIOUS_COMPLETION_KEY);
  }
  const item: PendingRegistration = {
    version: 1, chinaDate: completionChinaDate, templateId: grantedTemplateId || "",
    reminderTime: readCachedReminderSettings().time, accepted: Boolean(grantedTemplateId),
  };
  savePendingRegistration(item, storageKey);
  return sendRegistration(item, storageKey);
}

/** 由「完成练习」的点击同步申请；只有录音落盘才核销今天并登记明天。 */
export async function reserveReminderOnLearningCompletion(
  day: string, recordingSaved: Promise<boolean>,
): Promise<CompletedReminderResult | null> {
  if (!canReserveOnStart() || !canRetryDate(day)) return null;
  const epoch = learningEpoch;
  const [, saved] = await Promise.all([prepareLearningConsent(day), recordingSaved.catch(() => false)]);
  if (!saved || epoch !== learningEpoch || !canReserveOnStart() || !canRetryDate(day)) return null;
  const grant = currentLearningStarts().find(item => item.requestChinaDate === day && item.status === "granted");
  const grantedTemplateId = hasTomorrowReservation(readCachedReminderSettings(), day) ? undefined : grant?.templateId;
  const result = recordLearningCompletion(day, grantedTemplateId);
  // recordLearningCompletion 已同步持久化登记，恢复时沿用相同日期和真实授权。
  if (grant) rememberLearningStart({ ...grant, status: "handled" });
  return result;
}

/** 首页重新出现时重试未登记的提醒；跨午夜五分钟内可补发昨日请求。 */
export function retryPendingTomorrowReminder(): Promise<CompletedReminderResult | null> {
  if (!isReminderAccountVerified()) return Promise.resolve(null);
  if (isReminderExplicitlyOff()) {
    discardPendingReminderRegistrations();
    return Promise.resolve(null);
  }
  const retries: Promise<CompletedReminderResult>[] = [];
  for (const storageKey of [PREVIOUS_COMPLETION_KEY, PENDING_REGISTRATION_KEY]) {
    const pending = readPendingRegistration(storageKey);
    if (!pending) continue;
    if (canRetryDate(pending.chinaDate)) retries.push(sendRegistration(pending, storageKey));
    else clearPendingRegistration(pending, storageKey);
  }
  if (retries.length > 1) return Promise.all(retries).then(results => results[results.length - 1]);
  return retries[0] || Promise.resolve(null);
}
