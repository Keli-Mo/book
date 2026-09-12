/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const sourcePath = path.resolve(
  __dirname,
  "../src/features/bookLibrary/homeNavigation.ts",
);

assert.equal(fs.existsSync(sourcePath), true, "首页导航栏尺寸模型应存在");

const compiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2017,
  },
});
const moduleContainer = { exports: {} };

vm.runInNewContext(compiled.outputText, {
  module: moduleContainer,
  exports: moduleContainer.exports,
});

const { calculateHomeNavigationMetrics } = moduleContainer.exports;
const projectRoot = path.resolve(__dirname, "..");
const home = fs.readFileSync(
  path.join(projectRoot, "src/pages/Home/Home.tsx"),
  "utf8",
);
const myCheckIns = fs.readFileSync(
  path.join(projectRoot, "src/pages/MyCheckIns/MyCheckIns.tsx"),
  "utf8",
);
const createTsxProgram = (fileName, source) => {
  const absoluteFileName = path.resolve(fileName);
  const compilerOptions = {
    jsx: ts.JsxEmit.React,
    noLib: true,
    target: ts.ScriptTarget.ESNext,
  };
  const host = ts.createCompilerHost(compilerOptions, true);
  host.getSourceFile = (requestedFileName, languageVersion) =>
    path.resolve(requestedFileName) === absoluteFileName
      ? ts.createSourceFile(
          absoluteFileName,
          source,
          languageVersion,
          true,
          ts.ScriptKind.TSX,
        )
      : undefined;
  host.fileExists = (requestedFileName) =>
    path.resolve(requestedFileName) === absoluteFileName;
  host.readFile = (requestedFileName) =>
    path.resolve(requestedFileName) === absoluteFileName ? source : undefined;
  const program = ts.createProgram([absoluteFileName], compilerOptions, host);
  return {
    checker: program.getTypeChecker(),
    sourceFile: program.getSourceFile(absoluteFileName),
  };
};
const findNodes = (node, predicate, results = []) => {
  if (predicate(node)) results.push(node);
  ts.forEachChild(node, (child) => {
    findNodes(child, predicate, results);
  });
  return results;
};
const isIdentifier = (node, name) => ts.isIdentifier(node) && node.text === name;
const isNamedImportBinding = (checker, identifier, moduleSpecifier, exportName) => {
  const symbol = checker.getSymbolAtLocation(identifier);
  return Boolean(
    symbol?.declarations?.some((declaration) => {
      if (
        !ts.isImportSpecifier(declaration) ||
        declaration.name.text !== exportName ||
        (declaration.propertyName && declaration.propertyName.text !== exportName)
      ) {
        return false;
      }

      let ancestor = declaration.parent;
      while (ancestor && !ts.isImportDeclaration(ancestor)) ancestor = ancestor.parent;
      return (
        ancestor &&
        ts.isStringLiteral(ancestor.moduleSpecifier) &&
        ancestor.moduleSpecifier.text === moduleSpecifier
      );
    }),
  );
};
const isDefaultPracticeUrl = (node, checker) =>
  ts.isTemplateExpression(node) &&
  node.head.text === "/pages/Practice/Practice?bookId=" &&
  node.templateSpans.length === 1 &&
  isIdentifier(node.templateSpans[0].expression, "DEFAULT_BOOK_ID") &&
  isNamedImportBinding(
    checker,
    node.templateSpans[0].expression,
    "@/features/listeningPractice/bookPractice",
    "DEFAULT_BOOK_ID",
  ) &&
  node.templateSpans[0].literal.text === "&practice=0";
const isDefaultPracticeNavigation = (node, checker) => {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression) ||
    !isIdentifier(node.expression.expression, "Taro") ||
    node.expression.name.text !== "navigateTo" ||
    node.arguments.length !== 1 ||
    !ts.isObjectLiteralExpression(node.arguments[0])
  ) {
    return false;
  }

  return node.arguments[0].properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      isIdentifier(property.name, "url") &&
      isDefaultPracticeUrl(property.initializer, checker),
  );
};
const assertEmptyCheckInDefaultEntry = (source) => {
  const { checker, sourceFile } = createTsxProgram("MyCheckIns.tsx", source);
  const firstPracticeButton = findNodes(
    sourceFile,
    (node) =>
      ts.isJsxElement(node) &&
      ts.isJsxOpeningElement(node.openingElement) &&
      isIdentifier(node.openingElement.tagName, "Button") &&
      node.children.some(
        (child) => ts.isJsxText(child) && child.getText(sourceFile).includes("开始第一次跟读"),
      ),
  )[0];
  assert.ok(firstPracticeButton, "空打卡状态必须提供开始第一次跟读按钮");
  const click = firstPracticeButton.openingElement.attributes.properties.find(
    (property) => ts.isJsxAttribute(property) && isIdentifier(property.name, "onClick"),
  );
  assert.ok(
    click &&
      click.initializer &&
      ts.isJsxExpression(click.initializer) &&
      click.initializer.expression &&
      ts.isArrowFunction(click.initializer.expression) &&
      findNodes(click.initializer.expression.body, (node) =>
        isDefaultPracticeNavigation(node, checker),
      ).length === 1,
    "空打卡按钮必须在实际点击处理器中用从 bookPractice 导入的 DEFAULT_BOOK_ID 导航至训练路由",
  );
};

