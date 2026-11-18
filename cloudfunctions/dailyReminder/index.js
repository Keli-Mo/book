/* eslint-disable import/no-commonjs */
const cloud = require("wx-server-sdk");
const packageName = require("./package.json").name;
if (!["daily-reminder", "daily-reminder-trial"].includes(packageName)) {
  throw new Error("Unknown reminder function package");
}
const trial = packageName === "daily-reminder-trial";
const collectionName = trial ? "dailyReminderTrialDeliveries" : "dailyReminderDeliveries";
const crypto = require("crypto");

const testerHashes = new Set((process.env.DAILY_REMINDER_TESTER_HASHES || "")
  .split(",").map(hash => hash.trim()).filter(hash => /^[a-f0-9]{64}$/.test(hash)));
const canUseReminders = openId => !trial || (typeof openId === "string"
  && testerHashes.has(crypto.createHash("sha256").update(openId).digest("hex")));

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database({ env: cloud.DYNAMIC_CURRENT_ENV, throwOnNotFound: false });
const deliveries = db.collection(collectionName);
const DAY_MS = 86400000;
const CHINA_OFFSET_MS = 8 * 3600000;
const MIDNIGHT_GRACE_MS = 5 * 60000;
const DISPATCH_INTERVAL_MS = 10 * 60000;
const BATCH_SIZE = 50;
const SEND_CONCURRENCY = 5;
const DISPATCH_WORK_MS = 20_000;
const DISPATCH_FINISH_RESERVE_MS = 10_000;
const FUNCTION_TIMEOUT_MS = 30_000;
const REMINDER_TIME = "09:00";
const PAGE = "pages/Home/Home";
const validTime = time => typeof time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
const validRequestId = id => typeof id === "string" && /^[A-Za-z0-9_-]{16,80}$/.test(id);

const chinaDate = now => new Date(now + CHINA_OFFSET_MS).toISOString().slice(0, 10);
const nextChinaDate = now => new Date(now + CHINA_OFFSET_MS + DAY_MS).toISOString().slice(0, 10);
const chinaDayStart = date => {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const start = Date.parse(`${date}T00:00:00+08:00`);
  return Number.isFinite(start) && chinaDate(start) === date ? start : null;
};
const idFor = (openId, date) => crypto.createHash("sha256").update(`${openId}:${date}`).digest("hex");
const settingsIdFor = openId => crypto.createHash("sha256").update(`dailyReminderSettings:${openId}`).digest("hex");
const receiptIdFor = (openId, requestId) => crypto.createHash("sha256")
  .update(`dailyReminderRequest:${openId}:${requestId}`).digest("hex");
const dueAt = (date, time) => Date.parse(`${date}T${time}:00+08:00`);
const canReplace = row => !row || ["disabled", "expired"].includes(row.status);
const movable = row => row?.status === "pending" && ["home", "manualDate"].includes(row.source);
const canBookToday = (today, settings, todayRow, tomorrowRow) => canReplace(todayRow)
  && settings?.lastCompletedDate !== today
  && (settings?.lastSendDate || (settings?.lastSentAtMs && chinaDate(settings.lastSentAtMs))) !== today
  // 旧版有时只保存完成后获得的明日预约，没有单独记录今日完成。
  && !(tomorrowRow?.status === "pending" && tomorrowRow.source === "practice");
const response = (data) => ({ ok: true, data });
const failure = (code) => ({ ok: false, code });

// 旧版可选 23:51 到 23:59，午夜是这些预约到期后的第一个整十分。
const canSendAfterMidnight = (row, now) => {
  const start = chinaDayStart(chinaDate(now));
  return now < start + DISPATCH_INTERVAL_MS && row.localDate === chinaDate(start - 1)
    && row.dueAtMs > start - DISPATCH_INTERVAL_MS && row.dueAtMs < start;
};

