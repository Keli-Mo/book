/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const postcss = require("postcss");
const sass = require("sass");
const ts = require("typescript");

const projectRoot = path.resolve(__dirname, "..");
const readSource = (relativePath) =>
  fs.readFileSync(path.join(projectRoot, relativePath), "utf8");

const pages = [
  {
    name: "首页",
    key: "Home",
    tsx: "src/pages/Home/Home.tsx",
    scss: "src/pages/Home/Home.scss",
    config: "src/pages/Home/Home.config.ts",
    safeAreaSelector: ".home-tabs",
    longTextSelectors: [".continue-card__title"],
  },
  {
    name: "书库",
    key: "BookLibrary",
    tsx: "src/pages/BookLibrary/BookLibrary.tsx",
    scss: "src/pages/BookLibrary/BookLibrary.scss",
    config: "src/pages/BookLibrary/BookLibrary.config.ts",
    safeAreaSelector: ".book-library",
    longTextSelectors: [".book-row__title"],
  },
  {
    name: "训练",
    key: "Practice",
    tsx: "src/pages/Practice/Practice.tsx",
    scss: "src/pages/Practice/Practice.scss",
    config: "src/pages/Practice/Practice.config.ts",
    safeAreaSelector: ".practice-page",
    longTextSelectors: [
      ".practice-header__course",
      ".practice-header__section",
    ],
  },
  {
    name: "打卡详情",
    key: "CheckInDetail",
    tsx: "src/pages/CheckInDetail/CheckInDetail.tsx",
    scss: "src/pages/CheckInDetail/CheckInDetail.scss",
    config: "src/pages/CheckInDetail/CheckInDetail.config.ts",
    safeAreaSelector: ".check-in-detail",
    longTextSelectors: [
      ".check-in-course-card__book",
      ".check-in-course-card__section",
    ],
  },
  {
    name: "我的打卡",
    key: "MyCheckIns",
    tsx: "src/pages/MyCheckIns/MyCheckIns.tsx",
    scss: "src/pages/MyCheckIns/MyCheckIns.scss",
    config: "src/pages/MyCheckIns/MyCheckIns.config.ts",
    safeAreaSelector: ".my-check-ins",
    longTextSelectors: [
      ".check-in-list-card__section",
      ".check-in-list-card__book",
    ],
  },
];

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

const findNodes = (node, predicate, results = []) => {
  if (predicate(node)) results.push(node);
  // TypeScript 会把 visitor 的 truthy 返回值当作“停止遍历”，这里不能直接返回数组。
  ts.forEachChild(node, (child) => {
    findNodes(child, predicate, results);
  });
  return results;
};

const propertyName = (node) => {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return "";
};

const findConfigObject = (sourceFile, factoryName) => {
  const call = findNodes(
    sourceFile,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === factoryName &&
      node.arguments.length === 1 &&
      ts.isObjectLiteralExpression(node.arguments[0]),
  )[0];
  assert.ok(call, `应使用 ${factoryName} 声明配置`);
  return call.arguments[0];
};

const getObjectProperty = (object, name) =>
  object.properties.find(
    (item) =>
      ts.isPropertyAssignment(item) && propertyName(item.name) === name,
  );

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

const jsxOpenings = (sourceFile) =>
  findNodes(
    sourceFile,
    (node) => ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node),
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
    ts.isJsxText(node)
  ) {
    fragments.push(node.text);
  } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
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

const classAttributeReferences = (opening, variableName, memberName) => {
  const attribute = getJsxAttribute(opening, "className");
  if (!attribute?.initializer) return false;
  return findNodes(
    attribute.initializer,
    (node) =>
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === variableName &&
      node.name.text === memberName,
  ).length > 0;
};

const findLayoutBinding = (sourceFile) => {
  const importName = getNamedImportLocalName(
    sourceFile,
    "@/hooks/useDeviceLayout",
    "useDeviceLayout",
  );
  assert.ok(importName, "应从 @/hooks/useDeviceLayout 命名导入 useDeviceLayout");
  const call = findNodes(
    sourceFile,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === importName,
  ).find(
    (node) =>
      ts.isVariableDeclaration(node.parent) &&
      node.parent.initializer === node &&
      ts.isIdentifier(node.parent.name),
  );
  assert.ok(call, "应把 useDeviceLayout() 结果保存在页面局部变量中");
  return call.parent.name.text;
};

