# 发布准备与云端只读预检

日期：2026-09-16。范围：整理已经验收的本地修复并提交留档，读取当前云端状态；不部署、不推送、不修改云配置、不启用清理、不操作真实录音。

## 结论

本地候选可以提交留档，但尚未达到生产放量条件。当前线上 checkIn 仍是修复前版本；云端权限、索引、用量、清理变量和平台触发器尚未核实，不能将这些项目记为通过。

本次没有新增业务代码。发布分支为 `codex/practice-home-navigation`，整理前 HEAD 为 `c8241bfe0bd827cd4c21b9bcb670c70d339d23f0`，工作树为 `.worktrees/all-books-device-recording`。不要从旧主目录构建或上传。

## 提交范围

- 31 个已跟踪的代码、测试及说明文件，加 7 份既有验收/计划文档，均属于已验收的录音容量、分享安全、删除与失败恢复工作。
- 本报告另随提交留档，共 39 个文件。
- 排除并原样保留 `project.config.json`、`project.private.config.json` 的本机开发者工具设置漂移；未还原、覆盖或暂存它们。
- 旧主目录的录音交互代码、测试及 output/ 不属于本次工作，保持原状。
- 完整 38 项业务/历史文档白名单及排除理由见本地证据 `.superpowers/sdd/2026-09-16-release-scope-report.md`。未发现待纳入文档中的凭证或真实录音文件；这是有界核查，不代表通用秘密审计。

历史文档中的“本轮未提交/未部署”描述的是对应修复阶段。此次只推进本地提交；9 月 13 日曾部署安全态 cleanupExpiredShares，不等于本轮修复已经上线。

## 新鲜验证

| 检查 | 本次结果 |
| --- | --- |
| 第一次全量回归 | 39/40；test-book-assets-remote.cjs 零输出 30,011 ms 超时，证据保留 |
| 超时脚本单独复跑 | 退出 0，约 1.55 秒 |
| 第二次完整回归 | 40/40，零自动重试，退出 0，合计 23,978 ms |
| TypeScript | `tsc --noEmit --skipLibCheck` 退出 0 |
| 已审查候选一致性 | 当前 33 个已跟踪修改的 Git blob 与整体审查快照全部一致；8 个关键源码 SHA256 全部一致 |

使用内置 Node v24.19.0，未修改测试断言或 30 秒超时限制。远端素材诊断测试在这次回归中使用模拟请求，并未扫描生产素材；其超时不能据此归因为云资源故障，根因仍未确定。不要把两次运行合并成“从未失败”。

原始报告分别为 `.superpowers/sdd/2026-09-16-release-preflight-regression.json` 与 `.superpowers/sdd/2026-09-16-release-preflight-regression-confirm.json`。

微信构建、160/160 布局场景和独立整体代码复审沿用同日修复阶段结果，本次没有重跑这三项。当前源码与该候选一致，详见 [修复验证结果](./2026-09-16-release-repairs-results.md)。这些结果不代替微信真机录音、原生文件系统或生产配置验收。

## 云端已核实

通过已登录的微信开发者工具官方 CLI，仅执行登录查询、环境/函数列表、函数信息与下载源码。不调用业务函数，不读取学生音频。

| 项目 | 当前结果 |
| --- | --- |
| 环境 | cloud1-6geu18jg425a604e |
| checkIn | Active；超时 3 秒；Nodejs16.13 |
| cleanupExpiredShares | Active；超时 3 秒；Nodejs16.13 |
| checkIn 代码 | 线上 index.js 与本地修复版本不同；package.json 和 config.json 一致 |
| cleanupExpiredShares 代码 | index.js、package.json、config.json 均与本地一致 |

checkIn/index.js 的 SHA256：

- 线上：`76C9540DF06526F8B31DB1E4FF04CF913E135D2C394BA0B9FD6E5EE6676C08A6`
- 本地：`1EC7687778609725E73A9BD040CFEC8B85F774FE445BA710B75CD6A055C9CA68`

cleanupExpiredShares/index.js 的线上/本地 SHA256 均为 `05E1FFFDE75F3AAC91C708E5C3F7DCDE82B854582CBE8C1C7F9520EADEEA1BFC`。

有效下载证据位于 `.superpowers/sdd/cloud-preflight-separated-20260916-96485fe6dbf3430d8260b57a188948ec/`，两个函数各自使用独立空目录。首次共用下载目录的尝试不作为比对证据。

下载包中的 cleanupExpiredShares/config.json 为 `triggers: []`，但这不能证明云平台当前没有另外配置触发器。函数 Active 也不代表过期清理已经启用、按时执行或验收通过。

## 尚未核实的云端门槛

当前可用官方 CLI 不提供下列信息；本轮 computer-use 所需界面通道不可用，已请用户提供控制台截图。没有用私有接口或凭据提取绕过限制。

1. 存储：当前已用容量、流量、计费周期及权限规则。历史套餐截图中的 3 GB 只能作历史依据，不能据此判断现在剩余空间或是否将超额。
2. 数据库：checkins、shareCleanupState 是否存在，以及各自权限和索引。
3. 清理：平台触发器、SHARE_CLEANUP_ENABLED、SHARE_STORAGE_FILE_ID_PREFIX 的实际配置；不需要提供其他密钥。
4. 真实旧文件：引用冲突和上传归属未做真实数据审计；单一旧引用不能证明上传人，禁止据此直接迁移或清除。
5. 函数预算：两个函数当前都是 3 秒，新增引用查询/录音下载及清理批次须用隔离测试数据测冷启动、最大录音与慢存储，不能仅凭本地通过认定预算足够。

## 下一步顺序

先补齐上述截图与只读证据，形成精确配置差异和变更清单；取得部署/配置变更授权后，再配套发布新版 checkIn 与小程序。发布需考虑旧 create 被拒绝的客户端升级提示，不能以旧主目录作为回滚包。

随后用专用测试账号和测试录音进行双账号分享、弱网重试、删除恢复以及手机/iPad 录音验收。清理开关继续保持不擅自启用：先验可信触发来源、完整录音前缀、全页 dry-run 和隔离数据删除，核对不影响本地录音后，才另行确认是否启用定时清理。

通用日志脱敏、频控、容量/流量告警、兼容数据的回滚候选及教材/隐私业务材料仍沿用 [上线检查报告](./2026-09-16-release-readiness.md) 的后续清单；本次预检没有把这些遗留项视为已完成。
