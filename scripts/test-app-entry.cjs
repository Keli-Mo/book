/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const projectRoot = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(projectRoot, file), "utf8");
const compiled = new Map();
const load = (file, overrides = {}, cache = new Map()) => {
  if (cache.has(file)) return cache.get(file);
  if (!compiled.has(file)) {
    compiled.set(
      file,
      ts.transpileModule(read(file), {
        fileName: file,
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
          jsx: ts.JsxEmit.ReactJSX,
        },
      }).outputText,
    );
  }
  const loaded = { exports: {} };
  cache.set(file, loaded.exports);
  new Function(
    "module",
    "exports",
    "require",
    "setTimeout",
    "wx",
    compiled.get(file),
  )(
    loaded,
    loaded.exports,
    (request) => {
      if (Object.hasOwn(overrides, request)) return overrides[request];
      if (request.startsWith("@/") || request.startsWith(".")) {
        const base = request.startsWith("@/")
          ? `src/${request.slice(2)}`
          : path.join(path.dirname(file), request);
        const target = [base, `${base}.ts`, `${base}.tsx`].find((candidate) =>
          fs.existsSync(path.join(projectRoot, candidate)),
        );
        assert.ok(target, `依赖必须存在：${request}`);
        return load(target, overrides, cache);
      }
      return require(request);
    },
    overrides.__setTimeout || setTimeout,
    overrides.wx,
  );
  return loaded.exports;
};

