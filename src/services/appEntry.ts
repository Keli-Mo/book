import { BOOKS, resolveBookAction } from "@/features/bookLibrary/bookCatalog";
import type { ReadingProgress } from "@/features/bookLibrary/readingProgress";

export type AppEntryMode = "intro" | "practice";

export type AppEntryResponse = {
  mode: AppEntryMode;
};

export const HOME_FALLBACK_URL = "/pages/Home/Home";
export const INTRO_URL = "/pages/Intro/Intro";

/** 本地开关：改这一处即可验证介绍页 / 听音跟读两条启动路径。 */
export const MOCK_APP_ENTRY_MODE: AppEntryMode = "intro";

const MOCK_NETWORK_DELAY_MS = 180;

export const isAppEntryMode = (value: unknown): value is AppEntryMode =>
  value === "intro" || value === "practice";

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

/**
 * 启动分流只经过这里。接入真实云函数/HTTP 时替换 mock，保持 `{ mode }` 形状。
 */
export async function fetchAppEntryMode(): Promise<AppEntryResponse> {
  await new Promise((resolve) => {
    setTimeout(resolve, MOCK_NETWORK_DELAY_MS);
  });
  return { mode: MOCK_APP_ENTRY_MODE };
}
