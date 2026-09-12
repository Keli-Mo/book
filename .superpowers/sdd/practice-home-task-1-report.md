# Task 1 实现报告：教材页顶部首页导航

## 状态

DONE

## 实现

- `CheckInNavigation` 增加可选 `title`，默认仍为“跟读打卡”，既有返回与首页按钮行为不变。
- Practice 页面启用 custom navigation，以 `practice-screen` 在正文 padding/限宽之外包裹公共导航和正常/错误正文。
- 教材页标题为“听力跟读训练”；返回箭头按页面栈 `navigateBack`，孤立入口兜底 `reLaunch` 首页；房子保持原公共组件的首页行为。
- 未修改 `PracticeSession` props、`useDidHide`、`useUnload` 或录音状态机。

## TDD 证据

### RED

- `node scripts/test-ui-navigation.cjs`
  - 失败于 `教材页必须启用 custom navigation`；Practice config 尚无 `navigationStyle: "custom"`。
- `node scripts/test-practice-book-route.cjs`
  - 失败于新增活动录音离页案例读取 `check-in-navigation__home` 的 `props`；教材页尚无导航按钮。

### GREEN

- `node scripts/test-ui-navigation.cjs`：通过。
- `node scripts/test-practice-book-route.cjs`：通过。
- `node scripts/test-responsive-page-contract.cjs`：通过。
- `node scripts/test-check-in-return-navigation.cjs`：通过。
- `node scripts/test-recording-interaction.cjs`：通过。
- `node scripts/test-ui-layout.cjs`：通过（仅有 caniuse-lite 17 个月未更新提示）。
- 新增真实点击覆盖：有栈/无栈返回、正常/错误页导航边界、活动录音、暂停录音、示范音频与录音回听从房子离页；活动和暂停录音均校验 release、terminal sink、保存结果和原教材页上下文。

## 额外校验

- `npx eslint src/pages/CheckInDetail/CheckInNavigation.tsx src/pages/Practice/Practice.tsx`：通过，无输出。
- `git diff --check`：通过；仅提示两个未由本任务修改或暂存的用户 project 配置将来可能发生 CRLF/LF 转换。
- `npx tsc --noEmit --pretty false`：未通过。错误来自既有 `config/index.ts`、BookDetail/Home 未使用变量和大量第三方 Taro/React Native/Vue 类型声明；输出中没有本任务修改文件错误。

## 文件

- `src/pages/CheckInDetail/CheckInNavigation.tsx`
- `src/pages/Practice/Practice.tsx`
- `src/pages/Practice/Practice.config.ts`
- `src/pages/Practice/Practice.scss`
- `scripts/test-ui-navigation.cjs`
- `scripts/test-practice-book-route.cjs`
- `.superpowers/sdd/practice-home-task-1-report.md`

## 自审

- 与 brief 接口、文案、外壳层级、配置和样式逐项核对完成。
- CheckInDetail 默认标题与原按钮接口保持兼容；Practice 只有一个顶层 return，会话 key 与 Hook 顺序不变。
- 测试通过真实组件回调和生命周期验证离页，不使用源字符串代替业务断言。
- 未修改主控负责的审计逻辑、构建产物、两个用户 project 配置；未推送、部署或操作真实录音。

## 风险/限制

- 本机测试为受控 React/Taro 测试壳，不等同微信真机验收；构建与 144 场景浏览器审计由主控执行。
- 仓库全量 TypeScript 检查存在上述既有基线错误。
