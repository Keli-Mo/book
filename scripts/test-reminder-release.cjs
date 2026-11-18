/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const TEMPLATE = "test-daily-template-id";
const DAY = "2026-11-18";
const OFF = { enabled: false, time: "09:00", nextStatus: "off" };
const ON = { enabled: true, time: "09:00", nextStatus: "needsConsent" };
const functionFor = version => version === "release" ? "dailyReminder" : "dailyReminderTrial";
const channelFor = version => version === "release" ? "formal" : "trial";
const keyFor = (version, name) => `haisha:${channelFor(version)}:${name}:v1`;
const compile = name => ts.transpileModule(
  fs.readFileSync(path.join(__dirname, "../src/features/dailyReminder", name), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
).outputText;
const settingsCode = compile("reminderSettings.ts");
const subscriptionCode = compile("wechatSubscription.ts");
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function harness(version = "trial") {
  const storage = new Map();
  const calls = [];
  const subscriptions = [];
  const current = { version };
  const serverSettings = new Map([
    ["dailyReminderTrial", { ...ON }], ["dailyReminder", { ...ON }],
  ]);
  const behaviour = { call: undefined, subscribe: undefined };
  const taro = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, plain(value)),
    removeStorageSync: key => storage.delete(key),
    requestSubscribeMessage: input => {
      subscriptions.push(plain(input));
      return behaviour.subscribe ? behaviour.subscribe() : Promise.resolve({ [TEMPLATE]: "accept" });
    },
  };
  const wx = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: current.version } }),
    cloud: { callFunction(input) {
      calls.push(plain(input));
      if (behaviour.call) return behaviour.call(input);
      const { name, data } = input;
      if (data.action === "getSettings") return Promise.resolve({
        result: { ok: true, data: serverSettings.get(name) },
      });
      if (data.action === "setSettings") {
        const state = { enabled: data.enabled, time: data.time, nextStatus: data.enabled ? "needsConsent" : "off" };
        serverSettings.set(name, state);
        return Promise.resolve({ result: { ok: true, data: state } });
      }
      return Promise.resolve({ result: { ok: true, data: {
        requestProcessed: true, nextScheduled: true, tomorrowScheduled: true, todayRecorded: true,
      } } });
    } },
  };
  const FixedDate = class extends Date { static now() { return Date.parse(DAY + "T08:00:00+08:00"); } };
  const settingsContext = {
    exports: {}, wx, Date: FixedDate,
    require(name) {
      if (name === "@tarojs/taro") return { default: taro };
      if (name === "@/cloud") return { CLOUD_ENV_ID: "test-env" };
      if (name === "./calendarReminder") return { DEFAULT_DAILY_REMINDER_TIME: "09:00" };
      throw new Error("Unexpected import " + name);
    },
  };
  vm.runInNewContext(settingsCode, settingsContext);
  const subscriptionContext = {
    exports: {}, wx, Date: FixedDate,
    process: { env: { TARO_ENV: "weapp", TARO_APP_DAILY_REMINDER_TEMPLATE_ID: TEMPLATE } },
    require(name) {
      if (name === "@tarojs/taro") return { default: taro };
      if (name === "@/cloud") return { CLOUD_ENV_ID: "test-env" };
      if (name === "./reminderSettings") return settingsContext.exports;
      throw new Error("Unexpected import " + name);
    },
  };
  vm.runInNewContext(subscriptionCode, subscriptionContext);
  return { storage, calls, subscriptions, current, serverSettings, behaviour,
    settings: settingsContext.exports, subscription: subscriptionContext.exports };
}

const homeQueue = () => ({
  version: 2, nearestOnly: true, requestChinaDate: DAY, templateId: TEMPLATE,
  reminderTime: "09:00", requestId: "home_test_request_123456789", targetDate: DAY,
});
const completionQueue = () => ({
  version: 1, chinaDate: DAY, accepted: true, templateId: TEMPLATE, reminderTime: "09:00",
});

