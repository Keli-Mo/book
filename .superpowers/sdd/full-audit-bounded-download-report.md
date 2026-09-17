# 云端录音有界读取实现报告

2026-09-17；工作树 `E:/REPOSITORY/haisha/haisha/.worktrees/all-books-device-recording`；任务基线 `5dc574f`。

状态：DONE（本地实现与指定验证完成，待独立复审；没有部署、push、真实网络请求或真实录音操作）。

实现提交：`9edf0c5` — `fix: 限制云端录音读取大小与等待时间`。本报告随后以单独文档提交记录该实现 SHA，避免自引用提交哈希。

## 实现摘要

- 新 `recordingDownload.js` 仅使用 Node 内置 https/crypto/url 与计时器，导出指定 8MiB 常量及 `readRecordingDigest(cloud,fileID,{deadlineAtMs})`。成功仅返回实际大小与 SHA-1，不拼接整文件。
- 严格签名 envelope/单条 fileID/status/errMsg/全部额外代码校验；typed 缺失仅来自无矛盾 SDK 签名失败，拒绝成功/权限/缺失冲突及失败携带 URL。仅 HTTPS、无凭据/fragment、默认或443端口；保留原签名 query。
- 独立连接 GET，identity、无重试/重定向/解压；严格200、长度/重复头/完整性校验。实际 chunk 先做 `chunk.length > MAX - bytes`，再计数与更新摘要，越界及迟到块不入 hash。
- 单一 settled 出口先置终止状态再清 timer/destroy。签名迟到成功不 GET，迟到拒绝被观察；保留 request/response error 监听，覆盖 destroy 同步 error、迟到 error/end/response；同步 URL/request/end/hash 异常均消毒为固定类别，无 cause/原文透传。
- handler 入口绝对预算仅信第二参数的正安全整数 `time_limit_in_ms`：`limit=min(value,20000)`，否则3000；`reserve=min(1000,floor(limit/4))`；截止 `startedAt+min(15000,limit-reserve)`。event 同名字段无效。读取结束后过期不激活，激活事务冲突重试前也检查预算；已有幂等早返不重读。
- commit 使用既有 RECORDING_FILE_MISMATCH/ETIMEDOUT/CHECK_IN_ERROR。shareStatus 签名前验证合法大小/hash，只有纯 typed 缺失或完整可信内容不匹配才 missing/invalid；404、权限、超限、截断、协议异常、超时均保留引用/文件并返回 SHARE_STATUS_UNAVAILABLE。
- 两个集成 harness 均加载真实 helper，复用新测试脚本中的假 HTTPS/真实 crypto/url/可控时钟；只解析 example.test 映射到内存文件。旧 downloadFile 禁止调用，删除无人使用的 downloadResult/downloadError 控制，迁移为真实签名和 HTTP 异常。

## 来源与边界

已完整读任务 brief/design、implementer-prompt、TDD 与 testing-anti-patterns。按设计定点读取实际云端下载依赖内 `wx-server-sdk/index.js` 的718附近签名包装和2818附近公共成功包；确认成功为 `getTempFileURL:ok`、条目数值0与 `ok`，与主控已核对的 wx-server-sdk4.0.2/CloudBase3.17.2 一致，没有依赖安装或修改。

README 已记录官方 runtime context 来源 `https://cloud.tencent.com/document/product/583/9694`（任务提供的来源，本轮按禁止真实网络请求约束未重新联网读取）。主控告知今日线上 timeout 仍3秒；代码数字严格按最终 brief 的保守策略实现，优先于早期设计中尚待确定的数值，不宣称已实测 SLA。

## TDD RED 证据

所有命令工作目录为上述工作树，固定 Node 路径如下。首次 RED 在任何生产修改之前，只给既有真实 handler harness 增加禁用 downloadFile 的成功提交断言，helper 尚未创建且该用例没有 require helper，因此不是缺文件造成的 RED。

```powershell
& 'C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' scripts/test-check-in-function.cjs
```

退出码1，相关实际输出：

```text
FAIL commit 必须签名并通过流读取，禁止整文件 SDK 下载: 真实 handler 应在禁用 downloadFile 后仍完成流校验
false !== true
1/39 项云函数契约失败
```

随后先写有界 helper 用例及迁移真实 handler 测试，再实现 helper；handler 仍未改时运行同命令，28/42失败，包含实际9MiB期望 RECORDING_FILE_MISMATCH 但得到 CHECK_IN_ERROR、绝对预算期望 ETIMEDOUT 但得到 CHECK_IN_ERROR。接入生产后剩3/42为原签名累计计数与模拟时钟的断言适配；改为操作前后计数及共享虚拟时钟，保留原“不新增签名、首次提交起30天”含义后42/42通过。

