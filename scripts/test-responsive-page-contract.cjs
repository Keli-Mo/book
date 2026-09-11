/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const postcss = require("postcss");
const sass = require("sass");
const ts = require("typescript");
const vm = require("vm");

const projectRoot = path.resolve(__dirname, "..");
const readSource = (relativePath) =>
  fs.readFileSync(path.join(projectRoot, relativePath), "utf8");

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

const parseTypeScript = (relativePath, scriptKind = ts.ScriptKind.TS) =>
  ts.createSourceFile(
    path.join(projectRoot, relativePath),
    readSource(relativePath),
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );

const compileStyles = (relativePath) => {
  const result = sass.compile(path.join(projectRoot, relativePath), {
    loadPaths: [path.join(projectRoot, "src")],
    style: "expanded",
  });
  return postcss.parse(result.css, { from: relativePath });
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

const jsxElementNode = (opening) =>
  ts.isJsxOpeningElement(opening) ? opening.parent : opening;
const descendantByClass = (opening, className) =>
  jsxOpenings(jsxElementNode(opening)).find(
    (candidate) => candidate !== opening && classTokens(candidate).has(className),
  );
const jsxBooleanTrue = (opening, attributeName) => {
  const attribute = getJsxAttribute(opening, attributeName);
  if (!attribute) return false;
  if (!attribute.initializer) return true;
  return Boolean(
    ts.isJsxExpression(attribute.initializer) &&
      attribute.initializer.expression?.kind === ts.SyntaxKind.TrueKeyword,
  );
};
const assertPracticeWorkspaceStructure = (sourceFile) => {
  const workspace = jsxOpenings(sourceFile).find((opening) =>
    classTokens(opening).has("practice-workspace"),
  );
  assert.ok(workspace, "训练页应提供 practice-workspace");
  assert.ok(
    descendantByClass(workspace, "practice-book-page"),
    "practice-workspace 必须实际包住教材区",
  );
  assert.ok(
    descendantByClass(workspace, "practice-recorder"),
    "practice-workspace 必须实际包住录音控制区",
  );
};
const assertDirectoryStructure = (sourceFile) => {
  const mask = jsxOpenings(sourceFile).find((opening) =>
    classTokens(opening).has("practice-directory-mask"),
  );
  assert.ok(mask, "目录组件应渲染 mask");
  const sheet = descendantByClass(mask, "practice-directory-sheet");
  assert.ok(sheet, "目录 sheet 必须嵌套在 mask 内");
  const scroll = descendantByClass(sheet, "practice-directory-scroll");
  assert.ok(
    scroll && jsxTagName(scroll) === "ScrollView" && jsxBooleanTrue(scroll, "scrollY"),
    "目录 ScrollView 必须嵌套在 sheet 内并以布尔真启用 scrollY",
  );
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

const classExpressionTokens = (component, expression, seen = new Set()) => {
  const tokens = collectStringFragments(expression)
    .flatMap((fragment) => fragment.split(/\s+/))
    .filter(Boolean);
  findNodes(expression, (node) => ts.isIdentifier(node)).forEach((identifier) => {
    if (seen.has(identifier.text)) return;
    const declaration = findNodesInComponent(
      component,
      (node) =>
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === identifier.text &&
        node.initializer,
    )[0];
    if (!declaration) return;
    seen.add(identifier.text);
    tokens.push(...classExpressionTokens(component, declaration.initializer, seen));
  });
  return new Set(tokens);
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
    const reservedModifiers = new Set([
      "device-layout--phone",
      "device-layout--pad",
      "device-layout--single",
      "device-layout--split",
      "device-layout--portrait",
      "device-layout--landscape",
    ]);
    const appendedModifiers = [
      ...classExpressionTokens(component, classAttribute.initializer),
    ].filter((token) => reservedModifiers.has(token));
    assert.deepEqual(
      appendedModifiers,
      [],
      `第 ${index + 1} 个根节点不得在 builder 结果之外追加设备 modifier`,
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

const splitSelectorList = (selectorList) => {
  const parts = [];
  let part = "";
  let depth = 0;
  let quote = "";
  for (const character of selectorList) {
    if (quote) {
      part += character;
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]") depth -= 1;
    if (character === "," && depth === 0) {
      if (part.trim()) parts.push(part.trim());
      part = "";
    } else part += character;
  }
  if (part.trim()) parts.push(part.trim());
  return parts;
};
const selectorParts = (rule) => splitSelectorList(rule.selector);
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
const matchingRuleParts = (root, fragments) => {
  const matches = [];
  const classNames = fragments.map((fragment) => fragment.replace(/^\./, ""));
  root.walkRules((rule) => {
    selectorParts(rule).forEach((selector) => {
      if (classNames.every((className) => selectorHasClass(selector, className))) {
        matches.push({ rule, selector });
      }
    });
  });
  return matches;
};
const matchingRules = (root, fragments) => [
  ...new Set(matchingRuleParts(root, fragments).map(({ rule }) => rule)),
];
const rulePartHasClass = (selector, className) =>
  selectorHasClass(selector, className.replace(/^\./, ""));
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
const targetCompound = (selector, className) =>
  selector
    .split(/\s+|[>+~]/)
    .filter(Boolean)
    .find((part) => selectorHasClass(part, className));
const selectorCanMatchElement = (selector, className, elementClasses) => {
  const compound = targetCompound(selector, className);
  if (!compound || /[:[]/.test(compound)) return false;
  const requiredClasses = [...compound.matchAll(/\.([\w-]+)/g)].map(
    (match) => match[1],
  );
  return requiredClasses.every((required) => elementClasses.has(required));
};
const rulesMatchingElement = (roots, opening, className) => {
  const elementClasses = classTokens(opening);
  return roots.flatMap((root) => {
    const rules = [];
    root.walkRules((rule) => {
      if (
        selectorParts(rule).some((selector) =>
          selectorCanMatchElement(selector, className, elementClasses),
        )
      ) {
        rules.push(rule);
      }
    });
    return rules;
  });
};
const baseRulesMatchingElement = (roots, opening, className) => {
  const elementClasses = classTokens(opening);
  return roots.flatMap((root) => {
    const rules = [];
    root.walkRules((rule) => {
      if (rule.parent?.type !== "root") return;
      if (
        selectorParts(rule).some((selector) => {
          const compound = targetCompound(selector, className);
          return (
            compound === selector.trim() &&
            selectorCanMatchElement(selector, className, elementClasses)
          );
        })
      ) {
        rules.push(rule);
      }
    });
    return rules;
  });
};
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
const selectorSubject = (selector) =>
  selector.trim().split(/\s+|[>+~]/).filter(Boolean).at(-1) || "";
const selectorSpecificity = (selector) => {
  const value = selector.replace(/:where\([^)]*\)/g, "");
  const ids = (value.match(/#[\w-]+/g) || []).length;
  const classes = (value.match(/\.[\w-]+/g) || []).length;
  const attributes = (value.match(/\[[^\]]+\]/g) || []).length;
  const pseudoClasses = (value.match(/:(?!:)[\w-]+(?:\([^)]*\))?/g) || []).length;
  const elements = value
    .replace(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|::?[\w-]+(?:\([^)]*\))?/g, " ")
    .split(/[\s>+~*]+/)
    .filter(Boolean).length;
  return [ids, classes + attributes + pseudoClasses, elements];
};
const compareSpecificity = (left, right) => {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
};
const collectBottomPaddingDeclarations = (root, selector) => {
  const className = selector.replace(/^\./, "");
  const declarations = [];
  let order = 0;
  root.walkDecls((declaration) => {
    order += 1;
    if (!["padding", "padding-bottom"].includes(declaration.prop)) return;
    selectorParts(declaration.parent).forEach((part) => {
      if (selectorHasClass(selectorSubject(part), className)) {
        declarations.push({
          declaration,
          selector: part,
          specificity: selectorSpecificity(part),
          order,
        });
      }
    });
  });
  return declarations;
};
const assertSafeAreaFallback = (root, selector, basePx) => {
  const allDeclarations = collectBottomPaddingDeclarations(root, selector);
  const exactDeclarations = allDeclarations.filter(
    ({ selector: candidate }) => candidate === selector,
  );
  const [constantEntry, envEntry] = exactDeclarations.slice(-2);
  const constantDeclaration = constantEntry?.declaration;
  const envDeclaration = envEntry?.declaration;
  const expectedConstant = `calc(${basePx}PX+constant(safe-area-inset-bottom))`;
  const expectedEnv = `calc(${basePx}PX+env(safe-area-inset-bottom))`;
  assert.equal(
    normalizeCssValue(constantDeclaration?.value || ""),
    expectedConstant,
    `${selector} 最终倒数第二条 padding-bottom 应保留 ${basePx}PX + constant()`,
  );
  assert.equal(constantDeclaration?.prop, "padding-bottom", `${selector} constant 前不得被 padding 简写打断`);
  assert.equal(
    normalizeCssValue(envDeclaration?.value || ""),
    expectedEnv,
    `${selector} 最后一条 padding-bottom 应以 ${basePx}PX + env() 覆盖`,
  );
  assert.equal(envDeclaration?.prop, "padding-bottom", `${selector} env 后不得出现 padding 简写覆盖`);

  const approved = new Set([constantDeclaration, envDeclaration]);
  const referenceSpecificity = selectorSpecificity(selector);
  const canOverrideEnv = (entry) => {
    if (approved.has(entry.declaration)) return false;
    const candidateImportant = Boolean(entry.declaration.important);
    const envImportant = Boolean(envDeclaration?.important);
    if (candidateImportant !== envImportant) return candidateImportant;
    const specificity = compareSpecificity(entry.specificity, referenceSpecificity);
    return specificity > 0 || (specificity === 0 && entry.order > envEntry.order);
  };
  const unsafeOverride = allDeclarations.find((entry) => {
    if (!canOverrideEnv(entry)) return false;
    if (entry.declaration.prop !== "padding-bottom") return true;
    const normalized = normalizeCssValue(entry.declaration.value);
    return normalized !== expectedConstant && normalized !== expectedEnv;
  });
  assert.equal(
    unsafeOverride,
    undefined,
    `${selector} 的安全区不得被 ${unsafeOverride?.selector || "后续规则"} 覆盖`,
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
const unsafeTargetDimension = (value, property = "min-height") => {
  const normalized = value.trim();
  const isMinimum = property.startsWith("min-");
  // 自定义值和计算式无法静态证明下限；CSS-wide keyword 会直接移除本层保证。
  if (/\b(?:var|env|calc)\s*\(/i.test(normalized)) return true;
  if (/^(?:initial|inherit|unset|revert|revert-layer)$/i.test(normalized)) return true;
  const unitTokens = value.match(/-?\d*\.?\d+(?:[a-zA-Z]+|%)/g) || [];
  for (const token of unitTokens) {
    const match = token.match(/^(-?\d*\.?\d+)([a-zA-Z]+|%)$/);
    if (!match) continue;
    const number = Number(match[1]);
    const unit = match[2];
    if (unit === "%") {
      if (isMinimum) return true;
      continue;
    }
    if (unit !== "PX" || number < 44) return true;
  }
  if (/^0(?:\.0+)?$/.test(normalized)) return true;
  return isMinimum && unitTokens.length === 0;
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
  const ownsMinimum = (element, targetClass) =>
    ["min-width", "min-height"].every((property) =>
      baseRulesMatchingElement(roots, element, targetClass).some((rule) =>
        declarationValues(rule, property).some(guarantees44Px),
      ),
    );
  assert.ok(
    elements.every(
      (element) =>
        ownsMinimum(element, className) ||
        (classTokens(element).has("device-touch-target") &&
          ownsMinimum(element, "device-touch-target")),
    ),
    `${selector} 应直接声明 >=44PX 最小宽高或使用 device-touch-target`,
  );

  const unsafe = elements.flatMap((element) => {
    const relevantClasses = [className];
    if (classTokens(element).has("device-touch-target")) {
      relevantClasses.push("device-touch-target");
    }
    return relevantClasses.flatMap((name) =>
      rulesMatchingElement(roots, element, name).flatMap((rule) =>
        ["width", "height", "min-width", "min-height"].flatMap((property) =>
          declarationValues(rule, property)
            .filter((value) => unsafeTargetDimension(value, property))
            .map((value) => `${rule.selector} { ${property}: ${value} }`),
        ),
      ),
    );
  });
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

const assertDeviceLayoutClassBuilder = (buildDeviceLayoutClassName) => {
  assert.equal(typeof buildDeviceLayoutClassName, "function", "应提供设备 class builder");
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
};

contract("设备 class builder 输出互斥且可预测", () => {
  const { buildDeviceLayoutClassName } = loadSimpleTypeScriptModule(
    "src/features/layout/deviceLayout.ts",
  );
  assertDeviceLayoutClassBuilder(buildDeviceLayoutClassName);
});

contract("设备 class builder 变异夹具能拦截永久和反向 modifier", () => {
  const correct = ({ isPad, isSplit, orientation }) =>
    [
      "device-layout",
      isPad ? "device-layout--pad" : "device-layout--phone",
      isSplit ? "device-layout--split" : "device-layout--single",
      `device-layout--${orientation}`,
    ].join(" ");
  assertDeviceLayoutClassBuilder(correct);
  assert.throws(() =>
    assertDeviceLayoutClassBuilder((profile) =>
      `${correct(profile)} device-layout--pad device-layout--split`,
    ),
  );
  assert.throws(() =>
    assertDeviceLayoutClassBuilder(({ isPad, isSplit, orientation }) =>
      [
        "device-layout",
        isPad ? "device-layout--phone" : "device-layout--pad",
        isSplit ? "device-layout--single" : "device-layout--split",
        orientation === "landscape"
          ? "device-layout--portrait"
          : "device-layout--landscape",
      ].join(" "),
    ),
  );
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
      const layoutClassName = buildDeviceLayoutClassName(layout);
      return <View className={\`\${layoutClassName} device-layout--pad device-layout--split\`}><View className='device-layout__content' /></View>;
    }
  `);
  const reversedModifier = fixture(`${imports}
    export default function Page() {
      const layout = useDeviceLayout();
      const layoutClassName = buildDeviceLayoutClassName(layout);
      return <View className={\`\${layoutClassName} \${layout.isSplit ? "device-layout--single" : "device-layout--split"}\`}><View className='device-layout__content' /></View>;
    }
  `);
  const indirectModifier = fixture(`${imports}
    export default function Page() {
      const layout = useDeviceLayout();
      const layoutClassName = buildDeviceLayoutClassName(layout);
      const alwaysSplit = "device-layout--split";
      return <View className={\`\${layoutClassName} \${alwaysSplit}\`}><View className='device-layout__content' /></View>;
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
  assert.throws(() => assertEveryReturnUsesResponsiveShell(reversedModifier));
  assert.throws(() => assertEveryReturnUsesResponsiveShell(indirectModifier));
  assert.throws(() => assertEveryReturnUsesResponsiveShell(uncoveredEarlyReturn));
});

contract("训练工作区与目录夹具验证真实 JSX 嵌套和布尔滚动", () => {
  const fixture = (source) =>
    ts.createSourceFile(
      "structure-fixture.tsx",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
  assertPracticeWorkspaceStructure(
    fixture(`<View className='practice-workspace'>
      <View className='practice-book-page' />
      <View className='practice-recorder' />
    </View>`),
  );
  assert.throws(() =>
    assertPracticeWorkspaceStructure(
      fixture(`<View><View className='practice-workspace' />
        <View className='practice-book-page' /><View className='practice-recorder' />
      </View>`),
    ),
  );

  const directory = (scrollY) => fixture(`<View className='practice-directory-mask'>
    <View className='practice-directory-sheet'>
      <ScrollView className='practice-directory-scroll' ${scrollY} />
    </View>
  </View>`);
  assertDirectoryStructure(directory("scrollY"));
  assert.throws(() => assertDirectoryStructure(directory("scrollY={false}")));
  assert.throws(() => assertDirectoryStructure(directory('scrollY="true"')));
  assert.throws(() =>
    assertDirectoryStructure(
      fixture(`<View><View className='practice-directory-mask' />
        <View className='practice-directory-sheet'>
          <ScrollView className='practice-directory-scroll' scrollY />
        </View>
      </View>`),
    ),
  );
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
  assert.throws(() =>
    assertSafeAreaFallback(
      postcss.parse(`${good.toString()} .page { padding: 0; }`),
      ".page",
      24,
    ),
  );
  assert.throws(() =>
    assertSafeAreaFallback(
      postcss.parse(`${good.toString()} .modifier .page { padding-bottom: 0; }`),
      ".page",
      24,
    ),
  );
  assert.throws(() =>
    assertSafeAreaFallback(
      postcss.parse(`.modifier .page { padding-bottom: 0; } ${good.toString()}`),
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
    ["unset", true],
    ["initial", true],
    ["revert", true],
    ["var(--target-size)", true],
  ].forEach(([value, unsafe]) =>
    assert.equal(unsafeTargetDimension(value), unsafe, `单位 fixture ${value}`),
  );
});

contract("紧凑触控完整夹具拒绝无效 selector 与下限重置", () => {
  const fixtureAst = ts.createSourceFile(
    "touch-fixture.tsx",
    "export default () => <View className='fixture-target' onClick={handleClick} />;",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const good = `.fixture-target { min-width: 44PX; min-height: 48PX; }`;
  assertCompactTarget(fixtureAst, [postcss.parse(good)], ".fixture-target");
  [
    `${good} .fixture-target { min-height: unset; }`,
    `${good} .fixture-target { min-height: var(--tiny); }`,
    `${good} .fixture-target { min-height: calc(100% - 48PX); }`,
    `.fixture-target.never { min-width: 44PX; min-height: 44PX; }`,
    `.never .fixture-target { min-width: 44PX; min-height: 44PX; }`,
    `@media (min-width: 900PX) { .fixture-target { min-width: 44PX; min-height: 44PX; } }`,
  ].forEach((css) =>
    assert.throws(() =>
      assertCompactTarget(fixtureAst, [postcss.parse(css)], ".fixture-target"),
    ),
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

  const realSplit = postcss.parse(
    ".device-layout--split .fixture-grid { grid-template-columns: 1fr 1fr; }",
  );
  const splitish = postcss.parse(
    ".device-layout--splitish .fixture-grid { grid-template-columns: 1fr 1fr; }",
  );
  const commaSplit = postcss.parse(
    ".device-layout--split, .fixture-grid { grid-template-columns: 1fr 1fr; }",
  );
  assert.equal(
    matchingRules(realSplit, [".device-layout--split", ".fixture-grid"]).length,
    1,
  );
  assert.equal(
    matchingRules(splitish, [".device-layout--split", ".fixture-grid"]).length,
    0,
  );
  assert.equal(
    matchingRules(commaSplit, [".device-layout--split", ".fixture-grid"]).length,
    0,
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
    const unsafe = matchingRuleParts(root, [selector]).some(
      ({ rule, selector: selectorPart }) =>
        !rulePartHasClass(selectorPart, "device-layout--split") &&
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

const functionFromIdentifier = (sourceFile, identifier) => {
  const declaration = findNodes(
    sourceFile,
    (node) =>
      (ts.isFunctionDeclaration(node) && node.name?.text === identifier.text) ||
      (ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === identifier.text &&
        node.initializer),
  )[0];
  if (!declaration) return undefined;
  if (ts.isFunctionDeclaration(declaration)) return declaration;
  const initializer = unwrapExpression(declaration.initializer);
  if (ts.isFunctionLike(initializer)) return initializer;
  if (
    ts.isCallExpression(initializer) &&
    initializer.arguments[0] &&
    ts.isFunctionLike(unwrapExpression(initializer.arguments[0]))
  ) {
    return unwrapExpression(initializer.arguments[0]);
  }
  return undefined;
};

const enclosingFunction = (node) => {
  let current = node.parent;
  while (current && !ts.isFunctionLike(current)) current = current.parent;
  return current;
};

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

const findMeasuredImageSizeState = (component, sourceFile, callback) => {
  const resultName = callbackParameterName(callback);
  assert.ok(resultName, "boundingClientRect 回调应接收实际盒子结果");
  const useStateName = getNamedImportLocalName(sourceFile, "react", "useState");
  assert.ok(useStateName, "应从 React 命名导入 useState");
  const states = findNodesInComponent(
    component,
    (node) =>
      ts.isVariableDeclaration(node) &&
      ts.isArrayBindingPattern(node.name) &&
      node.name.elements.length >= 2 &&
      ts.isBindingElement(node.name.elements[0]) &&
      ts.isIdentifier(node.name.elements[0].name) &&
      ts.isBindingElement(node.name.elements[1]) &&
      ts.isIdentifier(node.name.elements[1].name) &&
      node.initializer &&
      ts.isCallExpression(unwrapExpression(node.initializer)) &&
      ts.isIdentifier(unwrapExpression(node.initializer).expression) &&
      unwrapExpression(node.initializer).expression.text === useStateName,
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
    if (setterCall) return { sizeName, setterName, declaration: state };
  }
  assert.fail("实际 boundingClientRect 的 width/height 应写入同一个图片尺寸 state");
};

const expressionIsLayoutDependency = (expression, binding, member) => {
  const value = unwrapExpression(expression);
  if (binding.objectName) {
    return (
      ts.isPropertyAccessExpression(value) &&
      ts.isIdentifier(value.expression) &&
      value.expression.text === binding.objectName &&
      value.name.text === member
    );
  }
  return ts.isIdentifier(value) && value.text === binding.members.get(member);
};

const functionInvokesIdentifier = (callback, identifier) =>
  findNodesInComponent(
    callback,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === identifier,
  ).length > 0;

const objectMemberExpression = (object, member) => {
  const property = object.properties.find(
    (item) =>
      (ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item)) &&
      propertyName(item.name) === member,
  );
  if (property && ts.isPropertyAssignment(property)) return property.initializer;
  return property?.name;
};

const resolveStyleObject = (component, styleAttribute) => {
  if (
    !styleAttribute?.initializer ||
    !ts.isJsxExpression(styleAttribute.initializer) ||
    !styleAttribute.initializer.expression
  ) {
    return undefined;
  }
  let expression = unwrapExpression(styleAttribute.initializer.expression);
  if (ts.isIdentifier(expression)) {
    const declaration = findNodes(
      component.body,
      (node) =>
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === expression.text &&
        node.initializer,
    )[0];
    if (declaration) expression = unwrapExpression(declaration.initializer);
  }
  return ts.isObjectLiteralExpression(expression) ? expression : undefined;
};

const styleReadsClampResult = (styleObject, resultDeclaration) => {
  for (const member of ["left", "top"]) {
    const styleValue = objectMemberExpression(styleObject, member);
    if (!styleValue) return false;
    if (ts.isIdentifier(resultDeclaration.name)) {
      const readsCorrectMember = findNodes(
        styleValue,
        (node) =>
          ts.isPropertyAccessExpression(node) &&
          expressionReferencesIdentifier(node.expression, resultDeclaration.name.text) &&
          node.name.text === member,
      ).length > 0;
      if (!readsCorrectMember) return false;
      continue;
    }
    if (!ts.isObjectBindingPattern(resultDeclaration.name)) return false;
    const bindingElement = resultDeclaration.name.elements.find(
      (element) => propertyName(element.propertyName || element.name) === member,
    );
    if (
      !bindingElement ||
      !ts.isIdentifier(bindingElement.name) ||
      !expressionReferencesIdentifier(styleValue, bindingElement.name.text)
    ) {
      return false;
    }
  }
  return true;
};

const expressionUsesMeasuredSize = (expression, sizeName) => {
  const value = unwrapExpression(expression);
  if (ts.isIdentifier(value)) return value.text === sizeName;
  if (!ts.isObjectLiteralExpression(value)) return false;
  if (
    value.properties.some(
      (property) =>
        ts.isSpreadAssignment(property) &&
        ts.isIdentifier(property.expression) &&
        property.expression.text === sizeName,
    )
  ) {
    return true;
  }
  return ["width", "height"].every((member) => {
    const memberExpression = objectMemberExpression(value, member);
    return Boolean(
      memberExpression &&
        findNodes(
          memberExpression,
          (node) =>
            ts.isPropertyAccessExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === sizeName &&
            node.name.text === member,
        ).length > 0,
    );
  });
};

const assertHotspotMeasurementFlow = (sourceFile) => {
  const image = findImageByClass(sourceFile, "practice-book-page__image");
  assert.ok(image, "训练页应保留 practice-book-page__image 教材图");
  assert.equal(literalAttributeValue(image, "mode"), "widthFix", "教材图应使用 widthFix");
  const component = enclosingFunction(image);
  assert.ok(component?.body, "应定位包含教材图的训练组件");
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
  const rectCallbackExpression = rectCall.arguments[0]
    ? unwrapExpression(rectCall.arguments[0])
    : undefined;
  const callback =
    rectCallbackExpression && ts.isIdentifier(rectCallbackExpression)
      ? functionFromIdentifier(sourceFile, rectCallbackExpression)
      : rectCallbackExpression;
  assert.ok(callback && ts.isFunctionLike(callback), "boundingClientRect 应处理测量回调");
  const { sizeName: imageSizeName } = findMeasuredImageSizeState(
    component,
    sourceFile,
    callback,
  );

  const layoutBinding = findHookBinding(component, sourceFile);
  const effectName =
    getNamedImportLocalName(sourceFile, "react", "useEffect") || "useEffect";
  const resizeEffect = findNodesInComponent(
    component,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === effectName &&
      node.arguments.length >= 2 &&
      ts.isArrayLiteralExpression(node.arguments[1]) &&
      ["windowWidth", "windowHeight"].every((dimension) =>
        node.arguments[1].elements.some(
          (element) => expressionIsLayoutDependency(element, layoutBinding, dimension),
        ),
      ),
  )[0];
  assert.ok(resizeEffect, "resize effect 必须依赖同一 useDeviceLayout 的窗口宽高");
  const effectExpression = unwrapExpression(resizeEffect.arguments[0]);
  const effectCallback = ts.isIdentifier(effectExpression)
    ? functionFromIdentifier(sourceFile, effectExpression)
    : effectExpression;
  assert.ok(
    effectCallback &&
      ts.isFunctionLike(effectCallback) &&
      functionInvokesIdentifier(effectCallback, handlerName),
    "窗口变化 effect 必须真正调用 onLoad 使用的同一测量函数",
  );

  const clampName = getNamedImportLocalName(
    sourceFile,
    "@/features/listeningPractice/hotspotLayout",
    "clampHotspotCenter",
  );
  assert.ok(clampName, "应命名导入 clampHotspotCenter");
  const clampCall = findNodes(
    component.body,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === clampName &&
      node.arguments.length >= 2 &&
      expressionUsesMeasuredSize(node.arguments[1], imageSizeName),
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
    component.body,
    (node) =>
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      findNodes(node.initializer, (candidate) => candidate === clampCall).length > 0,
  )[0];
  assert.ok(resultDeclaration, "热点收敛结果应保存后再用于渲染");
  const usesClampResult = jsxOpenings(component.body)
    .filter((opening) => classTokens(opening).has("audio-hotspot"))
    .some((hotspot) => {
      const styleObject = resolveStyleObject(
        component,
        getJsxAttribute(hotspot, "style"),
      );
      return styleObject && styleReadsClampResult(styleObject, resultDeclaration);
    });
  assert.ok(
    usesClampResult,
    "热点 style.left/style.top 必须分别读取同一 clamp 结果的 left/top",
  );
};

contract("热点数据流变异夹具逐段绑定 load、resize、state、clamp 与 style", () => {
  const fixture = ({
    selector = ".practice-book-page__image",
    stateFactory = "useState",
    effectBody = "measureImage();",
    dependencies = "layout.windowWidth, layout.windowHeight",
    clampSize = "imageSize",
    style = "{ left: center.left, top: center.top }",
  } = {}) =>
    ts.createSourceFile(
      "hotspot-fixture.tsx",
      `
        import { useEffect, useState } from "react";
        import { useDeviceLayout } from "@/hooks/useDeviceLayout";
        import { clampHotspotCenter } from "@/features/listeningPractice/hotspotLayout";
        export default function Fixture() {
          const layout = useDeviceLayout();
          const [imageSize, setImageSize] = ${stateFactory}({ width: 0, height: 0 });
          const measureImage = () => {
            Taro.createSelectorQuery()
              .select("${selector}")
              .boundingClientRect((rect) => {
                setImageSize({ width: rect.width, height: rect.height });
              })
              .exec();
          };
          useEffect(() => { ${effectBody} }, [${dependencies}]);
          const center = clampHotspotCenter(
            { left: track.left, top: track.top },
            ${clampSize},
          );
          return <View>
            <Image className='practice-book-page__image' mode='widthFix' onLoad={measureImage} />
            <View className='audio-hotspot' style={${style}} />
          </View>;
        }
      `,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );

  assertHotspotMeasurementFlow(fixture());
  [
    { effectBody: "void measureImage;" },
    { effectBody: "const later = () => measureImage(); void later;" },
    { dependencies: "windowWidth, windowHeight" },
    { stateFactory: "makePair" },
    { selector: ".some-other-image" },
    { clampSize: "unmeasuredSize" },
    { clampSize: "{ width: 0, height: 0, ignored: imageSize }" },
    { style: "{ color: center.left, opacity: center.top }" },
    { style: "{ left: center.top, top: center.left }" },
  ].forEach((mutation) =>
    assert.throws(() => assertHotspotMeasurementFlow(fixture(mutation))),
  );
});

contract("训练热点使用图片 load/resize 后的实际盒子", () => {
  assertHotspotMeasurementFlow(practice.ast);
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
  assertPracticeWorkspaceStructure(practice.ast);
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
  const unsafe = matchingRuleParts(practice.styles, [".practice-workspace"]).some(
    ({ rule, selector }) =>
      !rulePartHasClass(selector, "device-layout--split") &&
      declarationValues(rule, "grid-template-columns").some(hasMultipleGridTracks),
  );
  assert.equal(unsafe, false, "split 外允许 1fr 单栏，但不得出现多轨布局");
});

contract("训练目录是可滚动的底部/右侧抽屉", () => {
  assertDirectoryStructure(directoryAst);
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
