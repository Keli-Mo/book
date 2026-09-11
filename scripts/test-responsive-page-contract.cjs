/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const postcss = require("postcss");
const sass = require("sass");
const ts = require("typescript");
const vm = require("vm");

const projectRoot = path.resolve(__dirname, "..");
const sourceCache = new Map();
const astCache = new Map();
const styleCache = new Map();
const readSource = (relativePath) => {
  if (!sourceCache.has(relativePath)) {
    sourceCache.set(
      relativePath,
      fs.readFileSync(path.join(projectRoot, relativePath), "utf8"),
    );
  }
  return sourceCache.get(relativePath);
};

const pages = [
  {
    name: "首页",
    tsx: "src/pages/Home/Home.tsx",
    scss: "src/pages/Home/Home.scss",
    config: "src/pages/Home/Home.config.ts",
    safeAreas: [[".home-tabs", 12]],
    longText: [".continue-card__title"],
    compactTargets: [
      ".library-home__search",
      ".continue-card__button",
      ".series-section__all",
      ".home-tabs__item",
    ],
    surfaceTargets: [".series-row"],
  },
  {
    name: "书库",
    tsx: "src/pages/BookLibrary/BookLibrary.tsx",
    scss: "src/pages/BookLibrary/BookLibrary.scss",
    config: "src/pages/BookLibrary/BookLibrary.config.ts",
    safeAreas: [[".book-library", 24]],
    longText: [".book-row__title"],
    compactTargets: [".book-search__clear", ".series-filter"],
    surfaceTargets: [".book-row"],
  },
  {
    name: "训练",
    tsx: "src/pages/Practice/Practice.tsx",
    scss: "src/pages/Practice/Practice.scss",
    config: "src/pages/Practice/Practice.config.ts",
    safeAreas: [
      [".practice-page", 24],
      [".practice-directory-sheet", 12],
    ],
    longText: [".practice-header__course", ".practice-header__section"],
    compactTargets: [
      ".practice-empty__button",
      ".practice-header__directory",
      ".audio-hotspot",
      ".record-button",
      ".record-actions__secondary",
      ".check-in-button",
      ".practice-navigation__button",
    ],
    surfaceTargets: [],
  },
  {
    name: "打卡详情",
    tsx: "src/pages/CheckInDetail/CheckInDetail.tsx",
    scss: "src/pages/CheckInDetail/CheckInDetail.scss",
    config: "src/pages/CheckInDetail/CheckInDetail.config.ts",
    safeAreas: [[".check-in-detail", 24]],
    longText: [
      ".check-in-course-card__book",
      ".check-in-course-card__section",
    ],
    compactTargets: [
      ".check-in-state__button",
      ".shared-recording__play",
      ".check-in-actions__share",
      ".check-in-actions__practice",
    ],
    surfaceTargets: [],
  },
  {
    name: "我的打卡",
    tsx: "src/pages/MyCheckIns/MyCheckIns.tsx",
    scss: "src/pages/MyCheckIns/MyCheckIns.scss",
    config: "src/pages/MyCheckIns/MyCheckIns.config.ts",
    safeAreas: [[".my-check-ins", 24]],
    longText: [".check-in-list-card__section", ".check-in-list-card__book"],
    compactTargets: [
      ".my-check-ins-state__button",
      ".check-in-list-card__open",
      ".check-in-list-card__delete",
    ],
    surfaceTargets: [],
  },
];

const directoryTargets = [".practice-directory-close", ".practice-directory-item"];
const failures = [];
const contract = (name, check) => {
  try {
    check();
  } catch (error) {
    failures.push(`${name}：${error instanceof Error ? error.message : error}`);
  }
};

const parseTypeScript = (relativePath, scriptKind = ts.ScriptKind.TS) => {
  const cacheKey = `${relativePath}:${scriptKind}`;
  if (!astCache.has(cacheKey)) {
    astCache.set(
      cacheKey,
      ts.createSourceFile(
        path.join(projectRoot, relativePath),
        readSource(relativePath),
        ts.ScriptTarget.Latest,
        true,
        scriptKind,
      ),
    );
  }
  return astCache.get(cacheKey);
};

const compileStyles = (relativePath) => {
  if (!styleCache.has(relativePath)) {
    const result = sass.compile(path.join(projectRoot, relativePath), {
      loadPaths: [path.join(projectRoot, "src")],
      style: "expanded",
    });
    styleCache.set(
      relativePath,
      postcss.parse(result.css, { from: relativePath }),
    );
  }
  return styleCache.get(relativePath);
};

const findNodes = (node, predicate, results = []) => {
  if (predicate(node)) results.push(node);
  // TypeScript visitor 返回 truthy 会提前停止遍历，因此显式丢弃递归返回值。
  ts.forEachChild(node, (child) => {
    findNodes(child, predicate, results);
  });
  return results;
};

const findNodesInComponent = (component, predicate) => {
  const results = [];
  const visit = (node) => {
    if (node !== component && ts.isFunctionLike(node)) return;
    if (predicate(node)) results.push(node);
    ts.forEachChild(node, visit);
  };
  visit(component.body);
  return results;
};

const propertyName = (node) =>
  ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : "";

const unwrapExpression = (expression) => {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const getObjectProperty = (object, name) =>
  object.properties.find(
    (item) => ts.isPropertyAssignment(item) && propertyName(item.name) === name,
  );

const resolveTopLevelIdentifier = (sourceFile, identifier) => {
  for (const statement of sourceFile.statements) {
    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.length === 1
    ) {
      const declaration = statement.declarationList.declarations[0];
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === identifier.text &&
        declaration.initializer
      ) {
        return unwrapExpression(declaration.initializer);
      }
    }
  }
  return identifier;
};

const findDefaultConfigObject = (sourceFile, factoryName) => {
  const assignment = sourceFile.statements.find(
    (statement) => ts.isExportAssignment(statement) && !statement.isExportEquals,
  );
  assert.ok(assignment, "配置必须通过 export default 导出");
  let expression = unwrapExpression(assignment.expression);
  if (ts.isIdentifier(expression)) {
    expression = resolveTopLevelIdentifier(sourceFile, expression);
  }
  assert.ok(
    ts.isCallExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === factoryName &&
      expression.arguments.length === 1 &&
      ts.isObjectLiteralExpression(expression.arguments[0]),
    `默认导出必须调用 ${factoryName}({...})`,
  );
  return expression.arguments[0];
};

