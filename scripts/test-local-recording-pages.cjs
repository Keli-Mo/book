/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const practice = read("src/pages/Practice/Practice.tsx");
const library = read("src/pages/MyCheckIns/MyCheckIns.tsx");
const detail = read("src/pages/CheckInDetail/CheckInDetail.tsx");

for (const [name, source] of [["Practice", practice], ["MyCheckIns", library], ["CheckInDetail", detail]]) {
  const ast = ts.createSourceFile(`${name}.tsx`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.equal(ast.parseDiagnostics.length, 0, `${name} 必须可解析`);
}

assert.match(practice, /await\s+getPendingCheckInStore\(\)\.complete\(pending\.requestId,\s*true\)/);
assert.match(practice, /CheckInDetail\/CheckInDetail\?localId=/);
assert.doesNotMatch(practice, /getCheckInSubmissionCoordinator\(\)\.submit\(/,
  "完成练习不能启动云端分享流水线");

assert.match(detail, /router\.params\?\.localId/);
assert.match(detail, /pendingStore\.list\(\)/);
assert.match(detail, /pendingStore\.beginShare\(/);
assert.match(detail, /submissionCoordinator\.submit\(/);
assert.match(detail, /openType=['"]share['"]/);
assert.match(detail, /expiresAtMs\s*>\s*Date\.now\(\)/);
assert.match(detail, /useDidShow\(\(\)\s*=>\s*\{\s*visibleRef\.current\s*=\s*true/);
assert.match(detail, /await\s+pendingStore\.beginShare\(localId\)[\s\S]*?visibleRef\.current[\s\S]*?submissionCoordinator\.submit\(snapshot\)/,
  "beginShare 迟到时必须先检查页面仍可见再上传");
assert.match(detail, /finally\s*\{[\s\S]*?setSharing\(false\)/, "分享准备异常也必须解除 loading");
assert.match(detail, /Math\.min\(expiresAtMs\s*-\s*Date\.now\(\)\s*\+\s*20,\s*2_147_000_000\)/, "页面停留跨过期点必须分段刷新按钮");
assert.doesNotMatch(detail, /path:[^\n]*localId/, "分享卡片不得暴露本地编号");

assert.match(library, /我的录音/);
assert.match(library, /共\s*\$\{libraryRecords\.length\}\s*次/);
assert.match(library, /正在加载录音…/);
assert.doesNotMatch(library, /待上传|已上传待确认|继续提交/);
assert.match(library, /localId=/);

console.log("本地录音页面契约测试通过。");
