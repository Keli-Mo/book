/* eslint-disable import/no-commonjs */
const assert = require('node:assert/strict');
const path = require('node:path');
const { readWxssWithImports } = require('./helpers/read-wxss.cjs');

const entry = path.resolve('wxss-fixture/app.wxss');
const sources = new Map([
  [entry, '@import "./base.wxss";@import "./common.wxss";.page{color:green}'],
  [path.resolve('wxss-fixture/base.wxss'), '.base{min-height:100vh}'],
  [path.resolve('wxss-fixture/common.wxss'), "@import './nested/tokens.wxss';.nav{height:44PX}"],
  [path.resolve('wxss-fixture/nested/tokens.wxss'), '.tokens{color:red}'],
]);
const read = file => {
  if (!sources.has(file)) throw new Error(`Missing fixture: ${file}`);
  return sources.get(file);
};
assert.equal(readWxssWithImports(entry, read), '.base{min-height:100vh}.tokens{color:red}.nav{height:44PX}.page{color:green}', '必须按构建引用次序展开公共导航和全局样式');
sources.set(entry, '@import "./base.wxss";.middle{}@import "./base.wxss";');
assert.equal(readWxssWithImports(entry, read), '.base{min-height:100vh}.middle{}.base{min-height:100vh}', '重复引用必须保留原位置，不能改变级联顺序');
sources.set(entry, '@import "./app.wxss";');
assert.throws(() => readWxssWithImports(entry, read), /循环引用/, '循环引用应报错，不应无限递归');
sources.set(entry, '@import "./missing.wxss";');
assert.throws(() => readWxssWithImports(entry, read), /Missing fixture/, '缺失构建产物不可静默忽略');
sources.set(entry, '.plain{background:url(data:image/png;base64,AA==)}');
assert.equal(readWxssWithImports(entry, read), sources.get(entry), '普通样式和内联资源原样保留');
console.log('WXSS 引用测试通过：嵌套、次序、重复、循环、缺失与普通样式。');