const reminderDoc = (source, openId, date) => source.collection(collectionName).doc(idFor(openId, date));
const settingsDoc = (source, openId) => source.collection(collectionName).doc(settingsIdFor(openId));
const receiptDoc = (source, openId, requestId) => source.collection(collectionName)
  .doc(receiptIdFor(openId, requestId));
const readStoredSettings = async (source, openId) => {
  const row = (await settingsDoc(source, openId).get()).data;
  return row?.status === "settings" && row.ownerOpenId === openId
    && typeof row.enabled === "boolean" && validTime(row.time) ? row : null;
};
const readReminder = async (source, openId, date) => {
  const row = (await reminderDoc(source, openId, date).get()).data;
  return row?.ownerOpenId === openId && row.localDate === date ? row : null;
};
const readReceipt = async (source, openId, requestId) => {
  const row = (await receiptDoc(source, openId, requestId).get()).data;
  return row?.status === "receipt" && row.ownerOpenId === openId && row.requestId === requestId
    ? row : null;
};

// The canonical day document remains the only dispatchable slot. Keep the old
// outcome before putting a newly authorised reminder in that same slot.
const archivePreviousOutcome = async (tx, row) => {
  if (!row || !["sent", "completed", "failed", "unknown"].includes(row.status)) return;
  const { _id, ...data } = row;
  const key = `history:${row.localDate}:${row.requestId || "legacy"}:${row.updatedAtMs || row.dueAtMs}`;
  await tx.collection(collectionName).doc(idFor(row.ownerOpenId, key)).set({ data });
};
const touchEnabledSettings = async (tx, openId, settings, time, now) => {
  const { _id, ...previousData } = settings || {};
  await settingsDoc(tx, openId).set({ data: {
    ...previousData,
    ownerOpenId: openId, status: "settings", enabled: true, time,
    createdAtMs: settings?.createdAtMs || now, updatedAtMs: now,
  } });
};

const getSettings = async openId => {
  const now = Date.now();
  const today = chinaDate(now);
  const tomorrow = nextChinaDate(now);
  const yesterday = chinaDate(now - DAY_MS);
  const [stored, todayRow, tomorrowRow, yesterdayRow] = await Promise.all([
    readStoredSettings(db, openId), readReminder(db, openId, today),
    readReminder(db, openId, tomorrow), readReminder(db, openId, yesterday),
  ]);
  const next = [todayRow, tomorrowRow].find(row => row?.status === "pending");
  const movableRow = [todayRow, tomorrowRow].find(movable);
  // Existing users may have a pending one-time reminder but no settings document yet.
  const enabled = stored?.enabled ?? Boolean(next);
  const time = stored?.time || next?.reminderTime || REMINDER_TIME;
  const last = stored && ["sent", "failed", "unknown"].includes(stored.lastSendStatus)
    ? { status: stored.lastSendStatus, lastSendCode: stored.lastSendCode }
    : [todayRow, yesterdayRow].find(row => ["sent", "failed", "unknown"].includes(row?.status));
  return {
    enabled, time,
    nextStatus: !enabled ? "off" : next ? "scheduled" : "needsConsent",
    ...(stored?.selectedDate === today || stored?.selectedDate === tomorrow
      ? { selectedDate: stored.selectedDate } : {}),
    ...(enabled && movableRow ? { movableDate: movableRow.localDate } : {}),
    ...(enabled && next ? { nextDate: next.localDate, scheduledTime: next.reminderTime } : {}),
    ...(enabled && tomorrowRow?.status === "pending" ? { tomorrowScheduledDate: tomorrow } : {}),
    ...(enabled && next === tomorrowRow && next?.status === "pending" && !movable(next)
      && canBookToday(today, stored, todayRow, tomorrowRow) ? { earlierAvailableDate: today } : {}),
    ...(last ? { lastSendStatus: last.status } : {}),
    ...(last && (typeof last.lastSendCode === "number" || typeof last.lastSendCode === "string")
      ? { lastSendCode: last.lastSendCode } : {}),
  };
};

