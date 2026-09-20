# Textbook Copy Refresh Implementation Plan

> **For agentic workers:** Use subagent-driven-development or executing-plans to implement this plan task-by-task. User approved this scope on 2026-09-20.

**Goal:** Apply the confirmed textbook labels, CASA names and ordinary WeChat share title.

**Architecture:** Keep the existing catalog and page bindings. Add one shared title next to the existing shared image and use it in ordinary share payloads.

**Tech Stack:** Taro 4, React, TypeScript, existing Node verification scripts.

## Global Constraints

- Category labels: 自拼&阅读, OW, OD, RE, 综合.
- CASA series name: CASA 自拼&阅读启蒙; books append 1 through 4.
- Ordinary share title: 海沙教材听力&跟读打卡.
- Preserve book IDs, media URLs, routing, recording behavior and personalized check-in share titles.
- Preserve the existing user edits in project.config.json and project.private.config.json.
- This is a reversible copy update: use existing checks without adding tests that duplicate the strings.

## Task 1: Catalog and displayed textbook names

- [x] Update `src/features/bookLibrary/bookCatalog.ts`: CASA titles and kind, CASA series title, and the five series shortTitle values.
- [x] Update CASA titles in `src/pages/Home/Components/BookShelf/BookShelf.tsx` and `src/pages/BookDetail/Components/BookPreview/BookPreview.tsx` to `CASA 自拼&阅读启蒙 1` through `4`.
- [x] Verify the existing home and library headings consume the updated catalog title.

## Task 2: Ordinary sharing

- [x] Add `export const sharedTitle = '海沙教材听力&跟读打卡'` in `src/constant.ts`.
- [x] Import and use `sharedTitle` in Home, BookLibrary, BookDetail and the invalid/expired CheckInDetail fallback.
- [x] Preserve the valid CheckInDetail personalized title, paths and shared image.

## Task 3: Verification

- [x] Run existing catalog, library, practice, bookshelf and check-in detail runtime checks.
- [x] Run `npm run build:weapp` and inspect the result.
- [x] Review `git diff --check` and the final diff against the confirmed copy checklist.

## Validation results

- `yarn.cmd install --frozen-lockfile --offline --non-interactive`: exit 0; package manifest and lockfile unchanged.
- `node --test --test-concurrency=1 --test-timeout=30000 scripts/test-book-catalog.cjs scripts/test-book-library-pages.cjs scripts/test-book-practice.cjs scripts/test-bookshelf-polish.cjs scripts/test-check-in-detail-runtime.cjs scripts/test-home-navigation.cjs`: 6 passed, 0 failed.
- `npm.cmd run build:weapp`: exit 0. Build reported dependency Sass deprecations, stale Browserslist data, and bundle size recommendations.
- Scoped `git diff --check`: passed. Independent read-only review found no issues against the approved scope.
- No device or WeChat chat-card visual check performed.