test("正式版和开发体验版路由正确，未知及缺失版本不申请也不调用云端", async () => {
  for (const version of ["release", "develop", "trial", "unknown", undefined, null]) {
    const h = harness(version);
    h.current.version = version;
    const expected = ["release", "develop", "trial"].includes(version) ? functionFor(version) : null;
    assert.equal(h.settings.getReminderFunction(), expected);
    assert.equal(h.settings.readCachedReminderSettings().enabled, false);
    assert.equal(await h.subscription.reserveTomorrowOnLearningStart(), null);
    assert.equal(h.subscriptions.length, 0);
    const result = await h.settings.getReminderSettings();
    assert.equal(result.ok, Boolean(expected));
    if (expected) {
      assert.equal(h.calls[0].name, expected);
      assert.equal((await h.subscription.reserveTomorrowOnLearningStart()).tomorrowScheduled, true);
      assert.equal(h.subscriptions.length, 1);
      assert.ok(h.calls.every(call => call.name === expected));
    } else {
      assert.equal((await h.subscription.requestTomorrowSubscription(true)).status, "not-configured");
      assert.equal(await h.subscription.retryPendingHomeReminder(), null);
      assert.equal(await h.subscription.retryPendingTomorrowReminder(), null);
      assert.equal(h.calls.length, 0);
    }
  }
});

