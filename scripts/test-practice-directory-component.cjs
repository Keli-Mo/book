/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const sourcePath = path.resolve(
  __dirname,
  "../src/pages/Practice/PracticeDirectory.tsx"
);

assert.equal(fs.existsSync(sourcePath), true, "训练目录组件文件应存在");

const compiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2017,
  },
});
const moduleContainer = { exports: {} };

vm.runInNewContext(compiled.outputText, {
  module: moduleContainer,
  exports: moduleContainer.exports,
  require(moduleName) {
    if (moduleName === "@tarojs/components") {
      return { ScrollView: "scroll-view", Text: "text", View: "view" };
    }

    if (moduleName === "@/features/listeningPractice/practiceDirectory") {
      return {
        findPracticeDirectoryGroupId(groups, practiceIndex) {
          return (
            groups.find((group) =>
              group.items.some(
                (item) => item.practiceIndex === practiceIndex
              )
            )?.id || ""
          );
        },
      };
    }

    return require(moduleName);
  },
});

const PracticeDirectory = moduleContainer.exports.default;
const groups = [
  {
    id: "practice-directory-group-0",
    title: "Unit 1 课文",
    items: [
      { id: "p1", practiceIndex: 0, pageNumber: 4, trackCount: 2 },
    ],
  },
];
const selected = [];
const props = {
  groups,
  currentPracticeIndex: 0,
  open: true,
  onClose() {},
  onSelect(practiceIndex) {
    selected.push(practiceIndex);
  },
};

assert.equal(PracticeDirectory({ ...props, open: false }), null);
const tree = PracticeDirectory({ ...props, open: true });
assert.match(JSON.stringify(tree), /Unit 1 课文/);
assert.match(JSON.stringify(tree), /第 4 页/);
assert.match(JSON.stringify(tree), /2 段音频/);

const flattenElements = (node) => {
  if (node === null || node === undefined || typeof node !== "object") {
    return [];
  }

  if (Array.isArray(node)) {
    return node.flatMap(flattenElements);
  }

  return [node, ...flattenElements(node.props?.children)];
};
const directoryItem = flattenElements(tree).find((element) =>
  String(element.props?.className || "").includes("practice-directory-item ")
);

assert.ok(directoryItem, "应渲染可点击的目录项");
directoryItem.props.onClick();
assert.deepEqual(selected, [0]);

console.log("训练目录组件测试通过：关闭状态、目录内容和选择回调正确。");
