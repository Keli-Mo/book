# 四处教材音频热点修正实施报告

日期：2026-09-17  
基线：`4749089`  
范围：只修正四处已有清晰同名印刷标记的音频热点；未下载或播放音频，不据此声称完成听音校对。

## 实现

| 教材 / 原音频键 / 轨 | 原坐标及类型 | 新坐标及类型 | 视觉落点 |
| --- | --- | --- | --- |
| book3 / 84 / 1 | `[673, 784]`，pixel（约 `4.26%, 101.82%`） | `['6.8%', '95%']`，Percentage | `Lunch at School` 左下红色播放标记 |
| book4 / 140 / 1 | `[959, 781]`，pixel（约 `65.25%, 101.32%`） | `['60.2%', '93%']`，Percentage | `Bird Goes Home` 右下封面黄色播放标记 |
| book4 / 164 / 1 | `[949, 799]`，pixel（约 `63.11%, 104.29%`） | `['57.9%', '95.4%']`，Percentage | `Carlos Goes to School` 右下封面黄色播放标记 |
| book5 / 134 / 1 | `[694, 782]`，pixel（约 `8.74%, 101.49%`） | `['5.1%', '41.5%']`，Percentage | `I Set the Table` 标题页黄色播放标记 |

四个 URL、教材图片、页码映射、音频段数和整体布局均未改。`test-book-practice.cjs` 的 Percentage 格式契约同步允许严格的小数百分比文本，并把四个条目的坐标类型统计从 pixel 转为 Percentage。

## TDD 证据

### RED

1. 写入四个解析后 mapping 的坐标与类型断言、把 warning 期望收敛为两处后运行：

   `C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe scripts/test-book-audio-map-validator.cjs`

   退出码 `1`；首个目标实际 `coordinateType` 为 `pixel`，期望 `Percentage`。失败原因正是生产坐标尚未写回。

2. 写回四处坐标后运行 `scripts/test-book-practice.cjs`：

   - 第一次退出码 `1`：既有 `/^-?\d+%$/` 只允许整数百分比，拒绝任务要求的小数百分比；
   - 扩展严格格式后第二次退出码 `1`：统计仍期望 `pixel: 594 / Percentage: 1229`，实际为 `pixel: 590 / Percentage: 1233`。

   两项均按新坐标的真实数据契约做最小修正。

### GREEN 与最终回归

固定 Node：`C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`。

| 命令 | 结果 |
| --- | --- |
| `node scripts/test-book-audio-map-validator.cjs` | 退出 `0`；23 本、4,056 图、1,393 页、2,081 段，4 个热点已校正，2 个待复核 warning |
| `node scripts/validate-book-audio-map.cjs` | 退出 `0`；映射校验通过，仅输出两处坐标 warning |
| `node scripts/test-book-practice.cjs` | 退出 `0`；96 项回归通过 |
| `node scripts/test-audio-playback.cjs` | 退出 `0`；播放与教材回归通过 |
| `node node_modules/typescript/bin/tsc --noEmit --skipLibCheck` | 退出 `0`，无输出 |
| `git diff --check` | 退出 `0`；仅有任务外既存配置文件的 CRLF 提示，未暂存这些文件 |

## 视觉验证

使用 `.superpowers/sdd/full-audit-confirmed-hotspot-visual.cjs` scratch 副本，只渲染四页；通过 Playwright route 把原图片 URL 映射到既有 `full-audit-hotspots/*-source.png`，没有重新下载图片或音频，也没有覆盖原审查证据。

新证据目录：`.superpowers/sdd/full-audit-confirmed-hotspots-scratch/`

| 页面 | 新截图 | 渲染中心 / 点击区 | 目视结论 |
| --- | --- | --- | --- |
| book3/page84 | `book3-page84-corrected-hotspot.png` | `(50.45, 997.08)` / `44×44` | 覆盖左下红色同名标记，点击区未越界 |
| book4/page140 | `book4-page140-corrected-hotspot.png` | `(446.67, 976.08)` / `44×44` | 覆盖右下封面黄色同名标记，点击区未越界 |
| book4/page164 | `book4-page164-corrected-hotspot.png` | `(429.61, 1001.28)` / `44×44` | 覆盖右下封面黄色同名标记，点击区未越界 |
| book5/page134 | `book5-page134-corrected-hotspot.png` | `(37.83, 435.56)` / `44×44` | 覆盖标题页黄色同名标记，点击区未越界 |

四张新截图均已用 `view_image` 原分辨率逐张检查。显示教材图尺寸为 `742×1049.5625`，四个 44px 点击区均完整位于图内。

## 保留的两处待复核 warning

- book6 / rawKey 88 / track 1：原 `offset: [694, 775]` 保持不变；原图无可信播放标记，需语义确认。
- book24 / rawKey 214（真实页 213）/ track 1：原 `offset: ['-1%', '54%']` 与 `flag: 'Percentage'` 保持不变；需试听或教研确认文章音频锚点。

CLI 明确显示 `坐标轻微越界 2 处（仅警告）`，并逐条输出以上原坐标。

## 自查与提交

- 只改四个目标 URL 条目的 `offset` / `flag`，未全文件格式化。
- validator 新增四个解析 mapping 的精确键、原始 Percentage 文本及 `1e-9` 浮点容差断言。
- 两处未确认坐标和 warning 均保留。
- scratch harness 与截图不进入提交；任务外 dirty 文件不暂存。
- 提交：`fix: 校正四处教材音频播放位置`。本报告与实现进入同一原子提交，最终 SHA 由提交完成后 `git log` 生成并在回传中报告。