const getNamedImportLocalName = (sourceFile, moduleName, exportName) => {
  for (const declaration of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(declaration) ||
      !ts.isStringLiteral(declaration.moduleSpecifier) ||
      declaration.moduleSpecifier.text !== moduleName
    ) {
      continue;
    }
    const bindings = declaration.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const specifier = bindings.elements.find(
      (item) => (item.propertyName?.text || item.name.text) === exportName,
    );
    if (specifier) return specifier.name.text;
  }
  return "";
};

const jsxOpenings = (node) =>
  findNodes(
    node,
    (candidate) =>
      ts.isJsxOpeningElement(candidate) || ts.isJsxSelfClosingElement(candidate),
  );

const jsxTagName = (opening) =>
  ts.isIdentifier(opening.tagName) ? opening.tagName.text : opening.tagName.getText();

const getJsxAttribute = (opening, name) =>
  opening.attributes.properties.find(
    (item) => ts.isJsxAttribute(item) && propertyName(item.name) === name,
  );

const collectStringFragments = (node, fragments = []) => {
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isJsxText(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  ) {
    fragments.push(node.text);
  }
  ts.forEachChild(node, (child) => {
    collectStringFragments(child, fragments);
  });
  return fragments;
};

const classTokens = (opening) => {
  const attribute = getJsxAttribute(opening, "className");
  if (!attribute?.initializer) return new Set();
  return new Set(
    collectStringFragments(attribute.initializer)
      .flatMap((fragment) => fragment.split(/\s+/))
      .map((token) => token.trim())
      .filter(Boolean),
  );
};

const findImageByClass = (sourceFile, className) =>
  jsxOpenings(sourceFile).find(
    (opening) =>
      jsxTagName(opening) === "Image" && classTokens(opening).has(className),
  );

const literalAttributeValue = (opening, name) => {
  const attribute = getJsxAttribute(opening, name);
  return attribute?.initializer && ts.isStringLiteral(attribute.initializer)
    ? attribute.initializer.text
    : "";
};

const findDefaultComponent = (sourceFile) => {
  const direct = sourceFile.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
      ),
  );
  if (direct) return direct;

  const assignment = sourceFile.statements.find(
    (statement) => ts.isExportAssignment(statement) && !statement.isExportEquals,
  );
  if (!assignment || !ts.isIdentifier(assignment.expression)) return undefined;
  return findNodes(
    sourceFile,
    (node) =>
      ((ts.isFunctionDeclaration(node) && node.name) ||
        ts.isVariableDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === assignment.expression.text,
  )
    .map((node) => (ts.isVariableDeclaration(node) ? node.initializer : node))
    .find((node) => node && ts.isFunctionLike(node));
};

const collectReturnRoots = (component) => {
  const returns = findNodesInComponent(component, (node) => ts.isReturnStatement(node));
  const roots = [];
  const collect = (expression) => {
    if (!expression) return;
    const current = unwrapExpression(expression);
    if (ts.isConditionalExpression(current)) {
      collect(current.whenTrue);
      collect(current.whenFalse);
      return;
    }
    if (ts.isJsxElement(current)) roots.push(current.openingElement);
    else if (ts.isJsxSelfClosingElement(current)) roots.push(current);
    else roots.push(undefined);
  };
  returns.forEach((statement) => collect(statement.expression));
  return roots;
};

const findHookBinding = (component, sourceFile) => {
  const hookName = getNamedImportLocalName(
    sourceFile,
    "@/hooks/useDeviceLayout",
    "useDeviceLayout",
  );
  assert.ok(hookName, "应命名导入 useDeviceLayout");
  const declaration = findNodesInComponent(
    component,
    (node) =>
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === hookName,
  )[0];
  assert.ok(declaration, "页面组件应在顶层保存 useDeviceLayout() 结果");
  if (ts.isIdentifier(declaration.name)) {
    return { declaration, objectName: declaration.name.text, members: new Map() };
  }
  assert.ok(ts.isObjectBindingPattern(declaration.name), "布局 Hook 只允许对象或对象解构绑定");
  const members = new Map();
  declaration.name.elements.forEach((element) => {
    if (!element.dotDotDotToken && ts.isIdentifier(element.name)) {
      members.set(propertyName(element.propertyName || element.name), element.name.text);
    }
  });
  return { declaration, objectName: "", members };
};

const expressionReferencesIdentifier = (node, name) =>
  Boolean(name) &&
  findNodes(node, (candidate) => ts.isIdentifier(candidate) && candidate.text === name)
    .length > 0;

const expressionReferencesLayoutMember = (node, binding, member) => {
  if (binding.objectName) {
    // 直接把完整 profile 传给 builder 是首选写法，等价包含全部成员。
    const expression = unwrapExpression(node);
    if (ts.isIdentifier(expression) && expression.text === binding.objectName) return true;
    if (
      ts.isObjectLiteralExpression(expression) &&
      expression.properties.some(
        (property) =>
          ts.isSpreadAssignment(property) &&
          ts.isIdentifier(property.expression) &&
          property.expression.text === binding.objectName,
      )
    ) {
      return true;
    }
    return (
      findNodes(
        node,
        (candidate) =>
          ts.isPropertyAccessExpression(candidate) &&
          ts.isIdentifier(candidate.expression) &&
          candidate.expression.text === binding.objectName &&
          candidate.name.text === member,
      ).length > 0
    );
  }
  return expressionReferencesIdentifier(node, binding.members.get(member));
};

const findResponsiveBuilderCalls = (component, sourceFile, binding) => {
  const builderName = getNamedImportLocalName(
    sourceFile,
    "@/features/layout/deviceLayout",
    "buildDeviceLayoutClassName",
  );
  assert.ok(builderName, "应命名导入 buildDeviceLayoutClassName");
  const calls = findNodesInComponent(
    component,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === builderName &&
      node.arguments.length >= 1 &&
      ["isPad", "isSplit", "orientation"].every((member) =>
        expressionReferencesLayoutMember(node.arguments[0], binding, member),
      ),
  );
  assert.ok(calls.length > 0, "class builder 的输入必须来自当前 useDeviceLayout 结果");
  return calls;
};

