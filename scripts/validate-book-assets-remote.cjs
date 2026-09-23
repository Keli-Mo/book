const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const projectRoot = path.resolve(__dirname, "..");
const constantsRoot = path.join(
  projectRoot,
  "src/pages/BookDetail/Components/BookPreview/constants",
);
const BOOK_IDS = Array.from({ length: 25 }, (_, index) => String(index + 3));
const DEFAULT_ALLOWED_HOSTS = ["636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la"];
const DEFAULT_CONFIG = Object.freeze({
  concurrency: 6,
  timeoutMs: 10_000,
  retries: 1,
  retryDelayMs: 250,
});
const CONFIG_LIMITS = Object.freeze({
  concurrency: { min: 1, max: 16, flag: "--concurrency" },
  timeoutMs: { min: 1, max: 60_000, flag: "--timeout-ms" },
  retries: { min: 0, max: 3, flag: "--retries" },
  retryDelayMs: { min: 1, max: 10_000, flag: "--retry-delay-ms" },
});
const RETRYABLE_CATEGORIES = new Set(["server-error", "timeout", "network-error"]);

const loadTypeScriptFile = (sourcePath) => {
  const source = fs.readFileSync(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const loadedModule = { exports: {} };
  new Function("module", "exports", "require", output)(
    loadedModule,
    loadedModule.exports,
    require,
  );
  return loadedModule.exports;
};

const loadTypeScriptConstantFile = (filename) =>
  loadTypeScriptFile(path.join(constantsRoot, filename));

const loadBookAssetConstants = () => {
  const { BOOKS, BOOK_SERIES } = loadTypeScriptFile(
    path.join(projectRoot, "src/features/bookLibrary/bookCatalog.ts"),
  );
  return {
    concatImages: loadTypeScriptConstantFile("images.ts").concatImages,
    allAudioList: loadTypeScriptConstantFile("audioList.ts").allAudioList,
    bookIds: BOOK_IDS,
    bookCovers: BOOKS.map(({ id, cover }) => ({ bookId: id, url: cover })),
    seriesCovers: BOOK_SERIES.map(({ id, cover }) => ({ seriesId: id, url: cover })),
  };
};

const sourceSortKey = (source) =>
  [
    String(source.bookId ?? source.seriesId).padStart(3, "0"),
    source.type === "cover" ? "0" : source.type === "series-cover" ? "1" : source.type === "image" ? "2" : "3",
    String(source.pageNumber ?? -1).padStart(5, "0"),
    String(source.imageIndex ?? source.trackIndex ?? -1).padStart(5, "0"),
  ].join("|");

const sortSources = (sources) =>
  [...sources].sort((left, right) => sourceSortKey(left).localeCompare(sourceSortKey(right)));

const collectBookAssets = ({
  concatImages,
  allAudioList,
  bookIds = BOOK_IDS,
  bookCovers = [],
  seriesCovers = [],
}) => {
  const byUrl = new Map();
  const addSource = (url, source) => {
    if (!byUrl.has(url)) byUrl.set(url, { url, sources: [] });
    byUrl.get(url).sources.push(source);
  };

  for (const rawBookId of bookIds) {
    const bookId = String(rawBookId);
    const images = concatImages?.[bookId];
    const audioByPage = allAudioList?.[bookId];
    if (!Array.isArray(images) || !audioByPage || typeof audioByPage !== "object") {
      throw new Error(`教材 ${bookId} 的图片或音频常量缺失`);
    }
    images.forEach((url, imageIndex) => {
      addSource(url, { bookId, type: "image", imageIndex });
    });
    for (const [pageKey, tracks] of Object.entries(audioByPage)) {
      if (!Array.isArray(tracks)) {
        throw new Error(`教材 ${bookId} 第 ${pageKey} 页的音频常量不是数组`);
      }
      tracks.forEach((track, trackIndex) => {
        addSource(track?.url, {
          bookId,
          type: "audio",
          pageNumber: Number(pageKey),
          trackIndex,
        });
      });
    }
  }

  // 书架与系列卡会直接显示这些 URL；必须与教材内页一起做远端可用性检查。
  bookCovers.forEach(({ bookId, url }) => {
    addSource(url, { bookId: String(bookId), type: "cover" });
  });
  seriesCovers.forEach(({ seriesId, url }) => {
    addSource(url, { seriesId: String(seriesId), type: "series-cover" });
  });

  return [...byUrl.values()].map((asset) => ({
    ...asset,
    sources: sortSources(asset.sources),
  }));
};

const validateAssetUrl = (rawUrl, allowedHosts = DEFAULT_ALLOWED_HOSTS) => {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return { ok: false, category: "invalid-url" };
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, category: "invalid-url" };
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return { ok: false, category: "invalid-url" };
  }
  const normalizedHosts = new Set(allowedHosts.map((host) => host.toLowerCase()));
  if (!normalizedHosts.has(parsed.hostname.toLowerCase())) {
    return { ok: false, category: "disallowed-host" };
  }
  return { ok: true, url: parsed.toString() };
};

