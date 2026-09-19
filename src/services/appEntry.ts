import { BOOKS, resolveBookAction } from "@/features/bookLibrary/bookCatalog";
import type { ReadingProgress } from "@/features/bookLibrary/readingProgress";
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
  if (progress) {
    return `/pages/Practice/Practice?bookId=${encodeURIComponent(progress.bookId)}&practice=${progress.practiceIndex}`;
  }

  const firstAvailable = BOOKS.find((book) => book.available);
  return firstAvailable
    ? resolveBookAction(firstAvailable).url
    : HOME_FALLBACK_URL;
}

export function resolveLaunchUrl(
  mode: unknown,
  progress: ReadingProgress | null,
): string {
  if (mode === "intro") return INTRO_URL;
  if (mode === "practice") return resolvePracticeEntryUrl(progress);
  return HOME_FALLBACK_URL;
}

const delay = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * 按微信云托管官方示例调用 GET /api/app-entry。
 */
export async function fetchAppEntryMode(): Promise<AppEntryResponse> {
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
