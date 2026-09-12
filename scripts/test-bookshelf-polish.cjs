/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const sass = require("sass");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const home = read("src/pages/Home/Home.tsx");
const library = read("src/pages/BookLibrary/BookLibrary.tsx");
const practice = read("src/pages/Practice/Practice.tsx");
const homeCss = sass.compileString(read("src/pages/Home/Home.scss")).css;
const libraryCss = sass.compileString(read("src/pages/BookLibrary/BookLibrary.scss")).css;

assert.doesNotMatch(home, /可跟读|册可练/, "首页不得显示可跟读数量标签");
assert.doesNotMatch(library, />可跟读</, "书库不得显示可跟读标签");
assert.match(home, /选择教材/, "空历史首页必须明确引导选择教材");
assert.match(home, /useDidShow/, "首页重显时必须重新读取本机进度");
assert.match(home, /progressPractice\.sectionTitle/, "有历史时必须展示真实章节");
assert.match(home, /progressPractice\.pageNumber/, "有历史时必须展示真实教材页");
assert.match(practice, /saveReadingProgress\(bundle\.book\.id, nextIndex\)/, "切页实际生效后必须保存合法训练位置");
assert.ok(practice.indexOf("setCurrentPractice({ practiceIndex: nextIndex") < practice.indexOf("saveReadingProgress(bundle.book.id, nextIndex)"), "进度保存必须位于训练状态提交之后");
assert.match(library, /useState<BookSeriesId \| "all">/, "系列筛选应留在保留的页面实例中");
assert.match(library, /const \[query, setQuery\] = useState\(""\)/, "搜索词应留在保留的页面实例中");
assert.match(library, /chevron-right/, "书库必须保留导航箭头");

for (const [name, css] of [["首页", homeCss], ["书库", libraryCss]]) {
  assert.match(css, /padding-left:\s*18PX/, `${name}手机基础左留白应为 18PX`);
  assert.match(css, /padding-right:\s*18PX/, `${name}手机基础右留白应为 18PX`);
  assert.match(css, /device-layout--pad[\s\S]*padding-left:\s*28PX/, `${name} Pad 左留白应为 28PX`);
  assert.match(css, /device-layout--pad[\s\S]*padding-right:\s*28PX/, `${name} Pad 右留白应为 28PX`);
}
assert.doesNotMatch(libraryCss, /padding:[^;]*constant\(/, "未保护的 padding 简写不得包含 constant 安全区");
assert.match(libraryCss, /series-filter[\s\S]*min-height:\s*44PX/, "筛选点击区至少 44PX");
assert.match(libraryCss, /book-row::after[\s\S]*left:\s*124rpx/, "书库分隔线应从文字区域开始");
assert.match(homeCss, /device-layout--pad[\s\S]*series-row::after[\s\S]*left:\s*55PX/, "Pad 首页分隔线应与固定尺寸的文字区域对齐");
assert.match(libraryCss, /device-layout--pad[\s\S]*book-row::after[\s\S]*left:\s*62PX/, "Pad 书库分隔线应与固定尺寸的文字区域对齐");
assert.match(homeCss, /continue-card__title[\s\S]*display:\s*-webkit-box[\s\S]*-webkit-line-clamp:\s*2/, "首页真实书名最多显示两行");

console.log("书架精修契约通过：标签、真实进度、留白、筛选触区和列表分隔均符合要求。");
