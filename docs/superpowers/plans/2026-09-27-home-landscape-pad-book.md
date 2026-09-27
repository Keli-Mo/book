# 手机横屏首页及 iPad 书页尺寸调整

用户根据模拟器截图要求调整手机横屏、放大 iPad 书页。手机竖屏保持不变。

## 方案与范围

- 截图中的手机横屏首页继续卡片过高：仅 `.device-layout--phone.device-layout--landscape` 使用固定 px 字号、封面和卡片间距；继续按钮保留 44px，首页仍单栏，可向下阅读系列列表，安全区不变。
- iPad 竖屏书页由整页 contain 改为按可用宽度显示，在现有固定阅读区内上下滚动，复用横屏已验证的图片和热点同滚结构。
- iPad 横屏操作栏从 220px 缩为 180px，多出的宽度交给教材。手机横屏阅读器布局不变。
- 录音状态不参与书页尺寸计算；手机竖屏与 iPad 首页不变，不修改录音容量检查、缓存或数据。

## 实施

- [x] Home.scss 添加局部固定像素样式；Home.tsx 图标本就使用固定 px，无需调整；72 条非目标样式逐条无变化。
- [x] 先在 `test-practice-fitted-layout.cjs` 验证 Pad 竖屏按宽显示期望失败，再将 Session 中 `isFittedLayout` 统一用于固定 viewport、书内 ScrollView 和 widthFix，图片尺寸统一 `fitImageToWidth(bookBounds.width, naturalImageSize)`。
- [x] 将书内滚动样式从 landscape 子规则移至 fitted 子规则，Pad 横屏列改为 180px，保留手机竖屏旧选择器。
- [x] 更新已被取代的 Pad contain 断言；验证 Pad 竖屏翻页、旋转、录音和草稿保留。
- [x] 完整回归 181/181、类型检查、小程序构建及差异格式检查通过；原生模拟器/真机验收范围见 `docs/qa/2026-09-27-home-landscape-pad-book.md`。

第四张截图是在 PowerShell 运行 JavaScript，不能作为 `getSavedFileList` 的运行结果；本轮仍未获得原生容量接口报错，不据此修改或跳过容量保护。
