/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const sourcePath = path.resolve(
  __dirname,
  "../src/features/listeningPractice/checkInSubmissionRuntime.ts",
);
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
});

const pendingStore = { name: "shared-pending-store" };
const cloud = {
  getCheckInRecordingInfo() {},
  prepareCheckIn() {},
  startPreparedCheckInUpload() {},
  commitCheckIn() {},
};
let capturedAdapters;
const coordinator = { submit() {} };
const moduleContainer = { exports: {} };
vm.runInNewContext(compiled.outputText, {
  module: moduleContainer,
  exports: moduleContainer.exports,
  require(name) {
    if (name === "./checkInSubmissionCoordinator") {
      return {
        createCheckInSubmissionCoordinator(adapters) {
          capturedAdapters = adapters;
          return coordinator;
        },
      };
    }
    if (name === "./pendingCheckInRuntime") {
      return { getPendingCheckInStore: () => pendingStore };
    }
    if (name === "@/services/cloudCheckIn") return cloud;
    throw new Error(`unexpected import: ${name}`);
  },
  Date,
  setTimeout,
  clearTimeout,
});

const runtime = moduleContainer.exports;
assert.strictEqual(runtime.getCheckInSubmissionCoordinator(), coordinator);
assert.strictEqual(runtime.getCheckInSubmissionCoordinator(), coordinator);
assert.strictEqual(capturedAdapters.pendingStore, pendingStore);
assert.strictEqual(capturedAdapters.getRecordingInfo, cloud.getCheckInRecordingInfo);
assert.strictEqual(capturedAdapters.prepareCheckIn, cloud.prepareCheckIn);
assert.strictEqual(
  capturedAdapters.startPreparedCheckInUpload,
  cloud.startPreparedCheckInUpload,
);
assert.strictEqual(capturedAdapters.commitCheckIn, cloud.commitCheckIn);
assert.equal(typeof capturedAdapters.scheduler.setTimeout, "function");
assert.equal(typeof capturedAdapters.scheduler.clearTimeout, "function");

console.log("打卡提交运行时测试通过：跨页面单例与云端适配接线正确。");
