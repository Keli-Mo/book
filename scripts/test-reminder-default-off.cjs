/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.join(__dirname, "../src/features/dailyReminder");
const compile = name => ts.transpileModule(fs.readFileSync(path.join(root, name), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

test("无本地设置时练习不自动申请订阅，恢复云端开启状态后才申请", async () => {
  const storage = new Map();
  const templateId = "test-daily-template-id";
  let requestCount = 0;
  const taro = {
    getStorageSync(key) { return storage.get(key); },
    setStorageSync(key, value) { storage.set(key, value); },
    removeStorageSync(key) { storage.delete(key); },
    requestSubscribeMessage() {
      requestCount += 1;
      return Promise.resolve({ [templateId]: "accept" });
    },
  };
  let version = "release";
  const calls = [];
  const wxMock = { getAccountInfoSync: () => ({ miniProgram: { envVersion: version } }), cloud: { callFunction: async ({ name, data }) => { calls.push(name); return ({
    result: data.action === "getSettings"
      ? { ok: true, data: { enabled: true, time: "09:00", nextStatus: "needsConsent" } }
      : { ok: false, code: "UNEXPECTED_ACTION" },
  }); } } };
  const settingsSandbox = { exports: {}, wx: wxMock, require(name) {
    if (name === "@tarojs/taro") return { default: taro };
    if (name === "@/cloud") return { CLOUD_ENV_ID: "test-env" };
    if (name === "./calendarReminder") return { DEFAULT_DAILY_REMINDER_TIME: "09:00" };
    throw new Error(`Unexpected import: ${name}`);
  } };
  vm.runInNewContext(compile("reminderSettings.ts"), settingsSandbox);
  const subscriptionSandbox = {
    exports: {}, wx: wxMock,
    process: { env: { TARO_ENV: "weapp", TARO_APP_DAILY_REMINDER_TEMPLATE_ID: templateId } },
    require(name) {
      if (name === "@tarojs/taro") return { default: taro };
      if (name === "@/cloud") return { CLOUD_ENV_ID: "test-env" };
      if (name === "./reminderSettings") return settingsSandbox.exports;
      throw new Error(`Unexpected import: ${name}`);
    },
  };
  vm.runInNewContext(compile("wechatSubscription.ts"), subscriptionSandbox);

  storage.set("haisha:wechat-reminder-settings:v1", { enabled: true, time: "12:00", nextStatus: "needsConsent" });
  for (const blockedVersion of ["release", "unknown"]) {
    version = blockedVersion;
    assert.equal((await settingsSandbox.exports.getReminderSettings()).ok, false);
    assert.equal(await subscriptionSandbox.exports.retryPendingHomeReminder(), null);
    assert.equal((await subscriptionSandbox.exports.requestTomorrowSubscription(true)).status, "not-configured");
  }
  assert.deepEqual(calls, []);
  version = "develop";
  assert.equal(settingsSandbox.exports.getReminderFunction(), "dailyReminderTrial");
  version = "trial";
  assert.equal((await subscriptionSandbox.exports.requestTomorrowSubscription()).status, "disabled");
  assert.equal(requestCount, 0, "首次启动时不得在服务器状态返回前弹订阅授权");
  assert.equal((await settingsSandbox.exports.getReminderSettings()).settings.enabled, true);
  assert.deepEqual(calls, ["dailyReminderTrial"]);
  const decision = subscriptionSandbox.exports.requestTomorrowSubscription();
  assert.equal(requestCount, 1, "恢复服务器开启状态后，用户完成练习可触发订阅授权");
  assert.equal((await decision).status, "accepted");
});

test("启动与首页共享设置请求，写入、到点与网络失败后能获取真实状态", async () => {
  let version = "trial";
  let now = Date.parse("2026-11-17T08:59:50+08:00");
  const calls = [];
  const sandbox = {
    exports: {}, Date: class extends Date { static now() { return now; } },
    wx: {
      getAccountInfoSync: () => ({ miniProgram: { envVersion: version } }),
      cloud: { callFunction: ({ data }) => new Promise((resolve, reject) => {
        calls.push({ action: data.action, resolve, reject });
      }) },
    },
    require(name) {
      if (name === "@tarojs/taro") return { default: { setStorageSync() {} } };
      if (name === "@/cloud") return { CLOUD_ENV_ID: "test-env" };
      if (name === "./calendarReminder") return { DEFAULT_DAILY_REMINDER_TIME: "09:00" };
      throw new Error(`Unexpected import: ${name}`);
    },
  };
  vm.runInNewContext(compile("reminderSettings.ts"), sandbox);
  const { getReminderSettings, setReminderSettings, invalidateReminderSettings } = sandbox.exports;
  const off = { enabled: false, time: "09:00", nextStatus: "off" };
  const scheduled = { enabled: true, time: "09:00", nextStatus: "scheduled",
    nextDate: "2026-11-17", scheduledTime: "09:00" };
  const respond = (call, data) => call.resolve({ result: { ok: true, data } });

  const launch = getReminderSettings();
  assert.equal(getReminderSettings(), launch);
  respond(calls[0], scheduled);
  await launch;
  assert.equal((await getReminderSettings()).settings.nextStatus, "scheduled");
  version = "release";
  assert.equal((await getReminderSettings()).ok, false);
  assert.equal(calls.length, 1);
  version = "trial";
  now += 10_000;
  const afterDue = getReminderSettings();
  assert.equal(calls.length, 2, "到期时重新读取，不能继续用已预约的旧状态");
  const toggle = setReminderSettings(false, "09:00");
  assert.equal(getReminderSettings(), toggle);
  respond(calls[2], off);
  await toggle;
  respond(calls[1], scheduled);
  assert.equal((await afterDue).reason, "STALE_RESPONSE");
  assert.equal((await getReminderSettings()).settings.enabled, false);
  assert.equal(calls.length, 3, "写入结果可直接用于下次打开首页");
  invalidateReminderSettings();
  const refresh = getReminderSettings();
  calls[3].reject(new Error("offline"));
  assert.equal((await refresh).ok, false);
  const retry = getReminderSettings();
  respond(calls[4], off);
  await retry;
  now += 60_000;
  const expired = getReminderSettings();
  respond(calls[5], scheduled);
  assert.equal((await expired).settings.enabled, true);
  const switchOff = setReminderSettings(false, "09:00");
  invalidateReminderSettings();
  assert.equal(getReminderSettings(), switchOff, "并行的练习登记不得取消关闭操作");
  respond(calls[6], off);
  assert.equal((await switchOff).settings.enabled, false);
  const reconcile = getReminderSettings();
  respond(calls[7], off);
  assert.equal((await reconcile).settings.enabled, false);
});
