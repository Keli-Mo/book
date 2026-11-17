/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const test = require("node:test");
const { createHash } = require("node:crypto");
const { serverHarness, TEMPLATE: TEMPLATE_ID } = require("./test-daily-wechat-reminder.cjs");
const {
  createPage,
  createFakeTimers,
  byClass,
  elements,
  textOf,
  buildBookPracticeBundle,
  load,
} = require("./test-practice-book-route.cjs");

const showPage = async page => {
  page.render();
  page.show();
  await settle();
};
const restoreAppSettings = page => page.loadModule("src/features/dailyReminder/reminderSettings.ts").getReminderSettings();

const PRACTICE_PAGE = String(buildBookPracticeBundle("22").practices[0].imageIndex);
const settle = () => new Promise(resolve => setImmediate(resolve));

const makePending = (id) => {
  const bookId = "22";
  const bundle = load("src/features/listeningPractice/bookPractice.ts").buildFullBookPracticeBundle(bookId);
  const practice = buildBookPracticeBundle(bookId).practices[0];
  const practiceIndex = bundle.practices.findIndex((item) => item.id === practice.id);
  return {
    requestId: id.repeat(32),
    localPath: `/saved/${id}.mp3`,
    recoverable: true,
    context: {
      bookId,
      bookTitle: bundle.book.title,
      practiceId: practice.id,
      practiceIndex,
      pageNumber: practice.pageNumber,
      sectionTitle: practice.sectionTitle,
      imageUrl: practice.imageUrl,
    },
    durationMs: 2400,
    fileSizeBytes: 5000,
    cloudFileId: "",
    status: "local",
    updatedAtMs: 1,
  };
};

const makeStorageTaro = (storage, extra = {}) => ({
  getStorageSync(key) { return storage.get(key); },
  setStorageSync(key, value) { storage.set(key, value); },
  removeStorageSync(key) { storage.delete(key); },
  getWindowInfo() {
    return {
      windowWidth: 390, windowHeight: 844,
      screenWidth: 390, screenHeight: 844,
      statusBarHeight: 47,
    };
  },
  ...extra,
});

const myPage = "src/pages/MyCheckIns/MyCheckIns.tsx";
const homePage = "src/pages/Home/Home.tsx";
const libraryPage = "src/pages/BookLibrary/BookLibrary.tsx";
const practicePage = "src/pages/Practice/Practice.tsx";

const expandSettings = page => {
  const summary = byClass(page.render(), "daily-reminder-card__disclosure");
  assert.ok(summary, "我的页面中有可展开的学习提醒设置");
  summary.props.onClick();
  return page.render();
};
const settingsSwitch = tree => byClass(tree, "daily-reminder-card__switch");
const changeSwitch = page => settingsSwitch(page.render()).props.onClick();
const timeSlots = (tree, field) => elements(tree)
  .filter(node => node.props?.className?.split(" ").includes("daily-reminder-card__" + field));
const timeSlot = (tree, field, value) => {
  const button = timeSlots(tree, field).find(node => textOf(node) === value);
  assert.ok(button, `应能点选 ${field} ${value}`);
  return button;
};
const timeWheel = (page, field) => {
  const wheel = byClass(page.render(), "silent-time-wheel__scroll--" + field);
  assert.equal(wheel?.type, "ScrollView", "静音滚轮使用普通滚动列表");
  return wheel;
};
const selectTime = (page, value, day) => {
  byClass(page.render(), "daily-reminder-card__time-trigger").props.onClick();
  if (day) byClass(page.render(), "daily-reminder-card__day--" + day).props.onClick();
  const [hour, minute] = value.split(":");
  timeSlot(page.render(), "hour", hour).props.onClick();
  timeSlot(page.render(), "minute", minute).props.onClick();
};
const changeTime = (page, value, day) => {
  selectTime(page, value, day);
  byClass(page.render(), "daily-reminder-card__time-confirm").props.onClick();
};
const startButton = page => byClass(page.render(), "continue-card__button");
const dateInChina = (days = 0) => new Date(Date.now() + 8 * 3600000 + days * 86400000)
  .toISOString().slice(0, 10);

async function readyToComplete(page, id, pendingComplete) {
  const practice = page(practicePage, { bookId: "22", page: PRACTICE_PAGE }, {
    pendingItems: [makePending(id)], pendingComplete,
  });
  await restoreAppSettings(practice);
  practice.render();
  practice.render();
  await settle();
  return practice;
}

async function setup(t, { enabled = false, envVersion = "trial", allowed = true, decisions = [], failFirstSwitchReservation = false } = {}) {
  const keys = ["TARO_ENV", "TARO_APP_DAILY_REMINDER_TEMPLATE_ID"];
  const previousEnv = keys.map(key => process.env[key]);
  process.env.TARO_ENV = "weapp";
  process.env.TARO_APP_DAILY_REMINDER_TEMPLATE_ID = TEMPLATE_ID;
  t.after(() => keys.forEach((key, i) => {
    if (previousEnv[i] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[i];
  }));

  const storage = new Map();
  const subscriptions = [];
  const calls = [];
  const toasts = [];
  const events = [];
  const server = serverHarness({
    DAILY_REMINDER_TESTER_HASHES: allowed ? createHash("sha256").update("parent-openid").digest("hex") : "",
  }, true);
  server.clock.now = Date.parse("2026-11-17T08:00:00+08:00");
  t.mock.method(Date, "now", () => server.clock.now);
  if (enabled && allowed) {
    assert.equal((await server.main({ action: "setSettings", enabled: true, time: "09:00" })).ok, true);
  }
  const pendingDates = () => [...server.records.values()].filter(row => row.status === "pending")
    .map(row => row.localDate).sort();
  const seedReservation = async (tomorrow = false) => {
    const result = await server.main({
      action: tomorrow ? "subscribeTomorrow" : "subscribeNext", settingsVersion: 1, accepted: true,
      requestId: "test-plan-existing-booking", requestChinaDate: dateInChina(),
      templateId: TEMPLATE_ID, reminderTime: "09:00", ...(tomorrow ? { source: "learningStart" } : {}),
    });
    assert.equal(result.ok, true);
  };
  const wx = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion } }),
    cloud: { async callFunction({ name, data }) {
      assert.equal(name, "dailyReminderTrial");
      calls.push(data);
      events.push(data.action);
      if (failFirstSwitchReservation && data.action === "subscribeNext") {
        failFirstSwitchReservation = false;
        throw new Error("temporary network failure");
      }
      return { result: await server.main(data) };
    } },
  };
  const taroOverrides = makeStorageTaro(storage, {
    requestSubscribeMessage(input) {
      subscriptions.push(input);
      events.push("subscribe");
      return Promise.resolve({ [TEMPLATE_ID]: decisions.shift() || "accept" });
    },
    addPhoneRepeatCalendar() { assert.fail("微信提醒操作不得触发系统日历"); },
  });
  const page = (file, params = {}, options = {}) => {
    const instance = createPage(file, params, {
      taroOverrides,
      overrides: { wx },
      showToast: value => toasts.push(value.title),
      ...options,
    });
    t.after(() => instance.dispose());
    return instance;
  };
  return { server, storage, pendingDates, seedReservation, subscriptions, calls, events, toasts, page };
}

