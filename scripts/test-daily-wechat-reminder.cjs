/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const serverSource = fs.readFileSync(path.join(__dirname, "../cloudfunctions/dailyReminder/index.js"), "utf8");
const clientSource = fs.readFileSync(path.join(__dirname, "../src/features/dailyReminder/wechatSubscription.ts"), "utf8");
const settingsSource = fs.readFileSync(path.join(__dirname, "../src/features/dailyReminder/reminderSettings.ts"), "utf8");
const TEMPLATE = "5bDl7Ao7kzSPmLXCHJZuHyy93dlzUNzZBQz-9TZz1TI";
const REMINDER_CONTENT = "今日英语练习待打卡";
const CHINA_2026_11_05 = Date.parse("2026-11-05T15:00:00+08:00");
const rowId = (openid, date) => crypto.createHash("sha256").update(`${openid}:${date}`).digest("hex");
const deliveryCount = harness => [...harness.records.values()].filter(row => typeof row.localDate === "string").length;
const enableReminders = async (harness, time = "09:00") => {
  assert.equal((await harness.main({ action: "setSettings", enabled: true, time })).ok, true);
};

function serverHarness(overrides = {}, trial = false) {
  const collectionName = trial ? "dailyReminderTrialDeliveries" : "dailyReminderDeliveries";
  const records = new Map();
  const clock = { now: CHINA_2026_11_05 };
  const context = { value: { SOURCE: "wx_client", OPENID: "parent-openid" } };
  const sent = [];
  const logs = [];
  const queries = [];
  let transactionTail = Promise.resolve();
  const env = {
    DAILY_REMINDER_TEMPLATE_ID: TEMPLATE,
    DAILY_REMINDER_TEMPLATE_FIELDS_JSON: JSON.stringify({ date5: "{{date}}", thing6: REMINDER_CONTENT, time23: "{{time}}" }),
    DAILY_REMINDER_MINIPROGRAM_STATE: "developer",
    ...overrides,
  };
  const clone = value => value === undefined ? undefined : structuredClone(value);
  const collection = () => ({
    doc(id) { return {
      async get() {
        if (overrides.beforeRead) await overrides.beforeRead(id, { clock, records });
        return { data: clone(records.get(id) || null) };
      },
      async set({ data }) {
        if (overrides.beforeWrite) await overrides.beforeWrite(id, data, { clock, records });
        records.set(id, { ...clone(data), _id: id });
      },
    }; },
    where(filter) { let take = Infinity; return {
      orderBy(key, direction) {
        assert.equal(key, "dueAtMs"); assert.equal(direction, "asc"); return this;
      },
      limit(n) { assert.ok(n > 0 && n <= 100); take = n; return this; },
      async get() {
        queries.push({ limit: take, now: clock.now });
        if (overrides.beforeQuery) await overrides.beforeQuery({ clock, records });
        return { data: [...records.values()].filter(row =>
        row.status === filter.status && row.dueAtMs <= filter.dueAtMs.lte)
        .sort((a, b) => a.dueAtMs - b.dueAtMs).slice(0, take).map(clone) }; },
    }; },
  });
  const db = {
    collection(name) { assert.equal(name, collectionName); return collection(); },
    command: { lte: value => ({ lte: value }) },
    runTransaction(callback) {
      // Model atomic claims when two timer invocations race for the same rows.
      const result = transactionTail.then(() => callback({ collection: name => {
        assert.equal(name, collectionName); return collection();
      } }));
      transactionTail = result.catch(() => {});
      return result;
    },
  };
  const cloud = {
    DYNAMIC_CURRENT_ENV: Symbol("env"),
    init() {},
    database() { return db; },
    getWXContext() { return context.value; },
    openapi: { subscribeMessage: { async send(args) {
      sent.push(args);
      if (overrides.onSend) return overrides.onSend(args, { clock, records });
      if (overrides.sendThrows) {
        const error = new Error("private SDK detail");
        if (overrides.throwCode !== undefined) error.errCode = overrides.throwCode;
        throw error;
      }
      return overrides.lowercaseCode
        ? { errcode: overrides.sendCode ?? 0 }
        : { errCode: overrides.sendCode ?? 0 };
    } } },
  };
  const FixedDate = class extends Date { static now() { return clock.now; } };
  const sandbox = { exports: {}, require: name => name === "wx-server-sdk" ? cloud
    : name === "./package.json" ? { name: trial ? "daily-reminder-trial" : "daily-reminder" } : require(name),
    process: { env }, Date: FixedDate, console: { info: (...args) => logs.push(args), error: (...args) => logs.push(args) } };
  vm.runInNewContext(serverSource, sandbox, { filename: "dailyReminder/index.js" });
  return { main: sandbox.exports.main, records, clock, context, sent, logs, env, queries };
}

const seedDueReminders = (h, count) => {
  for (let index = 0; index < count; index++) {
    const ownerOpenId = `queue-user-${index}`;
    const id = rowId(ownerOpenId, "2026-11-05");
    h.records.set(id, { _id: id, ownerOpenId, localDate: "2026-11-05",
      dueAtMs: h.clock.now - (count - index) * 1000, reminderTime: "15:00", status: "pending" });
  }
  h.context.value = { SOURCE: "wx_trigger" };
};

async function dispatchCapacityTests() {
  let active = 0;
  let peak = 0;
  const queue = serverHarness({ onSend: async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return { errCode: 0 };
  } });
  seedDueReminders(queue, 123);
  const batch = await queue.main();
  assert.equal(batch.ok, true);
  assert.equal(batch.data.sent, 123, "同一触发应继续分页清空超过 10 条的到期预约");
  assert.ok(queue.queries.length > 1, "数据库 limit 必须真实生效，并继续查询下一批");
  assert.ok(peak > 1 && peak <= 5, "微信发送应有并发，但不超过 5 个在途请求");
  assert.equal(active, 0, "云函数返回前必须等已开始的发送完成");
  await queue.main();
  assert.equal(queue.sent.length, 123, "再次触发不应重发已完成的记录");

  const slowQuery = serverHarness({ beforeQuery: ({ clock }) => { clock.now += 20_001; } });
  seedDueReminders(slowQuery, 23);
  const expired = await slowQuery.main();
  assert.equal(expired.data.budgetExhausted, true);
  assert.equal(slowQuery.sent.length, 0, "查询耗尽工作预算后不得开始 claim 或发送");
  assert.equal([...slowQuery.records.values()].filter(row => row.status === "pending").length, 23);

  const slowClaim = serverHarness({ beforeRead: (_id, { clock }) => { clock.now += 20_001; } });
  seedDueReminders(slowClaim, 23);
  assert.equal((await slowClaim.main()).data.budgetExhausted, true);
  assert.equal(slowClaim.sent.length, 0, "claim 的数据库读取耗尽预算后不能写 sending 或调微信");
  assert.equal([...slowClaim.records.values()].filter(row => row.status === "pending").length, 23);

  const slowSend = serverHarness({ onSend: async (_args, { clock }) => {
    await new Promise(resolve => setImmediate(resolve));
    clock.now += 20_001;
    return { errCode: 0 };
  } });
  seedDueReminders(slowSend, 23);
  const limited = await slowSend.main();
  assert.equal(limited.data.budgetExhausted, true);
  assert.ok(limited.data.sent > 0 && limited.data.sent <= 5);
  assert.equal([...slowSend.records.values()].some(row => row.status === "sending"), false,
    "预算耗尽仍须等待本轮已经 claim 的发送落库");
  assert.equal([...slowSend.records.values()].filter(row => row.status === "pending").length,
    23 - limited.data.sent, "未接手的预约留待后续触发");

  const shortRuntime = serverHarness();
  seedDueReminders(shortRuntime, 23);
  const short = await shortRuntime.main({ time_limit_in_ms: 999_999 }, { time_limit_in_ms: 5_000 });
  assert.equal(short.data.budgetExhausted, true);
  assert.equal(shortRuntime.queries.length, 0, "可信运行时不足收尾余量时不能启动查询；event 不能扩展预算");

  const race = serverHarness({ onSend: async () => {
    await new Promise(resolve => setImmediate(resolve));
    return { errCode: 0 };
  } });
  seedDueReminders(race, 23);
  const results = await Promise.all([race.main(), race.main()]);
  assert.ok(results.every(result => result.ok));
  assert.equal(race.sent.length, 23, "重叠触发必须靠事务 claim 避免重复发送");
  assert.equal(new Set(race.sent.map(item => item.touser)).size, 23);

  let failedWrite = false;
  let activeOnFailure = 0;
  const writeFailure = serverHarness({
    onSend: async () => {
      activeOnFailure++;
      await new Promise(resolve => setImmediate(resolve));
      activeOnFailure--;
      return { errCode: 0 };
    },
    beforeWrite: (_id, data) => {
      if (!failedWrite && data.status === "sent") {
        failedWrite = true;
        throw new Error("simulated final write failure");
      }
    },
  });
  seedDueReminders(writeFailure, 23);
  assert.equal((await writeFailure.main()).code, "DATABASE_ERROR");
  assert.equal(activeOnFailure, 0, "一条记录写入失败也必须等其他在途发送完成再返回");
  assert.equal([...writeFailure.records.values()].filter(row => row.status === "sending").length, 1);
  await writeFailure.main();
  assert.equal(writeFailure.sent.length, 23, "最后写入失败的已发送记录不可因后续触发再次发送");

  for (const outcome of ["failed", "unknown"]) {
    const h = serverHarness(outcome === "failed" ? { sendCode: 43101 } : { sendThrows: true });
    seedDueReminders(h, 123);
    assert.equal((await h.main()).data[outcome], 123);
    await h.main();
    assert.equal(h.sent.length, 123, "分页不能重新发送失败或结果未知的记录");
  }

  const tester = "queue-user-122";
  const isolated = serverHarness({ DAILY_REMINDER_TESTER_HASHES:
    crypto.createHash("sha256").update(tester).digest("hex") }, true);
  seedDueReminders(isolated, 123);
  assert.equal((await isolated.main()).data.sent, 1, "跨批次仍须逐条检查测试白名单");
  assert.equal(isolated.sent[0].touser, tester);
  assert.equal([...isolated.records.values()].filter(row => row.status === "disabled").length, 122);
}

