/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createUiPage, sampleRecording, settle } = require("./helpers/native-ui-fixtures.cjs");
const { byClass, elements, textOf } = require("./test-practice-book-route.cjs");

const projectRoot = path.resolve(__dirname, "..");
const pages = [];
const page = (name, options) => {
  const value = createUiPage(name, options);
  pages.push(value);
  return value;
};
const iconNodes = tree => elements(tree).filter(node =>
  node.type === "Text" && String(node.props?.className || "").split(" ").includes("at-icon"),
);
const assertPixelIcons = (tree, pageName) => {
  const icons = iconNodes(tree);
  assert.ok(icons.length > 0, `${pageName} 应渲染真实 AtIcon`);
  for (const icon of icons) {
    const fontSize = typeof icon.props.style === "object"
      ? icon.props.style.fontSize
      : String(icon.props.style).match(/font-size:([^;]+)/)?.[1];
    assert.match(String(fontSize), /^\d+px$/, `${pageName} 图标应固定为 CSS px：${JSON.stringify(icon.props.style)}`);
    assert.doesNotMatch(String(fontSize), /rpx$/, `${pageName} 图标不能被 rpx 放大`);
  }
};
const navigation = tree => {
  const root = byClass(tree, "check-in-navigation");
  assert.ok(root, "加载、错误和成功状态都必须显示自定义导航");
  const back = byClass(root, "check-in-navigation__back");
  const home = byClass(root, "check-in-detail__home");
  assert.equal(back.props["aria-label"], "返回上一页");
  assert.equal(home.props["aria-label"], "返回首页");
  assert.equal(textOf(back).trim(), "", "返回按钮必须只有图标");
  assert.equal(textOf(home).trim(), "", "首页按钮必须只有图标");
  return { back, home };
};

(async () => {
  assertPixelIcons(page("Home").render(), "首页");
  assertPixelIcons(page("BookLibrary").render(), "书库");

  const config = fs.readFileSync(path.join(projectRoot, "src/pages/CheckInDetail/CheckInDetail.config.ts"), "utf8");
  assert.match(config, /navigationStyle\s*:\s*["']custom["']/, "详情页必须启用 custom navigation");

  const loading = page("CheckInDetail", { params: { localId: "pending" }, pendingItems: [] });
  navigation(loading.render());

  const failed = page("CheckInDetail", { params: { id: "missing", token: "bad" }, detailError: "录音已失效" });
  failed.render(); await settle();
  navigation(failed.render());

  const stacked = page("CheckInDetail", {
    params: { localId: "ui-sample-3" }, pendingItems: [sampleRecording()],
    pageStack: [{ route: "pages/Practice/Practice" }, { route: "pages/CheckInDetail/CheckInDetail" }],
  });
  stacked.render(); await settle();
  let controls = navigation(stacked.render());
  await controls.back.props.onClick();
  assert.equal(stacked.navigationMethods.at(-1), "navigateBack", "有上一页时返回箭头应保留页面栈");
  await controls.home.props.onClick();
  assert.equal(stacked.navigationMethods.at(-1), "reLaunch");
  assert.equal(stacked.navigations.at(-1), "/pages/Home/Home");

  const isolated = page("CheckInDetail", { params: { localId: "ui-sample-3" }, pendingItems: [sampleRecording()], pageStack: [] });
  isolated.render(); await settle();
  controls = navigation(isolated.render());
  await controls.back.props.onClick();
  assert.notEqual(isolated.navigationMethods.at(-1), "navigateBack", "孤立入口不能调用无效 navigateBack");
  assert.ok(["navigateTo", "reLaunch"].includes(isolated.navigationMethods.at(-1)), "孤立入口必须提供合法安全退路");

  const scss = fs.readFileSync(path.join(projectRoot, "src/pages/CheckInDetail/CheckInNavigation.scss"), "utf8");
  assert.match(scss, /min-(?:width|height):\s*44px/i);
  assert.match(scss, /box-shadow:\s*none/, "纯图标导航必须显式取消阴影");
  assert.doesNotMatch(scss, /border-radius\s*:\s*50%/, "首页图标不应绘制圆形底色");

  console.log("UI 导航测试通过：真实图标固定 px，详情三态纯图标导航与页面栈退路正确。");
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => pages.forEach(item => item.dispose()));
