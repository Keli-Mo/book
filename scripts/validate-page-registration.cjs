/* eslint-disable import/no-commonjs */
// Run after build:weapp: source tests cannot detect Taro rewriting a page export.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { parse } = require("@babel/parser");
const traverse = require("@babel/traverse").default;

const dist = path.resolve(__dirname, "../dist");
const routes = ["pages/Practice/Practice", "pages/ThinkBookReader/ThinkBookReader"];
const modules = new Map();
const entries = new Map();
const propertyName = (node) => node?.name ?? node?.value;
const unwrap = (node) => node?.type === "SequenceExpression" ? node.expressions.at(-1) : node;

function readChunks(directory) {
  for (const file of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, file.name);
    if (file.isDirectory()) { readChunks(fullPath); continue; }
    if (!file.name.endsWith(".js")) continue;
    const source = fs.readFileSync(fullPath, "utf8");
    if (!source.includes("webpackJsonp")) continue;
    const relativePath = path.relative(dist, fullPath).replaceAll("\\", "/");
    traverse(parse(source), {
      CallExpression({ node }) {
        const payload = node.arguments[0];
        if (propertyName(node.callee.property) !== "push"
          || payload?.type !== "ArrayExpression"
          || payload.elements[0]?.type !== "ArrayExpression"
          || payload.elements[1]?.type !== "ObjectExpression") return;
        for (const item of payload.elements[1].properties) {
          modules.set(String(propertyName(item.key)), source.slice(item.value.start, item.value.end));
        }
        const runtime = payload.elements[2];
        if (!routes.some((route) => relativePath === `${route}.js`) || !runtime) return;
        // Execute only webpack's entry scheduler, never the app or platform runtime.
        const invoked = [];
        const requireEntry = (id) => invoked.push(String(id));
        requireEntry.O = (_result, _chunks, callback) => callback?.();
        vm.runInNewContext(`(${source.slice(runtime.start, runtime.end)})`, {}, { timeout: 1000 })(requireEntry);
        assert.equal(invoked.length, 1, `${relativePath} should schedule one entry module`);
        entries.set(relativePath.slice(0, -3), invoked[0]);
      },
    });
  }
}

const analyzed = new Map();
function analyze(id) {
  if (analyzed.has(id)) return analyzed.get(id);
  assert.ok(modules.has(id), `Missing compiled webpack module ${id}`);
  const info = { dependencies: new Set(), registrations: [], sessions: [], exports: new Set() };
  analyzed.set(id, info);
  const ast = parse(`(${modules.get(id)})`);
  traverse(ast, {
    FunctionExpression(factory) {
      if (factory.parent.type !== "ExpressionStatement") return;
      const requireName = factory.node.params[2]?.name;
      const requireBinding = factory.scope.getBinding(requireName);
      const imports = new Map();
      const isRequire = (call, scope) => call?.type === "CallExpression"
        && call.callee.type === "Identifier" && call.callee.name === requireName
        && scope.getBinding(requireName) === requireBinding
        && ["NumericLiteral", "StringLiteral"].includes(call.arguments[0]?.type);
      factory.traverse({
        VariableDeclarator(item) {
          if (item.node.id.type === "Identifier" && isRequire(item.node.init, item.scope)) {
            imports.set(item.scope.getBinding(item.node.id.name), String(item.node.init.arguments[0].value));
          }
        },
      });
      factory.traverse({
        CallExpression(item) {
          const { node, scope } = item;
          if (isRequire(node, scope)) info.dependencies.add(String(node.arguments[0].value));
          if (node.callee.type === "Identifier" && node.callee.name === "Page" && !scope.getBinding("Page")) {
            const config = scope.getBinding(node.arguments[0]?.name)?.path.node.init;
            const route = config?.arguments?.find((arg) => arg.type === "StringLiteral" && arg.value.startsWith("pages/"));
            info.registrations.push(route?.value ?? "unknown Page registration");
          }
          const callee = unwrap(node.callee);
          if (callee?.type !== "MemberExpression") return;
          if (callee.object.name === requireName && propertyName(callee.property) === "d") {
            for (const exported of node.arguments[1]?.properties ?? []) {
              info.exports.add(String(propertyName(exported.key)));
            }
          }
          if (!["jsx", "jsxs", "createElement"].includes(propertyName(callee.property))) return;
          const [component, props] = node.arguments;
          if (component?.type !== "MemberExpression" || props?.type !== "ObjectExpression") return;
          const keys = props.properties.map((prop) => propertyName(prop.key));
          if (!["bundle", "initialPractice", "initialPracticeIndex"].every((key) => keys.includes(key))) return;
          const dependency = imports.get(scope.getBinding(component.object.name));
          if (dependency) info.sessions.push({ moduleId: dependency, exportName: String(propertyName(component.property)) });
        },
      });
      factory.skip();
    },
  });
  return info;
}

function registrationsFrom(entry, seen = new Set()) {
  if (seen.has(entry)) return [];
  seen.add(entry);
  const info = analyze(entry);
  return [...info.registrations, ...[...info.dependencies].flatMap((id) => registrationsFrom(id, seen))];
}

readChunks(dist);
const errors = [];
const sessions = [];
for (const route of routes) {
  try {
    const entry = entries.get(route);
    assert.ok(entry, `${route}: compiled entry was not found; run build:weapp first`);
    const registrations = registrationsFrom(entry);
    assert.deepEqual(registrations, [route], `${route}: reachable Page registrations must contain only its own route`);
    const referenced = analyze(entry).sessions;
    assert.equal(referenced.length, 1, `${route}: expected one compiled PracticeSession JSX reference`);
    const session = referenced[0];
    const shared = analyze(session.moduleId);
    assert.equal(shared.registrations.length, 0, `${route}: PracticeSession must come from a regular component module`);
    assert.ok(shared.exports.has(session.exportName), `${route}: referenced PracticeSession export ${session.exportName} is missing`);
    sessions.push(session);
    console.log(`PASS ${route}: one Page registration and a valid PracticeSession export`);
  } catch (error) {
    errors.push(error.message);
  }
}
if (sessions.length === routes.length) {
  try { assert.deepEqual(sessions[0], sessions[1], "Both compiled pages must use the same shared PracticeSession export"); }
  catch (error) { errors.push(error.message); }
}
if (errors.length) {
  console.error(errors.join("\n\n"));
  process.exitCode = 1;
} else {
  console.log("Compiled Practice / ThinkBookReader page registration checks passed.");
}
