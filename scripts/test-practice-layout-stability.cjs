/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const test = require("node:test");
const { createPage, byClass, elements, textOf } = require("./test-practice-book-route.cjs");

const routes = [
  { name: "普通训练", file: "src/pages/Practice/Practice.tsx", params: { bookId: "22", practice: "0" } },
  { name: "Think", file: "src/pages/ThinkBookReader/ThinkBookReader.tsx", params: { bookId: "28", page: "12" } },
];
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const natural = { width: 600, height: 900 };
const renderSettled = (page) => { page.render(); page.render(); return page.render(); };
const button = (tree, label) => elements(tree).find((node) => node.type === "Button" && textOf(node) === label);

function fixture(route, { deferMeasurements = false } = {}) {
  const slot = { width: 360, height: 720 };
  const measurements = [];
  const page = createPage(route.file, route.params, {
    savedFilePath: `/saved/layout-${route.params.bookId}.mp3`,
    taroOverrides: {
      getImageInfo({ success }) { success(natural); },
      createSelectorQuery() {
        const requests = [];
        let selector;
        const query = {
          select(value) { selector = value; return query; },
          boundingClientRect(callback) { requests.push({ selector, callback }); return query; },
          exec(callback) {
            const results = requests.map((request) => {
              return request.selector === ".practice-workspace__book"
                ? { ...slot }
                : { width: slot.width, height: slot.width * natural.height / natural.width };
            });
            const deliver = () => {
              requests.forEach((request, index) => request.callback?.(results[index]));
              callback?.(results);
            };
            if (deferMeasurements) measurements.push(deliver);
            else deliver();
          },
        };
        return query;
      },
    },
  });
  renderSettled(page);
  return { page, slot, measurements };
}

const viewport = (page) => {
  const node = byClass(renderSettled(page), "practice-book-viewport");
  assert.ok(node, "教材必须有可测量的图面");
  return node.props.style;
};
const measureAgain = (page) => {
  byClass(page.render(), "practice-book-page__image").props.onLoad({ detail: natural });
  return renderSettled(page);
};
const begin = async (page) => {
  await byClass(page.render(), "record-button").props.onClick();
  page.recorderHandlers.Start();
  return renderSettled(page);
};
const finish = async (page) => {
  byClass(page.render(), "record-button--stop").props.onClick();
  await page.recorderHandlers.Stop({ tempFilePath: "/tmp/layout-recording.mp3", duration: 2200, fileSize: 8192 });
  await settle();
  return renderSettled(page);
};

