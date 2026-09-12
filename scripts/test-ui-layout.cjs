/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const path = require("node:path");
const sass = require("sass");
const postcss = require("postcss");
const cssnano = require("cssnano");
const failures = [];
const root = path.resolve(__dirname, "..");
const check = (label, run) => { try { run(); } catch (error) { failures.push(`${label}: ${error.message}`); } };

(async () => {
  const sheets = {};
  for (const name of ["Home", "BookLibrary", "Practice", "CheckInDetail", "MyCheckIns"]) {
    const compiled = sass.compile(path.join(root, `src/pages/${name}/${name}.scss`)).css;
    sheets[name] = postcss.parse(compiled);
    const minimized = await postcss([cssnano({ preset: "default" })]).process(compiled, { from: undefined });
    // 检查真实压缩产物，防止无效 constant() 被合并进基础 padding 并丢掉左右留白。
    minimized.root.walkDecls("padding", decl => {
      if (!decl.value.includes("constant(")) return;
      let parent = decl.parent;
      while (parent && !(parent.type === "atrule" && parent.name === "supports")) parent = parent.parent;
      check(`${name} 安全区兼容`, () => assert.ok(parent, `基础 padding 不能包含未保护的 constant(): ${decl.value}`));
    });
  }
  const values = (name, selector, prop) => {
    const found = [];
    sheets[name].walkRules(rule => { if (rule.selector.split(",").map(s => s.trim()).includes(selector)) rule.walkDecls(prop, decl => found.push(decl.value)); });
    return found;
  };
  check("Pad 录音封面", () => assert.ok(values("MyCheckIns", ".device-layout--pad .check-in-list-card__preview", "flex-basis").includes("88PX"), "必须覆盖真实 flex-basis，不能只设置 width"));
  check("底栏文字行高", () => assert.ok(values("Home", ".home-tabs__item", "line-height").includes("16PX"), "固定图标与文字行高应独立于屏宽"));
  check("底栏不压缩", () => assert.ok(values("Home", ".home-tabs__item", "flex-shrink").includes("0"), "底栏项目不应被高度强行压缩"));
  check("底栏固定高度", () => assert.ok(values("Home", ".home-tabs", "height").includes("64PX"), "底栏基础高度应容纳图标、间距和文字"));
  check("首页正文占位", () => assert.ok(values("Home", ".library-home", "padding-bottom").includes("76PX"), "正文应为固定底栏保留完整空间"));
  check("目录面板剩余空间", () => assert.ok(values("Practice", ".practice-directory-sheet", "display").includes("flex"), "所有窗口的目录面板统一分配头部和滚动区高度"));
  check("目录滚动区", () => assert.ok(values("Practice", ".practice-directory-scroll", "min-height").includes("0"), "滚动区允许缩至剩余高度"));
  check("空录音状态", () => assert.ok(values("MyCheckIns", ".my-check-ins-state", "min-height").includes("0"), "嵌套空态不能再占整屏导致横屏入口离开首屏"));
  check("Pad 打卡错误说明", () => {
    assert.ok(values("CheckInDetail", ".device-layout--pad .check-in-state__message", "font-size").includes("12PX"), "错误说明字号应固定为 12PX");
    assert.ok(values("CheckInDetail", ".device-layout--pad .check-in-state__message", "margin-top").includes("9PX"), "错误说明间距应固定为 9PX");
  });
  check("Pad 书库空态", () => {
    assert.ok(values("BookLibrary", ".device-layout--pad .book-empty", "min-height").includes("260PX"), "空态垂直槽应稳定为 260PX");
    assert.ok(values("BookLibrary", ".device-layout--pad .book-empty__title", "font-size").includes("17PX"), "空态标题字号应固定为 17PX");
    assert.ok(values("BookLibrary", ".device-layout--pad .book-empty__tip", "font-size").includes("12PX"), "空态说明字号应固定为 12PX");
  });
  if (failures.length) throw new Error(failures.join("\n"));
  console.log("全页面布局回归通过：压缩后留白、Pad封面、底栏文字、目录和空态契约。");
})().catch(error => { console.error(error.message); process.exitCode = 1; });