const rescheduleSelectedDate = async (tx, openId, targetDate, time, target, other, now) => {
  const canMove = movable(other);
  if (!canMove && target?.status !== "pending") return;
  if (canMove) {
    const { _id, ...data } = other;
    await reminderDoc(tx, openId, other.localDate).set({ data: {
      ...data, status: "disabled", updatedAtMs: now,
    } });
  }
  // A practice reminder already on the chosen date keeps its next-day semantics.
  const keepTarget = target?.status === "pending";
  if (!keepTarget) await archivePreviousOutcome(tx, target);
  const { _id, ...kept } = keepTarget ? target : other;
  const source = keepTarget && !movable(target) ? {} : { source: "manualDate" };
  await reminderDoc(tx, openId, targetDate).set({ data: {
    ...kept, ...source, localDate: targetDate, reminderTime: time,
    dueAtMs: dueAt(targetDate, time), updatedAtMs: now,
  } });
};

const setSettings = async (event, openId) => {
  if (typeof event.enabled !== "boolean" || !validTime(event.time)) return failure("INVALID_ARGUMENT");
  const now = Date.now();
  const today = chinaDate(now);
  const tomorrow = nextChinaDate(now);
  const dated = event.targetDate !== undefined;
  if (dated && event.targetDate !== today && event.targetDate !== tomorrow) return failure("INVALID_TARGET_DATE");
  if (dated && event.enabled && dueAt(event.targetDate, event.time) <= now) return failure("REMINDER_TIME_PASSED");
  const error = await db.runTransaction(async tx => {
    const doc = settingsDoc(tx, openId);
    const previous = await readStoredSettings(tx, openId);
    const todayRow = await readReminder(tx, openId, today);
    const tomorrowRow = await readReminder(tx, openId, tomorrow);
    const yesterdayRow = !event.enabled && now < chinaDayStart(today) + DISPATCH_INTERVAL_MS
      ? await readReminder(tx, openId, chinaDate(now - DAY_MS)) : null;
    const target = event.targetDate === today ? todayRow : tomorrowRow;
    if (dated && event.enabled && target?.status === "sending") return "REMINDER_IN_PROGRESS";
    const previousData = { ...previous };
    delete previousData._id;
    if (!dated) delete previousData.selectedDate;
    await doc.set({ data: {
      ...previousData,
      ownerOpenId: openId, status: "settings", enabled: event.enabled, time: event.time,
      ...(dated ? { selectedDate: event.targetDate } : {}),
      createdAtMs: previous?.createdAtMs || now, updatedAtMs: now,
    } });
    if (event.enabled) {
      if (dated) {
        const other = event.targetDate === today ? tomorrowRow : todayRow;
        await rescheduleSelectedDate(tx, openId, event.targetDate, event.time, target, other, now);
        return;
      }
      const todayDueAt = dueAt(today, event.time);
      const tomorrowDueAt = dueAt(tomorrow, event.time);
      if (todayRow?.status === "pending" && (movable(todayRow) || event.reserveNext === true)
        && todayDueAt <= now && canReplace(tomorrowRow)) {
        const { _id, ...data } = todayRow;
        await reminderDoc(tx, openId, today).set({ data: {
          ...data, status: "expired", updatedAtMs: now,
        } });
        await reminderDoc(tx, openId, tomorrow).set({ data: {
          ...data, source: "home", localDate: tomorrow, reminderTime: event.time,
          dueAtMs: tomorrowDueAt, status: "pending", updatedAtMs: now,
        } });
        return;
      }
      if (movable(tomorrowRow)
        && todayDueAt > now && canBookToday(today, previous, todayRow, tomorrowRow)) {
        const { _id, ...data } = tomorrowRow;
        await reminderDoc(tx, openId, tomorrow).set({ data: {
          ...data, status: "disabled", updatedAtMs: now,
        } });
        await reminderDoc(tx, openId, today).set({ data: {
          ...data, source: "home", localDate: today, reminderTime: event.time,
          dueAtMs: todayDueAt, status: "pending", updatedAtMs: now,
        } });
        return;
      }
    }
    for (const row of [todayRow, tomorrowRow, yesterdayRow]) {
      if (!row || row.status !== "pending") continue;
      const date = row.localDate;
      const { _id, ...data } = row;
      if (!event.enabled) {
        await reminderDoc(tx, openId, date).set({ data: { ...data, status: "disabled", updatedAtMs: now } });
        continue;
      }
      const nextDueAt = dueAt(date, event.time);
      if (nextDueAt > now) {
        await reminderDoc(tx, openId, date).set({ data: {
          ...data, reminderTime: event.time, dueAtMs: nextDueAt, updatedAtMs: now,
        } });
      } else {
        // Do not unexpectedly deliver an overdue reminder after the user moves its time backwards.
        await reminderDoc(tx, openId, date).set({ data: { ...data, status: "expired", updatedAtMs: now } });
      }
    }
  });
  if (error) return failure(error);
  return response(await getSettings(openId));
};