(async () => {
  const {
    HOME_FALLBACK_URL,
    INTRO_URL,
    MOCK_APP_ENTRY_MODE,
    readAppEntryMode,
    resolveLaunchUrl,
    resolvePracticeEntryUrl,
  } = load("src/services/appEntry.ts");

  assert.equal(HOME_FALLBACK_URL, "/pages/Home/Home");
  assert.equal(INTRO_URL, "/pages/Intro/Intro");
  assert.ok(
    MOCK_APP_ENTRY_MODE === "intro" || MOCK_APP_ENTRY_MODE === "practice",
    "mock 开关只能是 intro 或 practice",
  );

  assert.equal(
    resolveLaunchUrl("intro", null),
    INTRO_URL,
    "intro 应进入介绍页",
  );
  assert.equal(
    resolveLaunchUrl("practice", null),
    "/pages/Practice/Practice?bookId=3&practice=0",
    "无阅读进度时 practice 应进入第一本可用教材",
  );
  assert.equal(
    resolveLaunchUrl("practice", { version: 1, bookId: "9", practiceIndex: 4 }),
    "/pages/Practice/Practice?bookId=9&practice=4",
    "有阅读进度时 practice 应回到上次跟读位置",
  );
  assert.equal(
    resolveLaunchUrl("unknown", { version: 1, bookId: "9", practiceIndex: 4 }),
    HOME_FALLBACK_URL,
    "未知 mode 应回落到书架首页",
  );
  assert.equal(
    resolveLaunchUrl(undefined, null),
    HOME_FALLBACK_URL,
    "缺失 mode 应回落到书架首页",
  );
  assert.equal(
    resolvePracticeEntryUrl(null),
    "/pages/Practice/Practice?bookId=3&practice=0",
    "无进度时跟读入口应使用第一本可用教材",
  );

  assert.equal(readAppEntryMode({ mode: "practice" }), "practice");
  assert.equal(readAppEntryMode({ data: { ok: true, mode: "intro" } }), "intro");
  assert.equal(
    readAppEntryMode({ statusCode: 200, data: '{"ok":true,"mode":"intro"}' }),
    "intro",
  );
  assert.equal(readAppEntryMode({ statusCode: 500, data: { mode: "intro" } }), null);
  assert.equal(readAppEntryMode({ data: { mode: "other" } }), null);

  const delayed = [];
  const mocked = load(
    "src/services/appEntry.ts",
    {
      __setTimeout: (callback) => {
        delayed.push(callback);
        return delayed.length;
      },
    },
    new Map(),
  );
  const pending = mocked.fetchAppEntryMode();
  assert.equal(delayed.length, 1, "mock 接口应模拟一次网络等待");
  delayed[0]();
  assert.deepEqual(await pending, { mode: MOCK_APP_ENTRY_MODE });

  const calls = [];
  const hosted = load(
    "src/services/appEntry.ts",
    {
      wx: {
        cloud: {
          callContainer: async (input) => {
            calls.push(input);
            return { data: { ok: true, mode: "practice" } };
          },
        },
      },
    },
    new Map(),
  );
  assert.deepEqual(await hosted.fetchAppEntryMode(), { mode: "practice" });
  assert.equal(calls[0].path, "/api/app-entry");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].header["X-WX-SERVICE"], "koa-hwx1");
  assert.equal(calls[0].config.env, "prod-d0gxpzolg8a06fa69");
  assert.equal(calls[0].timeout, undefined);
  assert.equal(calls[0].dataType, undefined);

  const appConfig = read("src/app.config.ts");
  assert.match(
    appConfig,
    /entryPagePath:\s*"pages\/Launch\/Launch"/,
    "冷启动入口必须是闸门页",
  );
  assert.match(
    appConfig,
    /pages:\s*\[\s*"pages\/Launch\/Launch"/,
    "闸门页必须注册为 pages 第一项",
  );
  assert.match(appConfig, /pages\/Intro\/Intro/, "介绍页必须注册到小程序路由");

  const launch = read("src/pages/Launch/Launch.tsx");
  assert.match(launch, /fetchAppEntryMode/, "闸门页必须请求入口配置");
  assert.match(launch, /resolveLaunchUrl/, "闸门页必须按 mode 解析跳转");
  assert.match(launch, /Taro\.reLaunch/, "闸门页必须 reLaunch 清掉 loading 栈");
  assert.match(
    launch,
    /HOME_FALLBACK_URL/,
    "请求失败必须回落到书架首页",
  );
  assert.doesNotMatch(
    launch,
    /useAppEntryIntroGuard/,
    "闸门页自己分流，不再套子页 intro 门禁",
  );

  const hostedGuard = load(
    "src/services/appEntry.ts",
    {
      wx: {
        cloud: {
          callContainer: async () => ({ data: { ok: true, mode: "intro" } }),
        },
      },
    },
    new Map(),
  );
  const introJumps = [];
  assert.equal(
    await hostedGuard.redirectToIntroIfNeeded(async (url) => {
      introJumps.push(url);
    }),
    "redirected",
  );
  assert.deepEqual(introJumps, [INTRO_URL]);

  const stayGuard = load(
    "src/services/appEntry.ts",
    {
      wx: {
        cloud: {
          callContainer: async () => ({ data: { ok: true, mode: "practice" } }),
        },
      },
    },
    new Map(),
  );
  const stayJumps = [];
  assert.equal(
    await stayGuard.redirectToIntroIfNeeded(async (url) => {
      stayJumps.push(url);
    }),
    "stay",
  );
  assert.deepEqual(stayJumps, []);

  const errorGuard = load(
    "src/services/appEntry.ts",
    {
      wx: {
        cloud: {
          callContainer: async () => {
            throw new Error("network down");
          },
        },
      },
    },
    new Map(),
  );
  const errorJumps = [];
  assert.equal(
    await errorGuard.redirectToIntroIfNeeded(async (url) => {
      errorJumps.push(url);
    }),
    "error",
  );
  assert.deepEqual(errorJumps, []);

  const hook = read("src/hooks/useAppEntryIntroGuard.ts");
  assert.match(hook, /useDidShow/, "子页门禁必须在页面显示时触发，才能覆盖热启动");
  assert.match(hook, /redirectToIntroIfNeeded/, "子页门禁必须复用入口接口");
  assert.match(hook, /Taro\.reLaunch/, "intro 必须清栈进介绍页");

  const guardedPages = [
    "src/pages/Home/Home.tsx",
    "src/pages/BookLibrary/BookLibrary.tsx",
    "src/pages/Practice/Practice.tsx",
    "src/pages/CheckInDetail/CheckInDetail.tsx",
    "src/pages/MyCheckIns/MyCheckIns.tsx",
  ];
  for (const file of guardedPages) {
    assert.match(
      read(file),
      /useAppEntryIntroGuard\(\)/,
      `${file} 热启动时必须再问一次入口`,
    );
  }

  const intro = read("src/pages/Intro/Intro.tsx");
  assert.match(intro, /海沙牛娃/, "介绍页应展示机构名称");
  assert.match(intro, /英语教培课程/, "介绍页应展示机构简介");
  assert.match(intro, /教学体系兼顾素质及应试/, "介绍页应展示教学体系说明");
  assert.doesNotMatch(
    intro,
    /关注|私信|开始跟读|resolvePracticeEntryUrl|pages\/Practice\/Practice/,
    "介绍页是独立机构介绍页，不含关注私信，也不能跳到听音跟读页",
  );
  assert.doesNotMatch(
    intro,
    /useAppEntryIntroGuard|fetchAppEntryMode/,
    "介绍页已是 intro 终点，不再回跳",
  );

  assert.equal(
    fs.existsSync(path.join(projectRoot, "src/pages/Launch/Launch.config.ts")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(projectRoot, "src/pages/Intro/Intro.config.ts")),
    true,
  );

  console.log(
    "启动分流契约通过：mock intro/practice、未知值回首页、无进度用首册、闸门为入口。",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
