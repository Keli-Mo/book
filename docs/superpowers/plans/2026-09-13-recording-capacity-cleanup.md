# 本地录音安全容量与云端清理验收实施计划

> **For agentic workers:** Use subagent-driven-development for the isolated capacity task; execute cloud verification in the controlling session. Preserve the existing dirty worktree and leave changes uncommitted for combined review.

**Goal:** 按容量保护本地录音，并补足云端清理部署证据，不能把本地测试当作线上启用。

**Architecture:** 保留主动分享上传与服务端 30 天期限；本地容量检查在开麦前和保存时分层保护。独立清理函数保持默认只读，先核对目标环境、入口、索引、私有权限与预演，再单独确认真实删除。

**Tech Stack:** Taro 4 / React / TypeScript / 微信文件系统 / wx-server-sdk / Node 测试脚本。

## Global Constraints

- 不提前上传、不自动删除本地录音、不修改录音编码参数或页面布局。
- 保留 100 MiB 本地录音预算，划出 10 MiB 不可用于新录音的安全余量；开麦前额外预留单条上限 8 MiB，不用码率估算保证空间。
- 取消 500 条业务数量拦截；元数据写入失败必须保留恢复信息，不声称手机空闲空间就是小程序可用空间。
- 实际文件统计失败时不把未知当作 0 或容量充足；未知原因不自动删索引或文件。
- 容量检查为只读；录音前异步检查后的页面/会话门闩必须复核，旧录音不能提前丢失。
- 只对新版到期分享清理；教材、旧无期限录音、未到期记录必须保留。
- 云端权限修改、购买、真实删除、公开文件、清缓存均不在本轮自动操作范围；启用删除前向用户展示验收结果并确认。
- 保留已有分享收尾和项目配置修改。不推送、不部署未经核验的删除任务；如无法登录或控制台无数据，记录阻塞，不伪造验收成功。

## Task 1: 本地容量保护

详细要求见 `docs/superpowers/plans/2026-09-13-recording-capacity-task.md`。范围是容量策略、真实用量适配、保存/开麦接线和对应测试。

- [x] RED：边界、超过 500 条仍有空间、统计失败、开麦检查离页、实际大小改变等测试先失败。
- [x] GREEN：最小实现容量检查；不重写录音状态机。
- [x] 验证：仓储、运行时、练习路由、录音恢复测试；保存证据。
- [x] 独立审查：容量与会话安全；修复已移动路径的补索引重试 Important 并复审关闭，无剩余分级问题。

## Task 2: 云端清理只读验收

Files: `cloudfunctions/cleanupExpiredShares/index.js`, `scripts/test-share-expiry-cleanup.cjs`, `cloudfunctions/README.md`, `docs/local-recording-expiring-share-deployment.md`。

- [x] 现有清理基线测试：`node scripts/test-share-expiry-cleanup.cjs`（原 9 组，补齐后 11 组通过）。
- [x] 验证 dry-run 是否与真实删除使用相同路径校验；先补失败测试再修复，使预演能报告不安全候选且无任何写入；独立审查通过。
- [ ] 用现有官方 CLI/控制台只读核对环境、函数部署、环境变量的非敏感配置、定时器、索引和私有读取权限；2026-09-13 11:10 环境已确认，11:45 经用户确认仅新增部署清理函数，回读三文件哈希一致，`checkIn` 源码仍未改变。其余配置与权限仍待核查；不读取或输出分享口令/用户录音正文。
- [x] 用户确认后新增部署默认只读、无触发器的清理函数，核对 Active 状态和回读源码；未设置删除开关或调用清理。
- [ ] 只有可信平台入口才做 dry-run；不放宽身份校验以便控制台手动调用。
- [x] 记录线上证据或明确缺失项。服务端口及函数缺失问题已解决；控制台截图重试仍报不支持此接口。函数已安全部署，完整配置/权限及线上预演仍未验收，未设置 `SHARE_CLEANUP_ENABLED=true`。

## Task 3: 集成验证与交付

- [x] 全部 `scripts/test-*.cjs` 分进程运行，最终完整轮次 40/40 通过；保留中间目录测试超时记录，单项复查和完整重跑均通过，没有修改超时或断言。
- [x] `npm run build:weapp`、修改文件 ESLint、`git diff --check` 通过；TypeScript 仍有 4 条既有未使用变量，关闭这两项 unused 检查后通过。
- [x] 独立综合审查并关闭阻断问题。
- [x] 输出本地完成项、线上未完成项、真实删除启用前需用户操作的精确步骤；详见 `docs/recording-capacity-cleanup-acceptance-2026-09-13.md`，不声称绝对安全。
