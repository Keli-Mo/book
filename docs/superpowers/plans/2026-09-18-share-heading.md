# 分享页标题微调 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将分享页“完成一次英语跟读”精确改为“完成英语跟读”。

**Architecture:** 只修改共用详情标题文字，使用现有运行时页面测试验证真实 JSX 输出，不改变样式、布局或分享行为。

**Tech Stack:** Taro React TypeScript、Node.js 页面测试。

## Global Constraints

- 标题精确为“完成英语跟读”；不改其他文案、样式或行为。
- 本地优先、主动分享才上传、30天首次提交期限、本地保留不变。
- 不碰 project.config.json、project.private.config.json 或主目录已有修改；不推送、不发布。
- 固定 Node 为 `C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`。

### Task 1: 标题与运行时断言

**Files:**
- Modify: `src/pages/CheckInDetail/CheckInDetail.tsx`
- Test: `scripts/test-check-in-detail-runtime.cjs`

**Interfaces:** 使用既有 `byClass(tree, className)`、`textOf(node)`、本地页面 `createLocalPage`；同一 JSX 标题用于本地和分享详情。

- [ ] Step 1: 在已有状态循环 `let tree = checked.page.render();` 后加入：

```js
assert.equal(textOf(byClass(tree, "check-in-detail__title")), "完成英语跟读", "详情标题使用精简文案");
```

- [ ] Step 2: 用固定 Node 运行 `scripts/test-check-in-detail-runtime.cjs`，确认 RED 是旧标题不匹配而非超时或测试设施错误。
- [ ] Step 3: 仅将源码 JSX 改为：

```tsx
<Text className='check-in-detail__title'>完成英语跟读</Text>
```

- [ ] Step 4: 运行同一脚本与 `scripts/test-audio-playback.cjs`，确认通过；`git diff --check`。
- [ ] Step 5: 显式暂存这两个文件，本地提交 `fix: 精简分享页跟读完成标题`。不暂存计划或其他已有修改。报告 RED/GREEN 命令和结果至 `.superpowers/sdd/2026-09-18-share-heading-report.md`，等待独立复审。
