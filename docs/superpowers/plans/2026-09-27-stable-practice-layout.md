# Stable practice layout implementation plan

User approved the screenshot-based layout and compact controls on 2026-09-27.

**Goal:** Keep the lesson image stable through recording, playback and retry, while compacting the surrounding controls.

**Architecture:** Both Practice and ThinkBookReader keep sharing PracticeSession. Calculate image dimensions from the book column's width and the image's intrinsic aspect ratio; recorder height is not an input. Let the page scroll vertically when its natural content exceeds the screen, and retain horizontal Swiper navigation and hotspot alignment.

**Tech stack:** Taro 4 / React / TypeScript / Sass, existing Node regression harness.

## Constraints

- Preserve the existing audio, recording, local persistence and share behavior.
- Preserve existing local configuration changes and the untracked recording audit.
- Reduce the unit heading from 42rpx to 36rpx and secondary course text from 24rpx to 22rpx; compact navigation/icon visuals without reducing 44px touch targets.
- Recorded state: heading contains title, retry action and duration; the only primary action row contains playback and completion side by side, including narrow phones.
- Do not change SDK permissions, cloud configuration, or publish/push as part of this task.

## 1. Stable sizing and page behavior

- [x] Add a failing behavioral test: shrinking only the available slot height between idle/recording/recorded must leave image dimensions unchanged; changing width must preserve the image aspect ratio.
- [x] Replace `fitContainSize(slot, natural)` with `fitImageToWidth(width, natural)`: return `{ width, height: Math.round(width * natural.height / natural.width) }` for positive finite inputs, otherwise `null`.
- [x] Update PracticeSession to measure only the book column width and derive hotspot bounds from the actual applied image dimensions. Keep intrinsic dimensions associated with their source URL across page changes.
- [x] Give Swiper explicit calculated dimensions. Remove fixed viewport-height and hidden vertical-overflow constraints; enable scrolling on both page routes. Keep the existing Pad split layout.
- [x] Return to the top only after a successful practice switch; preserve the current position when switching is cancelled or blocked.

## 2. Compact controls

- [x] Move the existing retry action into the recorded-state heading without changing its enable/save conditions.
- [x] Move completion into the playback action row and keep the pair horizontal on narrow screens.
- [x] Reduce surrounding headings, margins, navigation and hotspot visuals. Keep safe areas and minimum touch sizes.
- [x] Add optional compact navigation styling for Practice and Think only.

## 3. Verification

- [x] Exercise real Practice/Think page callbacks through the existing recording harness; verify recording/retry/completion still operate from their new positions.
- [x] Run focused hotspot, responsive layout, Think UI and practice route tests, then the full regression command and `npm run build:weapp` including compiled page-registration validation.
- [x] Inspect rendered layout at phone, narrow phone and Pad dimensions using local browser rendering if available; do not present a browser simulation as real WeChat device validation.
- [x] Review the diff, preserve unrelated changes, and report any remaining device verification limits.

## Verification results

- Twelve new behavioral cases pass for Practice and Think, covering image stability, action placement, scroll reset, directory scroll locking and stale measurement callbacks; missing behaviors were verified to fail before their fixes.
- Final `npm run test:regression`: 118 passed, 0 failed.
- Final `npm run build:weapp`: passed, including both page-registration checks. Existing Sass deprecation and bundle-size warnings remain.
- Chrome simulation: eight scenarios passed (Practice widths 320/360/390/768/1024/1180 and Think widths 390/1180), with stable image bounds across idle/recording/saved, equal-width action buttons, 44px retry touch targets and no horizontal overflow.
- Browser verification uses real TSX and production Sass, an offline image fixture, and only the current Swiper item. Native WeChat gestures, actual recording hardware and safe-area behavior still require device verification.
- Independent review and `git diff --check` passed. Existing local configuration files and the recording audit were preserved. No commit, push or publishing was performed.

## 4. Approved follow-up repairs

- [x] Lock page scrolling while the directory is open, retain the directory's internal scrolling, and restore normal page scrolling after closing it. Verify 12 browser scenarios and native template bindings.
- [x] Ignore stale and post-unload width measurements with a request sequence; add real component regressions for both readers.
- [x] Correct the existing app-config type error with a local narrow type while proving Taro's serialized config is identical; `tsc --noEmit --skipLibCheck` passes.