async function serverTests() {
  const h = serverHarness();
  const accepted = { action: "completeToday", accepted: true, templateId: TEMPLATE,
    reminderTime: "09:00", completionChinaDate: "2026-11-05" };
  const legacyUnversioned = serverHarness();
  assert.equal((await legacyUnversioned.main(accepted)).data.tomorrowScheduled, true,
    "旧体验版请求没有版本标记时须保留已获授权的次日排期");
  assert.equal([...legacyUnversioned.records.values()].find(row => row.status === "settings")?.enabled, true,
    "旧版首次排期同时迁移为开启状态");
  const brandNew = serverHarness();
  assert.equal((await brandNew.main({ action: "getSettings" })).data.enabled, false);
  const unpromptedCompletion = await brandNew.main({ ...accepted, settingsVersion: 1 });
  assert.equal(unpromptedCompletion.data.tomorrowScheduled, false,
    "新用户尚未开启提醒时，完成练习不能自动开启");
  assert.equal(unpromptedCompletion.data.reason, "REMINDERS_DISABLED");
  assert.equal(brandNew.records.size, 0, "完成练习不应创建设置或提醒记录");
  assert.equal((await h.main({ action: "sendDue" })).code, "FORBIDDEN", "client cannot dispatch");
  assert.equal((await h.main({ SOURCE: "wx_trigger", action: "sendDue" })).code, "FORBIDDEN",
    "client event cannot spoof the timer source");
  assert.equal((await h.main({ ...accepted, reminderTime: "25:00" })).code, "INVALID_ARGUMENT");
  assert.equal((await h.main({ ...accepted, reminderTime: "19:99" })).code, "INVALID_ARGUMENT",
    "微信提醒时间必须是有效的 HH:mm");
  assert.equal((await h.main({ ...accepted, completionChinaDate: "2026-11-31" })).code,
    "INVALID_COMPLETION_DATE", "非法日历日期必须拒绝");
  assert.equal((await h.main({ ...accepted, completionChinaDate: "2026-11-04" })).code,
    "EXPIRED_COMPLETION_DATE", "过期的完成日期必须拒绝");
  await enableReminders(h);
  assert.equal((await h.main({ ...accepted, templateId: "wrong-template" })).data.reason,
    "TEMPLATE_NOT_CONFIGURED", "client cannot select a different server template");
  const first = await h.main(accepted);
  assert.equal(first.data.tomorrowScheduled, true);
  const tomorrowId = rowId("parent-openid", "2026-11-06");

  assert.equal(h.records.get(tomorrowId).dueAtMs, Date.parse("2026-11-06T09:00:00+08:00"));
  assert.equal((await h.main(accepted)).data.tomorrowScheduled, true, "repeat completion is idempotent");
  assert.equal(deliveryCount(h), 1);
  h.context.value = { SOURCE: "wx_trigger" };
  assert.equal((await h.main()).data.examined, 0, "全天触发，但尚未到期时不发送");
  h.clock.now = Date.parse("2026-11-06T09:00:00+08:00");
  const batch = await h.main();
  assert.equal(batch.data.sent, 1);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].touser, "parent-openid");
  assert.equal(h.sent[0].templateId, TEMPLATE);
  assert.equal(h.sent[0].data.date5.value, "2026-11-06");
  assert.equal(h.sent[0].data.thing6.value, REMINDER_CONTENT);
  assert.equal(h.sent[0].data.time23.value, "09:00");
  assert.equal(h.records.get(tomorrowId).status, "sent");
  await h.main();
  assert.equal(h.sent.length, 1, "timer retry does not duplicate delivery");

  const midnight = serverHarness();
  await enableReminders(midnight);
  midnight.clock.now = Date.parse("2026-11-05T23:59:59+08:00");
  await midnight.main(accepted);
  assert.equal(midnight.records.get(tomorrowId).localDate, "2026-11-06");
  midnight.clock.now = Date.parse("2026-11-06T00:00:01+08:00");
  assert.equal((await midnight.main(accepted)).data.tomorrowScheduled, true,
    "午夜后收到昨日完成请求仍应关联昨日的次日提醒");
  assert.equal(deliveryCount(midnight), 1, "跨午夜重试不应错误排到后天");
  assert.equal((await midnight.main({ ...accepted, completionChinaDate: "2026-11-06" })).data.tomorrowScheduled,
    true, "新一天的真实完成请求应排到后天");
  assert.equal(midnight.records.get(rowId("parent-openid", "2026-11-07")).localDate, "2026-11-07");

  const late = serverHarness();
  await enableReminders(late);
  late.clock.now = Date.parse("2026-11-05T23:59:59+08:00");
  await late.main(accepted);
  late.clock.now = Date.parse("2026-11-06T00:05:01+08:00");
  assert.equal((await late.main(accepted)).code, "EXPIRED_COMPLETION_DATE",
    "跨日宽限结束后不再接受昨日完成日期");
  assert.equal(late.records.get(tomorrowId).status, "pending",
    "过期完成请求不得取消新一天已存在的提醒");
  const canceled = serverHarness();
  await enableReminders(canceled);
  await canceled.main(accepted);
  canceled.clock.now = Date.parse("2026-11-06T08:00:00+08:00");
  await canceled.main({ action: "completeToday", accepted: false, templateId: "",
    reminderTime: "09:00", completionChinaDate: "2026-11-06" });
  assert.equal(canceled.records.get(tomorrowId).status, "completed");
  canceled.context.value = { SOURCE: "wx_trigger" };
  canceled.clock.now = Date.parse("2026-11-06T09:00:00+08:00");
  await canceled.main();
  assert.equal(canceled.sent.length, 0, "completed task receives no reminder");

  const stale = serverHarness();
  await enableReminders(stale);
  await stale.main(accepted);
  stale.context.value = { SOURCE: "wx_trigger" };
  stale.clock.now = Date.parse("2026-11-07T09:00:00+08:00");
  await stale.main();
  assert.equal(stale.records.get(tomorrowId).status, "expired");
  assert.equal(stale.sent.length, 0, "old reminders are not sent on the next day");

  const failed = serverHarness({ sendThrows: true });
  await enableReminders(failed);
  await failed.main(accepted);
  failed.context.value = { SOURCE: "wx_trigger" };
  failed.clock.now = Date.parse("2026-11-06T09:00:00+08:00");
  assert.equal((await failed.main()).data.unknown, 1);
  await failed.main();
  assert.equal(failed.sent.length, 1, "unknown send outcome is never retried blindly");
  assert.equal(failed.records.get(tomorrowId).status, "unknown");
  const unknownLog = failed.logs.find(([message]) => message === "每日提醒发送结果不明");
  assert.equal(unknownLog?.[1]?.deliveryIdPrefix, tomorrowId.slice(0, 12));
  assert.equal(unknownLog?.[1]?.errCode, "UNKNOWN");
  assert.doesNotMatch(JSON.stringify(failed.logs), /parent-openid|private SDK detail/,
    "诊断日志不得包含 OPENID 或异常原文");

  const explicitFailure = serverHarness({ sendCode: 43101 });
  await enableReminders(explicitFailure);
  await explicitFailure.main(accepted);
  explicitFailure.context.value = { SOURCE: "wx_trigger" };
  explicitFailure.clock.now = Date.parse("2026-11-06T09:00:00+08:00");
  assert.equal((await explicitFailure.main()).data.failed, 1);
  assert.equal(explicitFailure.records.get(tomorrowId).status, "failed");
  const failureLog = explicitFailure.logs.find(([message]) => message === "每日提醒发送明确失败");
  assert.equal(failureLog?.[1]?.deliveryIdPrefix, tomorrowId.slice(0, 12));
  assert.equal(failureLog?.[1]?.errCode, 43101);
  assert.doesNotMatch(JSON.stringify(explicitFailure.logs), /parent-openid|今日英语练习待打卡/,
    "诊断日志不得包含接收者或消息内容");

  const lowercase = serverHarness({ lowercaseCode: true });
  await enableReminders(lowercase);
  await lowercase.main(accepted);
  lowercase.context.value = { SOURCE: "wx_trigger" };
  lowercase.clock.now = Date.parse("2026-11-06T09:00:00+08:00");
  assert.equal((await lowercase.main()).data.sent, 1, "兼容云调用返回的小写错误码字段");

  const unconfigured = serverHarness({ DAILY_REMINDER_TEMPLATE_ID: "" });
  await enableReminders(unconfigured);
  const noTemplate = await unconfigured.main(accepted);
  assert.equal(noTemplate.data.tomorrowScheduled, false);
  assert.equal(noTemplate.data.reason, "TEMPLATE_NOT_CONFIGURED");
  unconfigured.context.value = { SOURCE: "wx_trigger" };
  assert.equal((await unconfigured.main()).code, "TEMPLATE_NOT_CONFIGURED");
  assert.equal(deliveryCount(unconfigured), 0);

  const home = serverHarness();
  const homeRequest = { action: "subscribeTomorrow", accepted: true, templateId: TEMPLATE,
    reminderTime: "09:00", requestChinaDate: "2026-11-05", settingsVersion: 1 };
  assert.equal((await home.main({ ...homeRequest, accepted: false })).code, "INVALID_ARGUMENT");
  assert.equal((await home.main({ ...homeRequest, reminderTime: "19:99" })).code, "INVALID_ARGUMENT");
  assert.equal((await home.main({ ...homeRequest, requestChinaDate: "2026-11-31" })).code,
    "INVALID_REQUEST_DATE");
  assert.equal((await home.main({ ...homeRequest, requestChinaDate: "2026-11-04" })).code,
    "EXPIRED_REQUEST_DATE");
  assert.equal((await home.main({ ...homeRequest, requestChinaDate: "2026-11-06" })).code,
    "EXPIRED_REQUEST_DATE", "future client date must not schedule an extra day");
  assert.equal((await home.main({ ...homeRequest, templateId: "wrong-template" })).code,
    "TEMPLATE_NOT_CONFIGURED");
  assert.equal(home.records.size, 0, "rejected Home requests do not create records");
  assert.equal((await home.main(homeRequest)).code, "REMINDERS_DISABLED",
    "未开启的新用户即使传来授权结果也不能预约");
  assert.equal(home.records.size, 0);
  const legacyHome = serverHarness();
  const { settingsVersion: _legacyMarker, ...oldHomeRequest } = homeRequest;
  assert.equal((await legacyHome.main(oldHomeRequest)).data.tomorrowScheduled, true,
    "旧体验版首页没有版本标记时沿用已获授权的排期");
  assert.equal([...legacyHome.records.values()].find(row => row.status === "settings")?.enabled, true);
  await enableReminders(home);
  const homeFirst = await home.main({ ...homeRequest, openId: "spoofed-openid" });
  assert.equal(homeFirst.data.requestProcessed, true);
  assert.equal(homeFirst.data.tomorrowScheduled, true);
  assert.equal(home.records.get(tomorrowId).ownerOpenId, "parent-openid",
    "only authenticated WX context controls the recipient");
  assert.equal(home.records.has(rowId("spoofed-openid", "2026-11-06")), false);
  assert.equal(home.records.has(rowId("parent-openid", "2026-11-05")), false,
    "Home subscription must not record today as completed");
  const homeState = (await home.main({ action: "getSettings" })).data;
  assert.equal(homeState.enabled, true);
  assert.equal(homeState.nextStatus, "scheduled");
  assert.equal(homeState.scheduledTime, "09:00");
  assert.equal((await home.main(homeRequest)).data.tomorrowScheduled, true);
  assert.equal(deliveryCount(home), 1, "repeated Home subscription is idempotent");
  home.context.value = { SOURCE: "wx_trigger" };
  home.clock.now = Date.parse("2026-11-06T09:00:00+08:00");
  assert.equal((await home.main()).data.sent, 1, "Home subscription is delivered by the timer");

  const keepToday = serverHarness();
  await enableReminders(keepToday);
  await keepToday.main(accepted);
  keepToday.clock.now = Date.parse("2026-11-06T08:00:00+08:00");
  const nextHomeRequest = { ...homeRequest, requestChinaDate: "2026-11-06" };
  assert.equal((await keepToday.main(nextHomeRequest)).data.tomorrowScheduled, true);
  assert.equal(keepToday.records.get(tomorrowId).status, "pending",
    "Home subscription must not cancel today's pending reminder");
  assert.equal(keepToday.records.get(rowId("parent-openid", "2026-11-07")).status, "pending");

  const homeMidnight = serverHarness();
  await enableReminders(homeMidnight);
  homeMidnight.clock.now = Date.parse("2026-11-05T23:59:59+08:00");
  await homeMidnight.main(homeRequest);
  homeMidnight.clock.now = Date.parse("2026-11-06T00:00:01+08:00");
  assert.equal((await homeMidnight.main(homeRequest)).data.tomorrowScheduled, true,
    "Home retry just after midnight keeps the original target date");
  assert.equal(deliveryCount(homeMidnight), 1);
  homeMidnight.clock.now = Date.parse("2026-11-06T00:05:01+08:00");
  assert.equal((await homeMidnight.main(homeRequest)).code, "EXPIRED_REQUEST_DATE");

  const homeUnconfigured = serverHarness({ DAILY_REMINDER_TEMPLATE_ID: "" });
  assert.equal((await homeUnconfigured.main(homeRequest)).code, "TEMPLATE_NOT_CONFIGURED");
  assert.equal(homeUnconfigured.records.size, 0);

  const legacy = serverHarness();
  const legacyTodayId = rowId("parent-openid", "2026-11-05");
  legacy.records.set(legacyTodayId, {
    _id: legacyTodayId, ownerOpenId: "parent-openid", localDate: "2026-11-05",
    status: "pending", reminderTime: "21:00", dueAtMs: Date.parse("2026-11-05T21:00:00+08:00"),
  });
  const legacyState = (await legacy.main({ action: "getSettings" })).data;
  assert.equal(legacyState.enabled, true, "已有旧版待发记录的用户应维持开启状态");
  assert.equal(legacyState.nextStatus, "scheduled");
  assert.equal((await legacy.main(homeRequest)).data.tomorrowScheduled, true,
    "旧版已预约用户仍可为次日登记新的微信授权");
  assert.equal(legacy.records.get(tomorrowId).status, "pending");
  assert.equal([...legacy.records.values()].find(row => row.status === "settings")?.enabled, true,
    "旧版用户下次登记时补建设置文档");

  const settings = serverHarness();
  assert.deepEqual(JSON.parse(JSON.stringify((await settings.main({ action: "getSettings" })).data)), {
    enabled: false, time: "09:00", nextStatus: "off",
  }, "无设置和待发记录时默认为关闭");
  assert.equal((await settings.main({ action: "setSettings", enabled: true, time: "25:00" })).code,
    "INVALID_ARGUMENT");
  assert.equal((await settings.main({ action: "setSettings", enabled: "true", time: "09:00" })).code,
    "INVALID_ARGUMENT");
  assert.equal((await settings.main({ action: "setSettings", enabled: true, time: "18:45",
    openId: "spoofed-openid" })).data.nextStatus, "needsConsent",
  "保存长期偏好不能制造微信消息额度");
  const settingsRow = [...settings.records.values()].find(row => row.status === "settings");
  assert.equal(settingsRow.ownerOpenId, "parent-openid", "设置必须归属微信上下文中的用户");
  assert.equal(settingsRow.time, "18:45");
  assert.equal((await settings.main(homeRequest)).data.tomorrowScheduled, true);
  assert.equal(settings.records.get(tomorrowId).dueAtMs, Date.parse("2026-11-06T18:45:00+08:00"),
    "服务器设置的时间覆盖客户端旧版 09:00 参数");
  const changed = await settings.main({ action: "setSettings", enabled: true, time: "07:20" });
  assert.equal(changed.data.nextStatus, "scheduled");
  assert.equal(changed.data.nextDate, "2026-11-06");
  assert.equal(changed.data.scheduledTime, "07:20");
  assert.equal(settings.records.get(tomorrowId).dueAtMs, Date.parse("2026-11-06T07:20:00+08:00"),
    "改时间时须同步修改未发送记录");
  settings.context.value = { SOURCE: "wx_trigger" };
  settings.clock.now = Date.parse("2026-11-06T07:19:59+08:00");
  assert.equal((await settings.main()).data.sent, 0);
  settings.clock.now = Date.parse("2026-11-06T07:20:00+08:00");
  assert.equal((await settings.main()).data.sent, 1, "全天定时器按用户时间发送");
  assert.equal(settings.sent[0].data.time23.value, "07:20");

  const switchOff = serverHarness();
  await switchOff.main({ action: "setSettings", enabled: true, time: "09:00" });
  await switchOff.main(homeRequest);
  assert.equal((await switchOff.main({ action: "setSettings", enabled: false, time: "09:00" })).data.nextStatus,
    "off");
  assert.equal(switchOff.records.get(tomorrowId).status, "disabled",
    "关闭开关应取消未发送消息");
  assert.equal((await switchOff.main(homeRequest)).code, "REMINDERS_DISABLED",
    "关闭后旧客户端也不能重新排期");
  const offCompletion = await switchOff.main(accepted);
  assert.equal(offCompletion.data.todayRecorded, true);
  assert.equal(offCompletion.data.tomorrowScheduled, false);
  assert.equal(offCompletion.data.reason, "REMINDERS_DISABLED");
  assert.equal((await switchOff.main({ action: "setSettings", enabled: true, time: "09:00" })).data.nextStatus,
    "needsConsent", "重新开启也不能凭旧授权恢复发送额度");
  assert.equal(switchOff.records.get(tomorrowId).status, "disabled");
  assert.equal((await switchOff.main(homeRequest)).data.tomorrowScheduled, true,
    "重新点击并获得订阅同意后可重排先前关闭的明日记录");
  assert.equal(switchOff.records.get(tomorrowId).status, "pending");
  await switchOff.main({ action: "setSettings", enabled: false, time: "09:00" });
  // Simulate a stale pending row racing with switch-off: claim must re-check the preference.
  switchOff.records.set(tomorrowId, { ...switchOff.records.get(tomorrowId), status: "pending" });
  switchOff.context.value = { SOURCE: "wx_trigger" };
  switchOff.clock.now = Date.parse("2026-11-06T09:00:00+08:00");
  await switchOff.main();
  assert.equal(switchOff.sent.length, 0);
  assert.equal(switchOff.records.get(tomorrowId).status, "disabled");

  const reopenFromPractice = serverHarness();
  await reopenFromPractice.main({ action: "setSettings", enabled: true, time: "09:00" });
  await reopenFromPractice.main(homeRequest);
  await reopenFromPractice.main({ action: "setSettings", enabled: false, time: "09:00" });
  await reopenFromPractice.main({ action: "setSettings", enabled: true, time: "17:30" });
  assert.equal((await reopenFromPractice.main(accepted)).data.tomorrowScheduled, true,
    "完成练习的新授权也可重新安排已关闭记录");
  assert.equal(reopenFromPractice.records.get(tomorrowId).reminderTime, "17:30");
  reopenFromPractice.records.set(tomorrowId, {
    ...reopenFromPractice.records.get(tomorrowId), status: "failed",
  });
  assert.equal((await reopenFromPractice.main(accepted)).data.tomorrowScheduled, false,
    "明确发送失败的记录不能因重复请求而重发");
  assert.equal(reopenFromPractice.records.get(tomorrowId).status, "failed");

  const movedPast = serverHarness();
  movedPast.clock.now = Date.parse("2026-11-04T15:00:00+08:00");
  await movedPast.main({ action: "setSettings", enabled: true, time: "17:00" });
  await movedPast.main({ ...homeRequest, requestChinaDate: "2026-11-04" });
  const todayDueId = rowId("parent-openid", "2026-11-05");
  movedPast.clock.now = Date.parse("2026-11-05T15:00:00+08:00");
  assert.equal((await movedPast.main({ action: "setSettings", enabled: true, time: "14:00" })).data.nextStatus,
    "needsConsent");
  assert.equal(movedPast.records.get(todayDueId).status, "expired",
    "改到已过去的时间不能立即补发");

  const exhausted = serverHarness({ sendCode: 43101 });
  await exhausted.main({ action: "setSettings", enabled: true, time: "09:00" });
  await exhausted.main(homeRequest);
  exhausted.context.value = { SOURCE: "wx_trigger" };
  exhausted.clock.now = Date.parse("2026-11-06T09:00:00+08:00");
  await exhausted.main();
  exhausted.context.value = { SOURCE: "wx_client", OPENID: "parent-openid" };
  const exhaustedState = (await exhausted.main({ action: "getSettings" })).data;
  assert.equal(exhaustedState.enabled, true);
  assert.equal(exhaustedState.nextStatus, "needsConsent");
  assert.equal(exhaustedState.lastSendStatus, "failed");
  assert.equal(exhaustedState.lastSendCode, 43101, "微信额度用尽的真实发送状态应可查询");
  exhausted.clock.now = Date.parse("2026-11-10T12:00:00+08:00");
  assert.equal((await exhausted.main({ action: "getSettings" })).data.lastSendCode, 43101,
    "发送失败状态应持久保存，不能过两天就忘记");
}

