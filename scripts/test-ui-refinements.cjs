/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const readSource = (relativePath) =>
  fs.readFileSync(path.join(projectRoot, relativePath), "utf8");

const practice = readSource("src/pages/Practice/Practice.tsx");
const practiceStyles = readSource("src/pages/Practice/Practice.scss");
const home = readSource("src/pages/Home/Home.tsx");
const myCheckIns = readSource("src/pages/MyCheckIns/MyCheckIns.tsx");
const myCheckInsStyles = readSource("src/pages/MyCheckIns/MyCheckIns.scss");

assert.doesNotMatch(
  practice,
  /先听示范，再完成自己的跟读|点击教材页上的播放标记|录音先保存在本机/,
  "训练页应移除重复的操作说明",
);
assert.doesNotMatch(practiceStyles, /\.practice-guide\b/, "训练页不应保留无用提示框样式");

assert.doesNotMatch(home, /班级|showClassPreview/, "首页底栏应只保留当前可用入口");
assert.match(home, />学习</, "首页底栏应保留学习入口");
assert.match(home, />我的</, "首页底栏应保留我的入口");

assert.doesNotMatch(
  myCheckIns,
  /仅本人可查看完整列表/,
  "打卡列表标题只需要显示累计次数",
);
assert.match(
  myCheckIns,
  /getCheckInCover\(record\.bookId, record\.imageUrl\)/,
  "打卡卡片应优先显示教材封面，并兼容旧记录图片",
);
assert.match(myCheckIns, /mode='aspectFit'/, "教材封面应完整显示，不能裁切");
assert.match(
  myCheckInsStyles,
  /&__open,[\s\S]*?display:\s*flex;[\s\S]*?align-items:\s*center;[\s\S]*?justify-content:\s*center;/,
  "打卡操作按钮文字应水平、垂直居中",
);
assert.match(
  myCheckInsStyles,
  /white-space:\s*nowrap;/,
  "打卡操作按钮文字不应换行",
);

console.log("界面收紧测试通过：提示文案、底栏、封面和按钮布局符合要求。");