assert.deepEqual(
  JSON.parse(
    JSON.stringify(
      calculateHomeNavigationMetrics(390, 47, {
        top: 51,
        bottom: 83,
        left: 294,
        right: 381,
        width: 87,
        height: 32,
      }),
    ),
  ),
  { statusBarHeight: 47, navigationHeight: 40, capsuleReserve: 104 },
  "应根据 iOS 胶囊位置计算导航高度和右侧留白",
);
assert.deepEqual(
  JSON.parse(
    JSON.stringify(
      calculateHomeNavigationMetrics(412, 24, {
        top: 30,
        bottom: 62,
        left: 316,
        right: 403,
        width: 87,
        height: 32,
      }),
    ),
  ),
  { statusBarHeight: 24, navigationHeight: 44, capsuleReserve: 104 },
  "应适配 Android 不同状态栏高度",
);

const normalize = (value) => JSON.parse(JSON.stringify(value));
const assertNavigationFallback = (
  scenario,
  windowWidth,
  statusBarHeight,
  menuButton,
  expectedStatusBarHeight = 20,
) => {
  const actual = normalize(
    calculateHomeNavigationMetrics(windowWidth, statusBarHeight, menuButton),
  );
  assert.deepEqual(
    actual,
    {
      statusBarHeight: expectedStatusBarHeight,
      navigationHeight: 44,
      capsuleReserve: 96,
    },
    `${scenario}：无效导航输入必须得到稳定回退`,
  );
  for (const key of ["statusBarHeight", "navigationHeight", "capsuleReserve"]) {
    assert.ok(Number.isFinite(actual[key]), `${scenario}：${key} 必须是有限数`);
  }
};

const validMenuButton = {
  top: 51,
  bottom: 83,
  left: 294,
  right: 381,
  width: 87,
  height: 32,
};
assertNavigationFallback("胶囊缺失", 390, 47, undefined, 47);

for (const [name, invalidValue] of [
  ["NaN", Number.NaN],
  ["正 Infinity", Number.POSITIVE_INFINITY],
  ["负 Infinity", Number.NEGATIVE_INFINITY],
  ["负数", -1],
  ["零", 0],
]) {
  for (const field of ["top", "bottom", "left", "right", "width", "height"]) {
    assertNavigationFallback(
      `胶囊 ${field} 为${name}`,
      390,
      47,
      { ...validMenuButton, [field]: invalidValue },
      47,
    );
  }
}

for (const [scenario, menuButton] of [
  ["胶囊垂直几何次序相等", { ...validMenuButton, bottom: validMenuButton.top }],
  ["胶囊垂直几何次序反向", { ...validMenuButton, bottom: validMenuButton.top - 1 }],
  ["胶囊顶部越过状态栏", { ...validMenuButton, top: 46 }],
  ["胶囊水平几何次序相等", { ...validMenuButton, right: validMenuButton.left }],
  ["胶囊水平几何次序反向", { ...validMenuButton, right: validMenuButton.left - 1 }],
  ["胶囊右侧越过窗口", { ...validMenuButton, right: 391 }],
]) {
  assertNavigationFallback(scenario, 390, 47, menuButton, 47);
}

for (const [name, invalidValue] of [
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["负数", -1],
  ["零", 0],
]) {
  assertNavigationFallback(`windowWidth 为${name}`, invalidValue, 47, validMenuButton, 47);
  assertNavigationFallback(`statusBarHeight 为${name}`, 390, invalidValue, validMenuButton);
}