// Only operator-controlled environment variables determine the template and its fields.
// Selected template fields: {"date5":"{{date}}","thing6":"今日英语练习待打卡","time23":"{{time}}"}
const templateConfig = () => {
  const templateId = process.env.DAILY_REMINDER_TEMPLATE_ID;
  if (typeof templateId !== "string" || !/^[A-Za-z0-9_-]{20,128}$/.test(templateId)) return null;
  let fields;
  try { fields = JSON.parse(process.env.DAILY_REMINDER_TEMPLATE_FIELDS_JSON || ""); }
  catch { return null; }
  if (!fields || Array.isArray(fields) || typeof fields !== "object") return null;
  const entries = Object.entries(fields);
  if (!entries.length || entries.length > 8 || entries.some(([key, value]) =>
    !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key) || typeof value !== "string" || value.length > 100)) return null;
  const state = trial ? "trial" : process.env.DAILY_REMINDER_MINIPROGRAM_STATE || "formal";
  if (!["formal", "trial", "developer"].includes(state)) return null;
  return { templateId, fields, state };
};
const renderData = (fields, date, time) => Object.fromEntries(Object.entries(fields).map(([key, raw]) => [
  key, { value: raw.replace(/\{\{date\}\}/g, date).replace(/\{\{time\}\}/g, time) },
]));
const safeErrorCode = value => {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?\d{1,6}$/.test(value)) return Number(value);
  return "UNKNOWN";
};

