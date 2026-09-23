const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  DEFAULT_ALLOWED_HOSTS,
  loadBookAssetConstants,
  collectBookAssets,
  validateAssetUrl,
  classifyStatus,
  checkAssets,
  summarizeResults,
  formatReport,
  parseCliArgs,
  determineExitCode,
} = require("./validate-book-assets-remote.cjs");

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const makeResponse = (status, onCancel = () => {}) => ({
  status,
  body: { cancel: async () => onCancel() },
});

const makeRedirectResponse = (onCancel) => ({
  ...makeResponse(302, onCancel),
  headers: new Headers({ Location: "https://evil.example/asset.mp3" }),
});

const testCollection = () => {
  const shared = "https://allowed.example/shared.bin";
  const assets = collectBookAssets({
    concatImages: {
      3: [shared, "https://allowed.example/book-3_2.png"],
      4: [shared],
    },
    allAudioList: {
      3: {
        2: [{ url: shared }, { url: "https://allowed.example/track-2.mp3" }],
      },
      4: { 7: [{ url: "https://allowed.example/track-2.mp3" }] },
    },
    bookIds: ["3", "4"],
  });

  assert.equal(assets.length, 3, "完整 URL 应跨教材、跨资源类型去重");
  assert.deepEqual(
    assets.find((asset) => asset.url === shared).sources,
    [
      { bookId: "3", type: "image", imageIndex: 0 },
      { bookId: "3", type: "audio", pageNumber: 2, trackIndex: 0 },
      { bookId: "4", type: "image", imageIndex: 0 },
    ],
    "重复 URL 应保留全部教材、类型、页号和索引来源，且顺序稳定",
  );
};

const testRealConstantCollection = () => {
  const constants = loadBookAssetConstants();
  assert.equal(constants.bookCovers.length, 25, "远端校验必须覆盖 25 张教材书架封面");
  assert.equal(constants.seriesCovers.length, 6, "远端校验必须覆盖 6 张首页系列封面");
  const assets = collectBookAssets(constants);
  const sources = assets.flatMap((asset) => asset.sources);
  assert.equal(assets.length, 6_545, "修正 Think 1 非正式音频后，教材页、音频及封面应有 6,545 个唯一素材");
  assert.equal(
    assets.filter((asset) => asset.sources.some((source) => source.type !== "audio")).length,
    4_329,
  );
  assert.equal(
    assets.filter((asset) => asset.sources.some((source) => source.type === "audio")).length,
    2_216,
    "修正 Think 1 非正式音频后，音频唯一 URL 应为 2,216",
  );
  assert.equal(sources.filter((source) => source.type === "image").length, 4_314);
  assert.equal(sources.filter((source) => source.type === "cover").length, 25);
  assert.equal(sources.filter((source) => source.type === "series-cover").length, 6);
  assert.equal(
    sources.filter((source) => source.type === "audio").length,
    2_310,
    "含 Think 1 重复印刷标签的音频热点来源数应为 2,310",
  );
  assert.deepEqual(
    [...new Set(sources.map(({ bookId }) => bookId).filter(Boolean))],
    Array.from({ length: 25 }, (_, index) => String(index + 3)),
  );
};

const testRedirectIsNotFollowedOrRetried = async () => {
  const calls = [];
  let cancelCount = 0;
  const redirectResponse = makeRedirectResponse(() => cancelCount++);
  const [result] = await checkAssets(
    [
      {
        url: "https://allowed.example/redirected.png",
        sources: [{ bookId: "3", type: "image", imageIndex: 0 }],
      },
    ],
    {
      allowedHosts: ["allowed.example"],
      concurrency: 1,
      timeoutMs: 100,
      retries: 2,
      retryDelayMs: 1,
      fetch: async (_url, options) => {
        calls.push(options);
        return redirectResponse;
      },
    },
  );

  assert.equal(result.category, "unexpected-status");
  assert.equal(result.status, 302);
  assert.equal(result.attempts, 1, "3xx 是确定性失败，不应重试");
  assert.equal(redirectResponse.headers.get("location"), "https://evil.example/asset.mp3");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].redirect, "manual");
  assert.equal(cancelCount, 1, "3xx 响应正文也必须主动取消");
};

