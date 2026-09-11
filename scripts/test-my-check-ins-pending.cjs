/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const page = fs.readFileSync(
  path.join(root, "src/pages/MyCheckIns/MyCheckIns.tsx"),
  "utf8",
);
const styles = fs.readFileSync(
  path.join(root, "src/pages/MyCheckIns/MyCheckIns.scss"),
  "utf8",
);

const pageAst = ts.createSourceFile(
  "MyCheckIns.tsx",
  page,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
assert.equal(pageAst.parseDiagnostics.length, 0, "MyCheckIns.tsx 必须可被 TypeScript 解析");

for (const required of [
  "getPendingCheckInStore",
  "getCheckInSubmissionCoordinator",
  "useDidShow",
  "useDidHide",
  "useUnload",
]) {
  assert.match(page, new RegExp(`\\b${required}\\b`), `我的打卡必须接入 ${required}`);
}

assert.match(page, /await\s+pendingStore\.ready\s*\(\s*\)/);
assert.match(page, /await\s+pendingStore\.cleanup\s*\(\s*\)/);
assert.match(page, /pendingStore\.list\s*\(\s*\)/);
assert.match(page, /submissionCoordinator\.submit\s*\(/);
assert.match(page, /onProgress\s*:/);
assert.match(page, /\.cancel\s*\(\s*\)/);
assert.match(page, /pendingStore\.remove\s*\(/);
assert.match(
  page,
  /errorMessage\s*&&\s*pendingRecords\.length\s*===\s*0\s*&&\s*records\.length\s*===\s*0/,
  "云端失败时不能遮住仍可管理的本地录音",
);
assert.match(page, /title:\s*["']删除本地录音？["']/);
assert.match(page, /!pending\.recoverable\s*&&\s*!progress/);

for (const copy of [
  "本地待提交",
  "提交失败",
  "已上传待确认",
  "继续提交",
  "取消提交",
  "删除本地录音",
  "进度暂不可用",
]) {
  assert.ok(page.includes(copy), `待上传卡片缺少文案：${copy}`);
}

for (const field of [
  "context.imageUrl",
  "context.bookTitle",
  "context.sectionTitle",
  "context.pageNumber",
  "durationMs",
]) {
  assert.ok(page.includes(field), `待上传卡片必须展示 ${field}`);
}

assert.match(page, /CheckInDetail\/CheckInDetail\?id=/);
assert.match(page, /my-check-ins__notice/);
assert.match(styles, /&--pending/);
assert.match(styles, /pending-check-in-status/);

console.log("我的打卡待上传录音接线测试通过：恢复、显式提交、取消、进度与本地删除均已接入。");
