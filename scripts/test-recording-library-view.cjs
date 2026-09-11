/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const vm = require("node:vm");

const file = path.resolve(__dirname, "../src/features/listeningPractice/recordingLibraryView.ts");
const source = fs.readFileSync(file, "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const moduleValue = { exports: {} };
vm.runInNewContext(js, { module: moduleValue, exports: moduleValue.exports });
const { mergeRecordingLibrary } = moduleValue.exports;

const local = [{
  requestId: "a".repeat(32), localPath: "wxfile://local.mp3", recoverable: true,
  context: { bookId: "book", bookTitle: "教材", practiceId: "p", practiceIndex: 2, pageNumber: 8, imageUrl: "cover", sectionTitle: "第三课" },
  durationMs: 2500, fileSizeBytes: 10, cloudFileId: "", status: "local", updatedAtMs: 200,
  completedAtMs: 180, share: { id: "cloud-1", shareToken: "secret", expiresAtMs: 999 },
}];
const cloud = [
  { id: "cloud-1", shareToken: "secret", bookId: "book", bookTitle: "教材", practiceId: "p", practiceIndex: 2, pageNumber: 8, imageUrl: "cover", sectionTitle: "第三课", durationMs: 2500, createdAt: 180 },
  { id: "cloud-2", shareToken: "old", bookId: "book", bookTitle: "教材", practiceId: "p2", practiceIndex: 3, pageNumber: 9, imageUrl: "cover", sectionTitle: "第四课", durationMs: 3000, createdAt: 100 },
];
const result = mergeRecordingLibrary(local, cloud);
assert.equal(result.length, 2, "同一 share.id 的云记录必须去重");
assert.equal(result[0].kind, "local", "本地录音优先展示");
assert.equal(result[0].localId, "a".repeat(32));
assert.equal(result[1].kind, "cloud");

console.log("录音库合并运行时测试通过：本地优先且云记录按 share.id 去重。");
