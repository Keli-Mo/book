/* eslint-disable import/no-commonjs */
// Run against the built mini-program: JSX-only tests cannot detect omitted native bindings.
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("@babel/parser");
const traverse = require("@babel/traverse").default;

const dist = path.resolve(process.argv[2] || path.join(__dirname, "../dist"));
const nativeEvents = ["touchstart", "touchmove", "touchend", "touchcancel"];
const reactEvents = ["onTouchStart", "onTouchMove", "onTouchEnd", "onTouchCancel"];
const classes = ["practice-book-zoom-view", "practice-book-zoom-area"];
const compiledProps = new Map(classes.map((name) => [name, []]));
const propertyName = (node) => node?.name ?? node?.value;
const unwrap = (node) => node?.type === "SequenceExpression" ? node.expressions.at(-1) : node;

function readChunks(directory) {
  for (const file of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, file.name);
    if (file.isDirectory()) {
      readChunks(fullPath);
      continue;
    }
    if (!file.name.endsWith(".js")) continue;
    const source = fs.readFileSync(fullPath, "utf8");
    if (!classes.some((name) => source.includes(name))) continue;
    traverse(parse(source), {
      CallExpression({ node }) {
        const callee = unwrap(node.callee);
        if (callee?.type !== "MemberExpression"
          || !["jsx", "jsxs", "createElement"].includes(propertyName(callee.property))) return;
        const props = node.arguments[1];
        if (props?.type !== "ObjectExpression") return;
        const properties = new Map(props.properties
          .filter((prop) => prop.type === "ObjectProperty")
          .map((prop) => [propertyName(prop.key), prop.value]));
        const className = properties.get("className");
        if (className?.type !== "StringLiteral" || !compiledProps.has(className.value)) return;
        compiledProps.get(className.value).push({ properties, fullPath });
      },
    });
  }
}

function isHandler(value) {
  return value && !["NullLiteral", "UnaryExpression"].includes(value.type)
    && !(value.type === "Identifier" && value.name === "undefined");
}

function validate() {
  if (!fs.existsSync(dist) || !fs.statSync(dist).isDirectory()) {
    throw new Error(`Missing compiled mini-program directory ${dist}; run build:weapp first.`);
  }
  const templatePath = path.join(dist, "base.wxml");
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Missing compiled native template ${templatePath}; run build:weapp first.`);
  }
  const template = fs.readFileSync(templatePath, "utf8");
  const nativeViews = template.match(/<movable-view\b[^>]*>/g) || [];
  if (!nativeViews.some((tag) => nativeEvents.every((event) =>
    new RegExp(`\\bbind${event}\\s*=`).test(tag)))) {
    throw new Error("Compiled movable-view must expose bindtouchstart, bindtouchmove, bindtouchend, and bindtouchcancel.");
  }
  console.log("PASS native movable-view template: all four touch bindings exist");

  readChunks(dist);
  const viewProps = compiledProps.get(classes[0]);
  if (!viewProps.length) {
    throw new Error("Compiled practice-book-zoom-view JSX was not found; build the current practice pages first.");
  }
  if (!viewProps.some(({ properties }) => reactEvents.every((event) => isHandler(properties.get(event))))) {
    const missing = [...new Set(viewProps.flatMap(({ properties }) =>
      reactEvents.filter((event) => !isHandler(properties.get(event)))))];
    throw new Error(`Compiled practice-book-zoom-view is missing touch handlers: ${missing.join(", ")}.`);
  }
  console.log("PASS compiled zoom view: all four handlers are attached to the native movable-view");

  const areaProps = compiledProps.get(classes[1]);
  if (!areaProps.length) {
    throw new Error("Compiled practice-book-zoom-area JSX was not found; build the current practice pages first.");
  }
  if (!areaProps.some(({ properties }) => reactEvents.every((event) => !properties.has(event)))) {
    throw new Error("Compiled practice-book-zoom-area still owns touch handlers that the native template cannot deliver.");
  }
  console.log("PASS compiled zoom area: touch handlers do not depend on unsupported native bindings");
  console.log("Compiled practice gesture checks passed.");
}

try {
  validate();
} catch (error) {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
}
