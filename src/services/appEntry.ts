import { BOOKS, resolveBookAction } from "@/features/bookLibrary/bookCatalog";
import type { ReadingProgress } from "@/features/bookLibrary/readingProgress";

export type AppEntryMode = "intro" | "practice";

export type AppEntryResponse = {
  mode: AppEntryMode;
};

export const HOME_FALLBACK_URL = "/pages/Home/Home";
export const INTRO_URL = "/pages/Intro/Intro";
export const CLOUD_HOSTING_SERVICE = "koa-hwx1";
export const APP_ENTRY_PATH = "/api/app-entry";

/** 启动分流接口在独立仓库 haisha-server；本地无云托管时用此开关。 */
export const MOCK_APP_ENTRY_MODE: AppEntryMode = "intro";

const CLOUD_ENV_ID = "cloud1-6geu18jg425a604e";
const MOCK_NETWORK_DELAY_MS = 180;

export const isAppEntryMode = (value: unknown): value is AppEntryMode =>
  value === "intro" || value === "practice";

export function readAppEntryMode(payload: unknown): AppEntryMode | null {
  if (!payload || typeof payload !== "object") return null;
  const body = "data" in payload ? (payload as { data: unknown }).data : payload;
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

type CloudContainerClient = {
  callContainer: (options: {
    config: { env: string };
    path: string;
    method: string;
    header: Record<string, string>;
  }) => Promise<unknown>;
};

const getCallContainer = () => {
  if (typeof wx === "undefined" || !wx.cloud) return undefined;
  const callContainer = (wx.cloud as typeof wx.cloud & Partial<CloudContainerClient>).callContainer;
  return typeof callContainer === "function" ? callContainer.bind(wx.cloud) : undefined;
};

/**
 * 启动分流只经过这里。有云托管则请求 koa-hwx1（haisha-server），没有 callContainer 时用本地 mock。
 */
export async function fetchAppEntryMode(): Promise<AppEntryResponse> {
  const callContainer = getCallContainer();
  if (!callContainer) {
    await delay(MOCK_NETWORK_DELAY_MS);
    return { mode: MOCK_APP_ENTRY_MODE };
  }

  const response = await callContainer({
    config: { env: CLOUD_ENV_ID },
    path: APP_ENTRY_PATH,
    method: "GET",
    header: {
      "X-WX-SERVICE": CLOUD_HOSTING_SERVICE,
      "content-type": "application/json",
    },
  });
  const mode = readAppEntryMode(response);
  if (!mode) throw new Error("invalid app entry");
  return { mode };
}
