/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const postcss = require("postcss");
const sass = require("sass");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const ast = (file, kind = ts.ScriptKind.TS) =>
  ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, kind);
const styles = (file) =>
  postcss.parse(
    sass.compile(path.join(root, file), {
      loadPaths: [path.join(root, "src")],
      style: "expanded",
    }).css,
    { from: file },
  );

const pages = [
  {
    name: "首页",
    file: "src/pages/Home/Home.tsx",
    config: "src/pages/Home/Home.config.ts",
    scss: "src/pages/Home/Home.scss",
    safe: [[".home-tabs", 12]],
    targets: ["library-home__search", "continue-card__button", "series-section__all", "home-tabs__item"],
  },
  {
    name: "书库",
    file: "src/pages/BookLibrary/BookLibrary.tsx",
    config: "src/pages/BookLibrary/BookLibrary.config.ts",
    scss: "src/pages/BookLibrary/BookLibrary.scss",
    safe: [[".book-library", 24]],
    targets: ["book-search__clear", "series-filter"],
  },
  {
    name: "训练",
    file: "src/pages/Practice/Practice.tsx",
    config: "src/pages/Practice/Practice.config.ts",
    scss: "src/pages/Practice/Practice.scss",
    safe: [[".practice-page", 24], [".practice-directory-sheet", 12]],
    targets: [
      "practice-empty__button",
      "practice-header__directory",
      "audio-hotspot",
      "record-button",
      "record-actions__secondary",
      "check-in-button",
      "practice-navigation__button",
    ],
  },
  {
    name: "打卡详情",
    file: "src/pages/CheckInDetail/CheckInDetail.tsx",
    config: "src/pages/CheckInDetail/CheckInDetail.config.ts",
    scss: "src/pages/CheckInDetail/CheckInDetail.scss",
    safe: [[".check-in-detail", 24]],
    targets: ["check-in-state__button", "shared-recording__play", "check-in-actions__share", "check-in-actions__practice"],
  },
  {
    name: "我的打卡",
    file: "src/pages/MyCheckIns/MyCheckIns.tsx",
    config: "src/pages/MyCheckIns/MyCheckIns.config.ts",
    scss: "src/pages/MyCheckIns/MyCheckIns.scss",
    safe: [[".my-check-ins", 24]],
    targets: ["my-check-ins-state__button", "check-in-list-card__open", "check-in-list-card__delete"],
  },
].map((page) => ({
  ...page,
  source: read(page.file),
  ast: ast(page.file, ts.ScriptKind.TSX),
  styles: styles(page.scss),
}));

const failures = [];
const check = (name, run) => {
  try {
    run();
  } catch (error) {
    failures.push(`${name}：${error instanceof Error ? error.message : error}`);
  }
};

const walk = (node, predicate, result = []) => {
  if (predicate(node)) result.push(node);
  ts.forEachChild(node, (child) => {
    walk(child, predicate, result);
  });
  return result;
};
const nameOf = (node) => (ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : "");
const importedName = (sourceFile, moduleName, exportName) => {
  for (const node of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== moduleName
    ) {
      continue;
    }
    const bindings = node.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const item = bindings.elements.find(
      (entry) => (entry.propertyName?.text || entry.name.text) === exportName,
    );
    if (item) return item.name.text;
  }
  return "";
};
const calls = (sourceFile, localName) =>
  Boolean(localName) &&
  walk(
    sourceFile,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === localName,
  ).length > 0;
const propertyCalls = (sourceFile, method, argument) =>
  walk(
    sourceFile,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === method &&
      (argument === undefined ||
        (node.arguments[0] &&
          ts.isStringLiteral(node.arguments[0]) &&
          node.arguments[0].text === argument)),
  ).length > 0;

const defaultConfig = (sourceFile, factory) => {
  const exported = sourceFile.statements.find(
    (node) => ts.isExportAssignment(node) && !node.isExportEquals,
  );
  assert.ok(exported, "配置必须 default export");
  let expression = exported.expression;
  if (ts.isIdentifier(expression)) {
    const identifier = expression.text;
    expression = walk(
      sourceFile,
      (node) =>
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === identifier &&
        node.initializer,
    )[0]?.initializer;
  }
  assert.ok(
    expression &&
      ts.isCallExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === factory &&
      ts.isObjectLiteralExpression(expression.arguments[0]),
    `默认配置必须调用 ${factory}`,
  );
  return expression.arguments[0];
};
const configValue = (object, key) =>
  object.properties.find(
    (item) => ts.isPropertyAssignment(item) && nameOf(item.name) === key,
  )?.initializer;

