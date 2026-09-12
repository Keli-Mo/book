# iPad UI 与返回导航修复计划

> 使用 subagent-driven-development 分工实现，测试驱动逐项修复并独立复核；不使用 using-superpowers 总入口。

**Goal:** 修复用户截图中的图标放大和底栏文字遮挡，将打卡页首页按钮改成纯房子图标，并对五个在用页面做有证据的布局检查。

**Architecture:** 统一图标的 CSS 像素尺寸；仅打卡详情改自定义轻导航以替代不可直接控制外观的系统 home 键。所有页面以实际组件树、真实 AtIcon 渲染及打包 WXSS 检查，不触碰录音、分享或教材映射业务。

**Tech Stack:** Taro 4、React、TypeScript、SCSS、Node 测试、经用户允许的本机 Edge 无头布局检查。

## Global Constraints

- 保留现有绿色设计、页面信息与路由，不增加业务功能；在现有隔离工作树的新分支工作。
- 图标固定 CSS 像素，不随 iPad 整窗 rpx 放大；交互命中区至少 44 CSS px。
- 返回首页为无圆形底色、无边框、无阴影的房子图标；返回箭头保留原页面栈语义，独立入口提供安全退路。
- 返回教材必须保留原书原训练页、录音器唯一会话、离页停止回听，不自动上传录音。
- 正常、空、错误、播放、录音/暂停和目录状态均纳入检查；正常与失效数据不能造成横向溢出或底栏遮字。
- 不修改/提交 project.config.json、project.private.config.json，不推送、合并或部署。
- 注释中文；Conventional Commit 英文类型，冒号后中文。
- Edge 截图是受控组件/样式验证，不冒称微信原生全流程验收；原生平台弹窗、录音硬件和安全区保留设备验收说明。

## Task 1: 图标固定尺寸与纯图标返回导航

**Files:** 新建 src/components/AppIcon/AppIcon.tsx、src/pages/CheckInDetail/CheckInNavigation.tsx、CheckInNavigation.scss；修改 Home.tsx、BookLibrary.tsx、CheckInDetail.tsx/config.ts 和 CheckInDetail.scss 中导航布局部分；新增 scripts/test-ui-navigation.cjs，按需更新受影响测试。

**Interfaces:** AppIcon 消费现有图标 value/color/size，内部传 `customStyle={{ fontSize: `${size}px` }}` 给真实 AtIcon，保留图标字体。CheckInNavigation 消费 `onBack:()=>void`，首页固定 `/pages/Home/Home`；使用现有 calculateHomeNavigationMetrics 与 useDeviceLayout。保留 `check-in-detail__home` 便于旧回归识别首页入口。

- [x] RED：用真实 AtIcon render 和 pxTransform 路径断言首页/书库图标实际 fontSize 采用 px 而非 rpx；检查详情配置 custom navigation。新增导航点击测试，覆盖保留页面栈返回、孤立入口、有/无详情和纯图标 aria-label。
- [x] GREEN：实现薄 AppIcon 适配，不复制图标源码；纯图标导航按钮 44px 点击区、房子 22px、返回 24px、标题 16px，不绘制圆背景/阴影。导航根据胶囊尺寸预留左右空间，窄屏标题可省略但不盖按钮。
- [x] GREEN：详情正常/加载/错误都显示导航，删除重复“返回首页”正文入口；有上一页 navigateBack，无上一页用合法实践路径（或首页），详情录音/分享业务保持原样。
- [x] 验证：新测试、test-check-in-return-navigation.cjs、test-check-in-detail-runtime.cjs、test-home-navigation.cjs、test-reading-progress-pages.cjs、TypeScript 和 ESLint；独立提交，仅任务文件。

## Task 2: 五页面布局缺陷修复

**Files:** Home.scss、BookLibrary.scss、Practice.scss、CheckInDetail.scss、MyCheckIns.scss；scripts/test-ui-layout.cjs；根代理补充可重复的真实组件截图工具。

- [x] RED：先在未改样式上截图并测量底栏文字边界、正常左右 padding、Pad 录音列表封面 flex-basis、目录头/滚动区/安全区高度、空态 CTA 是否在首屏。
- [x] GREEN：只修检查确认的缺陷：有效纯数值基础 padding，constant/env 安全区放对应 supports；补齐 Pad 固定尺寸；底栏文字显式行高和防压缩布局；目录滚动区占剩余高度；窄分屏保证可读可点。不改教材热点坐标/录音状态机。
- [x] 验证：五页面、多状态、手机/Pad 竖横屏/窄分屏；断言不横向溢出、固定区文字完整可见、图标/封面尺寸与原始比例符合预期。

## Task 3: 回归、独立复核与交付

- [x] 所有 test-*.cjs 各自进程、兼容 tsc、变更文件 lint、无缓存小程序构建；出现新错误必须解决。
- [x] 对全部五页面按编号记录截图、可见问题与验证边界；补充弱网/过期/空态等可测试场景，不实际上传或删除用户录音。
- [x] 任务级与全分支独立代码复核，修复问题后复测；中文提交与验收报告，保留新分支不推送。
