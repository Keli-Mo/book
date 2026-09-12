/* eslint-disable import/no-commonjs */
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const React = require("react");
const { createPage, buildBookPracticeBundle } = require("../test-practice-book-route.cjs");

// 只隔离微信原生 API；执行已安装图标组件、工具函数及 Taro 的真实尺寸换算。
function evaluateModule(file, overrides = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    name => Object.hasOwn(overrides, name) ? overrides[name] : require(name), mod, mod.exports,
  );
  return mod.exports;
}
const taroTools = evaluateModule(path.join(path.dirname(require.resolve("@tarojs/api/package.json")), "dist/tools.js"));
const taro = { getEnv: () => "WEAPP" };
taroTools.getInitPxTransform(taro)({ designWidth: 750, deviceRatio: { 750: 1 }, targetUnit: "rpx" });
taro.pxTransform = taroTools.getPxTransform(taro);
const iconPath = require.resolve("taro-ui/lib/components/icon/index.js");
const utils = evaluateModule(path.resolve(path.dirname(iconPath), "../../common/utils.js"), {
  "@tarojs/taro": { __esModule: true, default: taro },
});
const AtIcon = evaluateModule(iconPath, {
  react: React,
  "@tarojs/components": { Text: "Text" },
  "../../common/utils": utils,
}).default;
function renderAtIcon(props) {
  const rendered = new AtIcon({ ...AtIcon.defaultProps, ...props }).render();
  // 仅测试输出携带期望尺寸，便于对真实渲染结果测量，而不是猜测所有图标都应小于某阈值。
  return { ...rendered, props: { ...rendered.props, "data-ui-icon-size": props.size ?? 24 } };
}
const iconModule = { __esModule: true, default: renderAtIcon };
const settle = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

function createUiPage(name, options = {}) {
  const profile = options.profile || { windowWidth: 768, windowHeight: 1024, isPad: true, isSplit: false, orientation: "portrait", statusBarHeight: 20, safeAreaBottom: 0 };
  const storage = new Map(options.history ? [["haisha:reading-progress:v1", options.history]] : []);
  const pending = options.pendingItems || [];
  return createPage(`src/pages/${name}/${name}.tsx`, options.params || {}, {
    ...options,
    taroOverrides: {
      getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
      getMenuButtonBoundingClientRect: () => ({ top: 26, bottom: 58, left: profile.windowWidth - 100, right: profile.windowWidth - 8, width: 92, height: 32 }),
      ...options.taroOverrides,
    },
    overrides: {
      "taro-ui/lib/components/icon": iconModule,
      "@/hooks/useDeviceLayout": { useDeviceLayout: () => profile },
      "@/features/listeningPractice/checkInSubmissionRuntime": { getCheckInSubmissionCoordinator: () => ({ isSubmitting: () => false }) },
      "@/services/cloudCheckIn": {
        listMyCheckIns: async () => { if (options.cloudError) throw new Error("network unavailable"); return options.cloudRecords || []; },
        getCheckInDetail: async () => { if (options.detailError) throw new Error(options.detailError); return options.detail; },
        getReadableCloudError: error => error.message,
      },
      ...(name === "MyCheckIns" || name === "CheckInDetail" ? {
        "@/features/listeningPractice/pendingCheckInRuntime": { getPendingCheckInStore: () => ({ ready: async () => {}, cleanup: async () => {}, list: () => pending }) },
      } : {}),
      ...options.overrides,
    },
  });
}

function sampleRecording(bookId = "3", practiceIndex = 0) {
  const bundle = buildBookPracticeBundle(bookId);
  const practice = bundle.practices[practiceIndex];
  return {
    requestId: `ui-sample-${bookId}`, localPath: "/ui-fixture/record.mp3", recoverable: true,
    status: "local", durationMs: 12500, fileSizeBytes: 60000, completedAtMs: 1789180800000,
    updatedAtMs: 1789180800000, cloudFileId: "",
    context: { bookId, bookTitle: bundle.book.title, practiceIndex, pageNumber: practice.pageNumber, sectionTitle: practice.sectionTitle, imageUrl: practice.imageUrl },
  };
}
module.exports = { renderAtIcon, iconModule, createUiPage, sampleRecording, settle };