const openings = (node) =>
  walk(
    node,
    (item) => ts.isJsxOpeningElement(item) || ts.isJsxSelfClosingElement(item),
  );
const attribute = (opening, name) =>
  opening.attributes.properties.find(
    (item) => ts.isJsxAttribute(item) && nameOf(item.name) === name,
  );
const stringParts = (node) =>
  walk(
    node,
    (item) =>
      ts.isStringLiteral(item) ||
      ts.isNoSubstitutionTemplateLiteral(item) ||
      ts.isTemplateHead(item) ||
      ts.isTemplateMiddle(item) ||
      ts.isTemplateTail(item),
  ).map((item) => item.text);
const classNames = (opening) => {
  const className = attribute(opening, "className");
  return new Set(
    className?.initializer
      ? stringParts(className.initializer).flatMap((part) => part.split(/\s+/))
      : [],
  );
};
const byClass = (sourceFile, className, tagName) =>
  openings(sourceFile).filter(
    (opening) =>
      classNames(opening).has(className) &&
      (!tagName || opening.tagName.getText() === tagName),
  );
const literalAttribute = (opening, name) => {
  const value = attribute(opening, name)?.initializer;
  return value && ts.isStringLiteral(value) ? value.text : "";
};
const trueAttribute = (opening, name) => {
  const value = attribute(opening, name);
  return Boolean(
    value &&
      (!value.initializer ||
        (ts.isJsxExpression(value.initializer) &&
          value.initializer.expression?.kind === ts.SyntaxKind.TrueKeyword)),
  );
};
const descendant = (opening, className) => {
  const element = ts.isJsxOpeningElement(opening) ? opening.parent : opening;
  return openings(element).some(
    (candidate) => candidate !== opening && classNames(candidate).has(className),
  );
};

const selectorParts = (rule) => rule.selector.split(",").map((part) => part.trim());
const matchingRules = (styleRoot, fragments) => {
  const result = [];
  styleRoot.walkRules((rule) => {
    if (
      selectorParts(rule).some((part) =>
        fragments.every((fragment) => part.includes(fragment)),
      )
    ) {
      result.push(rule);
    }
  });
  return result;
};
const exactRules = (styleRoot, selector) => {
  const result = [];
  styleRoot.walkRules((rule) => {
    if (selectorParts(rule).includes(selector)) result.push(rule);
  });
  return result;
};
const values = (rule, property) =>
  rule.nodes
    .filter((node) => node.type === "decl" && node.prop === property)
    .map((node) => node.value.trim());
const has = (rule, property, expected) =>
  values(rule, property).some((value) =>
    expected instanceof RegExp ? expected.test(value) : value === expected,
  );
const ruleWith = (styleRoot, fragments, declarations) =>
  matchingRules(styleRoot, fragments).find((rule) =>
    Object.entries(declarations).every(([property, expected]) =>
      has(rule, property, expected),
    ),
  );
const compact = (value) => value.replace(/\s+/g, "");
const safeArea = (styleRoot, selector, base) => {
  const declarations = exactRules(styleRoot, selector).flatMap((rule) =>
    values(rule, "padding-bottom"),
  );
  const constant = `calc(${base}PX+constant(safe-area-inset-bottom))`;
  const env = `calc(${base}PX+env(safe-area-inset-bottom))`;
  const constantIndex = declarations.findIndex((value) => compact(value) === constant);
  const envIndex = declarations.findIndex((value) => compact(value) === env);
  assert.ok(
    constantIndex >= 0 && envIndex > constantIndex,
    `${selector} 缺少 constant → env 安全区`,
  );
};
const atLeast44PX = (value) => {
  const match = value.match(/^(\d+(?:\.\d+)?)PX$/);
  return Boolean(match && Number(match[1]) >= 44);
};

