const assert = require("node:assert/strict");
const { Weapp } = require("@tarojs/plugin-platform-weapp");
const helper = require("@tarojs/helper");
const { getComponentsAlias } = require("@tarojs/shared");
// Normally supplied by Taro's webpack DefinePlugin; disable unrelated DOM extras.
for (const flag of ["ENABLE_INNER_HTML", "ENABLE_ADJACENT_HTML", "ENABLE_CLONE_NODE", "ENABLE_CONTAINS", "ENABLE_SIZE_APIS", "ENABLE_TEMPLATE_CONTENT", "ENABLE_MUTATION_OBSERVER"]) global[flag] = false;
const runtime = require("@tarojs/runtime/dist/index.cjs.js");
const plugin = require("./taro-voice-accessibility.cjs");

const ctx = { helper, paths: {}, modifyWebpackChain() {} };
const platform = new Weapp(ctx, { compiler: "webpack5" }, {});
platform.modifyTemplate({});
const template = platform.template;
const aliasesBefore = getComponentsAlias(template.internalComponents);
const propertiesBefore = JSON.stringify(template.internalComponents);
let setup;
plugin({ registerMethod({ name, fn }) {
  assert.equal(name, "onSetupClose");
  setup = fn;
} });
setup(platform);

const output = template.buildTemplate({
  includes: new Set(["button", "view", "static-view"]),
  includeAll: false,
  thirdPartyComponents: new Map(),
});
assert.equal(JSON.stringify(template.internalComponents), propertiesBefore, "不能改动内置组件属性表");
assert.deepEqual(template.componentsAlias, aliasesBefore, "既有组件与属性的压缩别名必须保持一致");
assert.match(output, /<button\b[^>]*\baria-label="\{\{i\.ariaLabel\}\}"/, "图标按钮须输出动态原生无障碍标签");
assert.match(output, /<view\b[^>]*\baria-label="\{\{i\.ariaLabel\}\}"/, "View 标签也须透传");
assert.match(output, /<view\b[^>]*\baria-role="\{\{i\.ariaRole\}\}"/, "View 的角色须透传");

const button = runtime.document.createElement("button");
button.setAttribute("ariaLabel", "开始说英语");
assert.equal(runtime.hydrate(button).ariaLabel, "开始说英语");
button.setAttribute("ariaLabel", "结束说话并发送");
assert.equal(runtime.hydrate(button).ariaLabel, "结束说话并发送", "状态切换后的动态标签不能固定在首次值");
const view = runtime.document.createElement("view");
view.setAttribute("ariaLabel", "语音处理失败");
view.setAttribute("ariaRole", "alert");
assert.equal(runtime.hydrate(view).ariaLabel, "语音处理失败");
assert.equal(runtime.hydrate(view).ariaRole, "alert");

const untouched = {};
setup({ platform: "h5", template: untouched });
assert.deepEqual(untouched, {}, "补齐仅作用于微信模板");
console.log("voice accessibility template and dynamic labels checks passed");
