/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const source = fs.readFileSync(path.resolve(__dirname, "../src/features/dailyReminder/calendarReminder.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function createFixture(options = {}) {
  let stored = options.stored;
  let writes = 0;
  const events = [];
  const taro = {
    canIUse: () => options.supported !== false,
    getStorageSync: () => {
      if (options.readFails) throw Error("storage unavailable");
      return stored;
    },
    setStorageSync: (_key, value) => {
      writes += 1;
      if (options.writeFails || (options.activeWriteFails && writes === 2)) throw Error("storage full");
      stored = value;
    },
    removeStorageSync: () => { stored = undefined; },
    addPhoneRepeatCalendar: async (event) => {
      events.push(event);
      if (options.calendarError) throw options.calendarError;
      if (options.waitForCalendar) await options.waitForCalendar;
    },
  };
  const module = { exports: {} };
  new Function("module", "exports", "require", compiled)(module, module.exports, (request) => {
    if (request === "@tarojs/taro") return { default: taro };
    return require(request);
  });
  return { api: module.exports, events, get stored() { return stored; }, get writes() { return writes; } };
}

(async () => {
  const now = new Date(2026, 10, 5, 18, 30, 0);
  {
    const fixture = createFixture();
    const result = await fixture.api.addDailyCalendarReminder("19:00", now);
    assert.deepEqual(result, { status: "added", time: "19:00" });
    assert.equal(fixture.events.length, 1);
    assert.equal(fixture.events[0].repeatInterval, "day");
    assert.equal(fixture.events[0].alarm, true);
    assert.equal(fixture.events[0].startTime, Math.floor(new Date(2026, 10, 5, 19, 0).getTime() / 1000));
    assert.deepEqual(fixture.api.getCalendarReminderStatus(), { status: "active", time: "19:00" });
    assert.deepEqual(await fixture.api.addDailyCalendarReminder("19:00", now), { status: "already-added", time: "19:00" });
    assert.deepEqual(await fixture.api.addDailyCalendarReminder("20:00", now), { status: "manual-change", time: "19:00" });
    assert.equal(fixture.events.length, 1, "重复点击或改时间都不得添加第二条系统日历事件");
  }
  {
    const fixture = createFixture();
    await fixture.api.addDailyCalendarReminder("18:00", now);
    assert.equal(fixture.events[0].startTime, Math.floor(new Date(2026, 10, 6, 18, 0).getTime() / 1000));
  }
  {
    const fixture = createFixture();
    assert.deepEqual(await fixture.api.addDailyCalendarReminder("24:00", now), { status: "invalid-time" });
    assert.equal(fixture.events.length, 0);
  }
  {
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    const fixture = createFixture({ waitForCalendar: waiting });
    const first = fixture.api.addDailyCalendarReminder("19:00", now);
    const second = fixture.api.addDailyCalendarReminder("19:00", now);
    release();
    await Promise.all([first, second]);
    assert.equal(fixture.events.length, 1, "并发点击只能产生一条日历事件");
  }
  {
    const fixture = createFixture({ calendarError: { errMsg: "addPhoneRepeatCalendar:fail auth deny" } });
    assert.deepEqual(await fixture.api.addDailyCalendarReminder("19:00", now), { status: "permission-denied" });
    assert.equal(fixture.api.getCalendarReminderStatus().status, "none", "明确失败后应允许用户授权后重试");
  }
  {
    const fixture = createFixture({ calendarError: { errCode: 608, errMsg: "addPhoneRepeatCalendar:fail add calendar event failed" } });
    assert.deepEqual(await fixture.api.addDailyCalendarReminder("19:00", now), {
      status: "failed",
      detail: "错误码 608，addPhoneRepeatCalendar:fail add calendar event failed",
    });
    assert.equal(fixture.api.getCalendarReminderStatus().status, "none", "接口失败后应允许再次尝试");
  }
  {
    const fixture = createFixture({ calendarError: {
      errno: 112,
      errMsg: "addPhoneRepeatCalendar:fail api scope is not declared in the privacy agreement",
    } });
    assert.deepEqual(await fixture.api.addDailyCalendarReminder("19:00", now), { status: "privacy-undeclared" });
    assert.equal(fixture.api.getCalendarReminderStatus().status, "none", "平台隐私指引补齐后应允许再次尝试");
  }
  {
    const fixture = createFixture({ activeWriteFails: true });
    assert.deepEqual(await fixture.api.addDailyCalendarReminder("19:00", now), { status: "pending-check", time: "19:00" });
    assert.deepEqual(await fixture.api.addDailyCalendarReminder("19:00", now), { status: "pending-check", time: "19:00" });
    assert.equal(fixture.events.length, 1, "系统事件已添加、回写失败时不能盲目重试");
  }
  {
    const fixture = createFixture({ readFails: true });
    assert.deepEqual(await fixture.api.addDailyCalendarReminder("19:00", now), { status: "storage-unavailable" });
    assert.equal(fixture.events.length, 0, "无法读取本地记录时不能冒险重复添加");
  }
  {
    const fixture = createFixture({ supported: false });
    assert.deepEqual(await fixture.api.addDailyCalendarReminder("19:00", now), { status: "unsupported" });
    assert.equal(fixture.events.length, 0);
  }
  console.log("每日重复日历提醒测试通过：时间、并发幂等、权限失败及写入中断均正确。");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