const assertEveryReturnUsesResponsiveShell = (sourceFile) => {
  const component = findDefaultComponent(sourceFile);
  assert.ok(component?.body, "应能定位默认导出的页面组件");
  const binding = findHookBinding(component, sourceFile);
  const builderCalls = findResponsiveBuilderCalls(component, sourceFile, binding);
  const resultNames = new Set();
  for (const call of builderCalls) {
    const declaration = findNodesInComponent(
      component,
      (node) =>
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        findNodes(node.initializer, (candidate) => candidate === call).length > 0,
    )[0];
    if (declaration) resultNames.add(declaration.name.text);
  }

  const roots = collectReturnRoots(component);
  assert.ok(roots.length > 0, "页面组件至少应有一个顶层 return");
  roots.forEach((root, index) => {
    assert.ok(root, `第 ${index + 1} 个顶层 return 必须返回响应式 JSX 根节点`);
    const classAttribute = getJsxAttribute(root, "className");
    assert.ok(classAttribute?.initializer, `第 ${index + 1} 个根节点必须声明 className`);
    const usesDirectCall = builderCalls.some(
      (call) => findNodes(classAttribute.initializer, (node) => node === call).length > 0,
    );
    const usesResult = [...resultNames].some((name) =>
      expressionReferencesIdentifier(classAttribute.initializer, name),
    );
    assert.ok(
      usesDirectCall || usesResult,
      `第 ${index + 1} 个顶层 return 必须使用 buildDeviceLayoutClassName 的结果`,
    );
    const rootNode = ts.isJsxOpeningElement(root) ? root.parent : root;
    assert.ok(
      jsxOpenings(rootNode).some((opening) =>
        classTokens(opening).has("device-layout__content"),
      ),
      `第 ${index + 1} 个顶层 return 必须包含 device-layout__content`,
    );
  });

  const firstReturnPosition = Math.min(
    ...findNodesInComponent(component, (node) => ts.isReturnStatement(node)).map(
      (node) => node.pos,
    ),
  );
  assert.ok(
    binding.declaration.pos < firstReturnPosition,
    "useDeviceLayout 不得位于可能提前返回的分支之后",
  );
};

const selectorParts = (rule) => rule.selector.split(",").map((item) => item.trim());
const selectorHasClass = (selector, className) =>
  new RegExp(
    `(^|[^\\w-])\\.${className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w-]|$)`,
  ).test(selector);
const exactSelectorRules = (root, selector) => {
  const rules = [];
  root.walkRules((rule) => {
    if (selectorParts(rule).includes(selector)) rules.push(rule);
  });
  return rules;
};
const matchingRules = (root, fragments) => {
  const rules = [];
  root.walkRules((rule) => {
    if (fragments.every((fragment) => rule.selector.includes(fragment))) rules.push(rule);
  });
  return rules;
};
const rulesForClass = (roots, className) =>
  roots.flatMap((root) => {
    const rules = [];
    root.walkRules((rule) => {
      if (selectorParts(rule).some((selector) => selectorHasClass(selector, className))) {
        rules.push(rule);
      }
    });
    return rules;
  });
const declarationValues = (rule, property) =>
  rule.nodes
    .filter((node) => node.type === "decl" && node.prop === property)
    .map((node) => node.value.trim());
const hasDeclaration = (rule, property, expected) =>
  declarationValues(rule, property).some((value) =>
    typeof expected === "string" ? value === expected : expected.test(value),
  );
const findRuleWith = (root, fragments, declarations) =>
  matchingRules(root, fragments).find((rule) =>
    Object.entries(declarations).every(([property, expected]) =>
      hasDeclaration(rule, property, expected),
    ),
  );

const normalizeCssValue = (value) => value.replace(/\s+/g, "");
const assertSafeAreaFallback = (root, selector, basePx) => {
  const declarations = exactSelectorRules(root, selector).flatMap((rule) =>
    rule.nodes.filter(
      (node) => node.type === "decl" && node.prop === "padding-bottom",
    ),
  );
  const [constantDeclaration, envDeclaration] = declarations.slice(-2);
  assert.equal(
    normalizeCssValue(constantDeclaration?.value || ""),
    `calc(${basePx}PX+constant(safe-area-inset-bottom))`,
    `${selector} 最终倒数第二条 padding-bottom 应保留 ${basePx}PX + constant()`,
  );
  assert.equal(
    normalizeCssValue(envDeclaration?.value || ""),
    `calc(${basePx}PX+env(safe-area-inset-bottom))`,
    `${selector} 最后一条 padding-bottom 应以 ${basePx}PX + env() 覆盖`,
  );
};

const assertLongTextPolicy = (root, selector) => {
  const valid = matchingRules(root, [selector]).some((rule) => {
    const overflowHidden = hasDeclaration(rule, "overflow", "hidden");
    return (
      (overflowHidden &&
        (hasDeclaration(rule, "text-overflow", "ellipsis") ||
          declarationValues(rule, "-webkit-line-clamp").length > 0)) ||
      hasDeclaration(rule, "overflow-wrap", /^(?:anywhere|break-word)$/) ||
      hasDeclaration(rule, "word-break", /^(?:break-all|break-word)$/)
    );
  });
  assert.ok(valid, `${selector} 应提供省略、行截断或安全断词策略`);
};

