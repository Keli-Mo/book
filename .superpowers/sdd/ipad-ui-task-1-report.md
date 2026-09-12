# Task 1 实施报告：图标固定尺寸与纯图标返回导航

## 结果

- 新增 `AppIcon` 薄适配器，继续执行真实 Taro UI `AtIcon`，以 `customStyle.fontSize = size + "px"` 覆盖其默认 rpx 放大结果。
- 首页和书库的全部 Taro UI 图标改用 `AppIcon`。
- 打卡详情启用自定义导航；加载、错误、成功三态共用返回箭头、标题和无底色首页图标。
- 返回箭头在有页面栈时 `navigateBack`，孤立入口按有效训练路径或首页安全 `reLaunch`；继续跟读、回听和分享生命周期未改。
- 点击区固定为 44 CSS PX，返回图标 24px、首页图标 22px、标题 16 CSS PX；保留 `check-in-detail__home` 回归类名。

## TDD 证据

- RED：`node scripts/test-ui-navigation.cjs` 首次按预期失败，真实 `AtIcon` 最终得到 `font-size:54rpx;color:#278465;`。
- GREEN：同一测试通过，真实首页/书库图标最终字号均为 `Npx`，并覆盖详情三态、纯图标 aria-label、栈返回、孤立入口和首页入口。

## 验证

- 通过：`test-ui-navigation.cjs`
- 通过：`test-check-in-return-navigation.cjs`
- 通过：`test-check-in-detail-runtime.cjs`
- 通过：`test-home-navigation.cjs`
- 通过：`test-reading-progress-pages.cjs`
- 通过：`test-reading-progress.cjs`
- 通过：任务文件 ESLint；仅输出仓库现有 browserslist 数据过期提示。
- 阻塞：`npx tsc --noEmit` 非零。仓库现有源码错误包括 `config/index.ts`、`BookPreview.tsx`、`BottomBar.tsx` 未使用声明；其余为 Taro/React Native/Vue/微信类型声明冲突。输出未包含本任务新增文件错误。

## 边界

- 未运行构建，留给根任务统一执行。
- 未修改或提交两个 project 配置，也未提交根任务的 `scripts/test-ui-layout.cjs` 和共享夹具。
- Edge 截图仅作为受控组件/样式证据；微信原生返回、胶囊安全区和设备行为仍需真机验收。

## Review 修复

- RED（结构）：新增三态公共页面外壳断言，首次失败为“必须使用无正文 padding 的公共页面外壳”。
- RED（运行时）：新增胶囊 API 抛错用例，首次失败为未捕获 `API unavailable`。
- GREEN：导航提升到 `.check-in-detail-page` 视口外壳，加载、错误和成功正文统一放入 `.check-in-detail-page__content`；状态正文继续居中，但导航不再继承正文 padding、限宽或居中布局。
- GREEN：胶囊 API 缺失或抛错时传 `undefined` 给 `calculateHomeNavigationMetrics`，使用其既有保守回退尺寸。
- Fresh 验证输出：`test-ui-navigation.cjs`、`test-check-in-return-navigation.cjs`、`test-check-in-detail-runtime.cjs` 均通过；`test-responsive-page-contract.cjs` 输出“响应式页面契约通过”；变更文件 ESLint exit 0（仅 browserslist 过期提示）；兼容 TypeScript 命令 `npx tsc --noEmit --skipLibCheck --noUnusedLocals false --noUnusedParameters false` exit 0。
