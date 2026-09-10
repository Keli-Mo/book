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
const parseTsx = (source) =>
  ts.createSourceFile("BookLibrary.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const isIdentifier = (node, name) => ts.isIdentifier(node) && node.text === name;
const getVariable = (sourceFile, name) =>
  findNodes(
    sourceFile,
    (node) =>
      ts.isVariableDeclaration(node) &&
      isIdentifier(node.name, name) &&
      node.initializer,
  )[0];
const isCall = (node, name, argumentName) =>
  ts.isCallExpression(node) &&
  isIdentifier(node.expression, name) &&
  node.arguments.length === 1 &&
  isIdentifier(node.arguments[0], argumentName);
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
  const sourceFile = parseTsx(source);
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
      isCall(node.initializer, "resolveBookAction", "book"),
  )[0];
  assert.ok(action, "openBook 必须把当前 book 传给 resolveBookAction(book)");
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
      isCall(node.initializer.expression.body, "openBook", "book"),
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

const fixedBookMutation = library.replace(
  "resolveBookAction(book)",
  "resolveBookAction(BOOKS[0])",
);
assert.throws(
  () => assertBookNavigationChain(fixedBookMutation),
  /当前 book|当前列表教材|固定其他教材/,
  "变异负例：固定教材不得绕过书库点击数据链",
);
const fixedIdMutation = library.replace(
  "resolveBookAction(book)",
  'resolveBookAction({ ...book, id: "3" })',
);
assert.throws(
  () => assertBookNavigationChain(fixedIdMutation),
  /resolveBookAction\(book\)/,
  "变异负例：书库点击不得向 resolver 固定教材 ID",
);
const bypassResolverMutation = library.replace(
  "const action = resolveBookAction(book);",
  'const action = { url: "/pages/Practice/Practice?bookId=3&practice=0" };',
);
assert.throws(
  () => assertBookNavigationChain(bypassResolverMutation),
  /resolveBookAction/,
  "变异负例：书库点击不得绕过 resolver",
);

console.log("多书页面测试通过：首页入口、页面路由、搜索筛选和当前教材点击数据链正确。");