async function nextOccurrenceTests() {
  const request = { action: "subscribeNext", settingsVersion: 1, accepted: true,
    templateId: TEMPLATE, reminderTime: "15:23", requestChinaDate: "2026-11-05",
    requestId: "request-20261105-1523-abcde" };
  const todayId = rowId("parent-openid", "2026-11-05");
  const tomorrowId = rowId("parent-openid", "2026-11-06");

  const start = { ...request, action: "subscribeTomorrow", source: "learningStart" };
  const sameSetting = serverHarness();
  await enableReminders(sameSetting, "15:23");
  await sameSetting.main({ ...request, nearestOnly: true });
  const secondDevice = { ...request, nearestOnly: true, requestId: "setting-second-device-001" };
  assert.equal((await sameSetting.main(secondDevice)).data.nextScheduled, true);
  assert.equal((await sameSetting.main(secondDevice)).data.nextScheduled, true);
  assert.equal(sameSetting.records.has(tomorrowId), false, "两台设备同时设置最近一次时不应为第二个请求多排明天");

  const fixedTomorrow = serverHarness();
  await enableReminders(fixedTomorrow, "15:23");
  await fixedTomorrow.main(start);
  const fixed = (await fixedTomorrow.main({ action: "getSettings" })).data;
  assert.equal(fixed.earlierAvailableDate, "2026-11-05");
  assert.equal(fixed.tomorrowScheduledDate, "2026-11-06");
  await fixedTomorrow.main({ action: "setSettings", reserveNext: true, enabled: true, time: "20:00" });
  await fixedTomorrow.main(request);
  const both = (await fixedTomorrow.main({ action: "getSettings" })).data;
  assert.equal(both.nextDate, "2026-11-05");
  assert.equal(both.tomorrowScheduledDate, "2026-11-06");
  assert.equal(both.earlierAvailableDate, undefined);
  assert.equal(fixedTomorrow.records.get(tomorrowId).source, "learningStart");

  const finishedWithoutBooking = serverHarness();
  await enableReminders(finishedWithoutBooking, "09:00");
  await finishedWithoutBooking.main({ action: "completeToday", settingsVersion: 1,
    completionChinaDate: "2026-11-05", accepted: false, reminderTime: "09:00" });
  await finishedWithoutBooking.main({ action: "setSettings", reserveNext: true, enabled: true, time: "20:00" });
  await finishedWithoutBooking.main(request);
  assert.equal(finishedWithoutBooking.records.get(todayId), undefined, "当天练习已经完成，后来在设置补约只约明天");
  assert.equal(finishedWithoutBooking.records.get(tomorrowId).status, "pending");

  const oldPractice = serverHarness();
  oldPractice.clock.now -= 86400000;
  await enableReminders(oldPractice, "20:00");
  await oldPractice.main({ ...start, requestChinaDate: "2026-11-04" });
  oldPractice.clock.now += 86400000;
  const reused = (await oldPractice.main({ action: "setSettings", reserveNext: true, enabled: true, time: "09:00" })).data;
  assert.equal(reused.nextDate, "2026-11-06", "今天未发的授权可随设置顺延到明天");
  assert.equal(reused.scheduledTime, "09:00");
  assert.equal(oldPractice.records.get(todayId).status, "expired");
  assert.equal(oldPractice.records.get(tomorrowId).status, "pending");

  const learning = serverHarness();
  learning.clock.now = Date.parse("2026-11-05T15:21:00+08:00");
  await enableReminders(learning, "15:23");
  await learning.main(request);
  assert.equal((await learning.main(start)).data.tomorrowScheduled, true);
  assert.equal(learning.records.get(todayId).status, "pending", "开始跟读保留今天的预约");
  assert.equal(learning.records.get(tomorrowId).source, "learningStart");
  await learning.main({ action: "completeToday", settingsVersion: 1,
    completionChinaDate: "2026-11-05", accepted: false, reminderTime: "15:23" });
  assert.notEqual(learning.records.get(todayId).status, "pending");
  assert.equal(learning.records.get(tomorrowId).status, "pending", "真实完成练习只核销今天的预约");

  for (const disableFirst of [false, true]) {
    const revive = serverHarness();
    revive.clock.now = Date.parse("2026-11-05T15:25:00+08:00");
    await enableReminders(revive, "15:23");
    await revive.main(request);
    assert.equal(revive.records.get(tomorrowId).source, "home");
    if (disableFirst) {
      await revive.main({ action: "setSettings", enabled: false, time: "15:23" });
      assert.equal(revive.records.get(tomorrowId).status, "disabled");
      await enableReminders(revive, "15:23");
    }
    assert.equal((await revive.main(start)).data.tomorrowScheduled, true);
    assert.equal(revive.records.get(tomorrowId).source, "learningStart");
    const retimed = await revive.main({ action: "setSettings", enabled: true, time: "15:26" });
    assert.equal(retimed.data.nextDate, "2026-11-06", "跟读开始预约即使改时间仍只排在明天");
    assert.notEqual(revive.records.get(todayId)?.status, "pending");
  }

  const disabled = serverHarness();
  assert.equal((await disabled.main({ ...request, requestId: "short" })).code, "INVALID_ARGUMENT",
    "新版首页请求必须带稳定的幂等 ID");
  assert.equal((await disabled.main(request)).code, "REMINDERS_DISABLED",
    "新版首页未开启时不得凭订阅结果预约");
  const enabled = serverHarness();
  enabled.clock.now = Date.parse("2026-11-05T15:21:00+08:00");
  await enableReminders(enabled, "15:23");
  const first = await enabled.main(request);
  assert.equal(first.ok, true, "新版首页申请下一次提醒应被处理");
  assert.equal(first.data.nextScheduled, true);
  assert.equal(enabled.records.get(todayId)?.localDate, "2026-11-05",
    "所选时间今天还未到时，首条应预约今天");
  assert.equal(enabled.records.get(todayId)?.dueAtMs, Date.parse("2026-11-05T15:23:00+08:00"));
  assert.equal(enabled.records.get(todayId)?.source, "home");
  assert.equal(enabled.records.has(tomorrowId), false);
  assert.equal((await enabled.main({ action: "getSettings" })).data.nextDate, "2026-11-05");
  assert.equal((await enabled.main(request)).data.nextScheduled, true,
    "重复请求不应把同一次授权同时排到明天");
  assert.equal(deliveryCount(enabled), 1);
  const secondRequest = { ...request, requestId: "request-20261105-1523-other" };
  assert.equal((await enabled.main(secondRequest)).data.nextScheduled, true,
    "今天已有一条时，新授权应预约明天");
  assert.equal(enabled.records.get(tomorrowId)?.status, "pending");
  enabled.context.value = { SOURCE: "wx_trigger" };
  enabled.clock.now = Date.parse("2026-11-05T15:23:00+08:00");
  assert.equal((await enabled.main()).data.sent, 1, "全天触发器应在今天设定时间发送");
  assert.equal(enabled.sent[0].data.date5.value, "2026-11-05");
  enabled.context.value = { SOURCE: "wx_client", OPENID: "parent-openid" };
  const sentRetry = await enabled.main(request);
  assert.equal(sentRetry.data.nextScheduled, false,
    "今日已发送后重试同一次授权，不得再排明天");
  assert.equal(deliveryCount(enabled), 2,
    "旧请求重试不得生成第三天的待发记录");

  const afterTime = serverHarness();
  afterTime.clock.now = Date.parse("2026-11-05T15:24:00+08:00");
  await enableReminders(afterTime, "15:23");
  assert.equal((await afterTime.main(request)).data.nextScheduled, true);
  assert.equal(afterTime.records.has(todayId), false);
  assert.equal(afterTime.records.get(tomorrowId)?.localDate, "2026-11-06",
    "所选时间已过则预约明天");
  afterTime.clock.now = Date.parse("2026-11-06T00:00:01+08:00");
  assert.equal((await afterTime.main(request)).data.nextScheduled, true,
    "跨午夜重试同一授权仍指向原预约日期");
  assert.equal(deliveryCount(afterTime), 1);

  const prior = serverHarness();
  prior.clock.now = Date.parse("2026-11-04T08:00:00+08:00");
  await enableReminders(prior, "09:00");
  assert.equal((await prior.main({ ...request, action: "subscribeTomorrow", requestChinaDate: "2026-11-04",
    reminderTime: "09:00" })).data.tomorrowScheduled, true);
  prior.context.value = { SOURCE: "wx_trigger" };
  prior.clock.now = Date.parse("2026-11-05T09:00:00+08:00");
  assert.equal((await prior.main()).data.sent, 1);
  prior.context.value = { SOURCE: "wx_client", OPENID: "parent-openid" };
  prior.clock.now = Date.parse("2026-11-05T15:21:00+08:00");
  await prior.main({ action: "setSettings", enabled: true, time: "15:23" });
  assert.equal((await prior.main(request)).data.nextScheduled, true);
  assert.equal(prior.records.get(todayId).status, "sent",
    "同一日已发送的记录不可重新发送");
  assert.equal(prior.records.get(tomorrowId)?.status, "pending");

  const homeMovedLater = serverHarness();
  homeMovedLater.clock.now = Date.parse("2026-11-05T15:21:00+08:00");
  await enableReminders(homeMovedLater, "15:23");
  await homeMovedLater.main(request);
  assert.equal((await homeMovedLater.main({ action: "setSettings", enabled: true, time: "15:20" })).data.nextDate,
    "2026-11-06", "今天的时间改到已过去时，首页订阅应改约明天而不是白白失效");
  assert.notEqual(homeMovedLater.records.get(todayId)?.status, "pending");
  assert.equal(homeMovedLater.records.get(tomorrowId)?.status, "pending");
  assert.equal(homeMovedLater.records.get(tomorrowId)?.source, "home");
  assert.equal(homeMovedLater.records.get(tomorrowId)?.requestId, request.requestId,
    "调时移动时保留幂等 ID");
  assert.equal(homeMovedLater.records.get(tomorrowId)?.dueAtMs,
    Date.parse("2026-11-06T15:20:00+08:00"));
  assert.equal((await homeMovedLater.main(request)).data.nextScheduled, true,
    "调时移动后的旧请求重试只能返回既有明日预约");
  assert.equal(deliveryCount(homeMovedLater), 2, "重试不得生成额外日期的待发记录");

  const homeMovedSooner = serverHarness();
  homeMovedSooner.clock.now = Date.parse("2026-11-05T15:24:00+08:00");
  await enableReminders(homeMovedSooner, "15:23");
  await homeMovedSooner.main(request);
  assert.equal((await homeMovedSooner.main({ action: "setSettings", enabled: true, time: "15:26" })).data.nextDate,
    "2026-11-05", "明日首页订阅调到今天尚未来到的时间时应前移");
  assert.equal(homeMovedSooner.records.get(todayId)?.status, "pending");
  assert.equal(homeMovedSooner.records.get(todayId)?.source, "home");
  assert.notEqual(homeMovedSooner.records.get(tomorrowId)?.status, "pending",
    "一次授权重排后不得同时保留明日待发记录");

  const practiceStaysTomorrow = serverHarness();
  practiceStaysTomorrow.clock.now = Date.parse("2026-11-05T15:24:00+08:00");
  await enableReminders(practiceStaysTomorrow, "15:23");
  await practiceStaysTomorrow.main({ action: "completeToday", settingsVersion: 1, accepted: true,
    templateId: TEMPLATE, reminderTime: "15:23", completionChinaDate: "2026-11-05" });
  assert.equal(practiceStaysTomorrow.records.get(tomorrowId)?.source, "practice");
  assert.equal((await practiceStaysTomorrow.main({ action: "setSettings", enabled: true, time: "15:26" })).data.nextDate,
    "2026-11-06", "完成练习后的次日提醒不能因调时间而前移到今天");
  assert.equal(practiceStaysTomorrow.records.has(todayId), false);

  const homeThenPractice = serverHarness();
  homeThenPractice.clock.now = Date.parse("2026-11-05T15:24:00+08:00");
  await enableReminders(homeThenPractice, "15:23");
  await homeThenPractice.main(request);
  assert.equal(homeThenPractice.records.get(tomorrowId)?.source, "home");
  assert.equal((await homeThenPractice.main({ action: "completeToday", settingsVersion: 1,
    accepted: true, templateId: TEMPLATE, reminderTime: "15:23",
    completionChinaDate: "2026-11-05" })).data.tomorrowScheduled, true);
  assert.equal(homeThenPractice.records.get(tomorrowId)?.source, "practice",
    "完成练习后复用已有明日记录，也必须保持练习次日语义");
  assert.equal((await homeThenPractice.main({ action: "setSettings", enabled: true,
    time: "15:26" })).data.nextDate, "2026-11-06",
  "完成练习后的记录不应再被首页调时规则前移到今天");

  const homeThenDeclinedPractice = serverHarness();
  homeThenDeclinedPractice.clock.now = Date.parse("2026-11-05T15:24:00+08:00");
  await enableReminders(homeThenDeclinedPractice, "15:23");
  await homeThenDeclinedPractice.main(request);
  assert.equal(homeThenDeclinedPractice.records.get(tomorrowId)?.source, "home");
  const declinedCompletion = await homeThenDeclinedPractice.main({ action: "completeToday", settingsVersion: 1,
    accepted: false, templateId: "", reminderTime: "15:23",
    completionChinaDate: "2026-11-05" });
  assert.equal(declinedCompletion.data.todayRecorded, true);
  assert.equal(declinedCompletion.data.tomorrowScheduled, true,
    "拒绝本次授权不应隐瞒此前已预约的明日提醒");
  assert.equal(homeThenDeclinedPractice.records.get(tomorrowId)?.source, "practice",
    "完成练习即使此次订阅被拒绝，已有明日提醒也应保持次日语义");
  assert.equal((await homeThenDeclinedPractice.main({ action: "setSettings", enabled: true,
    time: "15:26" })).data.nextDate, "2026-11-06");

  const overwritten = serverHarness();
  overwritten.clock.now = Date.parse("2026-11-05T15:21:00+08:00");
  await enableReminders(overwritten, "15:23");
  await overwritten.main(request);
  await overwritten.main({ action: "setSettings", enabled: false, time: "15:23" });
  await overwritten.main({ action: "setSettings", enabled: true, time: "15:23" });
  await overwritten.main(secondRequest);
  assert.equal(overwritten.records.get(todayId)?.requestId, secondRequest.requestId);
  const beforeOldRetry = deliveryCount(overwritten);
  assert.equal((await overwritten.main(request)).data.requestProcessed, true,
    "旧行被新授权覆盖后，独立 receipt 仍识别旧请求");
  assert.equal(deliveryCount(overwritten), beforeOldRetry);
  assert.equal(overwritten.records.has(tomorrowId), false,
    "旧请求重试不得另排明天");
}