const completeToday = async (event, openId) => {
  const now = Date.now();
  if (!validTime(event.reminderTime) || typeof event.accepted !== "boolean") return failure("INVALID_ARGUMENT");
  const completedAtDayStart = chinaDayStart(event.completionChinaDate);
  if (completedAtDayStart === null) return failure("INVALID_COMPLETION_DATE");
  const serverTodayStart = chinaDayStart(chinaDate(now));
  const isToday = completedAtDayStart === serverTodayStart;
  const isRecentYesterday = completedAtDayStart === serverTodayStart - DAY_MS
    && now - serverTodayStart < MIDNIGHT_GRACE_MS;
  if (!isToday && !isRecentYesterday) return failure("EXPIRED_COMPLETION_DATE");
  const today = event.completionChinaDate;
  const tomorrow = nextChinaDate(completedAtDayStart);
  const config = templateConfig();
  const result = await db.runTransaction(async tx => {
    const settings = await readStoredSettings(tx, openId);
    const time = settings?.time || event.reminderTime;
    if (dueAt(tomorrow, time) <= now) return { error: "REMINDER_TIME_PASSED" };
    const todayDoc = tx.collection(collectionName).doc(idFor(openId, today));
    const todayRow = (await todayDoc.get()).data;
    const tomorrowDoc = tx.collection(collectionName).doc(idFor(openId, tomorrow));
    const existing = (await tomorrowDoc.get()).data;
    const legacyPending = !settings && [todayRow, existing].some(row =>
      row?.ownerOpenId === openId && row.status === "pending");
    // Earlier preview builds did not send settingsVersion. Preserve an accepted one-time
    // subscription from those builds while new builds default to an explicit OFF state.
    const enabled = settings?.enabled === true || legacyPending
      || (!settings && event.settingsVersion === undefined);
    const canSchedule = enabled && event.accepted && config && event.templateId === config.templateId;
    const reason = !enabled ? "REMINDERS_DISABLED"
      : event.accepted && !canSchedule ? "TEMPLATE_NOT_CONFIGURED" : undefined;
    if (enabled && (canSchedule || (settings && (!settings.lastCompletedDate || settings.lastCompletedDate < today)))) {
      const lastCompletedDate = settings?.lastCompletedDate > today ? settings.lastCompletedDate : today;
      await touchEnabledSettings(tx, openId, { ...settings, lastCompletedDate }, time, now);
    }
    const tomorrowAlreadyPending = existing?.ownerOpenId === openId && existing.status === "pending";
    if (tomorrowAlreadyPending && existing.source !== "practice") {
      const { _id, ...data } = existing;
      await tomorrowDoc.set({ data: { ...data, source: "practice", updatedAtMs: now } });
    }
    if (todayRow?.ownerOpenId === openId && todayRow.status === "pending"
      && !(todayRow.source === "manualDate" && settings?.lastCompletedDate === today)) {
      const { _id, ...data } = todayRow;
      await todayDoc.set({ data: { ...data, status: "completed", updatedAtMs: now } });
    }
    if (!canSchedule) return {
      todayRecorded: true, tomorrowScheduled: enabled && tomorrowAlreadyPending, reason,
    };
    if (existing?.ownerOpenId === openId && ["disabled", "expired"].includes(existing.status)) {
      const { _id, ...data } = existing;
      await tomorrowDoc.set({ data: {
        ...data, dueAtMs: dueAt(tomorrow, time), reminderTime: time, source: "practice",
        status: "pending", updatedAtMs: now,
      } });
      return { todayRecorded: true, tomorrowScheduled: true };
    }
    if (existing) {
      return {
        todayRecorded: true, tomorrowScheduled: tomorrowAlreadyPending,
        ...(tomorrowAlreadyPending ? {} : { reason: "ALREADY_HANDLED" }),
      };
    }
    await tomorrowDoc.set({ data: {
      ownerOpenId: openId, localDate: tomorrow, dueAtMs: dueAt(tomorrow, time),
      reminderTime: time, source: "practice", status: "pending", createdAtMs: now, updatedAtMs: now,
    } });
    return { todayRecorded: true, tomorrowScheduled: true };
  });
  return result.error ? failure(result.error) : response(result);
};

