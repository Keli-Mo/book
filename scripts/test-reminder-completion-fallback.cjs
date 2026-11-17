/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const test = require("node:test");
const { load } = require("./test-practice-book-route.cjs");

const source = "src/features/dailyReminder/wechatSubscription.ts";
const template = "test-reminder-completion-template";
function fixture(t) {
  const clock = { now: Date.parse("2026-11-17T23:59:58+08:00") };
  t.mock.method(Date, "now", () => clock.now);
  for (const [key, value] of Object.entries({ TARO_ENV: "weapp", TARO_APP_DAILY_REMINDER_TEMPLATE_ID: template })) {
    const original = process.env[key];
    process.env[key] = value;
    t.after(() => { if (original === undefined) delete process.env[key]; else process.env[key] = original; });
  }
  const settings = { enabled: true, time: "09:00", nextStatus: "needsConsent" };
  const saved = new Map(), prompts = [], calls = [];
  let offline = false;
  const api = load(source, {
    "@/cloud": { CLOUD_ENV_ID: "test" },
    "./reminderSettings": {
      getReminderFunction: () => "dailyReminderTrial", isReminderAccountVerified: () => true,
      isReminderExplicitlyOff: () => !settings.enabled, readCachedReminderSettings: () => settings,
      invalidateReminderSettings() {},
    },
    "@tarojs/taro": { default: {
      getStorageSync: key => saved.get(key), setStorageSync: (key, data) => saved.set(key, data),
      removeStorageSync: key => saved.delete(key),
      requestSubscribeMessage() {
        return new Promise(resolve => prompts.push(value => resolve({ [template]: value })));
      },
    } },
    wx: { cloud: { async callFunction({ data }) {
      calls.push(data);
      if (offline) throw new Error("offline");
      return { result: { ok: true, data: { todayRecorded: true, requestProcessed: true, tomorrowScheduled: true } } };
    } } },
  });
  return { api, clock, calls, prompts, setOffline: value => { offline = value; } };
}

test("跨午夜保存成功，完成时获准的额度按点击日期重试，一次云调用同时核销与预约", async t => {
  const { api, calls, clock, prompts, setOffline } = fixture(t);
  const save = Promise.withResolvers();
  const pending = api.reserveReminderOnLearningCompletion("2026-11-17", save.promise);
  assert.equal(prompts.length, 1);
  prompts[0]("accept");
  clock.now = Date.parse("2026-11-18T00:00:03+08:00");
  setOffline(true);
  assert.equal(calls.length, 0);
  save.resolve(true);
  assert.equal((await pending).todayRecorded, false);
  assert.deepEqual(calls.map(x => [x.action, x.accepted, x.completionChinaDate]),
    [["completeToday", true, "2026-11-17"]]);
  setOffline(false);
  assert.equal((await api.retryPendingTomorrowReminder()).tomorrowScheduled, true);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(await api.retryPendingTomorrowReminder(), null);
  assert.equal(prompts.length, 1);
});

test("保存失败后本次授权只供实际学习操作重用，打开首页不会补登记", async t => {
  const { api, calls, prompts } = fixture(t);
  const failed = api.reserveReminderOnLearningCompletion("2026-11-17", Promise.resolve(false));
  prompts[0]("accept");
  assert.equal(await failed, null);
  assert.equal(await api.retryPendingLearningStartReminder(), null);
  assert.equal(await api.retryPendingTomorrowReminder(), null);
  assert.equal(calls.length, 0);
  const retry = await api.reserveReminderOnLearningCompletion("2026-11-17", Promise.resolve(true));
  assert.equal(retry.tomorrowScheduled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].accepted, true);
  assert.equal(prompts.length, 1);
});

test("开始与完成共用正在等待的微信授权，明日额度只交给一个登记请求", async t => {
  const { api, calls, prompts } = fixture(t);
  const start = api.reserveTomorrowOnLearningStart();
  const completion = api.reserveReminderOnLearningCompletion("2026-11-17", Promise.resolve(true));
  assert.equal(prompts.length, 1);
  prompts[0]("accept");
  await Promise.all([start, completion]);
  assert.equal(calls.filter(call => call.accepted).length, 1);
  assert.equal(calls.filter(call => call.action === "completeToday").length, 1);
});