const testUrlValidation = () => {
  const host = DEFAULT_ALLOWED_HOSTS[0];
  assert.deepEqual(validateAssetUrl(`https://${host}/asset.png`), {
    ok: true,
    url: `https://${host}/asset.png`,
  });
  assert.equal(validateAssetUrl(`http://${host}/asset.png`).category, "invalid-url");
  assert.equal(validateAssetUrl(`https://user:secret@${host}/asset.png`).category, "invalid-url");
  assert.equal(validateAssetUrl("not a url").category, "invalid-url");
  assert.equal(validateAssetUrl("https://unknown.example/asset.png").category, "disallowed-host");
};

const testStatusClassification = () => {
  assert.equal(classifyStatus(404), "not-found");
  assert.equal(classifyStatus(410), "not-found");
  assert.equal(classifyStatus(401), "permission-denied");
  assert.equal(classifyStatus(403), "permission-denied");
  assert.equal(classifyStatus(500), "server-error");
  assert.equal(classifyStatus(599), "server-error");
  assert.equal(classifyStatus(418), "unexpected-status");
  assert.equal(classifyStatus(200), null);
  assert.equal(classifyStatus(206), null);
};

const testRequestsAndDeduplication = async () => {
  const urls = [
    "https://allowed.example/a.png",
    "https://allowed.example/b.mp3",
    "https://allowed.example/a.png",
  ];
  const calls = [];
  let cancelCount = 0;
  const results = await checkAssets(
    urls.map((url, index) => ({
      url,
      sources: [{ bookId: "3", type: index === 1 ? "audio" : "image", imageIndex: index }],
    })),
    {
      allowedHosts: ["allowed.example"],
      concurrency: 2,
      timeoutMs: 100,
      retries: 0,
      retryDelayMs: 1,
      fetch: async (url, options) => {
        calls.push({ url, options });
        return makeResponse(url.endsWith("a.png") ? 200 : 206, () => cancelCount++);
      },
    },
  );

  assert.equal(calls.length, 2, "同一 URL 只能请求一次");
  assert.ok(calls.every(({ options }) => options.method === "GET"), "只能使用 GET");
  assert.ok(calls.every(({ options }) => options.headers.Range === "bytes=0-0"));
  assert.ok(calls.every(({ options }) => options.redirect === "manual"), "不得自动跟随到白名单外域名");
  assert.ok(calls.every(({ options }) => options.signal instanceof AbortSignal));
  assert.equal(cancelCount, 2, "读取响应后应主动取消响应正文");
  assert.ok(results.every((result) => result.ok));
};

const testBoundedConcurrency = async () => {
  let active = 0;
  let peak = 0;
  const assets = Array.from({ length: 8 }, (_, index) => ({
    url: `https://allowed.example/${index}.png`,
    sources: [{ bookId: "3", type: "image", imageIndex: index }],
  }));
  await checkAssets(assets, {
    allowedHosts: ["allowed.example"],
    concurrency: 3,
    timeoutMs: 200,
    retries: 0,
    retryDelayMs: 1,
    fetch: async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(8);
      active--;
      return makeResponse(206);
    },
  });
  assert.equal(peak, 3, "峰值并发不能超过配置值");
};

