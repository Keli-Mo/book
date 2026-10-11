# 教材页原位双指缩放实施计划

> **For agentic workers:** Use test-driven-development for each behavior. Git branches, commits, and pushes require the user's separate approval. This implementation plan itself did not authorize Git writes; on 2026-10-11 the user separately approved creating and pushing `codex/haisha-book-pinch-zoom` to `origin`.

**Goal:** 在教材页原位双指缩放并拖动，放大后仍能点击音频热点和使用录音控件。

**Architecture:** 当前页图片及热点位于独立的 `PracticeBookZoom` 缩放层；已预载图片节点始终保留在静态底层。缩放层内管理倍率、平移与误点抑制，只将“正在捏合或倍率大于 1”通知 `PracticeSession` 锁住横向翻页。横屏用可视书区作为 `MovableArea`，整页图片作为更高的 `MovableView`，在 1 倍时纵向移动阅读。手机竖屏放大时，底部精简录音操作条保持录音动作可达。成功切页或旋转只重置书页缩放层，不重建录音会话。

**Tech Stack:** Taro 4、React、TypeScript、SCSS、微信小程序 `movable-area` / `movable-view`、Node 运行时组件测试。

## 全局约束

- 普通教材和 Think 教材共用 `PracticeSession`；手机与 Pad 竖横屏均可直接在书页双指缩放，倍率 1–4。
- 1 倍保留单指横滑翻页和纵向阅读；大于 1 倍时单指平移书页，按钮和目录仍可切页。
- 图片与热点同一缩放坐标；热点视觉和命中范围接近现有 44PX，不因放大遮字；捏合及拖动不误播。
- 录音区不缩放，放大时仍可到达并使用；切页失败不重置，成功切页或旋转重置书页但不重启录音。
- 按项目根目录 `AGENTS.md`，取得明确同意前实现与验证保持未提交；2026-10-11 的分支提交和推送已有单独授权。

---

### Task 1：写出失败的页内交互测试

**Files:** Create `scripts/test-practice-pinch-zoom.cjs`; later modify `scripts/test-practice-fitted-layout.cjs`.

**Interfaces:** 复用 `scripts/test-practice-book-route.cjs` 的 `createPage`、`byClass`、`elements`；新组件使用 `practice-book-zoom-area` / `practice-book-zoom-view` 类名，`MovableView.scaleValue` 暴露当前倍率。

- [ ] 在两条真实路由和四种尺寸中断言当前图片、热点同处 `MovableView`，录音区位于其外；不存在旧“放大查看”入口及全屏预览。
- [ ] 调用当前 `MovableView.onScale({ detail: { scale: 2, x: 0, y: 0 } })`，断言 `Swiper.disableTouch` 为 true；再缩回 1 倍后为 false。横屏在 1 倍仍能纵向阅读。
- [ ] 放大后点击热点及录音操作仍有效；捏合或拖动紧接的热点点击被抑制。成功切页和旋转恢复 1 倍；取消切页保持倍率。
- [ ] 运行 `node --test scripts/test-practice-pinch-zoom.cjs`，确认失败原因是缺少原位缩放行为。

### Task 2：隔离缩放层并接入当前书页

**Files:** Create `src/pages/Practice/PracticeBookZoom.tsx`; modify `src/pages/Practice/PracticeSession.tsx` and `src/pages/Practice/Practice.scss`.

**Interfaces:** `PracticeBookZoom` 消费可视区域宽高、内容宽高、是否横屏、当前页内容渲染函数及 `onZoomActiveChange(active: boolean)`；内部状态只保留 `scale` 与手势误点时间，向内容渲染函数传当前倍率。`PracticeSession` 使用该回调更新 `Swiper.disableTouch`，由已提交的当前页 ID 与方向决定缩放组件的重置 key。

- [ ] 以 `MovableArea > MovableView` 直接嵌套，设置明确像素尺寸、`scaleMin={1}`、`scaleMax={4}`、`scaleValue`；1 倍横屏只许纵移，其余 1 倍不接管单指移动，大于 1 倍允许双向平移。
- [ ] 将活动页图片与热点一起放进缩放层，热点在视图中按 `1 / scale` 逆缩放；邻页沿用预载图片。录音区留在缩放层外。
- [ ] 双指开始和倍率大于 1 时锁住 Swiper；双指结束且回到 1 倍时解锁。通过手势时间窗阻止捏合或拖动后的误点，不阻止正常热点点击。
- [ ] 成功切页及方向变化重置缩放；录音状态变化、图片加载和失败切页均不重置。横屏用原生纵向移动替换当前页的内层 `ScrollView`，并把原滚动提示的消失条件接到纵向位移。
- [ ] 移除 Pad 的旧入口和全屏预览层；保持目录、录音和翻页按钮在原页工作。
- [ ] 运行新测试直到通过，再运行 `scripts/test-practice-swipe-rendering.cjs`、`scripts/test-practice-layout-stability.cjs` 和 `scripts/test-hotspot-layout.cjs`，修复实际回归。

### Task 3：更新旧布局契约并验证

**Files:** Modify `scripts/test-practice-fitted-layout.cjs` and any existing test that asserts the old full-screen preview.

- [ ] 把旧“放大查看/独立预览”的断言改为页内缩放、现有播放与录音状态不变；保留真实业务回归，删除只针对旧预览层的检查。
- [ ] 用第 12 页及其他细字页检查 2 倍和 3 倍可读性；若源图模糊，记录为素材限制，不以更高倍率掩盖。
- [ ] 运行 `npm run test:regression`、`npx tsc --noEmit --skipLibCheck`、`npm run build:weapp` 与改动文件 ESLint；检查 `git diff --check` 和未提交文件。
- [ ] 记录微信真机尚需确认的手势项：华为及 iPad 的 1 倍翻页、横屏纵移、放大拖动、热点命中、短屏录音可达、旋转与取消切页。模拟测试不能替代真机结论。
