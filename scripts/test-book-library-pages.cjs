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
assert.match(library, /onInput/, "全部教材页面应支持输入关键词搜索");
assert.match(library, /正在核对页面与音频/, "未开放教材应给出明确提示");
assert.match(
  library,
  /\/pages\/Practice\/Practice\?practice=0/,
  "可跟读教材应进入现有训练流程",
);

console.log("多书页面测试通过：首页入口、页面路由、搜索筛选和开放状态处理正确。");