async function trialIsolationTest() {
  const tester = "parent-openid";
  const hash = crypto.createHash("sha256").update(tester).digest("hex");
  const h = serverHarness({ DAILY_REMINDER_TESTER_HASHES: hash }, true);
  const stranger = "other-account";
  const date = "2026-11-05";
  const pending = { action: "subscribeNext", settingsVersion: 1, requestId: "trial_request_00001",
    requestChinaDate: date, accepted: true, templateId: TEMPLATE, reminderTime: "16:00" };
  await enableReminders(h, "16:00");
  assert.equal((await h.main(pending)).data.nextScheduled, true);
  h.context.value.OPENID = stranger;
  for (const action of ["getSettings", "setSettings", "subscribeNext", "completeToday"]) {
    assert.equal((await h.main({ ...pending, action, OPENID: tester, channel: "release" })).code,
      "TEST_ACCOUNT_REQUIRED");
  }
  h.records.set(rowId(stranger, date), { ...h.records.get(rowId(tester, date)),
    _id: rowId(stranger, date), ownerOpenId: stranger });
  h.context.value = { SOURCE: "wx_trigger" };
  h.clock.now += 3600000;
  assert.equal((await h.main({})).data.sent, 1);
  assert.equal(h.sent[0].touser, tester);
  assert.equal(h.sent[0].miniprogramState, "trial");
  assert.equal(h.records.get(rowId(stranger, date)).status, "disabled");
  const empty = serverHarness({}, true);
  assert.equal((await empty.main({ action: "getSettings" })).code, "TEST_ACCOUNT_REQUIRED");
}

