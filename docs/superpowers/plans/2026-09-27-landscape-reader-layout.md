# 横屏与 iPad 阅读区布局计划

> **For agentic workers:** Use subagent-driven-development for the isolated CSS and runtime test tasks; root integrates and verifies the result.

**Goal:** 手机横屏和 iPad 使用能完整显示教材的稳定阅读区，手机竖屏保持当前布局和行为。

**Architecture:** 页面局部 fitted class 管理占满窗口的 flex 布局，不修改共享设备分类。横屏左右两栏；iPad 竖屏上下两区，操作区预留固定高度。仅测量教材区域宽高，按原图比例 contain；录音状态不参与尺寸计算。操作区用原生 ScrollView 容纳长提示。拟合后的教材支持调用原生 previewImage 放大。

**Tech Stack:** Taro / React / TypeScript / Sass；生产组件运行时测试及 Chrome 尺寸模拟截图。

## 约束

- 用户已经批准上一轮提出的横屏左右分栏及稳定阅读区方案，并明确“手机竖屏先不动”。
- 手机竖屏保留旧 CSS、fitImageToWidth、页面自然滚动和操作区 View；截图像素对比验证。
- 不修改全页教材、音频、录音状态机、持久化、全局设备分类或其他页面。
- 不依赖录音区实际内容高度计算图片，不重新引入录音前后变小的问题。
- 保留已有未提交改动，不提交或推送本次工作。

## Task 1: 固定阅读区与图片比例

**Files:** `src/features/listeningPractice/hotspotLayout.ts`、两个阅读器 wrapper、`src/pages/Practice/PracticeSession.tsx`。

- [x] 先增加有限区域 contain 的尺寸测试与真实 Session RED 测试。
- [x] 新增 `fitImageToBounds(bounds: HotspotImageSize, natural: HotspotImageSize)`，按 `Math.min(bounds.width / natural.width, bounds.height / natural.height)` 计算，非法尺寸返回 null；保留 `fitImageToWidth`。
- [x] 使用 `layout.isPad || layout.orientation === "landscape"` 选择 fitted class 和尺寸算法；继续使用测量序号及 mounted 保护。
- [x] fitted 操作区使用 ScrollView；手机竖屏继续 View。放大按钮调用 `Taro.previewImage({current: practice.imageUrl, urls: [practice.imageUrl]})`，不改写当前页或录音。
- [x] 验证旋转、迟到测量、卸载、录音前后尺寸和手机竖屏旧行为。

## Task 2: 局部 CSS

**Files:** `src/pages/Practice/Practice.scss`。

- [x] 用修复前截图/DOM 尺寸复现：手机横屏 844×390 单栏高达 1449px，iPad 横屏 1180×820 教材底部达到 1182px。
- [x] 所有新规则以 `practice-screen--fitted` 或 `practice-page--fitted` 门控。外屏固定窗口高度，导航和标题不伸缩；剩余区域交给阅读区。
- [x] `.practice-page--landscape .practice-workspace` 左教材右操作；使用固定 px 字号与紧凑标题。iPad 竖屏给操作区固定保留高度。
- [x] 操作区独立滚动；图片区无 padding 干扰测量，图面居中。保持触控目标至少 44px。

## Task 3: 验证与截图

- [x] 运行 `node --test scripts/test-practice-fitted-layout.cjs scripts/test-practice-layout-stability.cjs scripts/test-hotspot-layout.cjs`，包含普通教材与 Think。
- [x] 检查当前要求与旧静态断言的区别，只更新已被此次明确替代的约束。
- [x] 运行 `npm run test:regression`、`npx tsc --noEmit --skipLibCheck`、`npm run build:weapp`。
- [x] 用实际 TSX、生产 WXSS、真实教材图片生成 820×1180 / 1180×820 / 390×844 / 844×390 四张截图；手机竖屏与之前的截图比较。
- [x] 追加 640×360、Pad 768×1024 以及长提示状态检查，确认操作可达、录音前后图面相同。
- [x] 独立复核结果，给用户明确标注模拟环境的截图。
