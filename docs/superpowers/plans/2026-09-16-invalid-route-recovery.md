# 失效训练页返回栈修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 无效训练链接的“选择教材”替换错误页，不将错误页保留在正常学习路径的返回栈中。

**Architecture:** 仅更改错误态 Button 的 navigateTo 为 redirectTo，正常目录/教材跳转与返回按钮完全不变。

## Global Constraints

- 不改文案、布局、数据模型、合法路由、录音或分享。
- 仅两个任务文件和实现报告。中文本地提交，不部署、不push；保留IDE及其他任务。

### Task 1: 用重定向替换错误页

**Files:**
- Modify: `src/pages/Practice/Practice.tsx`
- Test: `scripts/test-practice-book-route.cjs`

- [ ] Step 1: 既有 invalidRoutes 循环中，在点击错误态“选择教材”按钮后补 `assert.equal(page.navigationMethods.at(-1), 'redirectTo', '恢复应替换无效页，不能把错误页留在返回栈')`。先确认 harness navigationMethods 的实际形状；若为对象应读对应 method，而非为测试改生产。针对 broken bundle 也点击并断言同一行为。
- [ ] Step 2: 使用内置Node运行 scripts/test-practice-book-route.cjs，取得实际 navigateTo 与期望 redirectTo 不同的 RED。
- [ ] Step 3: 仅修改 Practice 路由未验证通过时按钮的调用：`Taro.redirectTo({ url: '/pages/BookLibrary/BookLibrary' })`。
- [ ] Step 4: 跑 test-practice-book-route、test-practice-recording-wiring、test-audio-playback、tsc --noEmit --skipLibCheck；确认正常首页/返回/目录路径没有改动。
- [ ] Step 5: 显式暂存任务文件与实现报告，提交 `fix: 恢复教材时移除失效训练页`；报告RED/GREEN命令与结果、变更、自查和commit，等待复审。
