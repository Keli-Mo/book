/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const readSource = (relativePath) =>
  fs.readFileSync(path.join(projectRoot, relativePath), "utf8");

const libraryPagePath = path.join(
  projectRoot,
  "src/pages/BookLibrary/BookLibrary.tsx",
);

assert.equal(fs.existsSync(libraryPagePath), true, "全部教材页面应存在");

const appConfig = readSource("src/app.config.ts");
const home = readSource("src/pages/Home/Home.tsx");
const library = fs.readFileSync(libraryPagePath, "utf8");

assert.match(
  appConfig,
  /pages\/BookLibrary\/BookLibrary/,
  "全部教材页面应注册到小程序路由",
);
assert.match(home, /BOOK_SERIES/, "首页应使用统一的五个系列数据");
assert.match(home, /全部教材/, "首页应提供全部教材入口");
assert.match(
  home,
  /\/pages\/BookLibrary\/BookLibrary/,
  "首页系列和搜索入口应进入全部教材页面",
);
assert.match(library, /filterBooks/, "全部教材页面应复用已测试的筛选逻辑");
assert.match(library, /resolveBookAction/, "页面点击应复用已测试的教材门禁逻辑");
assert.match(library, /onInput/, "全部教材页面应支持输入关键词搜索");
assert.match(
  library,
  /action\.type === "unavailable"/,
  "页面应按门禁结果区分未开放教材",
);
assert.match(library, /title: action\.message/, "未开放教材应显示门禁提示");
assert.match(library, /url: action\.url/, "可跟读教材应使用门禁返回的安全路由");

console.log("多书页面测试通过：首页入口、页面路由、搜索筛选和开放状态处理正确。");
