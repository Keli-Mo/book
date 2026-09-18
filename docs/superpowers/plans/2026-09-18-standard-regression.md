# 标准完整回归入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将已单次验证41/41的官方Node测试命令留为可复用项目入口，不用额外维护同步子进程执行器。

**Architecture:** 只增加npm别名，实际执行官方Node逐文件进程隔离模式；不改任何业务测试或断言。旧Windows暂停原因尚未确定，本任务不是声称修复操作系统。

**Tech Stack:** 已安装Node v24.19.0官方测试运行器，无新依赖。

## Global Constraints

- 所有`scripts/test-*.cjs`均执行，进程隔离、并发1、每项30000ms、零重试。不使用skip/todo或延长超时。
- 只改package.json的一个scripts字段和新增短说明，不改依赖/锁文件/系统配置/IDE配置，不推送或部署。
- 保留旧40/41失败和OS暂停证据，不把替换执行路径的一次通过说成暂停根因已消除。
- 同一41项测试的直接命令已有一次完整GREEN：`.superpowers/sdd/2026-09-18-standard-runner.tap`，16362.4932ms。文档说明测试于Node24.19.0验证，不声称所有版本兼容。

### Task 1: 可复用完整回归命令

**Files:**
- Modify: `package.json`
- Create: `docs/qa/regression-command.md`

**Interfaces:** 新npm命令`test:regression`。最终值精确为：

```json
"test:regression": "node --test --test-concurrency=1 --test-timeout=30000 \"scripts/test-*.cjs\""
```

- [ ] Step 1: 用apply_patch新建一次性契约检查`.superpowers/sdd/standard-regression-command-contract.cjs`：

```js
const assert = require('node:assert/strict');
const path = require('node:path');
const pkg = require(path.resolve(__dirname, '../../package.json'));
assert.equal(pkg.scripts['test:regression'], 'node --test --test-concurrency=1 --test-timeout=30000 "scripts/test-*.cjs"');
console.log('标准回归入口契约通过');
```

- [ ] Step 2: 用固定Node执行该检查，确认RED为缺失字段，而非运行错误。
- [ ] Step 3: 仅加入上述package字段。短说明文档写清`npm run test:regression`、Node24.19.0验证、每脚本隔离/30秒/无重试，及旧暂停调查记录链接`2026-09-18-release-blockers.md`；说明非原生设备/云端验收，不能保证本机系统不会再次暂停进程。
- [ ] Step 4: 固定Node执行同一契约GREEN，`git diff --check -- package.json docs/qa/regression-command.md`，核对没有依赖修改。完整相同命令主控已运行，不重复全量求绿。
- [ ] Step 5: 显式暂存两个正式文件，本地提交`test: 增加隔离执行的完整回归入口`；报告至`.superpowers/sdd/2026-09-18-standard-regression-report.md`，附RED/GREEN命令与结果、范围和历史暂停未根治的限制。