const appConfig = defaultConfig(ast("src/app.config.ts"), "defineAppConfig");
const appStyles = styles("src/app.scss");
const practice = pages.find((page) => page.name === "训练");
const directoryAst = ast("src/pages/Practice/PracticeDirectory.tsx", ts.ScriptKind.TSX);

check("应用允许 Pad 调整窗口", () => {
  const resizable = configValue(appConfig, "resizable");
  assert.ok(resizable?.kind === ts.SyntaxKind.TrueKeyword, "app.config.ts 应设置 resizable: true");
});

for (const page of pages) {
  check(`${page.name}允许自动旋转`, () => {
    const config = defaultConfig(ast(page.config), "definePageConfig");
    assert.ok(
      configValue(config, "pageOrientation")?.text === "auto",
      `${page.config} 应设置 pageOrientation: 'auto'`,
    );
  });
  check(`${page.name}接入共享设备布局`, () => {
    const hook = importedName(page.ast, "@/hooks/useDeviceLayout", "useDeviceLayout");
    const builder = importedName(
      page.ast,
      "@/features/layout/deviceLayout",
      "buildDeviceLayoutClassName",
    );
    assert.ok(calls(page.ast, hook), "应调用 useDeviceLayout");
    assert.ok(calls(page.ast, builder), "应调用 buildDeviceLayoutClassName");
    assert.match(page.source, /device-layout__content/, "应渲染共享内容容器");
  });
  check(`${page.name}保留底部安全区`, () => {
    page.safe.forEach(([selector, base]) => safeArea(page.styles, selector, base));
  });
  check(`${page.name}关键按钮使用共享触控尺寸`, () => {
    page.targets.forEach((className) => {
      const elements = byClass(page.ast, className);
      assert.ok(elements.length > 0, `缺少 .${className}`);
      assert.ok(
        elements.every((element) => classNames(element).has("device-touch-target")),
        `.${className} 应使用 device-touch-target`,
      );
    });
  });
}

check("训练目录按钮使用共享触控尺寸", () => {
  ["practice-directory-close", "practice-directory-item"].forEach((className) => {
    const elements = byClass(directoryAst, className);
    assert.ok(
      elements.length > 0 &&
        elements.every((element) => classNames(element).has("device-touch-target")),
    );
  });
});

check("共享内容、触控与窄屏操作规则存在", () => {
  const content = exactRules(appStyles, ".device-layout__content");
  assert.ok(content.some((rule) => has(rule, "width", "100%")));
  assert.ok(
    content.some(
      (rule) =>
        has(rule, "margin", /^(?:0|0PX)\s+auto$/) ||
        (has(rule, "margin-left", "auto") && has(rule, "margin-right", "auto")),
    ),
  );
  assert.ok(
    ruleWith(
      appStyles,
      [".device-layout--pad", ".device-layout--single", ".device-layout__content"],
      { "max-width": "820PX" },
    ),
  );
  assert.ok(
    ruleWith(
      appStyles,
      [".device-layout--split", ".device-layout__content"],
      { "max-width": "1280PX" },
    ),
  );
  const touch = matchingRules(appStyles, [".device-touch-target"]);
  for (const property of ["min-width", "min-height"]) {
    assert.ok(touch.some((rule) => values(rule, property).some(atLeast44PX)));
  }
  assert.ok(ruleWith(appStyles, [".device-actions"], { "flex-wrap": "wrap" }));
});

check("书库和我的打卡仅在 split 下使用两列", () => {
  for (const [name, selector] of [
    ["书库", ".book-list"],
    ["我的打卡", ".my-check-ins__list"],
  ]) {
    const page = pages.find((item) => item.name === name);
    assert.ok(
      matchingRules(page.styles, [".device-layout--split", selector]).some(
        (rule) =>
          has(rule, "display", "grid") &&
          values(rule, "grid-template-columns").some(
            (value) => compact(value) === "repeat(2,minmax(0,1fr))",
          ),
      ),
    );
  }
});

check("首页不因 split 进入多栏", () => {
  const home = pages.find((page) => page.name === "首页");
  const columns = matchingRules(
    home.styles,
    [".device-layout--split", ".library-home__content"],
  ).flatMap((rule) => values(rule, "grid-template-columns"));
  assert.ok(
    columns.every((value) => ["1fr", "minmax(0,1fr)"].includes(compact(value))),
  );
});

