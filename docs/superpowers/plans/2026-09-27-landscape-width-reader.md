# 横屏按宽阅读实施计划

用户已确认手机横屏效果图。参考图：`C:/Users/23237/.codex/generated_images/01a0beee-f004-7c31-8c91-5ed7cea9a5e0/exec-d82857bd-4673-41c1-ace2-114f9122b0cb.png`。

**Goal:** 横屏优先看清教材，页内上下滚动；右侧固定窄版操作栏，手机竖屏不变。

**Architecture:** 仅横屏使用按宽显示的图片内容层，外层 Swiper 维持固定阅读视口，每页增加原生 ScrollView。图片和热点在同一内容层；翻页成功后重建对应滚动节点以回到顶部，录音状态更新不重建节点。Pad 竖屏继续按宽高完整显示，手机竖屏继续原自然高度布局。

**Tech Stack:** Taro、React、TypeScript、Sass，现有 Node 页面运行时测试。

## 约束

- 不改录音状态机、存储、音频控制、完整电子书数据、全局设备分类。
- 保留所有此前未提交变更，不提交或推送。
- 横屏图片大小只与阅读区宽度和原图比例有关；操作栏不因录音状态改变宽度。
- 微信原生纵滑与横向 Swiper 的手势组合需真机验收，不将 API 夹具测试称为真机验证。
- 当前内置浏览器不允许打开本地文件；不通过其他浏览器接口绕过该限制。

## Task 1: 尺寸和页内滚动

Files: `src/pages/Practice/PracticeSession.tsx`、`scripts/test-practice-fitted-layout.cjs`。

- [x] 先验证横屏书页宽度等于阅读区宽度的测试失败。
- [x] 尺寸分支为 `isFittedLayout && !isLandscapeLayout ? fitImageToBounds(bookBounds, natural) : fitImageToWidth(bookBounds.width, natural)`。
- [x] 横屏 viewport 使用 `bookBounds`，内部 `.practice-book-page` 使用 `fittedBookSize`；Image 横屏使用 `widthFix`，图片和热点一起放入 `.practice-book-scroll`。
- [x] 原生 ScrollView 以 `active ? 'active' : 'neighbor'` 为 key；成功切换当前页才改变 key，录音状态及取消切页不改变 key。
- [x] 横屏标题缩至单行；取消横屏“放大查看”，保留 Pad 竖屏预览入口；重录移至已录操作底部，横屏页按钮文案缩短为上一页/下一页。

## Task 2: 局部样式

Files: `src/pages/Practice/Practice.scss`、`scripts/test-responsive-page-contract.cjs`。

- [x] 仅改横屏规则，网格列为 `minmax(0,1fr) 180PX`，Pad 220PX，窄横屏 160PX。
- [x] 阅读 ScrollView 和 Swiper 使用固定视口高度100%；图片内容层高度自动或使用测得的图片高度，不裁掉图片下半页。
- [x] 录音按钮竖排、翻页按钮并排，44px点击区域；长提示可在右侧滚动查看。
- [x] 添加不挡触摸的“上下滑动阅读”提示，仅在书页高于视口时显示。

## Task 3: 验证

- [x] 更新上一版已被本次取代的横屏 contain 测试，保留竖屏旧约束。
- [x] 验证两条路由的热点层、录音状态稳定、旋转、后台返回、成功与取消翻页、录音与草稿不重建。
- [x] `npm run test:regression`、`npx tsc --noEmit --skipLibCheck`、`npm run build:weapp`、`git diff --check`。
- [x] 独立检查实现与确认的效果图一致，记录验证范围及真机待测项。