const testRetryPolicyAndTimeout = async () => {
  const attempts = new Map();
  const count = (url) => attempts.set(url, (attempts.get(url) || 0) + 1);
  const fetch = async (url, { signal }) => {
    count(url);
    if (url.endsWith("network")) throw new TypeError("socket closed");
    if (url.endsWith("timeout")) {
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    const status = Number(url.split("/").pop());
    return makeResponse(status);
  };
  const names = ["network", "timeout", "500", "404", "401", "403", "418"];
  const results = await checkAssets(
    names.map((name, index) => ({
      url: `https://allowed.example/${name}`,
      sources: [{ bookId: "3", type: "audio", pageNumber: 1, trackIndex: index }],
    })),
    {
      allowedHosts: ["allowed.example"],
      concurrency: 2,
      timeoutMs: 10,
      retries: 1,
      retryDelayMs: 1,
      fetch,
    },
  );
  const categories = Object.fromEntries(results.map((result) => [result.url.split("/").pop(), result.category]));
  assert.deepEqual(categories, {
    network: "network-error",
    timeout: "timeout",
    500: "server-error",
    404: "not-found",
    401: "permission-denied",
    403: "permission-denied",
    418: "unexpected-status",
  });
  assert.equal(attempts.get("https://allowed.example/network"), 2);
  assert.equal(attempts.get("https://allowed.example/timeout"), 2);
  assert.equal(attempts.get("https://allowed.example/500"), 2);
  for (const name of ["404", "401", "403", "418"]) {
    assert.equal(attempts.get(`https://allowed.example/${name}`), 1, `${name} 不应重试`);
  }
};

const testInvalidUrlsNeedNoRequest = async () => {
  let calls = 0;
  const results = await checkAssets(
    [
      { url: "bad url", sources: [{ bookId: "3", type: "image", imageIndex: 0 }] },
      { url: "https://unknown.example/a.png", sources: [{ bookId: "3", type: "image", imageIndex: 1 }] },
    ],
    {
      allowedHosts: ["allowed.example"],
      concurrency: 1,
      timeoutMs: 100,
      retries: 0,
      retryDelayMs: 1,
      fetch: async () => {
        calls++;
        return makeResponse(200);
      },
    },
  );
  assert.equal(calls, 0);
  assert.deepEqual(results.map(({ category }) => category), ["invalid-url", "disallowed-host"]);
};

const testStableReport = () => {
  const assets = [
    {
      url: "https://allowed.example/shared?token=do-not-print",
      sources: [
        { bookId: "4", type: "audio", pageNumber: 2, trackIndex: 1 },
        { bookId: "3", type: "image", imageIndex: 0 },
      ],
    },
    {
      url: "https://allowed.example/audio",
      sources: [{ bookId: "3", type: "audio", pageNumber: 1, trackIndex: 0 }],
    },
  ];
  const results = [
    { ...assets[1], ok: true, status: 206, attempts: 1 },
    { ...assets[0], ok: false, status: 404, category: "not-found", attempts: 1 },
  ];
  const report = summarizeResults(assets, results);
  assert.deepEqual(report.counts, {
    uniqueUrls: 2,
    uniqueImages: 1,
    uniqueAudio: 2,
    succeeded: 1,
    failed: 1,
  });
  assert.deepEqual(report.failuresByCategory, { "not-found": 1 });
  assert.deepEqual(report.failures[0].sources, [
    { bookId: "3", type: "image", imageIndex: 0 },
    { bookId: "4", type: "audio", pageNumber: 2, trackIndex: 1 },
  ]);
  assert.match(formatReport(report), /唯一 URL 2.*图片 1.*音频 2.*成功 1.*失败 1/);
  assert.match(formatReport(report), /not-found：1/);
  assert.match(formatReport(report), /教材 3 图片索引 0/);
  assert.doesNotMatch(formatReport(report), /do-not-print/, "报告不得泄露查询串中的令牌");
};

const testConfigValidation = () => {
  assert.deepEqual(parseCliArgs(["--concurrency", "4", "--timeout-ms=500", "--retries", "2"]), {
    concurrency: 4,
    timeoutMs: 500,
    retries: 2,
  });
  for (const args of [
    ["--concurrency", "0"],
    ["--concurrency", "999"],
    ["--timeout-ms", "-1"],
    ["--retries", "999"],
    ["--unknown", "1"],
  ]) {
    assert.throws(() => parseCliArgs(args), /配置|参数/);
  }
  assert.equal(determineExitCode({ counts: { failed: 0 } }), 0);
  assert.equal(determineExitCode({ counts: { failed: 1 } }), 1);

  const invalidCli = spawnSync(
    process.execPath,
    [path.join(__dirname, "validate-book-assets-remote.cjs"), "--concurrency", "0"],
    { encoding: "utf8" },
  );
  assert.equal(invalidCli.status, 2, "非法配置应使用 exit 2，且不能启动公网扫描");
  assert.match(invalidCli.stderr, /配置\/数据错误/);
};

const main = async () => {
  testCollection();
  testRealConstantCollection();
  testUrlValidation();
  testStatusClassification();
  await testRequestsAndDeduplication();
  await testRedirectIsNotFollowedOrRetried();
  await testBoundedConcurrency();
  await testRetryPolicyAndTimeout();
  await testInvalidUrlsNeedNoRequest();
  testStableReport();
  testConfigValidation();
  console.log("远端素材诊断测试通过");
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
