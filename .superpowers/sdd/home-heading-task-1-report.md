# 首页卡片标题精简任务报告

## 更改

- 删除首页卡片上方的 `library-home__heading` 节点及其手机/Pad 专属样式，保留正文与卡片原有 padding。
- 空历史卡片标题改为“开始跟读练习”；有历史仍显示真实书名，说明、封面、章节、页码、按钮和导航行为保持不变。
- 阅读进度测试覆盖首页空态/历史态标题、说明、按钮、封面、章节页码和导航。
- 响应式标题检查改为 `.continue-card__title`；UI 文案测试明确禁止旧独立标题并保留按钮双态契约。
- 布局审计覆盖首页两种状态的旧标题消失、空态准确文案、导航与卡片顺序，以及卡片标题/说明/按钮的重叠和内边界检查；18 状态与 8 窗口矩阵未缩减。
- 修正 `test-ui-layout.cjs` 中已删除 MyCheckIns 空态 CTA 的过期样式断言，未修改 MyCheckIns 源码。

## RED

命令：`node scripts/test-reading-progress-pages.cjs`

结果：按预期失败，首个空态断言期望 `library-home__heading` 不存在，实际仍得到内容为“选择教材”的 `Text` 节点；堆栈定位 `scripts/test-reading-progress-pages.cjs:35`。

## GREEN 与自审

以下命令均退出码 0：

- `node scripts/test-reading-progress-pages.cjs`
- `node scripts/test-responsive-page-contract.cjs`
- `node scripts/test-ui-refinements.cjs`
- `node scripts/test-ui-layout.cjs`
- `node scripts/test-home-navigation.cjs`
- `node scripts/test-bookshelf-polish.cjs`
- `node --check scripts/audit-ui-layout.cjs`
- `npx eslint src/pages/Home/Home.tsx`
- `git diff --check`

`test-ui-layout.cjs` 输出既有 Browserslist/caniuse-lite 数据过期提示，但测试通过；按任务要求未升级依赖。

## 疑虑与交接

- 按分工未运行 `npm run build:weapp`、完整 144 场景 Edge 布局审计或视觉截图；由主代理在提交后执行。
- `project.config.json`、`project.private.config.json` 以及主代理维护的 plan 改动均未暂存或修改。
- Edge 布局审计是受控组件/样式验证，不等同微信真机验收。