async function sendDueAt(server, time) {
  server.clock.now = Date.parse(`${dateInChina()}T${time}:00+08:00`);
  const client = server.context.value;
  server.context.value = { SOURCE: "wx_trigger" };
  try {
    const result = await server.main({});
    assert.equal(result.ok, true);
    return result.data.sent;
  } finally {
    server.context.value = client;
  }
}

test("首页不占位，「我的」折叠行展开后可开关和调时，成功保持静默", async t => {
  const { page, calls, subscriptions, toasts, pendingDates } = await setup(t);
  const home = page(homePage);
  await showPage(home);
  assert.equal(byClass(home.render(), "daily-reminder-card"), undefined);
  assert.doesNotMatch(textOf(home.render()), /学习提醒|已预约/);

  const mine = page(myPage);
  await showPage(mine);
  const collapsed = mine.render();
  assert.match(textOf(byClass(collapsed, "daily-reminder-card__disclosure")), /学习提醒/);
  assert.equal(byClass(collapsed, "daily-reminder-card__panel"), undefined);
  assert.equal(byClass(collapsed, "daily-reminder-card__switch"), undefined);

  let tree = expandSettings(mine);
  assert.match(settingsSwitch(tree).props.ariaLabel, /已关闭/);
  assert.match(textOf(byClass(tree, "daily-reminder-card__time")), /09:00/);
  changeSwitch(mine);
  assert.deepEqual(subscriptions, [{ tmplIds: [TEMPLATE_ID] }], "首次打开开关在当前手势申请订阅");
  await settle();
  const booking = calls.find(call => call.action === "subscribeNext");
  assert.match(booking.requestId, /^[A-Za-z0-9_-]{16,80}$/);
  assert.equal(booking.templateId, TEMPLATE_ID);
  assert.equal(booking.accepted, true);
  assert.equal(calls.some(call => call.action === "completeToday"), false);

  changeTime(mine, "10:30");
  await settle();
  tree = mine.render();
  assert.match(settingsSwitch(tree).props.ariaLabel, /已开启/);
  assert.match(textOf(byClass(tree, "daily-reminder-card__time")), /10:30/);
  assert.match(textOf(byClass(tree, "daily-reminder-card__status")), /10:30.*已预约/);
  byClass(tree, "daily-reminder-card__disclosure").props.onClick();
  assert.match(textOf(byClass(mine.render(), "daily-reminder-card__disclosure")), /10:30/);
  expandSettings(mine);
  changeSwitch(mine);
  await settle();
  assert.match(settingsSwitch(mine.render()).props.ariaLabel, /已关闭/);
  assert.equal(calls.filter(call => call.action === "setSettings").at(-1).enabled, false);
  assert.deepEqual(pendingDates(), []);
  const library = page(libraryPage);
  await restoreAppSettings(library);
  byClass(library.render(), "book-row").props.onClick();
  await settle();
  assert.equal(subscriptions.length, 1, "关闭后进入练习不再申请授权");
  assert.deepEqual(toasts, []);
  assert.deepEqual(mine.modalCalls, []);
});

test("开启状态仅在确认时间时订阅，重复确认已约时间复用原预约", async t => {
  const { page, subscriptions, pendingDates, calls, toasts } = await setup(t, { enabled: true });
  const mine = page(myPage);
  await showPage(mine);
  expandSettings(mine);
  selectTime(mine, "06:40", "tomorrow");
  byClass(mine.render(), "daily-reminder-card__time-cancel").props.onClick();
  assert.equal(subscriptions.length, 0);
  assert.equal(calls.some(call => call.action === "setSettings"), false);
  byClass(mine.render(), "daily-reminder-card__time-trigger").props.onClick();
  byClass(mine.render(), "daily-reminder-card__day--tomorrow").props.onClick();
  const editor = mine.render();
  assert.ok(elements(editor).every(node => node.type !== "PickerView" && node.type !== "Picker"));
  assert.deepEqual(timeSlots(editor, "minute").map(textOf), ["00", "10", "20", "30", "40", "50"]);
  const confirm = byClass(editor, "daily-reminder-card__time-confirm");
  timeSlot(editor, "hour", "07").props.onClick();
  timeSlot(editor, "minute", "40").props.onClick();
  assert.equal(subscriptions.length, 0, "点选时间只更新草稿");
  // 在同一帧点选并确认时使用刚选的时刻。
  confirm.props.onClick();
  confirm.props.onClick();
  assert.equal(subscriptions.length, 1, "双击确认只在第一次真实点击手势中申请");
  await settle();
  assert.deepEqual(pendingDates(), [dateInChina(1)], "已明确选择明天 07:40");
  assert.match(textOf(byClass(mine.render(), "daily-reminder-card__status")), /07:40.*已预约/);
  changeTime(mine, "07:40");
  await settle();
  assert.equal(subscriptions.length, 1);
  assert.equal(calls.filter(call => call.action === "subscribeNext").length, 1);
  changeTime(mine, "08:30", "today");
  await settle();
  assert.deepEqual(pendingDates(), [dateInChina()], "已有开关预约可提前到今天");
  assert.equal(subscriptions.length, 1);
  assert.deepEqual(toasts, []);
});

