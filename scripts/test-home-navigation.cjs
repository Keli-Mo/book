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
const parseTsx = (fileName, source) =>
  ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const findNodes = (node, predicate, results = []) => {
  if (predicate(node)) results.push(node);
  ts.forEachChild(node, (child) => {
    findNodes(child, predicate, results);
  });
  return results;
};
const isIdentifier = (node, name) => ts.isIdentifier(node) && node.text === name;
const hasDefaultBookImport = (sourceFile) =>
  sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "@/features/listeningPractice/bookPractice" &&
      statement.importClause &&
      statement.importClause.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (element) =>
          element.name.text === "DEFAULT_BOOK_ID" &&
          (!element.propertyName || element.propertyName.text === "DEFAULT_BOOK_ID"),
      ),
  );
const hasLocalDefaultBookIdBinding = (sourceFile) =>
  findNodes(
    sourceFile,
    (node) => ts.isVariableDeclaration(node) && isIdentifier(node.name, "DEFAULT_BOOK_ID"),
  ).length > 0;
const isDefaultPracticeUrl = (node) =>
  ts.isTemplateExpression(node) &&
  node.head.text === "/pages/Practice/Practice?bookId=" &&
  node.templateSpans.length === 1 &&
  isIdentifier(node.templateSpans[0].expression, "DEFAULT_BOOK_ID") &&
  node.templateSpans[0].literal.text === "&practice=0";
const isDefaultPracticeNavigation = (node) => {
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
      isDefaultPracticeUrl(property.initializer),
  );
};
const getVariableArrowFunction = (sourceFile, name) => {
  const declaration = findNodes(
    sourceFile,
    (node) =>
      ts.isVariableDeclaration(node) &&
      isIdentifier(node.name, name) &&
      node.initializer &&
      ts.isArrowFunction(node.initializer),
  )[0];
  return declaration?.initializer;
};
const assertHomeDefaultEntry = (source) => {
  const sourceFile = parseTsx("Home.tsx", source);
  assert.ok(
    hasDefaultBookImport(sourceFile),
    "首页必须从 @/features/listeningPractice/bookPractice 精确导入 DEFAULT_BOOK_ID",
  );
  assert.equal(
    hasLocalDefaultBookIdBinding(sourceFile),
    false,
    "首页实际点击路径不得用局部 DEFAULT_BOOK_ID 遮蔽统一导入",
  );
  const startPractice = getVariableArrowFunction(sourceFile, "startPractice");
  assert.ok(startPractice, "首页必须保留 startPractice 实际点击处理器");
  assert.ok(
    findNodes(startPractice.body, isDefaultPracticeNavigation).length === 1,
    "首页 startPractice 必须用 DEFAULT_BOOK_ID 导航至实际训练路由",
  );
  assert.ok(
    findNodes(
      sourceFile,
      (node) =>
        ts.isJsxAttribute(node) &&
        isIdentifier(node.name, "onClick") &&
        node.initializer &&
        ts.isJsxExpression(node.initializer) &&
        isIdentifier(node.initializer.expression, "startPractice"),
    ).length === 1,
    "首页继续跟读按钮必须绑定 startPractice",
  );
};
const assertEmptyCheckInDefaultEntry = (source) => {
  const sourceFile = parseTsx("MyCheckIns.tsx", source);
  assert.ok(
    hasDefaultBookImport(sourceFile),
    "我的打卡必须从 @/features/listeningPractice/bookPractice 精确导入 DEFAULT_BOOK_ID",
  );
  assert.equal(
    hasLocalDefaultBookIdBinding(sourceFile),
    false,
    "我的打卡实际点击路径不得用局部 DEFAULT_BOOK_ID 遮蔽统一导入",
  );
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
      findNodes(click.initializer.expression.body, isDefaultPracticeNavigation).length === 1,
    "空打卡按钮必须在实际点击处理器中用 DEFAULT_BOOK_ID 导航至训练路由",
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
assertHomeDefaultEntry(home);
assertEmptyCheckInDefaultEntry(myCheckIns);

const localConstantMutation = (source) =>
  source.replace(
    'import { DEFAULT_BOOK_ID } from "@/features/listeningPractice/bookPractice";',
    'const DEFAULT_BOOK_ID = "3";',
  );
const shadowedLocalConstantMutation = (source) =>
  source.replace(
    "return (",
    'const DEFAULT_BOOK_ID = "25";\n\n  return (',
  );
const deadTokenAndWrongUrlMutation = (source) =>
  source.replace(
    'url: `/pages/Practice/Practice?bookId=${DEFAULT_BOOK_ID}&practice=0`,',
    'url: "/pages/Practice/Practice?practice=0", // bookId=${DEFAULT_BOOK_ID}&practice=0',
  );
for (const [name, assertEntry, source] of [
  ["首页", assertHomeDefaultEntry, home],
  ["空打卡入口", assertEmptyCheckInDefaultEntry, myCheckIns],
]) {
  assert.throws(
    () => assertEntry(localConstantMutation(source)),
    /精确导入/,
    `变异负例：${name} 不得用局部同名 DEFAULT_BOOK_ID 代替统一导入`,
  );
  assert.throws(
    () => assertEntry(shadowedLocalConstantMutation(source)),
    /局部 DEFAULT_BOOK_ID 遮蔽/,
    `变异负例：${name} 不得保留导入后又用局部 DEFAULT_BOOK_ID 遮蔽它`,
  );
  assert.throws(
    () => assertEntry(deadTokenAndWrongUrlMutation(source)),
    /实际.*训练路由/,
    `变异负例：${name} 不得用注释 token 掩盖无 bookId 的实际导航`,
  );
}

console.log("首页导航测试通过：胶囊尺寸及两个默认入口的真实导入和点击路由均正确。");
