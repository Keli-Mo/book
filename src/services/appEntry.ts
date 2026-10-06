import { BOOKS, resolveBookAction } from "@/features/bookLibrary/bookCatalog";
import { resolveReadingProgressUrl, type ReadingProgress } from "@/features/bookLibrary/readingProgress";
import { CLOUD_ENV_ID, CLOUD_RUN_ENV_ID, initCloudHosting } from "@/cloud";

export type AppEntryMode = "intro" | "practice";

export type AppEntryResponse = {
  mode: AppEntryMode;
};

export const HOME_FALLBACK_URL = "/pages/Home/Home";
export const INTRO_URL = "/pages/Intro/Intro";
export const CLOUD_HOSTING_SERVICE = "koa-hwx1";
export const APP_ENTRY_PATH = "/api/app-entry";
export { CLOUD_ENV_ID, CLOUD_RUN_ENV_ID, initCloudHosting };

/** 仅 Node 测试或没有 wx.cloud 时使用；真机/开发者工具走 haisha-server。 */
export const MOCK_APP_ENTRY_MODE: AppEntryMode = "intro";

const MOCK_NETWORK_DELAY_MS = 180;

export const isAppEntryMode = (value: unknown): value is AppEntryMode =>
  value === "intro" || value === "practice";

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return value;
  }
};

export function readAppEntryMode(payload: unknown): AppEntryMode | null {
  if (payload && typeof payload === "object" && "statusCode" in payload) {
    const statusCode = (payload as { statusCode: unknown }).statusCode;
    if (typeof statusCode === "number" && (statusCode < 200 || statusCode >= 300)) {
      return null;
    }
  }

  const nested =
    payload && typeof payload === "object" && "data" in payload
      ? (payload as { data: unknown }).data
      : payload;
  const body = typeof nested === "string" ? parseJson(nested) : nested;
  if (!body || typeof body !== "object") return null;
  const mode = (body as { mode?: unknown }).mode;
  return isAppEntryMode(mode) ? mode : null;
}

export function resolvePracticeEntryUrl(
  progress: ReadingProgress | null,
): string {
  const progressUrl = progress ? resolveReadingProgressUrl(progress) : null;
  if (progressUrl) return progressUrl;

  const firstAvailable = BOOKS.find((book) => book.available);
  return firstAvailable
    ? resolveBookAction(firstAvailable).url
    : HOME_FALLBACK_URL;
}

export function resolveLaunchUrl(mode: unknown): string {
  if (mode === "intro") return INTRO_URL;
  return HOME_FALLBACK_URL;
}

export type AppEntryPageGuardResult = "redirected" | "stay" | "error";

/**
 * 热启动可能直接落到跟读等子页，子页再问一次入口。
 * 仅 mode=intro 时跳介绍页；practice、未知值和请求失败都留在当前页。
 */
export async function redirectToIntroIfNeeded(
  reLaunch: (url: string) => Promise<unknown>,
): Promise<AppEntryPageGuardResult> {
  try {
    const { mode } = await fetchAppEntryMode();
    if (mode !== "intro") {
      return "stay";
    }
    await reLaunch(INTRO_URL);
    return "redirected";
  } catch {
    return "error";
  }
}

const delay = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** 正式版不走云托管，固定为书架。开发版和体验版才请求入口接口。 */
export const readMiniProgramEnvVersion = (): string => {
  try {
    if (typeof wx === "undefined" || typeof wx.getAccountInfoSync !== "function") return "";
    const version = wx.getAccountInfoSync()?.miniProgram?.envVersion;
    return typeof version === "string" ? version : "";
  } catch {
    return "";
  }
};

export const usesCloudHostingEntry = (envVersion = readMiniProgramEnvVersion()): boolean =>
  envVersion !== "release";

/**
 * 按微信云托管官方示例调用 GET /api/app-entry。
 * 线上 release 不调用容器，直接返回 practice。
 */
export async function fetchAppEntryMode(): Promise<AppEntryResponse> {
  if (!usesCloudHostingEntry()) return { mode: "practice" };

  const cloud = initCloudHosting() as
    | (WxCloud & {
        callContainer?: (options: {
          config: { env: string };
          path: string;
          header: Record<string, string>;
          method: string;
        }) => Promise<unknown>;
      })
    | undefined;
  const callContainer = cloud?.callContainer;
  if (typeof callContainer !== "function") {
    await delay(MOCK_NETWORK_DELAY_MS);
    return { mode: MOCK_APP_ENTRY_MODE };
  }

  const response = await callContainer.call(cloud, {
    config: {
      env: CLOUD_RUN_ENV_ID,
    },
    path: APP_ENTRY_PATH,
    header: {
      "X-WX-SERVICE": CLOUD_HOSTING_SERVICE,
    },
    method: "GET",
  });
  const mode = readAppEntryMode(response);
  if (!mode) throw new Error("invalid app entry");
  return { mode };
}