const assertResponsivePageClasses = (sourceFile) => {
  const layoutName = findLayoutBinding(sourceFile);
  const openings = jsxOpenings(sourceFile);
  const layoutRoot = openings.find((opening) => {
    const tokens = classTokens(opening);
    return (
      tokens.has("device-layout") &&
      tokens.has("device-layout--pad") &&
      tokens.has("device-layout--split") &&
      tokens.has("device-layout--single")
    );
  });
  assert.ok(
    layoutRoot,
    "根布局 class 应同时声明 device-layout、pad 与 split/single 分支",
  );
  assert.ok(
    classAttributeReferences(layoutRoot, layoutName, "isPad"),
    "pad class 必须由 layout.isPad 驱动",
  );
  assert.ok(
    classAttributeReferences(layoutRoot, layoutName, "isSplit"),
    "split/single class 必须由 layout.isSplit 驱动，不能只靠媒体查询",
  );
  assert.ok(
    openings.some((opening) => classTokens(opening).has("device-layout__content")),
    "页面应包含共享 device-layout__content 内容容器",
  );
};

const interactiveLabel = (opening) => {
  const tokens = [...classTokens(opening)];
  return tokens[0] || `<${jsxTagName(opening)}>`;
};

const assertTouchTargetsUseSharedClass = (relativePath) => {
  const sourceFile = parseTypeScript(relativePath, ts.ScriptKind.TSX);
  const missing = jsxOpenings(sourceFile)
    .filter((opening) => {
      const tag = jsxTagName(opening);
      const tokens = classTokens(opening);
      const isAction = tag === "Button" || Boolean(getJsxAttribute(opening, "onClick"));
      const isWholeSurface =
        tokens.has("practice-directory-mask") ||
        tokens.has("practice-directory-sheet");
      return isAction && !isWholeSurface && !tokens.has("device-touch-target");
    })
    .map(interactiveLabel);
  assert.equal(
    missing.length,
    0,
    `以下交互元素缺少 device-touch-target：${missing.join("、")}`,
  );
};

const literalAttributeValue = (opening, name) => {
  const attribute = getJsxAttribute(opening, name);
  return attribute?.initializer && ts.isStringLiteral(attribute.initializer)
    ? attribute.initializer.text
    : "";
};

const findImageByClass = (sourceFile, className) =>
  jsxOpenings(sourceFile).find(
    (opening) =>
      jsxTagName(opening) === "Image" && classTokens(opening).has(className),
  );

const compileStyles = (relativePath) => {
  const result = sass.compile(path.join(projectRoot, relativePath), {
    loadPaths: [path.join(projectRoot, "src")],
    style: "expanded",
  });
  return postcss.parse(result.css, { from: relativePath });
};

const ruleContains = (rule, fragments) =>
  fragments.every((fragment) => rule.selector.includes(fragment));