assert.doesNotMatch(home, /DEFAULT_BOOK_ID/, "首页不得伪造固定教材的上次进度");
assert.match(home, /readReadingProgress/, "首页入口应来自已校验的本机阅读进度");
assertEmptyCheckInDefaultEntry(myCheckIns);

const assertDefaultBookReferenceUsesPracticeImport = (source) => {
  const { checker, sourceFile } = createTsxProgram("DefaultBook.fixture.tsx", source);
  const template = findNodes(
    sourceFile,
    (node) =>
      ts.isTemplateExpression(node) &&
      node.head.text === "/pages/Practice/Practice?bookId=" &&
      node.templateSpans.length === 1 &&
      isIdentifier(node.templateSpans[0].expression, "DEFAULT_BOOK_ID") &&
      node.templateSpans[0].literal.text === "&practice=0",
  )[0];
  assert.ok(template, "变异 fixture 必须包含默认教材训练 URL");
  assert.ok(
    isNamedImportBinding(
      checker,
      template.templateSpans[0].expression,
      "@/features/listeningPractice/bookPractice",
      "DEFAULT_BOOK_ID",
    ),
    "实际 URL 的 DEFAULT_BOOK_ID 必须绑定到 bookPractice 命名导入",
  );
};
const defaultBookShadowFixtures = [
  [
    "函数参数",
    `import { DEFAULT_BOOK_ID } from "@/features/listeningPractice/bookPractice";
function startPractice(DEFAULT_BOOK_ID) {
  return \`/pages/Practice/Practice?bookId=\${DEFAULT_BOOK_ID}&practice=0\`;
}`,
  ],
  [
    "箭头参数",
    `import { DEFAULT_BOOK_ID } from "@/features/listeningPractice/bookPractice";
const startPractice = (DEFAULT_BOOK_ID) =>
  \`/pages/Practice/Practice?bookId=\${DEFAULT_BOOK_ID}&practice=0\`;`,
  ],
  [
    "局部变量",
    `import { DEFAULT_BOOK_ID } from "@/features/listeningPractice/bookPractice";
const startPractice = () => {
  const DEFAULT_BOOK_ID = "25";
  return \`/pages/Practice/Practice?bookId=\${DEFAULT_BOOK_ID}&practice=0\`;
};`,
  ],
  [
    "局部函数",
    `import { DEFAULT_BOOK_ID } from "@/features/listeningPractice/bookPractice";
const startPractice = () => {
  function DEFAULT_BOOK_ID() { return "25"; }
  return \`/pages/Practice/Practice?bookId=\${DEFAULT_BOOK_ID}&practice=0\`;
};`,
  ],
  [
    "局部类",
    `import { DEFAULT_BOOK_ID } from "@/features/listeningPractice/bookPractice";
const startPractice = () => {
  class DEFAULT_BOOK_ID {}
  return \`/pages/Practice/Practice?bookId=\${DEFAULT_BOOK_ID}&practice=0\`;
};`,
  ],
  [
    "catch binding",
    `import { DEFAULT_BOOK_ID } from "@/features/listeningPractice/bookPractice";
const startPractice = () => {
  try { throw "25"; } catch (DEFAULT_BOOK_ID) {
    return \`/pages/Practice/Practice?bookId=\${DEFAULT_BOOK_ID}&practice=0\`;
  }
};`,
  ],
];
for (const [name, fixture] of defaultBookShadowFixtures) {
  assert.throws(
    () => assertDefaultBookReferenceUsesPracticeImport(fixture),
    /绑定到 bookPractice/,
    `变异负例：${name} DEFAULT_BOOK_ID 不得遮蔽 bookPractice 命名导入`,
  );
}

const myCheckInsArrowParameterFixture = `
import { DEFAULT_BOOK_ID } from "@/features/listeningPractice/bookPractice";
const MyCheckIns = () => {
  const records = [];
  if (records.length === 0) {
    return (
      <Button onClick={(DEFAULT_BOOK_ID) => Taro.navigateTo({
        url: \`/pages/Practice/Practice?bookId=\${DEFAULT_BOOK_ID}&practice=0\`,
      })}>开始第一次跟读</Button>
    );
  }
  return null;
};`;
assert.throws(
  () => assertEmptyCheckInDefaultEntry(myCheckInsArrowParameterFixture),
  /实际点击处理器/,
  "变异负例：MyCheckIns 空打卡按钮的 onClick 参数不得遮蔽 bookPractice 默认教材",
);

console.log("首页导航测试通过：胶囊尺寸及两个默认入口的真实导入和点击路由均正确。");