for (const [source, target] of [["trial", "release"], ["release", "trial"]]) {
  test(`${source} 的设置、授权、待登记与已预约缓存不能被 ${target} 复用`, async () => {
    const h = harness(target);
    h.storage.set(keyFor(source, "wechat-reminder-settings"), { ...ON, time: "18:30" });
    h.storage.set("haisha:wechat-reminder-settings:v1", { ...ON, time: "18:30" });
    h.storage.set(keyFor(source, "tomorrow-subscribe-attempt"), {
      version: 1, chinaDate: DAY, templateId: TEMPLATE, status: "accepted",
    });
    h.storage.set(keyFor(source, "tomorrow-reminder-scheduled"), {
      version: 1, requestChinaDate: DAY, templateId: TEMPLATE,
    });
    h.storage.set(keyFor(source, "home-tomorrow-reminder-registration"), homeQueue());
    h.storage.set(keyFor(source, "tomorrow-reminder-registration"), completionQueue());
    h.storage.set(keyFor(source, "learning-start-reminders"), [{
      requestChinaDate: DAY, templateId: TEMPLATE, reminderTime: "18:30", status: "pending",
    }]);
    const foreignEntries = [...h.storage];
    assert.deepEqual(plain(h.settings.readCachedReminderSettings()), OFF);
    h.serverSettings.set(functionFor(target), { ...OFF });
    await h.settings.getReminderSettings();
    await h.subscription.retryPendingHomeReminder();
    await h.subscription.retryPendingTomorrowReminder();
    await h.subscription.retryPendingLearningStartReminder();
    assert.equal(await h.subscription.reserveTomorrowOnLearningStart(), null);
    assert.deepEqual(h.calls.map(call => call.data.action), ["getSettings"]);
    assert.equal(h.subscriptions.length, 0);
    assert.equal(h.subscription.isTomorrowWechatReminderScheduled(), false);
    await h.settings.setReminderSettings(true, "09:00");
    await h.subscription.reserveTomorrowOnLearningStart();
    assert.equal(h.subscriptions.length, 1, "新通道使用自己的真实授权");
    assert.equal(h.calls.at(-1).name, functionFor(target));
    assert.equal(h.calls.at(-1).data.action, "subscribeTomorrow");
    assert.equal((await h.subscription.requestTomorrowSubscription()).status, "accepted");
    assert.equal(h.subscriptions.length, 2, "旧授权接口也不能复用其它通道的订阅结果");
    assert.equal(h.storage.get(keyFor(target, "tomorrow-subscribe-attempt")).status, "accepted");
    for (const [key, value] of foreignEntries) assert.deepEqual(h.storage.get(key), value);
    h.subscription.discardPendingReminderRegistrations();
    for (const [key, value] of foreignEntries) assert.deepEqual(h.storage.get(key), value,
      "当前通道关闭不得清理其它通道数据");
  });

  test(`${source} 设置的迟到响应不会验证或覆盖 ${target}，请求各自合并`, async () => {
    const h = harness(source);
    const responses = [];
    h.behaviour.call = () => {
      const response = deferred();
      responses.push(response);
      return response.promise;
    };
    const oldSettings = h.settings.getReminderSettings();
    assert.equal(h.settings.getReminderSettings(), oldSettings);
    h.current.version = target;
    const newSettings = h.settings.getReminderSettings();
    assert.notEqual(newSettings, oldSettings);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.calls.map(call => call.name), [functionFor(source), functionFor(target)]);
    responses[0].resolve({ result: { ok: true, data: { ...ON, time: "18:30" } } });
    await oldSettings;
    assert.equal(h.settings.isReminderAccountVerified(), false);
    assert.equal(await h.subscription.reserveTomorrowOnLearningStart(), null);
    assert.equal(h.storage.has(keyFor(target, "wechat-reminder-settings")), false);
    responses[1].resolve({ result: { ok: true, data: OFF } });
    await newSettings;
    assert.equal((await h.settings.getReminderSettings()).settings.enabled, false);
    assert.deepEqual(plain(h.settings.readCachedReminderSettings()), OFF);
    assert.equal(h.calls.length, 2, "目标通道已完成的读取继续命中自己的缓存");
  });

  test(`${source} 订阅弹窗迟到时不会在 ${target} 登记或复用授权`, async () => {
    const h = harness(source);
    await h.settings.getReminderSettings();
    const consent = deferred();
    h.behaviour.subscribe = () => consent.promise;
    const earlier = h.subscription.reserveTomorrowOnLearningStart();
    assert.equal(h.subscriptions.length, 1);
    h.current.version = target;
    assert.equal(h.settings.isReminderAccountVerified(), false);
    await h.settings.getReminderSettings();
    consent.resolve({ [TEMPLATE]: "accept" });
    await earlier;
    assert.ok(h.calls.every(call => call.data.action === "getSettings"),
      "离开原通道后迟到授权不得写入当前通道");
    assert.equal(h.storage.has(keyFor(target, "learning-start-reminders")), false);
    h.behaviour.subscribe = undefined;
    await h.subscription.reserveTomorrowOnLearningStart();
    assert.equal(h.subscriptions.length, 2);
    const registration = h.calls.find(call => call.data.action === "subscribeTomorrow");
    assert.equal(registration.name, functionFor(target));
  });

  test(`${source} 云端回执迟到不会清除 ${target} 的同内容待登记记录`, async () => {
    const h = harness(source);
    await h.settings.getReminderSettings();
    const response = deferred();
    const call = h.behaviour.call;
    h.behaviour.call = input => input.data.action === "subscribeNext"
      ? response.promise
      : Promise.resolve({ result: { ok: true, data: ON } });
    const consent = await h.subscription.requestTomorrowSubscription(true);
    const earlier = h.subscription.subscribeNextFromHome(consent, DAY, "09:00", DAY);
    const otherQueueKey = keyFor(target, "home-tomorrow-reminder-registration");
    const record = plain(h.storage.get(keyFor(source, "home-tomorrow-reminder-registration")));
    h.storage.set(otherQueueKey, record);
    h.current.version = target;
    await h.settings.getReminderSettings();
    response.resolve({ result: { ok: true, data: { requestProcessed: true, nextScheduled: true } } });
    await earlier;
    assert.deepEqual(h.storage.get(otherQueueKey), record);
    assert.equal(h.storage.has(keyFor(target, "tomorrow-reminder-scheduled")), false);
    assert.equal(h.calls.filter(item => item.data.action === "subscribeNext").length, 1);
    assert.equal(h.calls.find(item => item.data.action === "subscribeNext").name, functionFor(source));
    h.behaviour.call = call;
  });
}
