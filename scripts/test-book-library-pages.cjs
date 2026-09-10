/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const projectRoot = path.resolve(__dirname, "..");
const readSource = (relativePath) =>
  fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
const findNodes = (node, predicate, results = []) => {
  if (predicate(node)) results.push(node);
  ts.forEachChild(node, (child) => {
    findNodes(child, predicate, results);
  });
  return results;
};
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
const getVariable = (sourceFile, name) =>
  findNodes(
    sourceFile,
    (node) =>
      ts.isVariableDeclaration(node) &&
      isIdentifier(node.name, name) &&
      node.initializer,
  )[0];
const isCatalogResolverCall = (node, checker, argumentName) =>
  ts.isCallExpression(node) &&
  isIdentifier(node.expression, "resolveBookAction") &&
  node.arguments.length === 1 &&
  isIdentifier(node.arguments[0], argumentName) &&
  isNamedImportBinding(
    checker,
    node.expression,
    "@/features/bookLibrary/bookCatalog",
    "resolveBookAction",
  );
const isNavigateWithActionUrl = (node) => {
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

  const url = node.arguments[0].properties.find(
    (property) =>
      ts.isPropertyAssignment(property) &&
      isIdentifier(property.name, "url"),
  );
  return (
    url &&
    ts.isPropertyAccessExpression(url.initializer) &&
    isIdentifier(url.initializer.expression, "action") &&
    url.initializer.name.text === "url"
  );
};
const assertBookNavigationChain = (source) => {
  const { checker, sourceFile } = createTsxProgram("BookLibrary.tsx", source);
  const openBook = getVariable(sourceFile, "openBook");
  assert.ok(
    openBook && ts.isArrowFunction(openBook.initializer),
    "书库必须声明 openBook(book) 点击处理器",
  );
  assert.equal(
    openBook.initializer.parameters.length,
    1,
    "openBook 必须只接收当前列表教材",
  );
  assert.ok(
    isIdentifier(openBook.initializer.parameters[0].name, "book"),
    "openBook 参数必须是当前列表教材 book",
  );

  const action = findNodes(
    openBook.initializer.body,
    (node) =>
      ts.isVariableDeclaration(node) &&
      isIdentifier(node.name, "action") &&
      node.initializer &&
      isCatalogResolverCall(node.initializer, checker, "book"),
  )[0];
  assert.ok(
    action,
    "openBook 必须把当前 book 传给从 bookCatalog 导入的 resolveBookAction(book)",
  );
  assert.ok(
    findNodes(openBook.initializer.body, isNavigateWithActionUrl).length > 0,
    "openBook 必须将 resolver 的 action.url 交给 Taro.navigateTo",
  );

  const bookRows = findNodes(
    sourceFile,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      isIdentifier(node.expression.expression, "visibleBooks") &&
      node.expression.name.text === "map" &&
      ts.isArrowFunction(node.arguments[0]) &&
      isIdentifier(node.arguments[0].parameters[0]?.name, "book"),
  );
  assert.equal(bookRows.length, 1, "书库列表必须遍历 visibleBooks 的当前 book");
  const rowClick = findNodes(
    bookRows[0].arguments[0].body,
    (node) =>
      ts.isJsxAttribute(node) &&
      isIdentifier(node.name, "onClick") &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression &&
      ts.isArrowFunction(node.initializer.expression) &&
      ts.isCallExpression(node.initializer.expression.body) &&
      isIdentifier(node.initializer.expression.body.expression, "openBook") &&
      node.initializer.expression.body.arguments.length === 1 &&
      isIdentifier(node.initializer.expression.body.arguments[0], "book"),
  )[0];
  assert.ok(rowClick, "每个书库行点击必须调用 openBook(book)，不能固定其他教材");
};

const libraryPagePath = path.join(
  projectRoot,
  "src/pages/BookLibrary/BookLibrary.tsx",
);

assert.equal(fs.existsSync(libraryPagePath), true, "全部教材页面应存在");

const appConfig = readSource("src/app.config.ts");
const home = readSource("src/pages/Home/Home.tsx");
const library = fs.readFileSync(libraryPagePath, "utf8");

assert.match(
  appConfig,
  /pages\/BookLibrary\/BookLibrary/,
  "全部教材页面应注册到小程序路由",
);
assert.match(home, /BOOK_SERIES/, "首页应使用统一的五个系列数据");
assert.match(home, /全部教材/, "首页应提供全部教材入口");
assert.match(
  home,
  /\/pages\/BookLibrary\/BookLibrary/,
  "首页系列和搜索入口应进入全部教材页面",
);
assert.match(library, /filterBooks/, "全部教材页面应复用已测试的筛选逻辑");
assert.match(library, /onInput/, "全部教材页面应支持输入关键词搜索");
assertBookNavigationChain(library);
assert.doesNotMatch(
  library,
  /action\.type === "unavailable"|正在核对|暂未开放/,
  "书库点击不应再显示正在核对或暂未开放的门禁提示",
);

const assertResolverCallUsesCatalogImport = (source) => {
  const { checker, sourceFile } = createTsxProgram("BookLibrary.fixture.tsx", source);
  const resolverCall = findNodes(
    sourceFile,
    (node) =>
      ts.isCallExpression(node) && isIdentifier(node.expression, "resolveBookAction"),
  )[0];
  assert.ok(resolverCall, "变异 fixture 必须包含 resolveBookAction 调用");
  assert.ok(
    isNamedImportBinding(
      checker,
      resolverCall.expression,
      "@/features/bookLibrary/bookCatalog",
      "resolveBookAction",
    ),
    "实际 resolveBookAction 调用必须绑定到 bookCatalog 的命名导入",
  );
};
const resolverShadowFixtures = [
  [
    "局部函数",
    `import { resolveBookAction } from "@/features/bookLibrary/bookCatalog";
const openBook = (book) => {
  function resolveBookAction(current) { return { url: "/pages/Practice/Practice?bookId=3&practice=0" }; }
  return resolveBookAction(book);
};`,
  ],
  [
    "参数",
    `import { resolveBookAction } from "@/features/bookLibrary/bookCatalog";
const openBook = (book, resolveBookAction) => resolveBookAction(book);`,
  ],
  [
    "局部变量",
    `import { resolveBookAction } from "@/features/bookLibrary/bookCatalog";
const openBook = (book) => {
  const resolveBookAction = () => ({ url: "/pages/Practice/Practice?bookId=3&practice=0" });
  return resolveBookAction(book);
};`,
  ],
  [
    "局部类",
    `import { resolveBookAction } from "@/features/bookLibrary/bookCatalog";
const openBook = (book) => {
  class resolveBookAction {}
  return resolveBookAction(book);
};`,
  ],
  [
    "catch binding",
    `import { resolveBookAction } from "@/features/bookLibrary/bookCatalog";
const openBook = (book) => {
  try { throw null; } catch (resolveBookAction) { return resolveBookAction(book); }
};`,
  ],
];
for (const [name, fixture] of resolverShadowFixtures) {
  assert.throws(
    () => assertResolverCallUsesCatalogImport(fixture),
    /绑定到 bookCatalog/,
    `变异负例：${name} resolveBookAction 不得遮蔽 bookCatalog 命名导入`,
  );
}

console.log("多书页面测试通过：首页入口、页面路由、搜索筛选和当前教材点击数据链正确。");