const subscribeTomorrow = async (event, openId, scheduleNext = false) => {
  const now = Date.now();
  const learningStart = !scheduleNext && event.settingsVersion === 1 && event.source === "learningStart";
  const dated = scheduleNext && event.targetDate !== undefined;
  if (scheduleNext && (event.settingsVersion !== 1 || !validRequestId(event.requestId))) {
    return failure("INVALID_ARGUMENT");
  }
  if (!validTime(event.reminderTime) || event.accepted !== true) return failure("INVALID_ARGUMENT");
  const requestedDayStart = chinaDayStart(event.requestChinaDate);
  if (requestedDayStart === null) return failure("INVALID_REQUEST_DATE");
  const tomorrow = nextChinaDate(requestedDayStart);
  if (dated && event.targetDate !== event.requestChinaDate && event.targetDate !== tomorrow) {
    return failure("INVALID_TARGET_DATE");
  }
  const serverTodayStart = chinaDayStart(chinaDate(now));
  const isToday = requestedDayStart === serverTodayStart;
  const isRecentYesterday = requestedDayStart === serverTodayStart - DAY_MS
    && now - serverTodayStart < MIDNIGHT_GRACE_MS;
  const retryForToday = dated && requestedDayStart === serverTodayStart - DAY_MS
    && event.targetDate === chinaDate(now);
  if (!isToday && !isRecentYesterday && !retryForToday) return failure("EXPIRED_REQUEST_DATE");
  const config = templateConfig();
  if (!config || event.templateId !== config.templateId) return failure("TEMPLATE_NOT_CONFIGURED");
  const scheduledResult = (scheduled, reason) => ({
    requestProcessed: true,
    ...(scheduleNext ? { nextScheduled: scheduled } : { tomorrowScheduled: scheduled }),
    ...(reason ? { reason } : {}),
  });
  const result = await db.runTransaction(async tx => {
    const settings = await readStoredSettings(tx, openId);
    const todayRow = settings && !scheduleNext ? null : await readReminder(tx, openId, event.requestChinaDate);
    const tomorrowRow = await readReminder(tx, openId, tomorrow);
    const receipt = scheduleNext ? await readReceipt(tx, openId, event.requestId) : null;
    if (receipt) {
      if (dated && receipt.targetDate !== event.targetDate) return { error: "REQUEST_ID_CONFLICT" };
      const stillPending = [todayRow, tomorrowRow].some(row =>
        row?.status === "pending" && (!dated || row.localDate === event.targetDate)
        && (row.requestId === event.requestId || (receipt.reusedExisting && receipt.targetDate === row.localDate
          && (!receipt.targetRequestId || receipt.targetRequestId === row.requestId))));
      return scheduledResult(stillPending, stillPending ? undefined : "ALREADY_HANDLED");
    }
    const legacyPending = !settings && [todayRow, tomorrowRow].some(row => row?.status === "pending");
    if (settings?.enabled !== true && !legacyPending
      && (settings || event.settingsVersion !== undefined)) return { error: "REMINDERS_DISABLED" };
    const time = settings?.time || event.reminderTime;
    if (dated && (settings?.selectedDate !== event.targetDate || time !== event.reminderTime)) {
      return { error: "RESERVATION_CHANGED" };
    }
    const useToday = dated ? event.targetDate === event.requestChinaDate
      : scheduleNext && isToday && dueAt(event.requestChinaDate, time) > now
      && (canBookToday(event.requestChinaDate, settings, todayRow, tomorrowRow)
        || (event.nearestOnly === true && todayRow?.status === "pending"));
    const targetDate = useToday ? event.requestChinaDate : tomorrow;
    const targetDueAt = dueAt(targetDate, time);
    if (targetDueAt <= now) return { error: "REMINDER_TIME_PASSED" };
    const targetDoc = tx.collection(collectionName).doc(idFor(openId, targetDate));
    const existing = useToday ? todayRow : tomorrowRow;
    const origin = scheduleNext ? { source: dated ? "manualDate" : "home", requestId: event.requestId }
      : learningStart ? { source: "learningStart" } : {};
    const saveReceipt = async (reusedExisting = false) => {
      if (!scheduleNext) return;
      await receiptDoc(tx, openId, event.requestId).set({ data: {
        ownerOpenId: openId, requestId: event.requestId, status: "receipt",
        targetDate, ...(reusedExisting ? { reusedExisting: true,
          ...(existing?.requestId ? { targetRequestId: existing.requestId } : {}) } : {}),
        createdAtMs: now, updatedAtMs: now,
      } });
    };
    await touchEnabledSettings(tx, openId, settings, time, now);
    if (existing?.ownerOpenId === openId && canReplace(existing)) {
      const { _id, ...data } = existing;
      await targetDoc.set({ data: {
        ...data, dueAtMs: targetDueAt, reminderTime: time,
        ...origin,
        status: "pending", updatedAtMs: now,
      } });
      await saveReceipt();
      return scheduledResult(true);
    }
    if (existing && dated && ["sent", "completed", "failed", "unknown"].includes(existing.status)) {
      await archivePreviousOutcome(tx, existing);
    } else if (existing) {
      const scheduled = existing.ownerOpenId === openId && existing.status === "pending";
      if (scheduled && learningStart && movable(existing)) {
        const { _id, ...data } = existing;
        await targetDoc.set({ data: { ...data, ...origin, updatedAtMs: now } });
      }
      await saveReceipt(scheduled && (dated || event.nearestOnly === true));
      return scheduledResult(scheduled, scheduled ? undefined : "ALREADY_HANDLED");
    }
    await targetDoc.set({ data: {
      ownerOpenId: openId, localDate: targetDate, dueAtMs: targetDueAt,
      reminderTime: time, ...origin,
      status: "pending", createdAtMs: now, updatedAtMs: now,
    } });
    await saveReceipt();
    return scheduledResult(true);
  });
  return result.error ? failure(result.error) : response(result);
};