for (const route of routes) {
  test(`${route.name}：新测宽生效后，迟到的旧回调不能缩回教材`, () => {
    const { page, slot, measurements } = fixture(route, { deferMeasurements: true });
    try {
      measurements.shift()();
      assert.deepEqual(viewport(page), { width: "360px", height: "540px" });
      measureAgain(page);
      const oldMeasurement = measurements.shift();
      slot.width = 640;
      measureAgain(page);
      measurements.shift()();
      assert.deepEqual(viewport(page), { width: "640px", height: "960px" });
      oldMeasurement();
      assert.deepEqual(viewport(page), { width: "640px", height: "960px" }, "旧测宽回调不得覆盖更新后的列宽");
      assert.equal(measurements.length, 0, "尺寸变化不应再次触发测量循环");
    } finally {
      page.unload();
      page.dispose();
    }
  });

  test(`${route.name}：卸载后忽略尚未返回的测宽结果`, () => {
    const { page, slot, measurements } = fixture(route, { deferMeasurements: true });
    try {
      measurements.shift()();
      assert.deepEqual(viewport(page), { width: "360px", height: "540px" });
      slot.width = 640;
      measureAgain(page);
      const pendingMeasurement = measurements.shift();
      page.unload();
      const stateAfterUnload = page.stateValues();
      pendingMeasurement();
      assert.deepEqual(page.stateValues(), stateAfterUnload, "页面卸载后的回调不得继续更新尺寸状态");
    } finally {
      page.dispose();
    }
  });

  test(`${route.name}：成功切页回到顶部，取消切页保留阅读位置`, async () => {
    const scrolls = [];
    const page = createPage(route.file, route.params, {
      showModal: async () => ({ confirm: false }),
      taroOverrides: { pageScrollTo: (options) => { scrolls.push(options); return Promise.resolve(); } },
    });
    try {
      const initialProgress = textOf(byClass(renderSettled(page), "practice-header__progress"));
      await byClass(page.render(), "practice-navigation__button--primary").props.onClick();
      const nextProgress = textOf(byClass(renderSettled(page), "practice-header__progress"));
      assert.notEqual(nextProgress, initialProgress, "下一练习应成功切换");
      assert.deepEqual(scrolls, [{ scrollTop: 0, duration: 0 }], "成功切页应让新教材从顶部开始显示");
      scrolls.length = 0;
      await begin(page);
      await byClass(page.render(), "practice-navigation__button--primary").props.onClick();
      assert.notEqual(textOf(byClass(renderSettled(page), "practice-header__progress")), nextProgress, "录音中翻到下一训练不需要确认");
      assert.deepEqual(scrolls, [{ scrollTop: 0, duration: 0 }], "跨页后新教材从顶部开始");
      assert.equal(page.modalCalls.length, 0, "下一个训练不弹出放弃录音");
      assert.ok(byClass(page.render(), "record-button--pause"), "翻页后继续录音");
    } finally {
      page.unload();
      page.dispose();
    }
  });

  test(`${route.name}：录音和可用高度变化不缩小教材，宽度变化保持固有比例`, async () => {
    const { page, slot } = fixture(route);
    try {
      const initial = { ...viewport(page) };
      assert.deepEqual(initial, { width: "360px", height: "540px" });
      slot.height = 220;
      await begin(page);
      measureAgain(page);
      assert.deepEqual(viewport(page), initial, "开始录音后书图区变矮，教材仍应保持原宽高");
      byClass(page.render(), "record-button--pause").props.onClick();
      page.recorderHandlers.Pause();
      assert.deepEqual(viewport(page), initial, "暂停录音不能改变教材尺寸");
      await finish(page);
      assert.deepEqual(viewport(page), initial, "录音完成后的按钮和提示不能挤小教材");
      slot.width = 300;
      measureAgain(page);
      assert.deepEqual(viewport(page), { width: "300px", height: "450px" }, "书图区宽度改变后应按固有比例重新计算高度");
    } finally {
      page.unload();
      page.dispose();
    }
  });

  test(`${route.name}：标题内重录和同排回听、完成保持原有行为`, async () => {
    const { page } = fixture(route);
    try {
      assert.equal(button(page.render(), "重新录制"), undefined, "尚未录音时不应出现重录按钮");
      await begin(page);
      let tree = await finish(page);
      const heading = byClass(tree, "practice-recorder__heading");
      const retry = button(heading, "重新录制");
      assert.ok(retry, "已保存录音的重新录制按钮应位于标题内");
      assert.ok(byClass(heading, "practice-recorder__heading-actions"));
      assert.ok(byClass(heading, "practice-recorder__retry"));
      assert.notEqual(retry.props.disabled, true);
      const actions = byClass(tree, "record-actions");
      assert.ok(button(actions, "回听录音"), "回听应位于主操作行");
      assert.ok(button(actions, "完成练习"), "完成应与回听位于同一操作行");
      assert.equal(button(actions, "重新录制"), undefined, "主操作行不应重复放置重录按钮");

      button(actions, "回听录音").props.onClick();
      const playingAudio = page.audios.at(-1);
      assert.equal(playingAudio.src, `/saved/layout-${route.params.bookId}.mp3`);
      assert.ok(playingAudio.events.includes("play"));
      tree = page.render();
      assert.ok(button(byClass(tree, "record-actions"), "停止回听"));
      await button(byClass(tree, "practice-recorder__heading"), "重新录制").props.onClick();
      assert.ok(playingAudio.events.includes("destroy"), "标题重录应先停止已有录音回听");
      assert.equal(page.recorderActions.filter(({ action }) => action === "start").length, 2);
      assert.equal(button(page.render(), "重新录制"), undefined, "正在重录时不应再次出现重录按钮");
      page.recorderHandlers.Start();
      await finish(page);
      assert.equal(page.savedRecordings.length, 2, "两次录音仍分别走本地保存");
      assert.ok(page.savedRecordings.every(({ context }) => context.bookId === route.params.bookId));
      await button(byClass(page.render(), "record-actions"), "完成练习").props.onClick();
      assert.equal(page.completedPending.length, 1);
      assert.equal(page.completedPending[0].committed, true);
      assert.equal(page.submittedPending.length, 0, "完成练习仍不得启动上传");
      assert.match(page.navigations.at(-1), /^\/pages\/CheckInDetail\/CheckInDetail\?localId=.+&fromPractice=1$/);
    } finally {
      page.unload();
      page.dispose();
    }
  });
}