const numericPx = (value) => {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)PX$/);
  return match ? Number(match[1]) : null;
};
const guarantees44Px = (value) => {
  const pixels = numericPx(value);
  return pixels !== null && pixels >= 44;
};
const unsafeTargetDimension = (value) => {
  // calc() 无法仅靠静态 token 证明最终尺寸不小于 44px，触控固定尺寸不接受它。
  if (/\bcalc\s*\(/i.test(value)) return true;
  const unitTokens = value.match(/-?\d*\.?\d+(?:[a-zA-Z]+|%)/g) || [];
  for (const token of unitTokens) {
    const match = token.match(/^(-?\d*\.?\d+)([a-zA-Z]+|%)$/);
    if (!match) continue;
    const number = Number(match[1]);
    const unit = match[2];
    if (unit === "%") continue;
    if (unit !== "PX" || number < 44) return true;
  }
  return /^0(?:\.0+)?$/.test(value.trim());
};

const hasFixedBoxHeight = (value) => {
  const normalized = value.trim().toLowerCase();
  if (["auto", "none", "unset"].includes(normalized)) return false;
  return /(?:^|[^\w.-])-?(?:\d+(?:\.\d+)?|\.\d+)(?:[a-z]+|%)?(?=$|[^\w-])/.test(
    normalized,
  );
};

const findElementsByClass = (sourceFile, selector) => {
  const className = selector.slice(1);
  return jsxOpenings(sourceFile).filter((opening) => classTokens(opening).has(className));
};

const assertCompactTarget = (sourceFile, roots, selector) => {
  const className = selector.slice(1);
  const elements = findElementsByClass(sourceFile, selector);
  assert.ok(elements.length > 0, `${selector} 必须绑定到实际交互元素`);
  assert.ok(
    elements.every(
      (element) =>
        jsxTagName(element) === "Button" ||
        Boolean(getJsxAttribute(element, "onClick")) ||
        Boolean(getJsxAttribute(element, "openType")),
    ),
    `${selector} 必须是真正可触发的交互元素`,
  );
  const ownsMinimum = ["min-width", "min-height"].every((property) =>
    rulesForClass(roots, className).some((rule) =>
      declarationValues(rule, property).some(guarantees44Px),
    ),
  );
  const usesSharedTarget = elements.every((element) =>
    classTokens(element).has("device-touch-target"),
  );
  assert.ok(
    ownsMinimum || usesSharedTarget,
    `${selector} 应直接声明 >=44PX 最小宽高或使用 device-touch-target`,
  );

  const relevantClasses = new Set([className]);
  if (usesSharedTarget) relevantClasses.add("device-touch-target");
  const unsafe = [...relevantClasses].flatMap((name) =>
    rulesForClass(roots, name).flatMap((rule) =>
      ["width", "height", "min-width", "min-height"].flatMap((property) =>
        declarationValues(rule, property)
          .filter(unsafeTargetDimension)
          .map((value) => `${rule.selector} { ${property}: ${value} }`),
      ),
    ),
  );
  assert.equal(
    unsafe.length,
    0,
    `${selector} 存在会缩小或被 Taro 转换的固定尺寸：${unsafe.join("；")}`,
  );
};

const assertSurfaceTarget = (sourceFile, root, selector) => {
  const elements = findElementsByClass(sourceFile, selector);
  assert.ok(
    elements.length > 0 &&
      elements.every((element) => Boolean(getJsxAttribute(element, "onClick"))),
    `${selector} 应是整面可点击区域`,
  );
  const className = selector.slice(1);
  const minHeights = rulesForClass([root], className).flatMap((rule) =>
    declarationValues(rule, "min-height"),
  );
  const isLargeEnoughAt320 = (value) => {
    if (guarantees44Px(value)) return true;
    const rpx = value.match(/^(\d+(?:\.\d+)?)rpx$/);
    return Boolean(rpx && (Number(rpx[1]) * 320) / 750 >= 44);
  };
  assert.ok(
    minHeights.length > 0 && minHeights.every(isLargeEnoughAt320),
    `${selector} 的每条 min-height 在 320PX 最窄支持宽度下都应至少高 44PX`,
  );
};

const splitTopLevelTracks = (value) => {
  const tracks = [];
  let depth = 0;
  let token = "";
  for (const character of value.trim()) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (/\s/.test(character) && depth === 0) {
      if (token) tracks.push(token);
      token = "";
    } else token += character;
  }
  if (token) tracks.push(token);
  return tracks.filter((track) => !/^\[.*\]$/.test(track));
};
const hasMultipleGridTracks = (value) => {
  const compact = normalizeCssValue(value);
  const repeat = compact.match(/^repeat\(([^,]+),/);
  if (repeat && (repeat[1] === "auto-fit" || repeat[1] === "auto-fill")) return true;
  if (repeat && Number(repeat[1]) >= 2) return true;
  return splitTopLevelTracks(value).length >= 2;
};

const loadSimpleTypeScriptModule = (relativePath) => {
  const output = ts.transpileModule(readSource(relativePath), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2017,
    },
    fileName: relativePath,
  }).outputText;
  const moduleContainer = { exports: {} };
  vm.runInNewContext(output, {
    module: moduleContainer,
    exports: moduleContainer.exports,
  });
  return moduleContainer.exports;
};

const contexts = pages.map((page) => ({
  ...page,
  ast: parseTypeScript(page.tsx, ts.ScriptKind.TSX),
  configAst: parseTypeScript(page.config),
  styles: compileStyles(page.scss),
}));
const appAst = parseTypeScript("src/app.config.ts");
const appStyles = compileStyles("src/app.scss");
const practice = contexts.find((page) => page.name === "训练");
const directoryAst = parseTypeScript(
  "src/pages/Practice/PracticeDirectory.tsx",
  ts.ScriptKind.TSX,
);

contract("设备 class builder 输出互斥且可预测", () => {
  const { buildDeviceLayoutClassName } = loadSimpleTypeScriptModule(
    "src/features/layout/deviceLayout.ts",
  );
  assert.equal(
    typeof buildDeviceLayoutClassName,
    "function",
    "deviceLayout.ts 应导出 buildDeviceLayoutClassName(profile)",
  );
  const base = { statusBarHeight: 20, safeAreaBottom: 0 };
  const cases = [
    [
      "横屏手机仍单栏",
      { ...base, isPad: false, isSplit: false, orientation: "landscape", contentMaxWidth: null },
      ["device-layout", "device-layout--phone", "device-layout--single", "device-layout--landscape"],
    ],
    [
      "Pad 竖屏为居中单栏",
      { ...base, isPad: true, isSplit: false, orientation: "portrait", contentMaxWidth: 820 },
      ["device-layout", "device-layout--pad", "device-layout--single", "device-layout--portrait"],
    ],
    [
      "Pad 横屏为双栏",
      { ...base, isPad: true, isSplit: true, orientation: "landscape", contentMaxWidth: 1280 },
      ["device-layout", "device-layout--pad", "device-layout--split", "device-layout--landscape"],
    ],
  ];
  for (const [scenario, profile, expected] of cases) {
    const actual = String(buildDeviceLayoutClassName(profile)).trim().split(/\s+/).sort();
    assert.deepEqual(actual, [...expected].sort(), `${scenario}的 class 不符合契约`);
  }
});

