/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const test = require("node:test");
const { serverHarness, TEMPLATE } = require("./test-daily-wechat-reminder.cjs");

const today = "2026-11-05";
const tomorrow = "2026-11-06";
const choose = (h, date, time, enabled = true) =>
  h.main({ action: "setSettings", enabled, time, targetDate: date });
const consent = (targetDate, reminderTime, requestId) => ({
  action: "subscribeNext", accepted: true, templateId: TEMPLATE, settingsVersion: 1,
  requestChinaDate: today, requestId, targetDate, reminderTime,
});
const rows = (h, status) => [...h.records.values()].filter(row => row.status === status);
async function tick(h, time, date = today) {
  h.clock.now = Date.parse(`${date}T${time}:00+08:00`);
  const clientContext = h.context.value;
  h.context.value = { SOURCE: "wx_trigger" };
  try {
    const result = await h.main({});
    assert.equal(result.ok, true);
    return result.data;
  } finally {
    h.context.value = clientContext;
  }
}

test("试用触发器整十分检查，旧版任意分钟预约在下一次检查投递", async () => {
  const config = require("../cloudfunctions/dailyReminderTrial/config.json");
  const prodConfig = require("../cloudfunctions/dailyReminder/config.json");
  assert.deepEqual(config.triggers.map(t => t.config), ["0 0,10,20,30,40,50 * * * * *"]);
  assert.deepEqual(prodConfig.triggers, []);
  const h = serverHarness();
  await choose(h, today, "16:07");
  await h.main(consent(today, "16:07", "legacy-minute-at-1607"));
  assert.equal((await tick(h, "16:00")).sent, 0);
  assert.equal((await tick(h, "16:10")).sent, 1);
  assert.equal(h.sent[0].data.time23.value, "16:07");
});

test("午夜首轮补发昨天最后九分钟的旧预约，一份授权只发一次，今天仍能预约", async () => {
  const h = serverHarness();
  await choose(h, today, "23:51");
  await h.main(consent(today, "23:51", "legacy-last-nine-minutes"));
  assert.equal((await tick(h, "23:50")).sent, 0);
  assert.equal((await tick(h, "00:01", tomorrow)).sent, 1);
  assert.equal(h.sent[0].data.date5.value, today);
  assert.equal(h.sent[0].data.time23.value, "23:51");
  assert.equal((await tick(h, "00:01", tomorrow)).sent, 0);

  await h.main({ action: "setSettings", enabled: true, reserveNext: true, time: "08:00" });
  const granted = consent(undefined, "08:00", "today-after-midnight-send");
  await h.main({ ...granted, requestChinaDate: tomorrow, nearestOnly: true });
  assert.equal(rows(h, "pending")[0].localDate, tomorrow);
});

test("跨午夜补发仍遵守关闭操作及过期边界", async () => {
  const h = serverHarness();
  await choose(h, today, "23:59");
  await h.main(consent(today, "23:59", "cancel-at-midnight-grant"));
  h.clock.now = Date.parse(`${tomorrow}T00:00:00+08:00`);
  await h.main({ action: "setSettings", enabled: false, time: "10:00" });
  await h.main({ action: "setSettings", enabled: true, time: "10:00" });
  assert.equal((await tick(h, "00:01", tomorrow)).sent, 0);
  assert.equal(rows(h, "disabled").length, 1);

  const late = serverHarness();
  await choose(late, today, "23:59");
  await late.main(consent(today, "23:59", "midnight-window-expired"));
  assert.equal((await tick(late, "00:10", tomorrow)).sent, 0);
  assert.equal(rows(late, "expired").length, 1);
});

test("当天已发可以重新授权预约稍晚时刻，每条回执只使用一次并保留原始发送记录", async () => {
  const h = serverHarness();
  const first = consent(today, "15:10", "first-request-20261105");
  const second = consent(today, "15:20", "second-request-20261105");
  await choose(h, today, first.reminderTime);
  assert.equal((await h.main(first)).data.nextScheduled, true);
  assert.equal((await tick(h, "15:10")).sent, 1);
  const original = rows(h, "sent")[0];
  assert.equal((await choose(h, today, second.reminderTime)).data.nextStatus, "needsConsent");
  assert.equal((await h.main({ ...second, accepted: false })).code, "INVALID_ARGUMENT");
  assert.equal((await h.main(first)).data.nextScheduled, false);
  assert.equal(rows(h, "pending").length, 0);
  assert.equal((await h.main(second)).data.nextScheduled, true);
  assert.equal((await h.main(second)).data.nextScheduled, true);
  assert.equal((await h.main({ ...second, requestId: "also-accepted-same-slot" })).data.nextScheduled, true);
  assert.equal(rows(h, "pending").length, 1);
  const saved = rows(h, "sent")[0];
  assert.equal(saved.requestId, original.requestId);
  assert.equal(saved.updatedAtMs, original.updatedAtMs);
  assert.equal(saved.lastSendCode, 0);
  assert.equal((await tick(h, "15:20")).sent, 1);
  assert.equal((await tick(h, "15:21")).sent, 0);
  assert.equal((await h.main(second)).data.nextScheduled, false);
  assert.equal(h.sent.length, 2);
  assert.equal(rows(h, "sent").length, 2);
});

test("当天完成后可显式补约；旧完成事件重放不会撤销补约，关闭可取消两天预约", async () => {
  const h = serverHarness();
  const completion = { action: "completeToday", settingsVersion: 1, accepted: true,
    templateId: TEMPLATE, completionChinaDate: today, reminderTime: "16:00" };
  await choose(h, today, "16:00");
  await h.main(consent(today, "16:00", "before-completion-request"));
  assert.equal((await h.main(completion)).data.tomorrowScheduled, true);
  assert.equal(rows(h, "completed").length, 1);
  await choose(h, today, "16:45");
  assert.equal((await h.main(consent(today, "16:45", "after-completion-request"))).data.nextScheduled, true);
  await h.main(completion);
  assert.equal(rows(h, "completed").length, 1);
  assert.deepEqual(rows(h, "pending").map(r => [r.localDate, r.reminderTime]).sort(), [
    [today, "16:45"], [tomorrow, "16:00"],
  ]);
  assert.equal((await choose(h, tomorrow, "17:30", false)).data.nextStatus, "off");
  assert.equal(rows(h, "pending").length, 0);
});

test("过期和被替换的请求不可重排，跨午夜离线登记保留选择的绝对日期", async () => {
  const h = serverHarness();
  await choose(h, today, "18:00");
  assert.equal((await choose(h, today, "15:00")).code, "REMINDER_TIME_PASSED");
  assert.equal((await choose(h, "2026-11-07", "18:00")).code, "INVALID_TARGET_DATE");
  assert.equal((await h.main({ action: "getSettings" })).data.time, "18:00");
  const late = consent(today, "18:00", "registration-from-old-device");
  await choose(h, tomorrow, "08:00");
  assert.equal((await h.main(late)).code, "RESERVATION_CHANGED");
  const retry = consent(tomorrow, "08:00", "registration-after-midnight");
  h.clock.now = Date.parse(`${tomorrow}T07:30:00+08:00`);
  assert.equal((await h.main(retry)).data.nextScheduled, true);
  assert.equal(rows(h, "pending")[0].localDate, tomorrow);
  assert.equal((await h.main({ ...retry, targetDate: "2026-11-07" })).code, "INVALID_TARGET_DATE");
});
