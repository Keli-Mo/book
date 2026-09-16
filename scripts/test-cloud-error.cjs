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
const secretMarker = "SYNTHETIC_PRIVATE_VALUE";
const unsafeMessage = `https://example.test/audio?token=${secretMarker}`;
for (const [error, expected] of [
  [new Error(unsafeMessage), "操作失败，请稍后重试"],
  [{ errMsg: `cloud.callFunction:fail network ${unsafeMessage}`, code: "ETIMEDOUT" }, "网络请求超时，请稍后重试"],
  [`FunctionName checkIn not found ${unsafeMessage}`, "云函数尚未部署，请先在微信开发者工具中上传并部署 checkIn 云函数"],
  [{ message: `DATABASE_COLLECTION_NOT_EXIST ${unsafeMessage}` }, "云数据库尚未创建 checkins 集合，请先按部署说明完成初始化"],
  [{ errCode: -404001, errMsg: `cloud.uploadFile:fail storage permission denied ${unsafeMessage}` }, "录音上传失败，请检查网络或云存储配置后重试"],
  [{ code: 12345, message: unsafeMessage }, "操作失败，请稍后重试"],
  [{ code: `UNKNOWN_${secretMarker}`, message: unsafeMessage }, "操作失败，请稍后重试"],
]) {
  const readable = getReadableCloudError(error);
  assert.equal(readable, expected);
  assert.equal(readable.includes(secretMarker), false);
}

console.log("云开发错误提示测试通过：错误对象、字符串及任意错误码均使用固定安全分类。");