const classifyStatus = (status) => {
  if (status === 200 || status === 206) return null;
  if (status === 404 || status === 410) return "not-found";
  if (status === 401 || status === 403) return "permission-denied";
  if (status >= 500 && status <= 599) return "server-error";
  return "unexpected-status";
};

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const cancelResponseBody = async (response) => {
  if (response?.body && typeof response.body.cancel === "function") {
    try {
      await response.body.cancel();
    } catch {
      // The connection may already be closed. No response bytes are consumed here.
    }
  }
};

const requestAssetOnce = async (asset, options) => {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("远端素材请求超时"));
  }, options.timeoutMs);
  const sourceTypes = new Set(
    asset.sources.map(({ type }) => (type === "audio" ? "audio" : "image")),
  );
  const accept =
    sourceTypes.size !== 1 ? "*/*" : sourceTypes.has("image") ? "image/*" : "audio/*";

  try {
    const response = await options.fetch(asset.url, {
      method: "GET",
      headers: { Range: "bytes=0-0", Accept: accept },
      signal: controller.signal,
      redirect: "manual",
    });
    clearTimeout(timer);
    await cancelResponseBody(response);
    const category = classifyStatus(response.status);
    return category
      ? { ok: false, status: response.status, category }
      : { ok: true, status: response.status };
  } catch (error) {
    clearTimeout(timer);
    return {
      ok: false,
      category: timedOut ? "timeout" : "network-error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const mergeDuplicateAssets = (assets) => {
  const byUrl = new Map();
  for (const asset of assets) {
    if (!byUrl.has(asset.url)) byUrl.set(asset.url, { url: asset.url, sources: [] });
    byUrl.get(asset.url).sources.push(...(asset.sources || []));
  }
  return [...byUrl.values()].map((asset) => ({
    ...asset,
    sources: sortSources(asset.sources),
  }));
};

const checkAssets = async (assets, options = {}) => {
  const config = { ...DEFAULT_CONFIG, ...options };
  const fetchImplementation = config.fetch || globalThis.fetch;
  if (typeof fetchImplementation !== "function") throw new Error("当前 Node.js 不支持 fetch");
  const uniqueAssets = mergeDuplicateAssets(assets);
  const results = new Array(uniqueAssets.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < uniqueAssets.length) {
      const index = nextIndex++;
      const asset = uniqueAssets[index];
      const validation = validateAssetUrl(asset.url, config.allowedHosts || DEFAULT_ALLOWED_HOSTS);
      if (!validation.ok) {
        results[index] = { ...asset, ok: false, category: validation.category, attempts: 0 };
        continue;
      }

      let outcome;
      let attempts = 0;
      do {
        attempts += 1;
        outcome = await requestAssetOnce(asset, {
          fetch: fetchImplementation,
          timeoutMs: config.timeoutMs,
        });
        if (outcome.ok || !RETRYABLE_CATEGORIES.has(outcome.category) || attempts > config.retries) {
          break;
        }
        await delay(config.retryDelayMs * attempts);
      } while (attempts <= config.retries);
      results[index] = { ...asset, ...outcome, attempts };
    }
  };

  const workerCount = Math.min(config.concurrency, uniqueAssets.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
};

const failureSortKey = (failure) => `${failure.category}|${String(failure.url)}`;

const summarizeResults = (assets, results) => {
  const uniqueAssets = mergeDuplicateAssets(assets);
  const uniqueImages = uniqueAssets.filter((asset) =>
    asset.sources.some(({ type }) => type !== "audio"),
  ).length;
  const uniqueAudio = uniqueAssets.filter((asset) =>
    asset.sources.some(({ type }) => type === "audio"),
  ).length;
  const failures = results
    .filter((result) => !result.ok)
    .map((failure) => ({ ...failure, sources: sortSources(failure.sources) }))
    .sort((left, right) => failureSortKey(left).localeCompare(failureSortKey(right)));
  const failuresByCategory = {};
  for (const failure of failures) {
    failuresByCategory[failure.category] = (failuresByCategory[failure.category] || 0) + 1;
  }
  const sortedCategories = Object.fromEntries(
    Object.entries(failuresByCategory).sort(([left], [right]) => left.localeCompare(right)),
  );
  return {
    counts: {
      uniqueUrls: uniqueAssets.length,
      uniqueImages,
      uniqueAudio,
      succeeded: results.length - failures.length,
      failed: failures.length,
    },
    failuresByCategory: sortedCategories,
    failures,
  };
};

const sanitizeUrlForReport = (rawUrl) => {
  try {
    const parsed = new URL(rawUrl);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "[非法 URL]";
  }
};

const formatSource = (source) => {
  if (source.type === "cover") return `教材 ${source.bookId} 书架封面`;
  if (source.type === "series-cover") return `系列 ${source.seriesId} 首页封面`;
  return source.type === "image"
    ? `教材 ${source.bookId} 图片索引 ${source.imageIndex}`
    : `教材 ${source.bookId} 第 ${source.pageNumber} 页音频索引 ${source.trackIndex}`;
};

const formatReport = (report) => {
  const { counts } = report;
  const lines = [
    `远端素材汇总：唯一 URL ${counts.uniqueUrls}，图片 ${counts.uniqueImages}，音频 ${counts.uniqueAudio}，成功 ${counts.succeeded}，失败 ${counts.failed}`,
  ];
  const categories = Object.entries(report.failuresByCategory);
  lines.push(
    categories.length
      ? `失败分类：${categories.map(([category, count]) => `${category}：${count}`).join("，")}`
      : "失败分类：无",
  );
  for (const failure of report.failures) {
    const status = failure.status ? ` HTTP ${failure.status}` : "";
    lines.push(
      `- ${failure.category}${status} ${sanitizeUrlForReport(failure.url)} ← ${failure.sources.map(formatSource).join("；")}`,
    );
  }
  return lines.join("\n");
};

const parseInteger = (rawValue, key) => {
  const limit = CONFIG_LIMITS[key];
  if (!/^(?:0|[1-9]\d*)$/.test(rawValue || "")) {
    throw new Error(`配置 ${limit.flag} 必须是整数`);
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < limit.min || value > limit.max) {
    throw new Error(`配置 ${limit.flag} 必须在 ${limit.min}–${limit.max} 之间`);
  }
  return value;
};

const parseCliArgs = (args) => {
  const flagToKey = Object.fromEntries(
    Object.entries(CONFIG_LIMITS).map(([key, { flag }]) => [flag, key]),
  );
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const separator = argument.indexOf("=");
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    const key = flagToKey[flag];
    if (!key) throw new Error(`未知参数：${flag}`);
    const rawValue = separator === -1 ? args[++index] : argument.slice(separator + 1);
    if (rawValue === undefined) throw new Error(`参数 ${flag} 缺少配置值`);
    parsed[key] = parseInteger(rawValue, key);
  }
  return parsed;
};

const determineExitCode = (report) => (report.counts.failed === 0 ? 0 : 1);

const runCli = async (args = process.argv.slice(2)) => {
  const overrides = parseCliArgs(args);
  const assets = collectBookAssets(loadBookAssetConstants());
  const results = await checkAssets(assets, {
    ...DEFAULT_CONFIG,
    ...overrides,
    fetch: globalThis.fetch,
  });
  const report = summarizeResults(assets, results);
  console.log(formatReport(report));
  return determineExitCode(report);
};

module.exports = {
  BOOK_IDS,
  DEFAULT_ALLOWED_HOSTS,
  DEFAULT_CONFIG,
  loadBookAssetConstants,
  collectBookAssets,
  validateAssetUrl,
  classifyStatus,
  checkAssets,
  summarizeResults,
  formatReport,
  parseCliArgs,
  determineExitCode,
  runCli,
};

if (require.main === module) {
  runCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(`远端素材诊断配置/数据错误：${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    });
}