async function clientTests() {
  let requestCount = 0, resolveRequest;
  const storage = new Map();
  const clock = { now: CHINA_2026_11_05 };
  let cloudMode = "success";
  const cloudCalls = [];
  let serverSettings = { enabled: true, time: "09:00", nextStatus: "needsConsent" };
  const taro = { requestSubscribeMessage() { requestCount++;
    return new Promise(resolve => { resolveRequest = resolve; }); },
    getStorageSync(key) { return storage.get(key); },
    setStorageSync(key, value) { storage.set(key, value); },
    removeStorageSync(key) { storage.delete(key); },
  };
  const compiled = ts.transpileModule(clientSource, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020 } }).outputText;
  const FixedDate = class extends Date { static now() { return clock.now; } };
  const wxMock = { getAccountInfoSync: () => ({ miniProgram: { envVersion: "trial" } }), cloud: { async callFunction(args) { cloudCalls.push(args);
    if (cloudMode === "failure") throw new Error("offline");
    if (args.data.action === "getSettings") {
      return { result: { ok: true, data: serverSettings } };
    }
    if (args.data.action === "setSettings") {
      serverSettings = { enabled: args.data.enabled, time: args.data.time,
        nextStatus: args.data.enabled ? "needsConsent" : "off" };
      return { result: { ok: true, data: serverSettings } };
    }
    return { result: { ok: true,
      data: args.data.action === "subscribeTomorrow"
        ? { requestProcessed: true, tomorrowScheduled: true }
        : { todayRecorded: true, tomorrowScheduled: serverSettings.enabled } } };
  } } };
  const settingsCompiled = ts.transpileModule(settingsSource, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
  } }).outputText;
  const settingsSandbox = { exports: {}, require: name => name === "@tarojs/taro" ? { default: taro }
    : name === "@/cloud" ? { CLOUD_ENV_ID: "test-env" }
    : name === "./calendarReminder" ? { DEFAULT_DAILY_REMINDER_TIME: "09:00" }
    : require(name), Date: FixedDate, wx: wxMock };
  vm.runInNewContext(settingsCompiled, settingsSandbox, { filename: "reminderSettings.ts" });
  const sandbox = { exports: {}, require: name => name === "@tarojs/taro" ? { default: taro }
    : name === "@/cloud" ? { CLOUD_ENV_ID: "test-env" }
    : name === "./reminderSettings" ? settingsSandbox.exports
    : require(name),
    process: { env: { TARO_ENV: "weapp", TARO_APP_DAILY_REMINDER_TEMPLATE_ID: TEMPLATE } },
    Date: FixedDate,
    wx: wxMock };
  vm.runInNewContext(compiled, sandbox, { filename: "wechatSubscription.ts" });
  assert.equal((await sandbox.exports.requestTomorrowSubscription()).status, "disabled",
    "尚未恢复服务器开关时练习不能自行弹订阅授权");
  assert.equal(requestCount, 0);
  assert.equal((await settingsSandbox.exports.getReminderSettings()).settings.enabled, true,
    "读取已开启的服务器偏好后方可继续订阅");
  cloudCalls.length = 0;
  const decisionPromise = sandbox.exports.requestTomorrowSubscription();
  assert.equal(requestCount, 1, "subscribe API is called synchronously in the tap handler");
  assert.equal(cloudCalls.length, 0, "no server registration before local completion");
  resolveRequest({ [TEMPLATE]: "accept" });
  const decision = await decisionPromise;
  assert.equal(decision.status, "accepted");
  assert.equal((await sandbox.exports.requestTomorrowSubscription()).status, "accepted");
  assert.equal(requestCount, 1, "same-day acceptance is reused without asking again");
  const firstRegistration = sandbox.exports.recordCompletedTaskAndTomorrowReminder(decision);
  const pendingKey = "haisha:trial:tomorrow-reminder-registration:v1";
  assert.equal(storage.get(pendingKey).chinaDate, "2026-11-05",
    "registration is saved synchronously before the network request settles");
  await firstRegistration;
  assert.equal(storage.has(pendingKey), false, "confirmed cloud registration clears the pending record");
  assert.equal(cloudCalls[0].data.action, "completeToday");
  assert.equal(cloudCalls[0].data.accepted, true);
  assert.equal(cloudCalls[0].data.reminderTime, "09:00");
  assert.match(cloudCalls[0].data.completionChinaDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(cloudCalls[0].config.env, "test-env");

  cloudMode = "failure";
  assert.equal((await sandbox.exports.recordCompletedTaskAndTomorrowReminder(decision)).todayRecorded, false);
  assert.equal(storage.has(pendingKey), true, "network failure retains the pending registration");
  cloudMode = "success";
  const beforeRetry = cloudCalls.length;
  const retryOne = sandbox.exports.retryPendingTomorrowReminder();
  const retryTwo = sandbox.exports.retryPendingTomorrowReminder();
  assert.equal(retryOne, retryTwo, "repeated Home show shares the in-flight request");
  assert.equal((await retryOne).tomorrowScheduled, true);
  assert.equal(cloudCalls.length, beforeRetry + 1);
  assert.equal(storage.has(pendingKey), false);

  clock.now = Date.parse("2026-11-05T23:59:59+08:00");
  const clickDay = sandbox.exports.currentChinaDayKey();
  clock.now = Date.parse("2026-11-06T00:00:01+08:00");
  cloudMode = "failure";
  await sandbox.exports.recordCompletedTaskAndTomorrowReminder(decision, "09:00", clickDay);
  assert.equal(storage.get(pendingKey).chinaDate, "2026-11-05",
    "跨午夜后登记仍应使用点击完成的日期");
  cloudMode = "success";
  const beforeGraceRetry = cloudCalls.length;
  assert.equal((await sandbox.exports.retryPendingTomorrowReminder()).tomorrowScheduled, true);
  assert.equal(cloudCalls.length, beforeGraceRetry + 1, "midnight grace should retry yesterday's completion");
  assert.equal(storage.has(pendingKey), false);

  storage.set(pendingKey, {
    version: 1, chinaDate: "2026-11-05", accepted: true,
    templateId: TEMPLATE, reminderTime: "09:00",
  });
  clock.now = Date.parse("2026-11-06T00:05:01+08:00");
  const beforeStaleRetry = cloudCalls.length;
  assert.equal(await sandbox.exports.retryPendingTomorrowReminder(), null);
  assert.equal(cloudCalls.length, beforeStaleRetry, "stale request must not schedule the following day");
  assert.equal(storage.has(pendingKey), false);

  const homePendingKey = "haisha:trial:home-tomorrow-reminder-registration:v1";
  const scheduledKey = "haisha:trial:tomorrow-reminder-scheduled:v1";
  clock.now = CHINA_2026_11_05;
  storage.delete(scheduledKey);
  storage.set(pendingKey, {
    version: 1, chinaDate: "2026-11-05", accepted: true,
    templateId: TEMPLATE, reminderTime: "09:00",
  });
  cloudMode = "failure";
  const failedHome = await sandbox.exports.subscribeTomorrowFromHome(decision, "2026-11-05");
  assert.equal(failedHome.requestProcessed, false);
  assert.equal(storage.get(homePendingKey).requestChinaDate, "2026-11-05",
    "Home registration must be saved independently for network retry");
  assert.equal(storage.has(pendingKey), true,
    "Home registration must not overwrite a pending practice completion");
  assert.equal(sandbox.exports.isTomorrowWechatReminderScheduled(), false,
    "acceptance alone must not claim cloud registration succeeded");
  const homePayload = cloudCalls.at(-1).data;
  assert.equal(homePayload.action, "subscribeTomorrow");
  assert.equal(homePayload.requestChinaDate, "2026-11-05");
  assert.equal(homePayload.accepted, true);
  assert.equal(homePayload.templateId, TEMPLATE);
  assert.equal(homePayload.reminderTime, "09:00");
  assert.equal(Object.hasOwn(homePayload, "completionChinaDate"), false,
    "Home action must not mark today's task complete");

  cloudMode = "success";
  const homeCallsBeforeRetry = cloudCalls.length;
  const homeRetryOne = sandbox.exports.retryPendingHomeReminder();
  const homeRetryTwo = sandbox.exports.retryPendingHomeReminder();
  assert.equal(homeRetryOne, homeRetryTwo, "concurrent Home retries share one cloud request");
  const retriedHome = await homeRetryOne;
  assert.equal(retriedHome.requestProcessed, true);
  assert.equal(retriedHome.tomorrowScheduled, true);
  assert.equal(cloudCalls.length, homeCallsBeforeRetry + 1);
  assert.equal(storage.has(homePendingKey), false);
  assert.equal(storage.has(pendingKey), true,
    "successful Home registration leaves the practice completion retry untouched");
  assert.equal(sandbox.exports.isTomorrowWechatReminderScheduled(), true,
    "only a confirmed cloud schedule changes the Home button to subscribed");

  clock.now = Date.parse("2026-11-05T23:59:59+08:00");
  cloudMode = "failure";
  await sandbox.exports.subscribeTomorrowFromHome(decision, sandbox.exports.currentChinaDayKey());
  clock.now = Date.parse("2026-11-06T00:00:01+08:00");
  cloudMode = "success";
  assert.equal((await sandbox.exports.retryPendingHomeReminder()).tomorrowScheduled, true,
    "Home request just after midnight still targets the original next day");
  assert.equal(storage.has(homePendingKey), false);
  assert.equal(sandbox.exports.isTomorrowWechatReminderScheduled(), false,
    "after midnight, the Home button refers to the new next day");
  storage.set(homePendingKey, {
    version: 1, requestChinaDate: "2026-11-05", templateId: TEMPLATE,
    reminderTime: "09:00",
  });
  clock.now = Date.parse("2026-11-06T00:05:01+08:00");
  const callsBeforeExpiredHome = cloudCalls.length;
  assert.equal(await sandbox.exports.retryPendingHomeReminder(), null);
  assert.equal(cloudCalls.length, callsBeforeExpiredHome,
    "stale Home retry must not schedule an unintended following day");
  assert.equal(storage.has(homePendingKey), false);

  clock.now = Date.parse("2026-11-07T08:00:00+08:00");
  const declinedPromise = sandbox.exports.requestTomorrowSubscription();
  assert.equal(requestCount, 2);
  resolveRequest({ [TEMPLATE]: "reject" });
  assert.equal((await declinedPromise).status, "declined");
  assert.equal((await sandbox.exports.requestTomorrowSubscription()).status, "declined");
  assert.equal(requestCount, 2, "practice flow should not repeatedly prompt after decline");
  const explicitRetryPromise = sandbox.exports.requestTomorrowSubscription(true);
  assert.equal(requestCount, 3, "explicit Home tap may retry a declined permission prompt");
  resolveRequest({ [TEMPLATE]: "accept" });
  assert.equal((await explicitRetryPromise).status, "accepted");

  const explicitAcceptedAgain = sandbox.exports.requestTomorrowSubscription(true);
  assert.equal(requestCount, 4,
    "显式补订阅即使同日曾允许，也必须重新调用微信接口获取新的一次性额度");
  resolveRequest({ [TEMPLATE]: "accept" });
  assert.equal((await explicitAcceptedAgain).status, "accepted");

  const requestCountBeforeSettings = requestCount;
  const restored = await settingsSandbox.exports.getReminderSettings();
  assert.equal(restored.ok, true);
  assert.equal(restored.settings.enabled, true);
  assert.equal(restored.settings.time, "09:00");
  assert.equal(requestCount, requestCountBeforeSettings,
    "启动时读取服务器开关不应自动申请微信订阅授权");

  const off = await settingsSandbox.exports.setReminderSettings(false, "18:45");
  assert.equal(off.ok, true);
  assert.equal(settingsSandbox.exports.readCachedReminderSettings().time, "18:45");
  assert.equal(settingsSandbox.exports.isReminderExplicitlyOff(), true);
  const requestsBeforeOffCompletion = requestCount;
  assert.equal((await sandbox.exports.requestTomorrowSubscription()).status, "disabled");
  assert.equal(requestCount, requestsBeforeOffCompletion,
    "服务器保存关闭状态后，练习点击不能再次拉起订阅弹窗");
  const disabledResult = await sandbox.exports.recordCompletedTaskAndTomorrowReminder(
    { status: "disabled" }, undefined, "2026-11-07");
  assert.equal(disabledResult.tomorrowScheduled, false);
  assert.equal(cloudCalls.at(-1).data.reminderTime, "18:45",
    "练习完成登记应使用服务器恢复的可调提醒时间");

  storage.set(pendingKey, { version: 1, chinaDate: "2026-11-07",
    accepted: true, templateId: TEMPLATE, reminderTime: "18:45" });
  storage.set(homePendingKey, { version: 1, requestChinaDate: "2026-11-07",
    templateId: TEMPLATE, reminderTime: "18:45" });
  sandbox.exports.discardPendingReminderRegistrations();
  assert.equal(storage.has(pendingKey), false);
  assert.equal(storage.has(homePendingKey), false,
    "关掉开关后应立刻清除两类旧的待登记请求");
  storage.set(pendingKey, { version: 1, chinaDate: "2026-11-07",
    accepted: true, templateId: TEMPLATE, reminderTime: "18:45" });
  storage.set(homePendingKey, { version: 1, requestChinaDate: "2026-11-07",
    templateId: TEMPLATE, reminderTime: "18:45" });
  const callsBeforeDisabledRetry = cloudCalls.length;
  assert.equal(await sandbox.exports.retryPendingTomorrowReminder(), null);
  assert.equal(await sandbox.exports.retryPendingHomeReminder(), null);
  assert.equal(storage.has(pendingKey), false);
  assert.equal(storage.has(homePendingKey), false);
  assert.equal(cloudCalls.length, callsBeforeDisabledRetry,
    "已关闭提醒时旧的待登记请求不能重新排期");

  const on = await settingsSandbox.exports.setReminderSettings(true, "18:45");
  assert.equal(on.ok, true);
  assert.equal(settingsSandbox.exports.isReminderExplicitlyOff(), false);
  const onDecisionPromise = sandbox.exports.requestTomorrowSubscription(true);
  assert.equal(requestCount, 5);
  resolveRequest({ [TEMPLATE]: "accept" });
  const onDecision = await onDecisionPromise;
  const scheduledAtCustomTime = await sandbox.exports.subscribeTomorrowFromHome(onDecision, "2026-11-07");
  assert.equal(scheduledAtCustomTime.tomorrowScheduled, true);
  assert.equal(cloudCalls.at(-1).data.action, "subscribeTomorrow");
  assert.equal(cloudCalls.at(-1).data.reminderTime, "18:45",
    "重新开启时明日微信消息使用当前设置时间");

  sandbox.process.env.TARO_APP_DAILY_REMINDER_TEMPLATE_ID = "";
  const missing = await sandbox.exports.requestTomorrowSubscription();
  assert.equal(missing.status, "not-configured");
  assert.equal(requestCount, 5, "missing template never opens the subscription dialog");
  assert.equal(await sandbox.exports.reserveTomorrowOnLearningStart(), null);
  sandbox.process.env.TARO_APP_DAILY_REMINDER_TEMPLATE_ID = TEMPLATE;
  const reserve = sandbox.exports.reserveTomorrowOnLearningStart;
  const complete = sandbox.exports.recordLearningCompletion;
  const replay = sandbox.exports.retryPendingLearningStartReminder;
  const learningKey = "haisha:trial:learning-start-reminders:v1";
  const olderCompletionKey = "haisha:trial:previous-completion:v1";
  clock.now = Date.parse("2026-11-08T10:00:00+08:00");
  serverSettings = { enabled: true, time: "18:45", nextStatus: "scheduled",
    nextDate: "2026-11-09", scheduledTime: "18:45" };
  await settingsSandbox.exports.getReminderSettings();
  const beforeConfirmed = cloudCalls.length;
  assert.equal(await reserve(), null, "云端已确认明天的预约时跳过新授权");
  assert.equal(cloudCalls.length, beforeConfirmed);
  assert.equal(requestCount, 5);
  serverSettings = { enabled: true, time: "18:45", nextStatus: "needsConsent" };
  settingsSandbox.exports.invalidateReminderSettings();
  await settingsSandbox.exports.getReminderSettings();
  storage.set("haisha:trial:tomorrow-reminder-scheduled:v1", {
    version: 1, requestChinaDate: "2026-11-08", templateId: TEMPLATE });
  storage.set("haisha:trial:tomorrow-subscribe-attempt:v1", {
    version: 1, chinaDate: "2026-11-08", templateId: TEMPLATE, status: "accepted" });
  const beforeStart = cloudCalls.length;
  const tap = reserve();
  assert.equal(requestCount, 6, "学习入口点击同步请求授权");
  assert.equal(reserve(), tap, "双击只使用一个授权请求");
  assert.equal(cloudCalls.length, beforeStart);
  resolveRequest({ [TEMPLATE]: "accept" });
  assert.equal((await tap).tomorrowScheduled, true);
  assert.equal(cloudCalls.length, beforeStart + 1);
  const fromStart = cloudCalls.at(-1).data;
  assert.equal(fromStart.action, "subscribeTomorrow");
  assert.equal(fromStart.source, "learningStart");
  assert.equal(fromStart.requestChinaDate, "2026-11-08");
  assert.equal(fromStart.reminderTime, "18:45");
  assert.equal(Object.hasOwn(fromStart, "completionChinaDate"), false);
  assert.equal(await reserve(), null);
  assert.equal(cloudCalls.length, beforeStart + 1, "当天重复练习不增加预约调用");
  await complete("2026-11-08");
  assert.equal(cloudCalls.at(-1).data.action, "completeToday");
  assert.equal(cloudCalls.at(-1).data.accepted, false);
  assert.equal(requestCount, 6, "完成练习不再请求微信授权");

  clock.now = Date.parse("2026-11-09T10:00:00+08:00");
  const declined = reserve();
  resolveRequest({ [TEMPLATE]: "reject" });
  await declined;
  assert.equal(await reserve(), null);
  assert.equal(requestCount, 7, "当天拒绝后不重复请求");

  clock.now = Date.parse("2026-11-10T23:59:59+08:00");
  cloudMode = "failure";
  const home = { version: 2, requestId: "existing-home-request",
    requestChinaDate: "2026-11-10", reminderTime: "18:45", templateId: TEMPLATE };
  storage.set(homePendingKey, home);
  const preMidnight = reserve();
  clock.now = Date.parse("2026-11-11T00:00:01+08:00");
  resolveRequest({ [TEMPLATE]: "accept" });
  assert.equal((await preMidnight).requestProcessed, false);
  assert.equal(storage.get(learningKey)[0].requestChinaDate, "2026-11-10");
  await complete("2026-11-10");
  assert.equal(storage.get(olderCompletionKey).accepted, false);
  assert.equal(storage.get(homePendingKey), home);
  cloudMode = "success";
  const beforeReplay = cloudCalls.length;
  const [a, b] = await Promise.all([replay(), replay()]);
  assert.equal(a.tomorrowScheduled && b.tomorrowScheduled, true);
  assert.equal(cloudCalls.length, beforeReplay + 1, "两个恢复钩子共享同一条登记");
  assert.equal(cloudCalls.at(-1).data.requestChinaDate, "2026-11-10");
  await sandbox.exports.retryPendingTomorrowReminder();
  assert.equal(cloudCalls.at(-1).data.completionChinaDate, "2026-11-10");
  assert.equal(storage.get(homePendingKey), home);
  assert.equal(requestCount, 8, "断网重试不再申请额度");

  cloudMode = "failure";
  storage.set(pendingKey, { version: 1, chinaDate: "2026-11-10",
    accepted: true, templateId: TEMPLATE, reminderTime: "18:45" });
  await complete("2026-11-11");
  await complete("2026-11-10");
  assert.equal(storage.get(olderCompletionKey).accepted, true, "昨天的旧版已授权登记不能被乱序回调降级");
  assert.equal(storage.get(pendingKey).chinaDate, "2026-11-11");
  cloudMode = "success";
  await sandbox.exports.retryPendingTomorrowReminder();
  assert.equal(storage.has(olderCompletionKey) || storage.has(pendingKey), false);

  const interrupt = reserve();
  assert.equal(requestCount, 9);
  await settingsSandbox.exports.setReminderSettings(false, "18:45");
  sandbox.exports.discardPendingReminderRegistrations();
  const beforeClosed = cloudCalls.length;
  resolveRequest({ [TEMPLATE]: "accept" });
  await interrupt;
  assert.equal(await reserve(), null);
  assert.equal(await complete("2026-11-11"), null);
  assert.equal(await replay(), null);
  assert.equal(cloudCalls.length, beforeClosed, "关闭后迟到的弹窗结果不能登记新预约");
  assert.equal(requestCount, 9);
}

if (require.main === module) {
  (async () => { await dispatchCapacityTests(); await serverTests(); await trialIsolationTest(); await nextOccurrenceTests(); await clientTests(); console.log("daily WeChat reminder tests passed"); })()
    .catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { serverHarness, TEMPLATE };
