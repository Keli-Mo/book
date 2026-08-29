/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const sourcePath = path.resolve(__dirname, "../src/services/cloudCheckIn.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2017,
  },
});
const moduleContainer = { exports: {} };

vm.runInNewContext(compiled.outputText, {
  module: moduleContainer,
  exports: moduleContainer.exports,
  console,
});

const { getReadableCloudError } = moduleContainer.exports;
const uploadError = {
  errCode: -404001,
  errMsg: "cloud.uploadFile:fail storage permission denied",
};
const readable = getReadableCloudError(uploadError);

assert.match(readable, /-404001/, "上传失败提示应保留云开发错误码");
assert.match(
  readable,
  /cloud\.uploadFile:fail storage permission denied/,
  "上传失败提示应保留云开发原始错误信息",
);

console.log("云开发错误提示测试通过：上传错误码和原始信息可用于定位故障。");