test("关闭状态改时只保存偏好，开启时使用已选时间预约", async t => {
  const { page, subscriptions, pendingDates, calls } = await setup(t);
  const mine = page(myPage);
  await showPage(mine);
  expandSettings(mine);
  changeTime(mine, "07:30", "tomorrow");
  await settle();
  assert.match(settingsSwitch(mine.render()).props.ariaLabel, /已关闭/);
  assert.equal(subscriptions.length, 0);
  assert.deepEqual(pendingDates(), []);
  changeSwitch(mine);
  await settle();
  assert.equal(subscriptions.length, 1);
  assert.equal(calls.find(call => call.action === "subscribeNext").reminderTime, "07:30");
  assert.deepEqual(pendingDates(), [dateInChina(1)]);
});

test("滚轮惯性未停时无法提交，停稳后用最后居中的时刻预约", async t => {
  const { page, subscriptions, calls, pendingDates, toasts } = await setup(t, { enabled: true });
  const timers = createFakeTimers();
  const mine = page(myPage, {}, { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  await showPage(mine);
  expandSettings(mine);
  byClass(mine.render(), "daily-reminder-card__time-trigger").props.onClick();
  const originalConfirm = byClass(mine.render(), "daily-reminder-card__time-confirm");
  const callsBeforeScroll = calls.length;
  const minute = timeWheel(mine, "minute");
  minute.props.onDragStart();
  minute.props.onScroll({ detail: { scrollTop: 78 } });
  assert.equal(byClass(mine.render(), "daily-reminder-card__time-confirm").props.disabled, true);
  originalConfirm.props.onClick();
  assert.equal(subscriptions.length, 0, "同一帧旧按钮回调也必须检查滚动中的最新状态");
  minute.props.onDragEnd();
  timers.advance(100);
  minute.props.onScroll({ detail: { scrollTop: 151 } });
  timers.advance(100);
  originalConfirm.props.onClick();
  assert.equal(calls.length, callsBeforeScroll, "滚动和惯性期间不得保存或请求云端");
  timers.advance(500);
  assert.equal(byClass(mine.render(), "daily-reminder-card__time-confirm").props.disabled, false);
  originalConfirm.props.onClick();
  await settle();
  assert.equal(calls.filter(call => call.action === "setSettings").at(-1).time, "09:40");
  assert.equal(subscriptions.length, 1);
  assert.deepEqual(pendingDates(), [dateInChina()]);
  assert.deepEqual(mine.audios, []);
  assert.deepEqual(toasts, []);
});

for (const fractional of [true, false]) {
  test(fractional ? "连续小数像素滑动累计一行后保存居中的分钟" : "同一手势的触摸和拖动开始事件保留已发生的滚动", async t => {
    const { page, calls, subscriptions } = await setup(t, { enabled: true });
    const timers = createFakeTimers();
    const mine = page(myPage, {}, { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
    await showPage(mine);
    expandSettings(mine);
    byClass(mine.render(), "daily-reminder-card__time-trigger").props.onClick();
    const wrapper = byClass(mine.render(), "silent-time-wheel--minute");
    const wheel = timeWheel(mine, "minute");
    wrapper.props.onTouchStart();
    if (fractional) {
      for (let step = 1; step <= 100; step++) {
        wheel.props.onScroll({ detail: { scrollTop: step * 0.4 } });
      }
    } else {
      wheel.props.onScroll({ detail: { scrollTop: 40 } });
      wheel.props.onDragStart();
    }
    assert.equal(calls.some(call => call.action === "setSettings"), false);
    wrapper.props.onTouchEnd();
    wheel.props.onDragEnd();
    timers.advance(500);
    assert.equal(timeWheel(mine, "minute").props.scrollTop, 40);
    byClass(mine.render(), "daily-reminder-card__time-confirm").props.onClick();
    await settle();
    assert.equal(calls.find(call => call.action === "setSettings").time, "09:10",
      "保存时刻必须与实际居中项一致");
    assert.equal(subscriptions.length, 1);
  });
}

test("关闭时两个滚轮分别停稳后才能开启，拖动到首尾均能准确居中", async t => {
  const { page, calls, subscriptions, pendingDates } = await setup(t);
  const timers = createFakeTimers();
  const mine = page(myPage, {}, { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  await showPage(mine);
  expandSettings(mine);
  byClass(mine.render(), "daily-reminder-card__time-trigger").props.onClick();
  byClass(mine.render(), "daily-reminder-card__day--tomorrow").props.onClick();
  const hour = timeWheel(mine, "hour");
  const minute = timeWheel(mine, "minute");
  hour.props.onDragStart();
  hour.props.onScroll({ detail: { scrollTop: -20 } });
  minute.props.onDragStart();
  minute.props.onScroll({ detail: { scrollTop: 240 } });
  hour.props.onDragEnd();
  timers.advance(500);
  changeSwitch(mine);
  assert.equal(subscriptions.length, 0, "另一列尚未松手时开关不能提交");
  assert.equal(calls.some(call => call.action === "setSettings"), false);
  minute.props.onDragEnd();
  timers.advance(500);
  changeSwitch(mine);
  await settle();
  assert.equal(calls.find(call => call.action === "setSettings").time, "00:50");
  assert.equal(subscriptions.length, 1);
  assert.deepEqual(pendingDates(), [dateInChina(1)]);
});

test("滚动后取消会清理待处理回调，重新打开使用云端已保存时间", async t => {
  const { page, calls, subscriptions } = await setup(t, { enabled: true });
  const timers = createFakeTimers();
  const mine = page(myPage, {}, { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  await showPage(mine);
  expandSettings(mine);
  byClass(mine.render(), "daily-reminder-card__time-trigger").props.onClick();
  const wheel = timeWheel(mine, "minute");
  wheel.props.onDragStart();
  wheel.props.onScroll({ detail: { scrollTop: 160 } });
  wheel.props.onDragEnd();
  byClass(mine.render(), "daily-reminder-card__time-cancel").props.onClick();
  mine.render();
  timers.advance(500);
  assert.equal(subscriptions.length, 0);
  assert.equal(calls.some(call => call.action === "setSettings"), false);
  assert.equal(byClass(mine.render(), "daily-reminder-card__time-editor"), undefined);
  byClass(mine.render(), "daily-reminder-card__time-trigger").props.onClick();
  assert.equal(timeWheel(mine, "minute").props.scrollTop, 0);
  byClass(mine.render(), "daily-reminder-card__time-confirm").props.onClick();
  await settle();
  assert.equal(calls.find(call => call.action === "setSettings").time, "09:00");
});

test("旧版非整十分钟的预约保留原时间，明确点选新分钟才改排", async t => {
  const { page, server, subscriptions, calls } = await setup(t, { enabled: true });
  await server.main({ action: "setSettings", enabled: true, time: "09:07" });
  assert.equal((await server.main({
    action: "subscribeNext", accepted: true, settingsVersion: 1, requestId: "legacy-time-reservation",
    requestChinaDate: dateInChina(), templateId: TEMPLATE_ID, reminderTime: "09:07",
  })).data.nextScheduled, true);
  const timers = createFakeTimers();
  const mine = page(myPage, {}, { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  await showPage(mine);
  expandSettings(mine);
  byClass(mine.render(), "daily-reminder-card__time-trigger").props.onClick();
  const editor = mine.render();
  assert.match(textOf(editor), /原为 07 分/);
  assert.equal(byClass(editor, "daily-reminder-card__time-confirm").props.disabled, true);
  const initialMinute = timeWheel(mine, "minute");
  initialMinute.props.onScroll({ detail: { scrollTop: initialMinute.props.scrollTop } });
  timers.advance(500);
  assert.equal(byClass(mine.render(), "daily-reminder-card__time-confirm").props.disabled, true,
    "初始程序定位不能替用户把旧预约改成整十分");
  byClass(editor, "daily-reminder-card__time-cancel").props.onClick();
  assert.match(textOf(byClass(mine.render(), "daily-reminder-card__status")), /09:07.*已预约/);
  assert.equal(calls.some(call => call.action === "setSettings"), false);
  changeTime(mine, "09:10");
  await settle();
  assert.equal(calls.filter(call => call.action === "setSettings").length, 1);
  assert.equal(subscriptions.length, 0);
  assert.match(textOf(byClass(mine.render(), "daily-reminder-card__status")), /09:10.*已预约/);
});

test("关闭时先选明天，重新进入设置开启后按此前选择预约，再关闭取消", async t => {
  const { page, subscriptions, pendingDates, calls } = await setup(t);
  const initial = page(myPage);
  await showPage(initial);
  expandSettings(initial);
  changeTime(initial, "18:30", "tomorrow");
  await settle();
  assert.equal(subscriptions.length, 0);
  assert.deepEqual(pendingDates(), []);
  assert.equal(calls.find(call => call.action === "setSettings").targetDate, dateInChina(1));

  const mine = page(myPage);
  await showPage(mine);
  expandSettings(mine);
  changeSwitch(mine);
  await settle();
  assert.equal(subscriptions.length, 1);
  assert.deepEqual(pendingDates(), [dateInChina(1)]);
  assert.equal(calls.find(call => call.action === "subscribeNext").targetDate, dateInChina(1));
  changeSwitch(mine);
  await settle();
  assert.deepEqual(pendingDates(), []);
  assert.equal(subscriptions.length, 1);
});

test("关闭时在编辑器选好明天和时间，直接打开开关即可一次预约", async t => {
  const { page, subscriptions, pendingDates, calls } = await setup(t);
  const mine = page(myPage);
  await showPage(mine);
  expandSettings(mine);
  selectTime(mine, "19:30", "tomorrow");
  changeSwitch(mine);
  assert.equal(subscriptions.length, 1);
  await settle();
  assert.deepEqual(pendingDates(), [dateInChina(1)]);
  const writes = calls.filter(call => call.action === "setSettings");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].time, "19:30");
  assert.equal(writes[0].targetDate, dateInChina(1));
});

test("改时时拒绝系统授权仍保存时间，再次确认同一时间可以补约", async t => {
  const { page, subscriptions, pendingDates, calls } = await setup(t, {
    enabled: true, decisions: ["reject", "accept"],
  });
  const mine = page(myPage);
  await showPage(mine);
  expandSettings(mine);
  changeTime(mine, "11:10");
  await settle();
  assert.deepEqual(pendingDates(), []);
  assert.match(textOf(byClass(mine.render(), "daily-reminder-card__time")), /11:10/);
  assert.match(settingsSwitch(mine.render()).props.ariaLabel, /已开启/);
  assert.equal(calls.some(call => call.action === "subscribeNext"), false);
  changeTime(mine, "11:10");
  await settle();
  assert.equal(subscriptions.length, 2);
  assert.deepEqual(pendingDates(), [dateInChina()]);
});

test("明确选明天可跳过今天的未来时段，改时和开始跟读均复用同一条预约", async t => {
  const { page, subscriptions, pendingDates, server, toasts } = await setup(t, { enabled: true });
  const mine = page(myPage);
  await showPage(mine);
  expandSettings(mine);
  selectTime(mine, "18:30", "tomorrow");
  assert.equal(subscriptions.length, 0, "点选日期和时间不请求授权");
  const confirm = byClass(mine.render(), "daily-reminder-card__time-confirm");
  confirm.props.onClick();
  assert.equal(subscriptions.length, 1, "单次微信授权在确认手势内发起");
  confirm.props.onClick();
  await settle();
  assert.deepEqual(pendingDates(), [dateInChina(1)]);
  changeTime(mine, "18:40", "tomorrow");
  await settle();
  const pending = [...server.records.values()].filter(row => row.status === "pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].dueAtMs, Date.parse(`${dateInChina(1)}T18:40:00+08:00`));
  const library = page(libraryPage);
  await restoreAppSettings(library);
  byClass(library.render(), "book-row").props.onClick();
  await settle();
  assert.equal(subscriptions.length, 1);
  assert.deepEqual(pendingDates(), [dateInChina(1)]);
  assert.deepEqual(toasts, []);
});

test("已预约明天时点击今天过期小时不会选中，取消仍保留原预约", async t => {
  const { page, seedReservation, subscriptions, pendingDates, calls } = await setup(t, { enabled: true });
  await seedReservation(true);
  const mine = page(myPage);
  await showPage(mine);
  expandSettings(mine);
  byClass(mine.render(), "daily-reminder-card__time-trigger").props.onClick();
  byClass(mine.render(), "daily-reminder-card__day--today").props.onClick();
  const past = timeSlot(mine.render(), "hour", "07");
  assert.equal(past.props.disabled, true);
  past.props.onClick();
  assert.equal(timeSlot(mine.render(), "hour", "07").props.className.includes("--selected"), false);
  byClass(mine.render(), "daily-reminder-card__time-cancel").props.onClick();
  assert.equal(subscriptions.length, 0);
  assert.equal(calls.some(call => call.action === "setSettings" || call.action === "subscribeNext"), false);
  assert.deepEqual(pendingDates(), [dateInChina(1)]);
});

test("日期只显示今天和明天，改回今天复用预约并在重进时保留选择", async t => {
  const { page, subscriptions, pendingDates } = await setup(t, { enabled: true });
  const mine = page(myPage);
  await showPage(mine);
  expandSettings(mine);
  changeTime(mine, "12:30", "tomorrow");
  await settle();
  assert.deepEqual(pendingDates(), [dateInChina(1)]);
  changeTime(mine, "12:30", "today");
  await settle();
  assert.deepEqual(pendingDates(), [dateInChina()]);
  assert.equal(subscriptions.length, 1);
  const nextVisit = page(myPage);
  await showPage(nextVisit);
  expandSettings(nextVisit);
  byClass(nextVisit.render(), "daily-reminder-card__time-trigger").props.onClick();
  const selected = byClass(nextVisit.render(), "daily-reminder-card__day--active");
  assert.equal(textOf(selected), "今天");
  assert.equal(byClass(nextVisit.render(), "daily-reminder-card__day--auto"), undefined);
  assert.doesNotMatch(textOf(nextVisit.render()), /自动/);
});

test("今天当前小时只允许未来分钟，滚入过去时段后停在最近可预约项", async t => {
  const { page, server, calls, subscriptions } = await setup(t, { enabled: true });
  server.clock.now = Date.parse(`${dateInChina()}T08:35:00+08:00`);
  const timers = createFakeTimers();
  const mine = page(myPage, {}, { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  await showPage(mine);
  expandSettings(mine);
  byClass(mine.render(), "daily-reminder-card__time-trigger").props.onClick();
  byClass(mine.render(), "daily-reminder-card__day--today").props.onClick();
  timeSlot(mine.render(), "hour", "08").props.onClick();
  for (const minute of ["00", "10", "20", "30"]) {
    assert.equal(timeSlot(mine.render(), "minute", minute).props.disabled, true);
  }
  assert.equal(timeSlot(mine.render(), "minute", "40").props.disabled, false);
  assert.equal(timeSlot(mine.render(), "minute", "50").props.disabled, false);
  const wheel = timeWheel(mine, "minute");
  wheel.props.onDragStart();
  wheel.props.onScroll({ detail: { scrollTop: 0 } });
  wheel.props.onDragEnd();
  timers.advance(500);
  assert.equal(timeWheel(mine, "minute").props.scrollTop, 160);
  assert.match(timeSlot(mine.render(), "minute", "40").props.className, /--selected/);
  assert.equal(subscriptions.length, 0);
  assert.equal(calls.some(call => call.action === "setSettings"), false);
  byClass(mine.render(), "daily-reminder-card__time-confirm").props.onClick();
  await settle();
  const saved = calls.find(call => call.action === "setSettings");
  assert.equal(saved.time, "08:40");
  assert.equal(saved.targetDate, dateInChina());
});

test("从明天切到今天时，已过的草稿调整为今天下一个整十分", async t => {
  const { page, server, calls } = await setup(t, { enabled: true });
  server.clock.now = Date.parse(`${dateInChina()}T08:35:00+08:00`);
  const mine = page(myPage);
  await showPage(mine);
  expandSettings(mine);
  selectTime(mine, "07:20", "tomorrow");
  byClass(mine.render(), "daily-reminder-card__day--today").props.onClick();
  assert.match(timeSlot(mine.render(), "hour", "08").props.className, /--selected/);
  assert.match(timeSlot(mine.render(), "minute", "40").props.className, /--selected/);
  byClass(mine.render(), "daily-reminder-card__time-confirm").props.onClick();
  await settle();
  const saved = calls.find(call => call.action === "setSettings");
  assert.equal(saved.time, "08:40");
  assert.equal(saved.targetDate, dateInChina());
});

test("23点50分后今天已无可选档，默认明天且禁用今天", async t => {
  const { page, server, calls, pendingDates } = await setup(t, { enabled: true });
  server.clock.now = Date.parse(`${dateInChina()}T23:50:00+08:00`);
  const mine = page(myPage);
  await showPage(mine);
  expandSettings(mine);
  byClass(mine.render(), "daily-reminder-card__time-trigger").props.onClick();
  const today = byClass(mine.render(), "daily-reminder-card__day--today");
  assert.equal(today.props.disabled, true);
  today.props.onClick();
  assert.equal(textOf(byClass(mine.render(), "daily-reminder-card__day--active")), "明天");
  assert.ok(timeSlots(mine.render(), "hour").every(node => !node.props.disabled));
  byClass(mine.render(), "daily-reminder-card__time-confirm").props.onClick();
  await settle();
  assert.equal(calls.find(call => call.action === "setSettings").targetDate, dateInChina(1));
  assert.deepEqual(pendingDates(), [dateInChina(1)]);
});

test("选定时刻刚好过去后，旧确认回调也阻止预约并更新可选时间", async t => {
  const { page, server, calls, subscriptions } = await setup(t, { enabled: true });
  server.clock.now = Date.parse(`${dateInChina()}T08:35:00+08:00`);
  const mine = page(myPage);
  await showPage(mine);
  expandSettings(mine);
  selectTime(mine, "08:40", "today");
  const confirm = byClass(mine.render(), "daily-reminder-card__time-confirm");
  server.clock.now = Date.parse(`${dateInChina()}T08:40:00+08:00`);
  confirm.props.onClick();
  assert.equal(subscriptions.length, 0);
  assert.equal(calls.some(call => call.action === "setSettings"), false);
  assert.ok(byClass(mine.render(), "daily-reminder-card__time-editor"));
  assert.equal(timeSlot(mine.render(), "minute", "40").props.disabled, true);
  assert.match(timeSlot(mine.render(), "minute", "50").props.className, /--selected/);
  byClass(mine.render(), "daily-reminder-card__time-confirm").props.onClick();
  await settle();
  assert.equal(calls.find(call => call.action === "setSettings").time, "08:50");
  assert.equal(subscriptions.length, 1);
});

test("时间边界在本地刷新禁用，跨午夜保留原明日的绝对日期", async t => {
  const { page, server, calls, subscriptions } = await setup(t, { enabled: true });
  const initialDay = dateInChina();
  const initialTomorrow = dateInChina(1);
  server.clock.now = Date.parse(`${initialDay}T23:59:30+08:00`);
  const timers = createFakeTimers();
  const mine = page(myPage, {}, { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  await showPage(mine);
  expandSettings(mine);
  selectTime(mine, "00:10", "tomorrow");
  const reads = calls.length;
  server.clock.now = Date.parse(`${initialTomorrow}T00:00:01+08:00`);
  timers.advance(31_000);
  assert.equal(calls.length, reads, "只刷新本地可选项，不定时查询服务器");
  assert.equal(subscriptions.length, 0);
  assert.equal(textOf(byClass(mine.render(), "daily-reminder-card__day--active")), "今天");
  assert.equal(timeSlot(mine.render(), "minute", "00").props.disabled, true);
  byClass(mine.render(), "daily-reminder-card__time-confirm").props.onClick();
  await settle();
  const saved = calls.find(call => call.action === "setSettings");
  assert.equal(saved.targetDate, initialTomorrow);
  assert.equal(saved.time, "00:10");
});

test("历史预约时间已过仍可直接关闭，关闭不要求重新选未来时间", async t => {
  const { page, server, calls, subscriptions } = await setup(t, { enabled: true });
  await server.main({ action: "setSettings", enabled: true, time: "09:00", targetDate: dateInChina() });
  server.clock.now = Date.parse(`${dateInChina()}T10:00:00+08:00`);
  const mine = page(myPage);
  await showPage(mine);
  expandSettings(mine);
  changeSwitch(mine);
  await settle();
  assert.equal(calls.find(call => call.action === "setSettings").enabled, false);
  assert.equal(subscriptions.length, 0);
  assert.match(settingsSwitch(mine.render()).props.ariaLabel, /已关闭/);
});

test("今日已送达且跟读已完成，仍可手动约今晚；同一授权和重复触发只送一条", async t => {
  const { page, server, seedReservation, subscriptions, pendingDates, calls } = await setup(t, { enabled: true });
  await seedReservation();
  assert.equal(await sendDueAt(server, "09:00"), 1);
  const practice = await readyToComplete(page, "b", async () => true);
  await byClass(practice.render(), "check-in-button").props.onClick();
  await settle();
  assert.deepEqual(pendingDates(), [dateInChina(1)]);
  assert.equal(subscriptions.length, 1, "完成跟读时取得了明天的额度");
  const mine = page(myPage);
  await showPage(mine);
  expandSettings(mine);
  changeTime(mine, "19:10", "today");
  await settle();
  assert.equal(subscriptions.length, 2, "明确约今天需要新授权，明天的练习预约继续保留");
  assert.deepEqual(pendingDates(), [dateInChina(), dateInChina(1)]);
  const registration = calls.filter(call => call.action === "subscribeNext").at(-1);
  assert.ok(registration);
  changeTime(mine, "19:10", "today");
  await settle();
  assert.equal(subscriptions.length, 2);
  assert.equal(await sendDueAt(server, "19:09"), 0);
  assert.equal(await sendDueAt(server, "19:10"), 1);
  await server.main(registration);
  assert.equal(await sendDueAt(server, "19:11"), 0);
  assert.deepEqual(server.sent.map(message => message.data.time23.value), ["09:00", "19:10"]);
  assert.deepEqual(pendingDates(), [dateInChina(1)]);
});

test("已有跟读明日预约时确认今天的未来时间，可同时保留两条预约", async t => {
  const { page, subscriptions, seedReservation, pendingDates } = await setup(t, { enabled: true });
  await seedReservation(true);
  const mine = page(myPage);
  await showPage(mine);
  expandSettings(mine);
  changeTime(mine, "07:40", "tomorrow");
  await settle();
  assert.equal(subscriptions.length, 0, "明日预约覆盖最近时间");
  changeTime(mine, "12:30", "today");
  await settle();
  assert.equal(subscriptions.length, 1, "保留明天的学习预约，今天使用新额度");
  assert.deepEqual(pendingDates(), [dateInChina(), dateInChina(1)]);
  const library = page(libraryPage);
  await restoreAppSettings(library);
  byClass(library.render(), "book-row").props.onClick();
  await settle();
  assert.equal(subscriptions.length, 1, "服务端有两天预约时，跟读不会重复申请");
});

test("首页只在继续跟读时顺手预约次日，进入书库、重显首页均不申请", async t => {
  const { page, storage, pendingDates, seedReservation, subscriptions, calls, events, toasts } = await setup(t, { enabled: true });
  await seedReservation();
  const home = page(homePage);
  await showPage(home);
  assert.match(textOf(startButton(home)), /选择教材/);
  startButton(home).props.onClick();
  assert.match(home.navigations.at(-1), /pages\/BookLibrary\/BookLibrary/);
  await settle();
  assert.equal(subscriptions.length, 0);

  storage.set("haisha:reading-progress:v1", { version: 1, bookId: "22", practiceIndex: 0 });
  home.show();
  await settle();
  assert.equal(subscriptions.length, 0);
  assert.match(textOf(startButton(home)), /继续跟读/);
  startButton(home).props.onClick();
  assert.deepEqual(subscriptions, [{ tmplIds: [TEMPLATE_ID] }], "必须直接在学习点击手势中申请");
  await settle();
  assert.match(home.navigations.at(-1), /pages\/Practice\/Practice/);
  const reservation = calls.find(call => call.action === "subscribeTomorrow");
  assert.ok(reservation, "学习入口应固定预约次日");
  assert.equal(reservation.requestChinaDate, dateInChina());
  assert.equal(reservation.accepted, true);
  assert.equal(reservation.templateId, TEMPLATE_ID);
  assert.equal(calls.some(call => ["subscribeNext", "completeToday"].includes(call.action)), false);
  assert.deepEqual(pendingDates(), [dateInChina(), dateInChina(1)], "开始练习保留今天的待发提醒");
  assert.deepEqual(toasts, []);

  const practice = await readyToComplete(page, "a", async () => { events.push("saved"); return true; });
  await byClass(practice.render(), "check-in-button").props.onClick();
  await settle();
  assert.equal(subscriptions.length, 1, "完成录音不得再申请明天的订阅");
  assert.deepEqual(practice.completedPending, [{ requestId: makePending("a").requestId, committed: true }]);
  const completion = calls.find(call => call.action === "completeToday");
  assert.equal(completion.completionChinaDate, dateInChina());
  assert.equal(completion.accepted, false);
  assert.ok(events.indexOf("saved") < events.indexOf("completeToday"));
  assert.deepEqual(pendingDates(), [dateInChina(1)], "完成练习后保留已约的明日提醒");
  assert.deepEqual(toasts, ["已保存到我的录音"]);
});

test("书库只在点具体教材时预约；选择分类不申请，重复进入不重约", async t => {
  const { page, subscriptions, calls, toasts } = await setup(t, { enabled: true });
  const library = page(libraryPage);
  await restoreAppSettings(library);
  const tree = library.render();
  byClass(tree, "series-filter").props.onClick();
  assert.equal(subscriptions.length, 0);
  byClass(library.render(), "book-row").props.onClick();
  assert.equal(subscriptions.length, 1);
  await settle();
  assert.match(library.navigations.at(-1), /pages\/(Practice|ThinkBookReader)\//);
  byClass(library.render(), "book-row").props.onClick();
  await settle();
  assert.equal(subscriptions.length, 1);
  assert.equal(calls.filter(call => call.action === "subscribeTomorrow").length, 1);
  assert.equal(calls.some(call => call.action === "completeToday"), false);
  assert.deepEqual(toasts, []);
});

test("开关申请被拒仍保存偏好；再次开始跟读可申请，拒绝不影响进书", async t => {
  const { page, calls, subscriptions, toasts } = await setup(t, { decisions: ["reject", "reject"] });
  const mine = page(myPage);
  await showPage(mine);
  expandSettings(mine);
  changeSwitch(mine);
  await settle();
  assert.match(settingsSwitch(mine.render()).props.ariaLabel, /已开启/);
  assert.doesNotMatch(textOf(byClass(mine.render(), "daily-reminder-card__status")), /已预约/);
  assert.equal(calls.some(call => call.action === "subscribeNext"), false);
  const library = page(libraryPage);
  await restoreAppSettings(library);
  const beforeStart = toasts.length;
  byClass(library.render(), "book-row").props.onClick();
  assert.equal(subscriptions.length, 2);
  await settle();
  assert.equal(library.navigations.length, 1);
  assert.equal(calls.some(call => call.action === "subscribeTomorrow"), false);
  byClass(library.render(), "book-row").props.onClick();
  await settle();
  assert.equal(subscriptions.length, 2, "当日拒绝后再进书不重弹");
  assert.equal(toasts.length, beforeStart, "练习入口的拒绝不弹提示");
});

test("从录音详情点「我也来跟读」才申请，缺失教材时只进入书库", async t => {
  const { page, subscriptions, calls } = await setup(t, { enabled: true });
  const detailPage = "src/pages/CheckInDetail/CheckInDetail.tsx";
  const record = {
    ...makePending("h").context, id: "record", shareToken: "token",
    durationMs: 1800, recordingUrl: "record.mp3", isOwner: true, createdAt: 1,
  };
  const missing = page(detailPage, { id: record.id }, { detail: { ...record, bookId: "unknown" } });
  await restoreAppSettings(missing);
  await showPage(missing);
  const chooseBook = byClass(missing.render(), "check-in-actions__practice");
  assert.match(textOf(chooseBook), /选择教材/);
  await chooseBook.props.onClick();
  assert.match(missing.navigations.at(-1), /pages\/BookLibrary\/BookLibrary/);
  assert.equal(subscriptions.length, 0);

  const detail = page(detailPage, { id: record.id }, { detail: record });
  await restoreAppSettings(detail);
  await showPage(detail);
  const start = byClass(detail.render(), "check-in-actions__practice");
  assert.match(textOf(start), /我也来跟读/);
  assert.equal(subscriptions.length, 0);
  start.props.onClick();
  assert.equal(subscriptions.length, 1);
  await settle();
  assert.match(detail.navigations.at(-1), /pages\/Practice\/Practice/);
  assert.equal(calls.filter(call => call.action === "subscribeTomorrow").length, 1);
});

test("开关的预约登记断网后回首页自动重试，沿用原请求 ID", async t => {
  const { page, calls, storage } = await setup(t, { failFirstSwitchReservation: true });
  const mine = page(myPage);
  await showPage(mine);
  expandSettings(mine);
  changeSwitch(mine);
  await settle();
  const homeQueue = "haisha:trial:home-tomorrow-reminder-registration:v1";
  const queued = storage.get(homeQueue);
  assert.match(queued.requestId, /^[A-Za-z0-9_-]{16,80}$/);
  const home = page(homePage);
  await showPage(home);
  assert.equal(storage.has(homeQueue), false);
  assert.deepEqual(calls.filter(call => call.action === "subscribeNext").map(call => call.requestId),
    [queued.requestId, queued.requestId]);
});

for (const [reconnectTime, canStillBook] of [["07:00", true], ["16:31", false]]) {
  test(`明确约明天后登记断网，次日 ${reconnectTime} ${canStillBook ? "复用原日期和授权补约" : "过时清除，不再顺延"}`, async t => {
    const { page, calls, storage, subscriptions, pendingDates, server } = await setup(t, {
      enabled: true, failFirstSwitchReservation: true,
    });
    const targetDate = dateInChina(1);
    const mine = page(myPage);
    await showPage(mine);
    expandSettings(mine);
    changeTime(mine, "16:30", "tomorrow");
    await settle();
    assert.deepEqual(pendingDates(), []);
    const queueKey = "haisha:trial:home-tomorrow-reminder-registration:v1";
    assert.equal(storage.get(queueKey).targetDate, targetDate);
    server.clock.now = Date.parse(`${targetDate}T${reconnectTime}:00+08:00`);
    await showPage(page(homePage));
    const bookings = calls.filter(call => call.action === "subscribeNext");
    assert.equal(bookings.length, canStillBook ? 2 : 1);
    if (canStillBook) {
      assert.equal(bookings[0].requestId, bookings[1].requestId);
      assert.equal(bookings[1].targetDate, targetDate);
    }
    assert.equal(subscriptions.length, 1);
    assert.deepEqual(pendingDates(), canStillBook ? [targetDate] : []);
    assert.equal(storage.has(queueKey), false);
  });
}

for (const allowed of [true, false]) {
  test(`直接进入练习后完成，${allowed ? "允许就补约明日" : "拒绝仍能完成录音"}`, async t => {
    const { page, calls, subscriptions, events, toasts, seedReservation, pendingDates } =
      await setup(t, { enabled: true, decisions: [allowed ? "accept" : "reject"] });
    await seedReservation();
    const practice = await readyToComplete(page, "c", async () => { events.push("saved"); return true; });
    const clicked = byClass(practice.render(), "check-in-button").props.onClick();
    assert.equal(subscriptions.length, 1, "完成按钮必须在点击回调内立即申请");
    await clicked;
    await settle();
    const completion = calls.find(call => call.action === "completeToday");
    assert.equal(completion.accepted, allowed);
    assert.equal(completion.completionChinaDate, dateInChina());
    assert.ok(events.indexOf("saved") < events.indexOf("completeToday"));
    assert.deepEqual(pendingDates(), allowed ? [dateInChina(1)] : []);
    assert.deepEqual(toasts, ["已保存到我的录音"]);
  });
}

test("录音保存失败保留今天的提醒，重新完成后再使用同一次授权", async t => {
  const { page, calls, subscriptions, seedReservation, pendingDates } = await setup(t, { enabled: true });
  await seedReservation();
  let canSave = false;
  const practice = await readyToComplete(page, "d", async () => canSave);
  await byClass(practice.render(), "check-in-button").props.onClick();
  await settle();
  assert.equal(subscriptions.length, 1);
  assert.equal(calls.some(call => ["completeToday", "subscribeTomorrow"].includes(call.action)), false);
  assert.deepEqual(pendingDates(), [dateInChina()]);
  canSave = true;
  await byClass(practice.render(), "check-in-button").props.onClick();
  await settle();
  assert.equal(subscriptions.length, 1, "保存重试使用上次同意的授权，不重复弹出订阅框");
  assert.deepEqual(pendingDates(), [dateInChina(1)]);
});

for (const [envVersion, audience] of [["release", "正式版"], ["trial", "未列入测试名单的体验版账号"]]) {
  test(audience + "无提醒入口，开始学习不会申请订阅", async t => {
    const { page, subscriptions, calls, storage } = await setup(t, { envVersion, allowed: false });
    storage.set("haisha:trial:wechat-reminder-settings:v1", { enabled: true, time: "09:00", nextStatus: "needsConsent" });
    const mine = page(myPage);
    await showPage(mine);
    assert.equal(byClass(mine.render(), "daily-reminder-card"), undefined);
    const library = page(libraryPage);
    await restoreAppSettings(library);
    byClass(library.render(), "book-row").props.onClick();
    await settle();
    assert.equal(subscriptions.length, 0);
    assert.ok(calls.every(call => call.action === "getSettings"));
    if (envVersion === "release") assert.equal(calls.length, 0);
  });
}
