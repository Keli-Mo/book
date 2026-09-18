# 标准完整回归入口

使用 `npm run test:regression` 执行所有 `scripts/test-*.cjs` 测试脚本。入口使用 Node 原生测试运行器，逐脚本进程隔离、并发为 1、每项超时 30 秒且不重试。

该命令已在 Node 24.19.0 验证；不声称所有 Node 版本兼容。它不替代原生设备或云端验收，也不能保证本机系统不会再次暂停进程。历史暂停调查记录见 [`2026-09-18-release-blockers.md`](2026-09-18-release-blockers.md)。
