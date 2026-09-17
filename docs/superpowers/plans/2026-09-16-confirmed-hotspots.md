# 已确认教材热点校正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 校正四个已有清晰印刷播放标记的越界音频按钮；不假造另外两个缺少标记页面的语义位置。

**Architecture:** 保留既有 audioList 数据结构，四个条目改为明确 Percentage；运行时设备边缘保护不变。

## Global Constraints

- 不改音频URL、页码映射、教材图片、目录、录音或整体布局。
- 6/88和24/213保持待人工语义核查，测试与报告明确保留两条warning，不机械钳到正数。
- 四点仅通过同名标题/封面播放标记视觉校正，不声称已逐段听音。
- 只改下列文件与报告，IDE/其他任务保留；中文本地提交，不部署不push。

### Task 1: 按证据写回四个百分比并固定剩余告警

**Files:**
- Modify: `src/pages/BookDetail/Components/BookPreview/constants/audioList.ts`
- Test: `scripts/test-book-audio-map-validator.cjs`

- [ ] Step 1: 先读 .superpowers/sdd/full-audit-hotspot-visual-report.md，并用view_image查看四张对应原图和 book4-page164-cover-marker-zoom.png；主控已独立查看同样证据。不要另下载素材或访问录音。
- [ ] Step 2: 新增解析后四个mapping的准确断言：book3/rawKey84/track1→[6.8,95.0]；book4/rawKey140/track1→[60.2,93.0]；book4/rawKey164/track1→[57.9,95.4]；book5/rawKey134/track1→[5.1,41.5]。使用允许微小浮点误差的数值比较或Percentage解析精确比较，原URL/页数/段数保持。现有warnings期望精确改为仅6/88原offset[694,775]与24/214原Percentage[-1%,54%]，CLI仍明确提示2处待复核。先运行validator测试得到坐标不匹配RED。
- [ ] Step 3: 对这四个唯一URL条目设置 `flag: 'Percentage'`、`offset: ['6.8%', '95%']`等对应值，其他条目不动。不要全文件格式化。
- [ ] Step 4: 跑 test-book-audio-map-validator、validate-book-audio-map、test-book-practice、test-audio-playback、tsc --noEmit --skipLibCheck（脚本名以实际rg核对）。既有坐标保护测试不删。用已存在局部截图harness重渲染这4页并自己view_image，证明覆盖正确标记且无点击区越界；只输出到scratch，不改原审查证据。
- [ ] Step 5: 仅显式暂存任务文件与实现报告，提交 `fix: 校正四处教材音频播放位置`。报告精确RED/GREEN、四点前后证据、剩余两warning和commit，等待复审。