check("训练 split 工作区为教材与控制双列", () => {
  assert.ok(practice.source.includes("practice-workspace"), "缺少 .practice-workspace");
  assert.ok(
    matchingRules(
      practice.styles,
      [".device-layout--split", ".practice-workspace"],
    ).some(
      (rule) =>
        has(rule, "display", "grid") &&
        values(rule, "grid-template-columns").some(
          (value) => compact(value) === "minmax(480PX,1fr)minmax(320PX,1fr)",
        ) &&
        (has(rule, "gap", "24PX") || has(rule, "column-gap", "24PX")),
    ),
  );
});

check("教材图保持自然比例并按实际节点测量热点", () => {
  const image = byClass(practice.ast, "practice-book-page__image", "Image")[0];
  assert.ok(image);
  assert.equal(literalAttribute(image, "mode"), "widthFix");
  assert.ok(attribute(image, "onLoad"), "教材图应在 onLoad 后测量");
  assert.ok(propertyCalls(practice.ast, "select", ".practice-book-page__image"));
  assert.ok(propertyCalls(practice.ast, "boundingClientRect"));
  const clamp = importedName(
    practice.ast,
    "@/features/listeningPractice/hotspotLayout",
    "clampHotspotCenter",
  );
  assert.ok(calls(practice.ast, clamp));
  assert.ok(
    matchingRules(practice.styles, [".practice-book-page__image"]).some((rule) =>
      has(rule, "width", "100%"),
    ),
  );
  for (const selector of [".practice-book-page", ".practice-book-page__image"]) {
    const heights = matchingRules(practice.styles, [selector]).flatMap((rule) =>
      ["height", "min-height", "max-height"].flatMap((property) =>
        values(rule, property),
      ),
    );
    assert.ok(heights.every((value) => /^(?:auto|none|unset)$/.test(value)));
  }
  assert.ok(
    ruleWith(practice.styles, [".practice-book-page__hotspots"], {
      position: "absolute",
      inset: "0",
    }),
  );
});

check("热点命中壳与视觉点分离", () => {
  const hotspot = byClass(practice.ast, "audio-hotspot")[0];
  assert.ok(hotspot && descendant(hotspot, "audio-hotspot__visual"));
  assert.ok(
    matchingRules(practice.styles, [".audio-hotspot__visual"]).some(
      (rule) => values(rule, "width").length > 0 && values(rule, "height").length > 0,
    ),
  );
});

check("训练目录在单栏贴底、split 靠右且可滚动", () => {
  assert.ok(
    ruleWith(practice.styles, [".practice-directory-mask"], {
      position: "fixed",
      inset: "0",
      display: "flex",
      "align-items": "flex-end",
    }),
  );
  assert.ok(
    ruleWith(
      practice.styles,
      [".device-layout--split", ".practice-directory-mask"],
      { "justify-content": "flex-end" },
    ),
  );
  assert.ok(
    matchingRules(
      practice.styles,
      [".device-layout--split", ".practice-directory-sheet"],
    ).some(
      (rule) =>
        values(rule, "width").some((value) => /^(?:3[2-9]\d|4[01]\d|420)PX$/.test(value)) &&
        [...values(rule, "height"), ...values(rule, "max-height")].some((value) =>
          /^(?:100%|100vh)$/.test(value),
        ),
    ),
  );
  const scroll = byClass(directoryAst, "practice-directory-scroll", "ScrollView")[0];
  assert.ok(scroll && trueAttribute(scroll, "scrollY"));
});

check("打卡教材快照完整显示", () => {
  for (const [name, className] of [
    ["打卡详情", "check-in-course-card__image"],
    ["我的打卡", "check-in-list-card__image"],
  ]) {
    const page = pages.find((item) => item.name === name);
    const image = byClass(page.ast, className, "Image")[0];
    assert.ok(image);
    assert.equal(literalAttribute(image, "mode"), "aspectFit");
  }
});

if (failures.length) {
  console.error(`响应式页面契约尚未满足（${failures.length} 项）：`);
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exitCode = 1;
} else {
  console.log("响应式页面契约通过：核心配置、布局、触控、教材图与目录规则均符合要求。");
}