const claim = async (id, now, deadline) => db.runTransaction(async tx => {
  if (Date.now() >= deadline) return null;
  const doc = tx.collection(collectionName).doc(id);
  const row = (await doc.get()).data;
  if (!row || row.status !== "pending" || row.dueAtMs > now || Date.now() >= deadline) return null;
  const settings = await readStoredSettings(tx, row.ownerOpenId);
  if (Date.now() >= deadline) return null;
  const { _id, ...data } = row;
  const status = !canUseReminders(row.ownerOpenId) || settings?.enabled === false ? "disabled"
    : row.localDate === chinaDate(now) || canSendAfterMidnight(row, now) ? "sending" : "expired";
  await doc.set({ data: { ...data, status, updatedAtMs: now } });
  return status === "sending" ? row : null;
});

const finishSend = async (id, status, now, lastSendCode) => db.runTransaction(async tx => {
  const doc = tx.collection(collectionName).doc(id);
  const row = (await doc.get()).data;
  if (!row || row.status !== "sending") return;
  const { _id, ...data } = row;
  await doc.set({ data: { ...data, status, lastSendCode, updatedAtMs: now } });
  const stored = await readStoredSettings(tx, row.ownerOpenId);
  if (stored) {
    const settingsData = { ...stored };
    delete settingsData._id;
    await settingsDoc(tx, row.ownerOpenId).set({ data: {
      ...settingsData, lastSendStatus: status, lastSendCode, lastSentAtMs: now, lastSendDate: row.localDate,
    } });
  }
});

const sendCandidate = async (candidate, config, summary, deadline) => {
  summary.examined++;
  const row = await claim(candidate._id, Date.now(), deadline);
  if (!row) return;
  const deliveryIdPrefix = typeof candidate._id === "string" ? candidate._id.slice(0, 12) : "UNKNOWN";
  // A sent message cannot be recalled. On an ambiguous SDK/network outcome the row
  // remains non-retryable, avoiding a second delivery or use of tomorrow's quota.
  let status = "unknown";
  let lastSendCode = "UNKNOWN";
  try {
    const sent = await cloud.openapi.subscribeMessage.send({
      touser: row.ownerOpenId,
      templateId: config.templateId,
      page: PAGE,
      data: renderData(config.fields, row.localDate, row.reminderTime),
      miniprogramState: config.state,
      lang: "zh_CN",
    });
    const errCode = safeErrorCode(sent?.errCode ?? sent?.errcode);
    lastSendCode = errCode;
    status = errCode === 0 ? "sent" : "failed";
    if (status === "failed") {
      console.error("每日提醒发送明确失败", { deliveryIdPrefix, errCode });
    }
  } catch (error) {
    lastSendCode = safeErrorCode(error?.errCode ?? error?.errcode);
    console.error("每日提醒发送结果不明", {
      deliveryIdPrefix,
      errCode: lastSendCode,
    });
  }
  await finishSend(candidate._id, status, Date.now(), lastSendCode);
  summary[status]++;
};

