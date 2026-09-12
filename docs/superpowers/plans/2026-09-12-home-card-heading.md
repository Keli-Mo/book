# 首页跟读卡片标题简化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 删除首页两种状态下卡片上方的重复标题，将空历史卡片标题改为“开始跟读练习”，验证手机与 Pad 页面布局。

**Architecture:** 只改变 Home 的展示层和覆盖该展示的测试；保留同一张跟读卡片、阅读进度模型、所有按钮及导航行为。复用真实页面组件、已构建 WXSS 和 Edge 受控布局验证，不操作用户录音或云数据。

**Tech Stack:** Taro / React / TypeScript / SCSS、Node 断言脚本、Playwright + 本机 Edge。

## Global Constraints

- 无历史时卡片标题准确为“开始跟读练习”。
- 两种状态均不显示卡片上方独立的“选择教材”/“继续跟读”标题。
- 卡片按钮保留原文：无历史“选择教材”，有历史“继续跟读”；点击行为不变。
- 无历史说明保留“还没有跟读记录，先去书库选择教材”；有历史保留真实书名、封面、章节和页码。
- 不修改录音、删除、分享、云函数、用户数据或其他页面 UI；保留 project.config.json 与 project.private.config.json 的用户改动。
- 复核手机、Pad 横竖屏与分屏；不得将 Edge 受控检查宣称为微信真机验收。

## Task 1: 简化首页卡片并补齐布局验收

**Files:**
- Modify: `src/pages/Home/Home.tsx`, `src/pages/Home/Home.scss`
- Test: `scripts/test-reading-progress-pages.cjs`, `scripts/test-responsive-page-contract.cjs`, `scripts/test-ui-refinements.cjs`, `scripts/test-ui-layout.cjs`, `scripts/audit-ui-layout.cjs`

**Interfaces:** 保持 `startPractice`、`readReadingProgress`、`useDidShow` 及所有导航 URL 不变；无新接口。

- [x] Step 1: 在已有真实页面测试中先替换旧标题断言，并增加双态断言：

```js
assert.equal(byClass(tree, "library-home__heading"), undefined);
assert.equal(textOf(byClass(tree, "continue-card__title")), "开始跟读练习");
assert.equal(textOf(byClass(tree, "continue-card__progress")), "还没有跟读记录，先去书库选择教材");
assert.equal(textOf(byClass(tree, "continue-card__button")), "选择教材");
// 有历史分支继续断言真实书名、封面、章节、页码与导航，并增加：
assert.equal(byClass(tree, "library-home__heading"), undefined);
assert.equal(textOf(byClass(tree, "continue-card__button")), "继续跟读");
```

- [x] Step 2: 运行 `node scripts/test-reading-progress-pages.cjs`，应因独立标题仍存在而失败，记录输出。
- [x] Step 3: 删除 Home.tsx 的整个 `library-home__heading` Text 节点，并将卡片标题表达式改为：

```tsx
{progressBundle?.book.title || "开始跟读练习"}
```

删除 Home.scss 中 `.library-home` 内的 `&__heading` 与 `.device-layout--pad .library-home__heading` 专属样式，其余卡片/正文 padding 不变，不删除 series-section 的 heading。

- [x] Step 4: 更新响应式测试中标题字号检查目标为 `.continue-card__title`；UI 文案测试明确断言独立标题消失，保留按钮双态契约。
  同步修正 `test-ui-layout.cjs` 中上轮用户已删除录音空态按钮的过期断言：将对 `${selector}__button` 的 44PX min-height 断言改为其样式匹配数量为 0。仅修测试，不恢复按钮或修改 MyCheckIns 源码。
- [x] Step 5: 扩充现有 audit-ui-layout.cjs 的 Home 验证：两种首页状态无旧独立标题；空状态新标题/原说明/原按钮正确；卡片顶部位于导航底部之后，卡片标题、说明与按钮不重叠且不越过卡片内边界，保留横向溢出/安全区/底栏/图片/触区检查。原18状态×8窗口仍保留，不缩减场景。
- [x] Step 6: 运行 `node scripts/test-reading-progress-pages.cjs`、`node scripts/test-responsive-page-contract.cjs`、`node scripts/test-ui-refinements.cjs`、`node scripts/test-home-navigation.cjs`、`node scripts/test-bookshelf-polish.cjs`；应全部通过。
- [x] Step 7: 精确暂存任务文件，提交 `fix: 简化首页跟读卡片标题`，自查并报告 RED/GREEN 和变更文件；不推送。

## Controller validation and handoff

- [x] 任务级独立复核 spec 与 code quality。
- [x] `npm run build:weapp`；已知依赖弃用/包体警告记录，不为消警升级依赖。
- [x] 使用现有 Playwright 的 NODE_PATH 执行 `node scripts/audit-ui-layout.cjs home-heading`，144场景0失败；查看手机/iPad首页双态截图及其他页面代表截图。
- [x] 运行全部 `scripts/test-*.cjs`，类型检查（既有兼容参数）、修改源文件 ESLint、git diff --check。
- [ ] 全分支独立复核，更新验证记录与进度，保留分支和工作树，不合并/推送/部署。
