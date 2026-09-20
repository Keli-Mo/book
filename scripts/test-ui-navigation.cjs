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
const assertNavigationShell = tree => {
  const shell = byClass(tree, "check-in-detail-page");
  const content = byClass(shell, "check-in-detail-page__content");
  assert.ok(shell && content, "三态都必须使用无正文 padding 的公共页面外壳");
  assert.ok(byClass(shell, "check-in-navigation"), "导航必须位于公共页面外壳");
  assert.equal(byClass(content, "check-in-navigation"), undefined, "导航不能位于居中或限宽的正文容器内");
};

(async () => {
  assertPixelIcons(page("Home").render(), "首页");
  assertPixelIcons(page("BookLibrary").render(), "书库");

  const config = fs.readFileSync(path.join(projectRoot, "src/pages/CheckInDetail/CheckInDetail.config.ts"), "utf8");
  assert.match(config, /navigationStyle\s*:\s*["']custom["']/, "详情页必须启用 custom navigation");
  const practiceConfig = fs.readFileSync(path.join(projectRoot, "src/pages/Practice/Practice.config.ts"), "utf8");
  assert.match(practiceConfig, /navigationStyle\s*:\s*["']custom["']/, "教材页必须启用 custom navigation");

  const unavailableCapsule = page("CheckInDetail", {
    params: { localId: "pending" }, pendingItems: [],
    taroOverrides: { getMenuButtonBoundingClientRect: () => { throw new Error("API unavailable"); } },
  });
  assert.doesNotThrow(() => navigation(unavailableCapsule.render()), "胶囊 API 不可用时应采用安全导航尺寸");

  const loading = page("CheckInDetail", { params: { localId: "pending" }, pendingItems: [] });
  let stateTree = loading.render();
  navigation(stateTree);
  assertNavigationShell(stateTree);

  const failed = page("CheckInDetail", { params: { id: "missing", token: "bad" }, detailError: "录音已失效" });
  failed.render(); await settle();
  stateTree = failed.render();
  navigation(stateTree);
  assertNavigationShell(stateTree);

  const stacked = page("CheckInDetail", {
    params: { localId: "ui-sample-3" }, pendingItems: [sampleRecording()],
    pageStack: [{ route: "pages/Practice/Practice" }, { route: "pages/CheckInDetail/CheckInDetail" }],
  });
  stacked.render(); await settle();
  stateTree = stacked.render();
  assertNavigationShell(stateTree);
  let controls = navigation(stateTree);
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

  const practice = page("Practice", {
    params: { bookId: "3", practice: "0" },
    pageStack: [{ route: "pages/Home/Home" }, { route: "pages/Practice/Practice" }],
  });
  let practiceTree = practice.render();
  const practiceShell = byClass(practiceTree, "practice-screen");
  assert.ok(practiceShell, "教材正常页必须使用含导航的页面外壳");
  assert.ok(byClass(practiceShell, "check-in-navigation"), "教材导航必须位于 practice-screen 内");
  assert.equal(byClass(byClass(practiceTree, "practice-page"), "check-in-navigation"), undefined, "教材导航不能位于正文内");
  assert.equal(textOf(byClass(practiceTree, "check-in-navigation__title")), "听力跟读训练");
  controls = navigation(practiceTree);
  await controls.back.props.onClick();
  assert.equal(practice.navigationMethods.at(-1), "navigateBack");
  await controls.home.props.onClick();
  assert.equal(practice.navigationMethods.at(-1), "reLaunch");
  assert.equal(practice.navigations.at(-1), "/pages/Home/Home");

  const isolatedPractice = page("Practice", { params: { bookId: "3", practice: "0" }, pageStack: [] });
  controls = navigation(isolatedPractice.render());
  await controls.back.props.onClick();
  assert.equal(isolatedPractice.navigationMethods.at(-1), "reLaunch", "教材孤立入口返回必须兜底首页");
  assert.equal(isolatedPractice.navigations.at(-1), "/pages/Home/Home");

  const invalidPractice = page("Practice", { params: { bookId: "invalid", practice: "0" } });
  practiceTree = invalidPractice.render();
  assert.ok(byClass(practiceTree, "practice-screen"), "教材错误页也必须保留页面外壳");
  assert.ok(byClass(practiceTree, "check-in-navigation"), "教材错误页必须显示导航");
  assert.equal(byClass(byClass(practiceTree, "practice-empty"), "check-in-navigation"), undefined, "教材导航不能位于错误正文内");

  const scss = fs.readFileSync(path.join(projectRoot, "src/pages/CheckInDetail/CheckInNavigation.scss"), "utf8");
  assert.match(scss, /position:\s*sticky/, "自定义导航必须在页面滚动时钉在顶部");
  assert.match(scss, /top:\s*0/, "自定义导航必须贴齐视口顶部");
  assert.match(scss, /min-(?:width|height):\s*44px/i);
  assert.match(scss, /box-shadow:\s*none/, "纯图标导航必须显式取消阴影");
  assert.doesNotMatch(scss, /border-radius\s*:\s*50%/, "首页图标不应绘制圆形底色");
  const detailScss = fs.readFileSync(path.join(projectRoot, "src/pages/CheckInDetail/CheckInDetail.scss"), "utf8");
  assert.match(detailScss, /\.check-in-detail-page\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;[\s\S]*?min-height:\s*100vh;/, "公共外壳必须从视口顶部按文档流排列导航与正文");
  assert.match(detailScss, /\.check-in-detail\s*\{[\s\S]*?flex:\s*1;[\s\S]*?min-height:\s*0;/, "成功正文不能在导航之外再占满一个视口");

  console.log("UI 导航测试通过：真实图标固定 px，详情三态纯图标导航与页面栈退路正确。");
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => pages.forEach(item => item.dispose()));