const matchingRules = (root, fragments) => {
  const rules = [];
  root.walkRules((rule) => {
    if (ruleContains(rule, fragments)) rules.push(rule);
  });
  return rules;
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

const assertSafeAreaFallback = (root, selector) => {
  const valid = matchingRules(root, [selector]).some((rule) => {
    const paddingDeclarations = rule.nodes.filter(
      (node) => node.type === "decl" && node.prop === "padding-bottom",
    );
    const constantIndex = paddingDeclarations.findIndex((node) =>
      node.value.includes("constant(safe-area-inset-bottom)"),
    );
    const envIndex = paddingDeclarations.findIndex((node) =>
      node.value.includes("env(safe-area-inset-bottom)"),
    );
    return constantIndex >= 0 && envIndex > constantIndex;
  });
  assert.ok(
    valid,
    `${selector} 应先声明 constant(safe-area-inset-bottom)，再用 env() 覆盖`,
  );
};

const assertLongTextPolicy = (root, selector) => {
  const valid = matchingRules(root, [selector]).some((rule) => {
    const overflowHidden = hasDeclaration(rule, "overflow", "hidden");
    const ellipsis = hasDeclaration(rule, "text-overflow", "ellipsis");
    const lineClamp = declarationValues(rule, "-webkit-line-clamp").length > 0;
    const wrapAnywhere =
      hasDeclaration(rule, "overflow-wrap", /^(?:anywhere|break-word)$/) ||
      hasDeclaration(rule, "word-break", /^(?:break-all|break-word)$/);
    return (overflowHidden && (ellipsis || lineClamp)) || wrapAnywhere;
  });
  assert.ok(valid, `${selector} 应提供省略、行截断或安全断词策略`);
};

const findConvertedFixedMinimum = (roots) => {
  const invalid = [];
  for (const [relativePath, root] of roots) {
    root.walkRules((rule) => {
      // 只约束本契约命名的触控 class，不误伤旧页面中其他自适应 rpx 尺寸。
      if (!rule.selector.includes(".device-touch-target")) return;
      rule.walkDecls(/^(?:min-width|min-height)$/, (declaration) => {
        const tokens = declaration.value.match(/[\d.]+(?:px|rpx)/gi) || [];
        if (
          tokens.some(
            (token) =>
              (token.toLowerCase() === "44px" && token !== "44PX") ||
              token.toLowerCase() === "88rpx",
          )
        ) {
          invalid.push(`${relativePath}:${declaration.source?.start?.line || "?"}`);
        }
      });
    });
  }
  return invalid;
};

const appConfig = parseTypeScript("src/app.config.ts");
contract("应用允许 Pad 窗口调整", () => {
  const config = findConfigObject(appConfig, "defineAppConfig");
  const resizable = getObjectProperty(config, "resizable");
  assert.ok(
    resizable && resizable.initializer.kind === ts.SyntaxKind.TrueKeyword,
    "app.config.ts 应显式设置 resizable: true",
  );
});

for (const page of pages) {
  contract(`${page.name}允许自动旋转`, () => {
    const config = findConfigObject(
      parseTypeScript(page.config),
      "definePageConfig",
    );
    const orientation = getObjectProperty(config, "pageOrientation");
    assert.ok(
      orientation &&
        ts.isStringLiteral(orientation.initializer) &&
        orientation.initializer.text === "auto",
      `${page.config} 应设置 pageOrientation: "auto"`,
    );
  });

  contract(`${page.name}接入共享设备布局`, () => {
    assertResponsivePageClasses(parseTypeScript(page.tsx, ts.ScriptKind.TSX));
  });

  contract(`${page.name}处理底部安全区`, () => {
    assertSafeAreaFallback(compileStyles(page.scss), page.safeAreaSelector);
  });

  contract(`${page.name}处理关键长文本`, () => {
    const styles = compileStyles(page.scss);
    for (const selector of page.longTextSelectors) {
      assertLongTextPolicy(styles, selector);
    }
  });

  contract(`${page.name}交互目标不少于 44 CSS px`, () => {
    assertTouchTargetsUseSharedClass(page.tsx);
  });
}

contract("训练目录交互目标不少于 44 CSS px", () => {
  assertTouchTargetsUseSharedClass("src/pages/Practice/PracticeDirectory.tsx");
});

const appStyles = compileStyles("src/app.scss");
const pageStyles = pages.map((page) => [page.scss, compileStyles(page.scss)]);

contract("共享触控尺寸使用不会被 Taro 转换的大写 PX", () => {
  const rule = findRuleWith(appStyles, [".device-touch-target"], {
    "min-width": "44PX",
    "min-height": "44PX",
  });
  assert.ok(
    rule,
    "app.scss 的 .device-touch-target 应显式设置 min-width/min-height: 44PX",
  );
  const invalid = findConvertedFixedMinimum([
    ["src/app.scss", appStyles],
    ...pageStyles,
  ]);
  assert.equal(
    invalid.length,
    0,
    `固定 44 CSS px 不得写成 44px/88rpx：${invalid.join("、")}`,
  );
});

contract("共享内容容器限制 Pad 最大宽度", () => {
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
});

contract("窄屏动作区可以折行和纵向排列", () => {
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
  assert.ok(
    hasNarrowColumn,
    "app.scss 应在 max-width: 360PX 下把 .device-actions 改为纵向",
  );

  for (const relativePath of [
    "src/pages/Practice/Practice.tsx",
    "src/pages/CheckInDetail/CheckInDetail.tsx",
    "src/pages/MyCheckIns/MyCheckIns.tsx",
  ]) {
    const sourceFile = parseTypeScript(relativePath, ts.ScriptKind.TSX);
    assert.ok(
      jsxOpenings(sourceFile).some((opening) =>
        classTokens(opening).has("device-actions"),
      ),
      `${relativePath} 的多按钮区域应使用 device-actions`,
    );
  }
});

contract("书库与打卡列表只由 split class 开启两列", () => {
  const bookStyles = compileStyles("src/pages/BookLibrary/BookLibrary.scss");
  const checkInStyles = compileStyles("src/pages/MyCheckIns/MyCheckIns.scss");
  for (const [label, root, selector] of [
    ["书库", bookStyles, ".book-list"],
    ["我的打卡", checkInStyles, ".my-check-ins__list"],
  ]) {
    const rule = matchingRules(root, [".device-layout--split", selector]).find(
      (candidate) =>
        hasDeclaration(candidate, "display", "grid") &&
        declarationValues(candidate, "grid-template-columns").some(
          (value) =>
            value.replace(/\s+/g, "") === "repeat(2,minmax(0,1fr))",
        ),
    );
    assert.ok(rule, `${label}应在 device-layout--split 下显示两列`);

    const unsafeGrid = matchingRules(root, [selector]).find(
      (candidate) =>
        !candidate.selector.includes(".device-layout--split") &&
        declarationValues(candidate, "grid-template-columns").length > 0,
    );
    assert.equal(
      unsafeGrid,
      undefined,
      `${label}双栏不得仅由媒体查询宽度触发`,
    );
  }
});

contract("训练教材图使用自然比例且按实际盒子收敛热点", () => {
  const sourceFile = parseTypeScript(
    "src/pages/Practice/Practice.tsx",
    ts.ScriptKind.TSX,
  );
  const image = findImageByClass(sourceFile, "practice-book-page__image");
  assert.ok(image, "训练页应保留 practice-book-page__image 教材图");
  assert.equal(literalAttributeValue(image, "mode"), "widthFix", "教材图应使用 widthFix");
  assert.ok(getJsxAttribute(image, "onLoad"), "教材图加载后应测量实际渲染盒子");

  const clampImport = getNamedImportLocalName(
    sourceFile,
    "@/features/listeningPractice/hotspotLayout",
    "clampHotspotCenter",
  );
  assert.ok(clampImport, "应导入 clampHotspotCenter 收敛边缘热点");
  assert.ok(
    findNodes(
      sourceFile,
      (node) =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === clampImport,
    ).length > 0,
    "应使用 clampHotspotCenter 处理热点中心",
  );
  for (const method of ["createSelectorQuery", "boundingClientRect"]) {
    assert.ok(
      findNodes(
        sourceFile,
        (node) =>
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === method,
      ).length > 0,
      `应调用 ${method} 获取教材图实际尺寸`,
    );
  }

  const styles = compileStyles("src/pages/Practice/Practice.scss");
  const imageRules = matchingRules(styles, [".practice-book-page__image"]);
  assert.ok(
    imageRules.some((rule) => hasDeclaration(rule, "width", "100%")),
    "教材图 CSS 宽度应为 100%",
  );
  for (const selector of [".practice-book-page", ".practice-book-page__image"]) {
    const fixedHeight = matchingRules(styles, [selector]).flatMap((rule) =>
      ["height", "min-height", "max-height"].flatMap((property) =>
        declarationValues(rule, property),
      ),
    );
    assert.equal(
      fixedHeight.length,
      0,
      `${selector} 不得设置固定高度造成留白或裁切`,
    );
  }
});

contract("训练热点拆分固定命中外壳与视觉圆点", () => {
  const sourceFile = parseTypeScript(
    "src/pages/Practice/Practice.tsx",
    ts.ScriptKind.TSX,
  );
  const hotspot = jsxOpenings(sourceFile).find((opening) => {
    const tokens = classTokens(opening);
    return tokens.has("audio-hotspot") && Boolean(getJsxAttribute(opening, "onClick"));
  });
  assert.ok(hotspot, "应渲染 audio-hotspot 点击外壳");
  assert.ok(
    classTokens(hotspot).has("device-touch-target"),
    "热点外壳应复用 44PX 的 device-touch-target",
  );
  const hotspotElement = ts.isJsxOpeningElement(hotspot)
    ? hotspot.parent
    : undefined;
  assert.ok(
    hotspotElement &&
      jsxOpenings(hotspotElement).some((opening) =>
        classTokens(opening).has("audio-hotspot__visual"),
      ),
    "热点外壳内应另设 audio-hotspot__visual，视觉圆点不能兼任命中区",
  );

  const styles = compileStyles("src/pages/Practice/Practice.scss");
  const visual = matchingRules(styles, [".audio-hotspot__visual"]);
  assert.ok(
    visual.some(
      (rule) =>
        declarationValues(rule, "width").length > 0 &&
        declarationValues(rule, "height").length > 0,
    ),
    "audio-hotspot__visual 应有独立宽高",
  );
});

contract("训练工作区仅在 split class 下变成教材与控制双列", () => {
  const sourceFile = parseTypeScript(
    "src/pages/Practice/Practice.tsx",
    ts.ScriptKind.TSX,
  );
  const tokens = new Set(
    jsxOpenings(sourceFile).flatMap((opening) => [...classTokens(opening)]),
  );
  assert.ok(tokens.has("practice-workspace"), "训练页应提供 practice-workspace 布局容器");

  const styles = compileStyles("src/pages/Practice/Practice.scss");
  const splitRule = matchingRules(styles, [
    ".device-layout--split",
    ".practice-workspace",
  ]).find((rule) => {
    const columns = declarationValues(rule, "grid-template-columns").map(
      (value) => value.replace(/\s+/g, ""),
    );
    return (
      hasDeclaration(rule, "display", "grid") &&
      columns.includes("minmax(480PX,1fr)minmax(320PX,420PX)") &&
      (hasDeclaration(rule, "gap", "24PX") ||
        hasDeclaration(rule, "column-gap", "24PX"))
    );
  });
  assert.ok(
    splitRule,
    "split 训练区应为 minmax(480PX,1fr) / minmax(320PX,420PX)，间距 24PX",
  );
  const unsafeGrid = matchingRules(styles, [".practice-workspace"]).find(
    (rule) =>
      !rule.selector.includes(".device-layout--split") &&
      declarationValues(rule, "grid-template-columns").length > 0,
  );
  assert.equal(
    unsafeGrid,
    undefined,
    "手机横屏不得因媒体查询误进双栏",
  );
});

contract("训练目录在单栏置底、split 置右并兼容安全区", () => {
  const styles = compileStyles("src/pages/Practice/Practice.scss");
  assert.ok(
    findRuleWith(styles, [".practice-directory-mask"], {
      "align-items": "flex-end",
    }),
    "单栏目录遮罩应把目录面板贴到底部",
  );
  assertSafeAreaFallback(styles, ".practice-directory-sheet");
  assert.ok(
    findRuleWith(
      styles,
      [".device-layout--split", ".practice-directory-mask"],
      { "justify-content": "flex-end" },
    ),
    "split 目录遮罩应把目录面板推到右侧",
  );
  const sideSheet = matchingRules(styles, [
    ".device-layout--split",
    ".practice-directory-sheet",
  ]).find((rule) => {
    const widths = declarationValues(rule, "width");
    const hasFixedSidebar = widths.some((value) => {
      const match = value.match(/^(\d+(?:\.\d+)?)PX$/);
      return match && Number(match[1]) >= 320 && Number(match[1]) <= 420;
    });
    const fillsHeight = [
      ...declarationValues(rule, "height"),
      ...declarationValues(rule, "max-height"),
    ].some((value) => /^(?:100%|100vh)$/.test(value));
    return hasFixedSidebar && fillsHeight;
  });
  assert.ok(sideSheet, "split 目录应是 320–420PX 宽、占满高度的右侧栏");
});

contract("打卡教材内页快照完整显示", () => {
  for (const [relativePath, className] of [
    ["src/pages/CheckInDetail/CheckInDetail.tsx", "check-in-course-card__image"],
    ["src/pages/MyCheckIns/MyCheckIns.tsx", "check-in-list-card__image"],
  ]) {
    const sourceFile = parseTypeScript(relativePath, ts.ScriptKind.TSX);
    const image = findImageByClass(sourceFile, className);
    assert.ok(image, `${relativePath} 应包含 ${className}`);
    assert.equal(
      literalAttributeValue(image, "mode"),
      "aspectFit",
      `${className} 必须使用 aspectFit 完整显示教材页`,
    );
  }
});

// 扫描器自身先证明能区分 44PX、Taro 会转换的 44px，以及随屏幕变化的 rpx。
contract("测试扫描器能识别固定 CSS 像素单位", () => {
  const fixture = (unit) =>
    postcss.parse(`.device-touch-target { min-width: ${unit}; min-height: ${unit}; }`);
  assert.ok(
    findRuleWith(fixture("44PX"), [".device-touch-target"], {
      "min-width": "44PX",
      "min-height": "44PX",
    }),
  );
  assert.equal(
    findRuleWith(fixture("44px"), [".device-touch-target"], {
      "min-width": "44PX",
      "min-height": "44PX",
    }),
    undefined,
  );
  assert.equal(
    findRuleWith(fixture("88rpx"), [".device-touch-target"], {
      "min-width": "44PX",
      "min-height": "44PX",
    }),
    undefined,
  );
  assert.deepEqual(findConvertedFixedMinimum([["fixture", fixture("44PX")]]), []);
  assert.equal(findConvertedFixedMinimum([["fixture", fixture("44px")]]).length, 2);
  assert.equal(findConvertedFixedMinimum([["fixture", fixture("88rpx")]]).length, 2);
});

if (failures.length > 0) {
  console.error(`响应式页面契约尚未满足（${failures.length} 项）：`);
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exitCode = 1;
} else {
  console.log(
    "响应式页面契约通过：五页旋转、设备 class、安全区、44PX 触控、Pad 双栏及教材图均符合要求。",
  );
}
