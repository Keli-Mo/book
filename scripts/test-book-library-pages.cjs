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
assert.match(library, /resolveBookAction/, "页面点击应复用已测试的教材路由逻辑");
assert.match(library, /onInput/, "全部教材页面应支持输入关键词搜索");
assert.match(library, /url: action\.url/, "可跟读教材应使用门禁返回的安全路由");
assert.doesNotMatch(
  library,
  /action\.type === "unavailable"|正在核对|暂未开放/,
  "书库点击不应再显示正在核对或暂未开放的门禁提示",
);

console.log("多书页面测试通过：首页入口、页面路由、搜索筛选和开放教材点击处理正确。");