自查新增“激活事务冲突消耗剩余预算后，不再发起新事务”，先运行同命令取得独立行为 RED（此时其他42组通过）：

```text
FAIL 激活事务冲突消耗剩余预算后，不再发起新事务: Expected values to be strictly equal:
+ undefined
- 'ETIMEDOUT'
1/43 项云函数契约失败
```

随后只为 commit 的 runTransaction 调用传入 deadline，每次尝试发出 DB RPC 前检查，43/43 GREEN。之后新增1字节/恰8MiB真实handler提交、shareStatus与幂等不重读覆盖，最终44组。

## 最终 GREEN 精确命令与输出

以下五个独立测试进程并行启动，各自退出码均0；不是多个 shell 命令最后一项掩盖失败。运行时 `node --version` 实际输出 `v24.19.0`。

```powershell
& 'C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' scripts/test-bounded-recording-download.cjs
& 'C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' scripts/test-check-in-function.cjs
& 'C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' scripts/test-local-share-lifecycle.cjs
& 'C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' scripts/test-cloud-check-in-service.cjs
& 'C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' scripts/test-cloud-error.cjs
```

对应实际汇总输出（逐用例均为PASS，无运行警告）：

```text
87/87 bounded recording tests passed (fake HTTPS/clock; no real network)
云函数协议测试通过：44 组，含乐观冲突、文件校验和墓碑。
本地分享集成通过：完成零联网、重启恢复、好友口令鉴权、30天过期重传、丢回包/本地回写失败幂等恢复、旧协议拦截、脱敏日志接线、本地不删除。
客户端打卡服务测试通过：14 组。
云开发错误提示测试通过：错误对象、字符串及任意错误码均使用固定安全分类。
```

语法/空白检查命令，退出码0，无输出：

```powershell
$nodePath = 'C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'; foreach ($scriptPath in @('cloudfunctions/checkIn/recordingDownload.js', 'cloudfunctions/checkIn/index.js', 'scripts/test-bounded-recording-download.cjs', 'scripts/test-check-in-function.cjs', 'scripts/test-local-share-lifecycle.cjs')) { & $nodePath --check $scriptPath; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }; git diff --check -- cloudfunctions/README.md cloudfunctions/checkIn/index.js scripts/test-check-in-function.cjs scripts/test-local-share-lifecycle.cjs
```

已显式暂存六个任务文件并运行 `git diff --cached --name-only` 确认范围，`git diff --cached --check` 无输出；提交成功。全树 diff 曾报告用户 IDE 配置 CRLF 提示，属于原 dirty，不是上述测试警告，未暂存或修改它们。

## 文件与自查

实现提交仅六个文件：

1. `cloudfunctions/checkIn/recordingDownload.js`（新增）
2. `cloudfunctions/checkIn/index.js`
3. `scripts/test-bounded-recording-download.cjs`（新增；也导出两个集成使用的内存HTTPS加载器）
4. `scripts/test-check-in-function.cjs`
5. `scripts/test-local-share-lifecycle.cjs`
6. `cloudfunctions/README.md`

本报告是第七个允许文件。没有改 cleanupExpiredShares、依赖/锁文件、运行时/权限/费用/配额、detail 签名逻辑或30天期限。原 IDE 配置和计划/QA dirty 均保留。

自查发现并修正：初始迟到 response 测试可能在请求创建前就超时，现改为明确断言已创建一个请求、尚无response，超时后手动发response并确认销毁及安全error监听；避免空循环造成虚假覆盖。新增 request/response error 上伪造缺失 code 仍 UNAVAILABLE。激活事务冲突后预算耗尽的边界按上述独立 RED/GREEN 补齐。没有已知未修复的本地正确性问题。

## 线上未验收项（不能作为本地 DONE 已完成项）

- Node24 的本地行为/语法检查不是 Nodejs16.13 真运行验收。
- 真实 SDK URL 是否全部无需跳转、使用默认HTTPS端口且提供identity原字节，真实响应头格式、网络协议与TLS时序尚未验证。
- 最大8MiB、正常文件、commit/shareStatus 冷暖启动总耗时与最终事务余量，当前3秒下能否完成尚未测量；20秒平台配置问题由主控与用户处理。
- 8MiB是应用进入摘要的累计字节上限，不代表内核/TLS/网络总接收恰好8MiB。
- SDK签名超时后不可真正取消其RPC，已发DB事务不能声称撤销；软deadline不等于平台硬超时。
- 主控需独立复审，按helper上传→确认回读→入口上传的顺序部署，不能并行或重装依赖；新增文件增量能力、源码摘要和平台状态需实际确认。主控已保存部署前快照，当前云端没有本helper，本代理未操作线上。
