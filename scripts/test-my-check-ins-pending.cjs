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
assert.doesNotMatch(page, /submissionCoordinator\.submit\s*\(/, "列表展示和回听不得启动上传");
assert.match(page, /submissionCoordinator\.isSubmitting\s*\(/, "上传中的本机文件不得删除");
assert.match(page, /pendingStore\.remove\s*\(/);
assert.match(page, /setLocalRecords[\s\S]*?await\s+listMyCheckIns/, "本地录音必须先于云历史落屏");
assert.match(page, /正在加载录音…/, "首屏必须先展示加载态，不能空列表闪成卡片");
assert.match(page, /finally\s*\{[\s\S]*?setLoading\(false\)/, "云端成功或失败后都必须结束加载态");
assert.match(page, /title:\s*["']删除本机录音？["']/);

for (const copy of ["待上传", "已上传待确认", "继续提交"]) assert.equal(page.includes(copy), false);
for (const copy of ["我的录音", "回听 / 分享", "临时文件"]) assert.ok(page.includes(copy));

for (const field of [
  "context?.imageUrl",
  "context?.bookTitle",
  "context?.sectionTitle",
  "context?.pageNumber",
  "durationMs",
]) {
  assert.ok(page.includes(field), `待上传卡片必须展示 ${field}`);
}

assert.match(page, /CheckInDetail\/CheckInDetail\?localId=/);
assert.match(page, /CheckInDetail\/CheckInDetail\?id=/);
assert.match(styles, /pending-check-in-status/);

console.log("我的录音接线测试通过：本地优先、云端补充、详情与安全删除均已接入。");