contract("配置扫描器只接受真实默认导出", () => {
  const fixtures = [
    ["直接默认导出", "export default definePageConfig({ pageOrientation: 'auto' });", true],
    ["变量默认导出", "const config = definePageConfig({ pageOrientation: 'auto' }); export default config;", true],
    ["死调用不能冒充默认配置", "definePageConfig({ pageOrientation: 'auto' }); export default {};", false],
  ];
  fixtures.forEach(([name, source, accepted]) => {
    const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
    if (accepted) findDefaultConfigObject(ast, "definePageConfig");
    else assert.throws(() => findDefaultConfigObject(ast, "definePageConfig"));
  });
});

contract("页面布局扫描器支持对象/解构并覆盖提前返回", () => {
  const fixture = (body) =>
    ts.createSourceFile("fixture.tsx", body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = `
    import { useDeviceLayout } from "@/hooks/useDeviceLayout";
    import { buildDeviceLayoutClassName } from "@/features/layout/deviceLayout";
  `;
  const direct = fixture(`${imports}
    export default function Page() {
      const layout = useDeviceLayout();
      const layoutClassName = buildDeviceLayoutClassName(layout);
      if (loading) return <View className={layoutClassName}><View className='device-layout__content' /></View>;
      return <View className={layoutClassName}><View className='device-layout__content' /></View>;
    }
  `);
  const destructured = fixture(`${imports}
    export default function Page() {
      const { isPad, isSplit, orientation } = useDeviceLayout();
      const layoutClassName = buildDeviceLayoutClassName({ isPad, isSplit, orientation });
      return <View className={layoutClassName}><View className='device-layout__content' /></View>;
    }
  `);
  assertEveryReturnUsesResponsiveShell(direct);
  assertEveryReturnUsesResponsiveShell(destructured);

  const permanentClasses = fixture(`${imports}
    export default function Page() {
      const layout = useDeviceLayout();
      return <View className={\`device-layout device-layout--pad device-layout--phone device-layout--split device-layout--single \${layout.isPad} \${layout.isSplit}\`}><View className='device-layout__content' /></View>;
    }
  `);
  const uncoveredEarlyReturn = fixture(`${imports}
    export default function Page() {
      const layout = useDeviceLayout();
      const layoutClassName = buildDeviceLayoutClassName(layout);
      if (loading) return <View className='loading'><View className='device-layout__content' /></View>;
      return <View className={layoutClassName}><View className='device-layout__content' /></View>;
    }
  `);
  assert.throws(() => assertEveryReturnUsesResponsiveShell(permanentClasses));
  assert.throws(() => assertEveryReturnUsesResponsiveShell(uncoveredEarlyReturn));
});

contract("安全区扫描器校验基础间距和最终级联", () => {
  const good = postcss.parse(`.page {
    padding-bottom: calc(24PX + constant(safe-area-inset-bottom));
    padding-bottom: calc(24PX + env(safe-area-inset-bottom));
  }`);
  assertSafeAreaFallback(good, ".page", 24);
  assert.throws(() =>
    assertSafeAreaFallback(
      postcss.parse(`.page {
        padding-bottom: constant(safe-area-inset-bottom);
        padding-bottom: env(safe-area-inset-bottom);
      }`),
      ".page",
      24,
    ),
  );
  assert.throws(() =>
    assertSafeAreaFallback(
      postcss.parse(`${good.toString()} .page { padding-bottom: 0; }`),
      ".page",
      24,
    ),
  );
});

contract("应用允许 Pad 调整窗口", () => {
  const config = findDefaultConfigObject(appAst, "defineAppConfig");
  const resizable = getObjectProperty(config, "resizable");
  assert.ok(
    resizable?.initializer.kind === ts.SyntaxKind.TrueKeyword,
    "app.config.ts 默认导出应显式设置 resizable: true",
  );
});

for (const page of contexts) {
  contract(`${page.name}允许自动旋转`, () => {
    const config = findDefaultConfigObject(page.configAst, "definePageConfig");
    const orientation = getObjectProperty(config, "pageOrientation");
    assert.ok(
      orientation &&
        ts.isStringLiteral(orientation.initializer) &&
        orientation.initializer.text === "auto",
      `${page.config} 默认导出应设置 pageOrientation: "auto"`,
    );
  });
  contract(`${page.name}所有顶层状态接入共享布局`, () => {
    assertEveryReturnUsesResponsiveShell(page.ast);
  });
  contract(`${page.name}安全区保留批准的基础间距`, () => {
    page.safeAreas.forEach(([selector, basePx]) =>
      assertSafeAreaFallback(page.styles, selector, basePx),
    );
  });
  contract(`${page.name}处理关键长文本`, () => {
    page.longText.forEach((selector) => assertLongTextPolicy(page.styles, selector));
  });
  contract(`${page.name}紧凑触控目标不少于 44 CSS px`, () => {
    const roots = [appStyles, page.styles];
    page.compactTargets.forEach((selector) =>
      assertCompactTarget(page.ast, roots, selector),
    );
    page.surfaceTargets.forEach((selector) =>
      assertSurfaceTarget(page.ast, page.styles, selector),
    );
  });
}

contract("训练目录紧凑触控目标不少于 44 CSS px", () => {
  directoryTargets.forEach((selector) =>
    assertCompactTarget(directoryAst, [appStyles, practice.styles], selector),
  );
});

contract("共享内容容器居中并限制三类窗口", () => {
  const baseRule = exactSelectorRules(appStyles, ".device-layout__content").find(
    (rule) => hasDeclaration(rule, "width", "100%"),
  );
  assert.ok(baseRule, ".device-layout__content 应设置 width: 100%");
  const centered =
    declarationValues(baseRule, "margin").some((value) =>
      /^(?:0|0PX)?\s*auto$/.test(value.trim()),
    ) ||
    (hasDeclaration(baseRule, "margin-left", "auto") &&
      hasDeclaration(baseRule, "margin-right", "auto"));
  assert.ok(centered, ".device-layout__content 应水平居中");
  assert.ok(
    findRuleWith(
      appStyles,
      [".device-layout--pad", ".device-layout--single", ".device-layout__content"],
      { "max-width": "820PX" },
    ),
    "Pad 单栏内容最大宽度应为 820PX",
  );
  assert.ok(
    findRuleWith(
      appStyles,
      [".device-layout--split", ".device-layout__content"],
      { "max-width": "1280PX" },
    ),
    "Pad 双栏内容最大宽度应为 1280PX",
  );
  assert.ok(
    matchingRules(appStyles, [
      ".device-layout--phone",
      ".device-layout--landscape",
      ".device-layout__content",
    ]).some((rule) =>
      declarationValues(rule, "max-width").some((value) => {
        const width = numericPx(value);
        return width !== null && width >= 320 && width <= 820;
      }),
    ),
    "横屏手机内容应以大写 PX 限宽且保持单栏",
  );
  assert.ok(
    findRuleWith(
      appStyles,
      [".device-layout--phone", ".device-layout--landscape"],
      { "overflow-y": /^(?:auto|scroll)$/ },
    ),
    "横屏手机应保留纵向滚动能力",
  );
});

contract("共享触控规则接受 >=44PX 并拒绝转换或缩小", () => {
  const sharedRules = rulesForClass([appStyles], "device-touch-target");
  for (const property of ["min-width", "min-height"]) {
    assert.ok(
      sharedRules.some((rule) =>
        declarationValues(rule, property).some(guarantees44Px),
      ),
      `.device-touch-target 应设置 ${property}: >=44PX`,
    );
  }
  [
    ["44PX", false],
    ["48PX", false],
    ["43PX", true],
    ["48px", true],
    ["96rpx", true],
    ["calc(100% - 40PX)", true],
    ["calc(100% - 48PX)", true],
  ].forEach(([value, unsafe]) =>
    assert.equal(unsafeTargetDimension(value), unsafe, `单位 fixture ${value}`),
  );
});

contract("自然教材高度与单栏轨道解析器边界明确", () => {
  ["auto", "none", "unset"].forEach((value) =>
    assert.equal(hasFixedBoxHeight(value), false, `教材高度 ${value} 应允许`),
  );
  ["0", "220PX", "62vh", "100%", "calc(100vh - 44PX)"].forEach(
    (value) =>
      assert.equal(hasFixedBoxHeight(value), true, `教材固定高度 ${value} 应拒绝`),
  );
  ["1fr", "minmax(0, 1fr)", "repeat(1, minmax(0, 1fr))"].forEach(
    (value) =>
      assert.equal(hasMultipleGridTracks(value), false, `单栏 ${value} 不应误报`),
  );
  ["1fr 1fr", "repeat(2, minmax(0, 1fr))", "repeat(auto-fit, 320PX)"].forEach(
    (value) =>
      assert.equal(hasMultipleGridTracks(value), true, `多栏 ${value} 应识别`),
  );
});

contract("窄屏多按钮区域可以折行和纵向排列", () => {
  assert.ok(
    findRuleWith(appStyles, [".device-actions"], { "flex-wrap": "wrap" }),
    ".device-actions 应允许 flex-wrap",
  );
  let hasNarrowColumn = false;
  appStyles.walkAtRules("media", (atRule) => {
    if (!/max-width\s*:\s*360PX/.test(atRule.params)) return;
    atRule.walkRules((rule) => {
      if (
        rule.selector.includes(".device-actions") &&
        hasDeclaration(rule, "flex-direction", "column")
      ) {
        hasNarrowColumn = true;
      }
    });
  });
  assert.ok(hasNarrowColumn, "360PX 窄屏下 .device-actions 应纵向排列");
  ["训练", "打卡详情", "我的打卡"].forEach((name) => {
    const page = contexts.find((context) => context.name === name);
    assert.ok(
      jsxOpenings(page.ast).some((opening) =>
        classTokens(opening).has("device-actions"),
      ),
      `${name}的多按钮区应使用 device-actions`,
    );
  });
});

contract("书库与打卡列表只在 split 下开启两列", () => {
  for (const [label, root, selector] of [
    ["书库", contexts.find((page) => page.name === "书库").styles, ".book-list"],
    ["我的打卡", contexts.find((page) => page.name === "我的打卡").styles, ".my-check-ins__list"],
  ]) {
    assert.ok(
      matchingRules(root, [".device-layout--split", selector]).some(
        (rule) =>
          hasDeclaration(rule, "display", "grid") &&
          declarationValues(rule, "grid-template-columns").some(
            (value) => normalizeCssValue(value) === "repeat(2,minmax(0,1fr))",
          ),
      ),
      `${label}应在 device-layout--split 下显示两列`,
    );
    const unsafe = matchingRules(root, [selector]).some(
      (rule) =>
        !rule.selector.includes(".device-layout--split") &&
        declarationValues(rule, "grid-template-columns").some(hasMultipleGridTracks),
    );
    assert.equal(unsafe, false, `${label}在 split 外只能使用合法单栏轨道`);
  }
});

contract("首页在任何设备布局下都保持单栏", () => {
  const home = contexts.find((page) => page.name === "首页");
  const multiTrack = matchingRules(home.styles, [".library-home__content"]).flatMap(
    (rule) =>
      declarationValues(rule, "grid-template-columns").filter(hasMultipleGridTracks),
  );
  assert.deepEqual(multiTrack, [], "首页不得因 Pad 或手机横屏变成多栏");
});

const functionFromIdentifier = (sourceFile, identifier) =>
  findNodes(
    sourceFile,
    (node) =>
      (ts.isFunctionDeclaration(node) && node.name?.text === identifier.text) ||
      (ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === identifier.text &&
        node.initializer &&
        ts.isFunctionLike(node.initializer)),
  ).map((node) => (ts.isVariableDeclaration(node) ? node.initializer : node))[0];

const resolveJsxHandler = (sourceFile, opening, attributeName) => {
  const attribute = getJsxAttribute(opening, attributeName);
  assert.ok(
    attribute?.initializer &&
      ts.isJsxExpression(attribute.initializer) &&
      attribute.initializer.expression,
    `${attributeName} 应绑定真实处理函数`,
  );
  const expression = unwrapExpression(attribute.initializer.expression);
  if (ts.isIdentifier(expression)) {
    const handler = functionFromIdentifier(sourceFile, expression);
    assert.ok(handler, `${attributeName} 标识符应解析到函数`);
    return { handler, handlerName: expression.text };
  }
  assert.ok(ts.isFunctionLike(expression), `${attributeName} 应绑定函数或函数标识符`);
  return { handler: expression, handlerName: "" };
};

const callbackParameterName = (callback) => {
  const first = callback.parameters?.[0]?.name;
  return first && ts.isIdentifier(first) ? first.text : "";
};

const objectPropertyReferences = (object, property, objectName, member) => {
  const assignment = getObjectProperty(object, property);
  return Boolean(
    assignment &&
      findNodes(
        assignment.initializer,
        (node) =>
          ts.isPropertyAccessExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === objectName &&
          node.name.text === member,
      ).length > 0,
  );
};

const findMeasuredImageSizeState = (sourceFile, callback) => {
  const resultName = callbackParameterName(callback);
  assert.ok(resultName, "boundingClientRect 回调应接收实际盒子结果");
  const states = findNodes(
    sourceFile,
    (node) =>
      ts.isVariableDeclaration(node) &&
      ts.isArrayBindingPattern(node.name) &&
      node.name.elements.length >= 2 &&
      ts.isBindingElement(node.name.elements[0]) &&
      ts.isIdentifier(node.name.elements[0].name) &&
      ts.isBindingElement(node.name.elements[1]) &&
      ts.isIdentifier(node.name.elements[1].name),
  );
  for (const state of states) {
    const sizeName = state.name.elements[0].name.text;
    const setterName = state.name.elements[1].name.text;
    const setterCall = findNodes(
      callback,
      (node) =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === setterName &&
        node.arguments.length > 0 &&
        ts.isObjectLiteralExpression(node.arguments[0]) &&
        objectPropertyReferences(node.arguments[0], "width", resultName, "width") &&
        objectPropertyReferences(node.arguments[0], "height", resultName, "height"),
    )[0];
    if (setterCall) return sizeName;
  }
  assert.fail("实际 boundingClientRect 的 width/height 应写入同一个图片尺寸 state");
};

const assertHotspotMeasurementFlow = () => {
  const sourceFile = practice.ast;
  const image = findImageByClass(sourceFile, "practice-book-page__image");
  assert.ok(image, "训练页应保留 practice-book-page__image 教材图");
  assert.equal(literalAttributeValue(image, "mode"), "widthFix", "教材图应使用 widthFix");
  const { handler, handlerName } = resolveJsxHandler(sourceFile, image, "onLoad");
  assert.ok(handlerName, "onLoad 测量函数还应由 resize effect 复用");

  const selectCall = findNodes(
    handler,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "select" &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === ".practice-book-page__image",
  )[0];
  assert.ok(selectCall, "onLoad 测量函数必须精确选择教材图片节点");
  assert.ok(
    findNodes(
      selectCall.expression.expression,
      (node) =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "createSelectorQuery",
    ).length > 0,
    "教材图片查询必须来自 createSelectorQuery()",
  );
  const rectCall = findNodes(
    handler,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "boundingClientRect" &&
      findNodes(node.expression.expression, (candidate) => candidate === selectCall).length > 0,
  )[0];
  assert.ok(rectCall, "同一图片查询链应调用 boundingClientRect");
  const callback = rectCall.arguments[0];
  assert.ok(callback && ts.isFunctionLike(callback), "boundingClientRect 应处理测量回调");
  const imageSizeName = findMeasuredImageSizeState(sourceFile, callback);

  const effectName =
    getNamedImportLocalName(sourceFile, "react", "useEffect") || "useEffect";
  const resizeEffect = findNodes(
    sourceFile,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === effectName &&
      node.arguments.length >= 2 &&
      ts.isArrayLiteralExpression(node.arguments[1]) &&
      expressionReferencesIdentifier(node.arguments[0], handlerName) &&
      ["windowWidth", "windowHeight"].every((dimension) =>
        node.arguments[1].elements.some(
          (element) =>
            (ts.isIdentifier(element) && element.text === dimension) ||
            (ts.isPropertyAccessExpression(element) &&
              element.name.text === dimension),
        ),
      ),
  )[0];
  assert.ok(resizeEffect, "窗口宽高变化的 effect 必须再次调用同一个图片测量函数");

  const clampName = getNamedImportLocalName(
    sourceFile,
    "@/features/listeningPractice/hotspotLayout",
    "clampHotspotCenter",
  );
  assert.ok(clampName, "应命名导入 clampHotspotCenter");
  const clampCall = findNodes(
    sourceFile,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === clampName &&
      node.arguments.length >= 2 &&
      expressionReferencesIdentifier(node.arguments[1], imageSizeName),
  )[0];
  assert.ok(clampCall, "clampHotspotCenter 的图片尺寸必须来自实际盒子测量 state");
  assert.ok(
    clampCall.arguments[0] &&
      ["left", "top"].every((property) =>
        findNodes(
          clampCall.arguments[0],
          (node) =>
            ts.isPropertyAccessExpression(node) && node.name.text === property,
        ).length > 0,
      ),
    "clampHotspotCenter 应接收当前轨道的 left/top",
  );

  const resultDeclaration = findNodes(
    sourceFile,
    (node) =>
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      findNodes(node.initializer, (candidate) => candidate === clampCall).length > 0,
  )[0];
  assert.ok(resultDeclaration, "热点收敛结果应保存后再用于渲染");
  const hotspot = jsxOpenings(sourceFile).find((opening) =>
    classTokens(opening).has("audio-hotspot"),
  );
  assert.ok(hotspot, "应渲染 audio-hotspot 命中外壳");
  const style = getJsxAttribute(hotspot, "style")?.initializer;
  assert.ok(style, "热点外壳应使用收敛后的 style");
  if (ts.isIdentifier(resultDeclaration.name)) {
    for (const member of ["left", "top"]) {
      assert.ok(
        findNodes(
          style,
          (node) =>
            ts.isPropertyAccessExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === resultDeclaration.name.text &&
            node.name.text === member,
        ).length > 0,
        `热点 style.${member} 必须来自 clampHotspotCenter 结果`,
      );
    }
  } else {
    assert.ok(ts.isObjectBindingPattern(resultDeclaration.name), "收敛结果应使用对象或对象解构");
    for (const member of ["left", "top"]) {
      const bindingElement = resultDeclaration.name.elements.find(
        (element) => propertyName(element.propertyName || element.name) === member,
      );
      assert.ok(
        bindingElement &&
          ts.isIdentifier(bindingElement.name) &&
          expressionReferencesIdentifier(style, bindingElement.name.text),
        `热点 style.${member} 必须来自 clampHotspotCenter 解构结果`,
      );
    }
  }
};

contract("训练热点使用图片 load/resize 后的实际盒子", () => {
  assertHotspotMeasurementFlow();
  const imageRules = matchingRules(practice.styles, [".practice-book-page__image"]);
  assert.ok(
    imageRules.some((rule) => hasDeclaration(rule, "width", "100%")),
    "教材图 CSS 宽度应为 100%",
  );
  for (const selector of [".practice-book-page", ".practice-book-page__image"]) {
    const forbidden = matchingRules(practice.styles, [selector]).flatMap((rule) =>
      ["height", "min-height", "max-height"].flatMap((property) =>
        declarationValues(rule, property).filter(hasFixedBoxHeight),
      ),
    );
    assert.equal(
      forbidden.length,
      0,
      `${selector} 不得设置固定数值、百分比或 viewport 高度`,
    );
  }
  assert.ok(
    findRuleWith(practice.styles, [".practice-book-page__hotspots"], {
      position: "absolute",
      inset: "0",
    }),
    "热点层应以 position:absolute + inset:0 覆盖实际图片盒子",
  );
});

contract("训练热点命中外壳与视觉圆点分离", () => {
  const hotspot = jsxOpenings(practice.ast).find((opening) =>
    classTokens(opening).has("audio-hotspot"),
  );
  const hotspotElement = hotspot && ts.isJsxOpeningElement(hotspot) ? hotspot.parent : undefined;
  assert.ok(
    hotspotElement &&
      jsxOpenings(hotspotElement).some((opening) =>
        classTokens(opening).has("audio-hotspot__visual"),
      ),
    "audio-hotspot 内应另设视觉圆点，不能让小圆点兼任命中区",
  );
  assert.ok(
    matchingRules(practice.styles, [".audio-hotspot__visual"]).some(
      (rule) =>
        declarationValues(rule, "width").length > 0 &&
        declarationValues(rule, "height").length > 0,
    ),
    "视觉圆点应有独立宽高",
  );
});

contract("训练工作区只在 split 下开启双伸展列", () => {
  assert.ok(
    jsxOpenings(practice.ast).some((opening) =>
      classTokens(opening).has("practice-workspace"),
    ),
    "训练页应提供 practice-workspace",
  );
  assert.ok(
    matchingRules(practice.styles, [
      ".device-layout--split",
      ".practice-workspace",
    ]).some((rule) => {
      const columns = declarationValues(rule, "grid-template-columns").map(
        normalizeCssValue,
      );
      return (
        hasDeclaration(rule, "display", "grid") &&
        columns.includes("minmax(480PX,1fr)minmax(320PX,1fr)") &&
        (hasDeclaration(rule, "gap", "24PX") ||
          hasDeclaration(rule, "column-gap", "24PX"))
      );
    }),
    "split 训练区应为 minmax(480PX,1fr) / minmax(320PX,1fr)，间距 24PX",
  );
  const unsafe = matchingRules(practice.styles, [".practice-workspace"]).some(
    (rule) =>
      !rule.selector.includes(".device-layout--split") &&
      declarationValues(rule, "grid-template-columns").some(hasMultipleGridTracks),
  );
  assert.equal(unsafe, false, "split 外允许 1fr 单栏，但不得出现多轨布局");
});

contract("训练目录是可滚动的底部/右侧抽屉", () => {
  assert.ok(
    exactSelectorRules(practice.styles, ".practice-directory-mask").some(
      (rule) =>
        hasDeclaration(rule, "position", "fixed") &&
        hasDeclaration(rule, "inset", "0") &&
        hasDeclaration(rule, "display", "flex") &&
        hasDeclaration(rule, "align-items", "flex-end"),
    ),
    "目录 mask 应 fixed + inset:0 + flex，并在单栏贴底",
  );
  assert.ok(
    findRuleWith(
      practice.styles,
      [".device-layout--split", ".practice-directory-mask"],
      { "justify-content": "flex-end" },
    ),
    "split 目录应靠右",
  );
  assert.ok(
    matchingRules(practice.styles, [
      ".device-layout--split",
      ".practice-directory-sheet",
    ]).some((rule) => {
      const width = declarationValues(rule, "width").map(numericPx).find(Number.isFinite);
      const fillsHeight = [
        ...declarationValues(rule, "height"),
        ...declarationValues(rule, "max-height"),
      ].some((value) => /^(?:100%|100vh)$/.test(value));
      return width >= 320 && width <= 420 && fillsHeight;
    }),
    "split 目录应为 320–420PX 宽且占满高度的右侧栏",
  );
  const scroll = jsxOpenings(directoryAst).find((opening) =>
    classTokens(opening).has("practice-directory-scroll"),
  );
  assert.ok(
    scroll && jsxTagName(scroll) === "ScrollView" && getJsxAttribute(scroll, "scrollY"),
    "目录内容应使用启用 scrollY 的 ScrollView",
  );
});

contract("打卡教材快照完整显示", () => {
  for (const [pageName, className] of [
    ["打卡详情", "check-in-course-card__image"],
    ["我的打卡", "check-in-list-card__image"],
  ]) {
    const sourceFile = contexts.find((page) => page.name === pageName).ast;
    const image = findImageByClass(sourceFile, className);
    assert.ok(image, `${className} 应存在`);
    assert.equal(
      literalAttributeValue(image, "mode"),
      "aspectFit",
      `${className} 必须使用 aspectFit`,
    );
  }
});

if (failures.length > 0) {
  console.error(`响应式页面契约尚未满足（${failures.length} 项）：`);
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exitCode = 1;
} else {
  console.log(
    "响应式页面契约通过：五页所有状态、44PX 触控、Pad 双栏、热点测量和安全区均符合要求。",
  );
}