const sendDue = async (startedAtMs, runtimeContext) => {
  const config = templateConfig();
  if (!config) return failure("TEMPLATE_NOT_CONFIGURED");
  // Only the runtime's second argument can shorten the deployed 30-second limit.
  // Stop admitting work after 20 seconds and drain already claimed sends/writes.
  // SDK calls are not cancelable; the reserve is headroom, not a hard RPC deadline.
  const runtimeLimit = Number.isSafeInteger(runtimeContext?.time_limit_in_ms)
    && runtimeContext.time_limit_in_ms > 0
    ? Math.min(FUNCTION_TIMEOUT_MS, runtimeContext.time_limit_in_ms) : FUNCTION_TIMEOUT_MS;
  const deadline = startedAtMs + Math.min(DISPATCH_WORK_MS,
    Math.max(0, runtimeLimit - DISPATCH_FINISH_RESERVE_MS));
  const summary = { examined: 0, sent: 0, failed: 0, unknown: 0, budgetExhausted: false };
  const attempted = new Set();
  while (Date.now() < deadline) {
    const due = await deliveries.where({ status: "pending", dueAtMs: db.command.lte(startedAtMs) })
      .orderBy("dueAtMs", "asc").limit(BATCH_SIZE).get();
    if (!Array.isArray(due?.data)) return failure("DATABASE_ERROR");
    const candidates = due.data.filter(candidate => !attempted.has(candidate._id));
    if (!candidates.length) break;
    let next = 0;
    let databaseError = false;
    const worker = async () => {
      while (!databaseError && next < candidates.length && Date.now() < deadline) {
        const candidate = candidates[next++];
        attempted.add(candidate._id);
        try {
          await sendCandidate(candidate, config, summary, deadline);
        } catch (_) {
          // Drain other workers before returning. A failed final write leaves
          // this record in sending, so no later invocation blindly resends it.
          databaseError = true;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, candidates.length) }, worker));
    if (databaseError) {
      console.error("每日提醒数据库处理失败", summary);
      return failure("DATABASE_ERROR");
    }
    if (due.data.length < BATCH_SIZE) break;
    // Claimed rows leave pending. Requery the first page instead of offsetting,
    // which would skip rows as this invocation and overlapping timers drain it.
  }
  summary.budgetExhausted = Date.now() >= deadline;
  console.info("每日提醒发送批次", summary);
  return response(summary);
};

exports.main = async (event = {}, runtimeContext) => {
  const startedAtMs = Date.now();
  try {
    const context = cloud.getWXContext();
    if (context.SOURCE === "wx_trigger" && !context.OPENID) return await sendDue(startedAtMs, runtimeContext);
    if (!context.OPENID) return failure("FORBIDDEN");
    if (!canUseReminders(context.OPENID)) return failure("TEST_ACCOUNT_REQUIRED");
    if (trial && ["completeToday", "subscribeTomorrow", "subscribeNext"].includes(event.action)
      && event.settingsVersion !== 1) return failure("INVALID_ARGUMENT");
    if (event?.action === "getSettings") return response(await getSettings(context.OPENID));
    if (event?.action === "setSettings") return await setSettings(event, context.OPENID);
    if (event?.action === "completeToday") return await completeToday(event, context.OPENID);
    if (event?.action === "subscribeTomorrow") return await subscribeTomorrow(event, context.OPENID);
    if (event?.action === "subscribeNext") return await subscribeTomorrow(event, context.OPENID, true);
    return failure("FORBIDDEN");
  } catch (_) {
    console.error("每日提醒云函数失败", { code: "DAILY_REMINDER_ERROR" });
    return failure("DAILY_REMINDER_ERROR");
  }
};
