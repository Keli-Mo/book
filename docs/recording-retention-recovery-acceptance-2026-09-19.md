# 旧录音保留与恢复验收记录

## 当前执行边界

用户要求先修复；任何云端或本地测试数据清除前，必须展示具体范围与数量，再取得新的明确确认。本轮不实现测试重置、不启用定时清理、不部署云函数或发布客户端。

现有用户配置修改保持原样：`project.config.json`、`project.private.config.json`、`cloudfunctions/cleanupExpiredShares/config.json`。

## 故障事实

- 用户确认：更新后旧录音从“我的录音”回听失败，新录音可以回听，同一旧录音从原聊天分享卡片可以听到声音。
- 当前列表会优先显示本机记录，分享卡片走云端读取；至少这条云端音频未丢失。
- 注入本机文件错误的页面探针证明旧实现没有云恢复入口且未记录原生播放错误，但该探针不证明实际手机文件丢失原因。
- 原始失效原因仍须在受影响设备采集脱敏错误码、来源类别和文件信息确认。

## 实施前基线

代码基线 `ad93a51`（仅增加设计与计划，未改变生产逻辑）。

固定运行时：`C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`。

执行 `--test --test-concurrency=1 --test-timeout=30000 scripts/test-pending-check-in.cjs scripts/test-pending-check-in-runtime.cjs`：2/2 文件通过，0 失败，耗时 696.848 ms。

此前同一生产代码的音频、详情、真实文件保存与录音库合并四组测试通过；不作为修复后验证结果。

## 分阶段验证

### 索引保留（已完成）

- 提交 `55fe134`，范围为原始索引保留、缺失/访问失败标记及一次性索引快照，不改变录音存储主键。
- RED：新增保留测试首次 7 条中 6 条在旧实现上按预期失败；追加畸形未知 ID 测试捕获异常并修复。
- GREEN：recording-retention、pending-check-in、pending-check-in-runtime、recording-file-roundtrip、local-recording-retry-runtime、recording-library-view 共 15/15 通过；仓储模块 TypeScript 检查通过。
- 独立 spec / quality 审查均通过。备份只用于保留升级前索引，不自动恢复，不能令已删除记录重新出现。
- 仍保留已有的显式删除边界：文件已删除但索引写入失败时，依赖本次会话内的 dirty 重试；本轮没有执行任何实际删除。

### 类型检查基线

在 Task 2 提交 `c549c07` 后执行固定 Node + `node_modules/typescript/bin/tsc --noEmit`：exit 1，120 个诊断均来自共享 `node_modules` 中的 Taro、微信/Node 全局类型、webpack-chain 等声明文件，没有应用源码诊断。未为本任务升级依赖或修改类型配置。

相同代码执行 `node_modules/typescript/bin/tsc --noEmit --skipLibCheck`：exit 0。后续“应用类型检查通过”均明确指这一命令，不冒称包含第三方声明文件的原始命令通过。

### 本人恢复源接口（已完成）

- 提交 `c549c07`，增加 `checkIn` 的 `recoverySource` action 和客户端严格读取接口；只读，不新增云文件，不续期。
- RED：云函数新增两条场景因未知 action 失败，客户端新增一条场景因函数未导出失败；已有测试通过。
- GREEN：check-in-function、cloud-check-in-service、local-share-lifecycle、bounded-recording-download、share-expiry-cleanup 5/5 测试文件通过（内部断言组分别为 55、15、生命周期集成、91、43）。
- 补充审查发现 v2 缺少必需 size/SHA 字段不应降级成旧无指纹记录；修复提交 `e80c720` 同时拒绝无主机的畸形 HTTPS 地址，随后独立 spec / quality 复审通过，无剩余问题。
- 父代理独立执行 `--test --test-concurrency=1 --test-timeout=30000 scripts/test-check-in-function.cjs scripts/test-cloud-check-in-service.cjs`：exit 0，2/2 runner，通过 56 组云函数和 15 组客户端场景，653.7304 ms。
- 未执行线上部署；不能据此声称受影响手机已经恢复。

### 本机诊断与主动恢复（已完成代码实现）

- 提交 `ef06309046153d12bfe1567c8c958a778004e7e9`。正常本机加载/播放零云请求；只有本人在本机回听失败后明确点击“从分享恢复”，才请求精确记录的授权恢复源，不上传、不续期。
- 下载采用原生 `wx.downloadFile`，校验 HTTP 状态、30 秒/来源期限、8 MiB 上限、实际大小和 SHA；保存前后均检查 100 MiB 总预算与 10 MiB 预留。任何失败都不删除旧录音，不自动腾挪或淘汰。
- 恢复进入仓储串行 mutation，并在保存、校验、写索引各阶段核对完整快照身份。删除、替换、换分享或页面生命周期产生的迟到结果不能覆盖新状态；新索引成功前保留旧路径。
- 页面恢复中禁止播放、准备分享和链接核验；重复点击复用同一任务，隐藏/卸载不补启动播放，新页面可采用仍在途的任务。
- 保存后索引写入或指纹读取失败的重试状态仅存在于当前小程序进程：当前会话只读已保存路径，不再次下载或移动；若进程结束，保存文件可能成为无法追踪的孤立文件。持久索引成功后可离线重启读取，但不能据此承诺永久存储。
- 新诊断日志已脱敏，只允许固定阶段、短编号、数值或白名单错误码、大小/指纹一致性和实际可用的平台/版本；不输出完整标识、路径、URL、token、SHA、OPENID、storage 原文或原始 error data。

## 首轮完整代码验证（父代理已执行）

以下证据均在最终代码 `ef06309046153d12bfe1567c8c958a778004e7e9` 上由父代理实际执行；不代表真机验收或线上部署。本任务未重复运行代码套件。

### 全部测试文件

```powershell
$retentionTestFiles = @(rg --files scripts -g 'test-*.cjs' | Sort-Object)
& 'C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' -e 'const {spawnSync}=require("node:child_process"); const files=process.argv.slice(1); let failed=0; for(const file of files){const started=Date.now(); const r=spawnSync(process.execPath,[file],{encoding:"utf8",timeout:30000,maxBuffer:4194304,windowsHide:true}); const ok=r.status===0&&!r.error; if(!ok)failed++; console.log(JSON.stringify({file,status:r.status,ok,ms:Date.now()-started,error:r.error?.message,...(!ok?{stdout:r.stdout,stderr:r.stderr}:{summary:(r.stdout||"").trim().split(/\r?\n/).slice(-2),warnings:(r.stderr||"").trim().slice(0,500)})}));} console.log(JSON.stringify({total:files.length,passed:files.length-failed,failed})); process.exitCode=failed?1:0;' @retentionTestFiles
```

exec session 88042，exit 0；最终 `{"total":43,"passed":43,"failed":0}`。这是 43 个测试文件逐个独立进程运行的结果，不是断言数；每文件上限 30 秒，无跳过。已知输出包括 roundtrip 的预期 4096→4097 模拟大小修正日志，以及 ui-layout 的 caniuse-lite 17 个月前版本提醒。

此前两次聚合 `node --test --test-concurrency=1 --test-timeout=30000` 未全通过：第一次出现旧教材校验子进程停滞和两个缺少新导出的页面 mock，mock 已修复；第二次出现另一旧布局子进程停滞。两次仅在核实 PID、PPID、命令属于该轮后结束停滞进程；两个停滞文件单独执行均 exit 0。聚合 runner 停滞原因未确认，不把两次运行冒称通过，也不记为产品缺陷已解决。

### 应用类型检查

```powershell
& 'C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' node_modules/typescript/bin/tsc --noEmit --skipLibCheck
```

exit 0，空输出，1.987 秒。早期原始 `tsc --noEmit` exit 1 的 120 个诊断全部位于共享 `node_modules` 第三方声明文件；没有声称原始命令通过，也没有升级依赖或修改类型配置。

### 微信构建

```powershell
$env:PATH = 'C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin;' + $env:PATH
& 'C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' node_modules/@tarojs/cli/bin/taro build --type weapp
```

exec session 95778，exit 0。`dist/app.json`、`dist/pages/CheckInDetail/CheckInDetail.js` 时间为 2026-09-19 12:53:36；`dist/common.js` 包含“从分享恢复”和 `RECOVERY_CHANGED`。已有警告：caniuse-lite 陈旧、taro-ui Sass 弃用、webpack 推荐体积阈值（common.js 520 KiB，app-origin.wxss 346 KiB）、NoAsyncChunksWarning；未为本任务升级依赖。

构建前后 `project.config.json`、`project.private.config.json`、`cloudfunctions/cleanupExpiredShares/config.json` 的 SHA256 全部一致；`git diff --check -- src scripts` 无错误。没有清除真实录音或云端数据，没有部署、发布或推送；cleanup 触发器保留用户的空数组。

## 最终总审查补修与重新验证

总审查发现一项完整性缺口：旧记录已有 SHA 时，恢复还应同时比较原来的实测大小，而不能只比较 SHA。提交 `df22c24` 在恢复协调层和仓储入口均补齐校验；无旧 SHA 的 legacy 仍兼容不准确的 onStop 大小。新增两个拒绝测试先以 `Missing expected rejection` 失败；修复后恢复测试 31/31，通过零保存、零索引写入、保留原引用及只清理下载临时文件的断言，另覆盖旧基准相同的成功恢复。

独立最终复审覆盖本轮 `ad93a51..df22c24`：要求符合性通过，无未解决 Critical、Important 或 Minor；这是代码级结论，不代表真机或线上验收。

父代理在最终代码 `df22c24` 上重新执行完整测试：

```powershell
$retentionFinalFiles = @(rg --files scripts -g 'test-*.cjs' | Sort-Object)
& 'C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' -e 'const {spawnSync}=require("node:child_process");const files=process.argv.slice(1);let failed=0;for(const file of files){const start=Date.now();const r=spawnSync(process.execPath,[file],{encoding:"utf8",timeout:30000,maxBuffer:4194304,windowsHide:true});const ok=r.status===0&&!r.error;if(!ok)failed++;console.log(JSON.stringify({file,status:r.status,ok,ms:Date.now()-start,...(!ok?{error:r.error?.message,stdout:r.stdout,stderr:r.stderr}:{warnings:(r.stderr||"").trim().slice(0,500)})}));}console.log(JSON.stringify({total:files.length,passed:files.length-failed,failed}));process.exitCode=failed?1:0;' @retentionFinalFiles
```

exec session 74665，exit 0，`{"total":43,"passed":43,"failed":0}`，无跳过。恢复用例已增至 31 条；测试文件总数仍为 43。roundtrip 模拟大小修正日志与 ui-layout Browserslist 提醒仍存在。

同时重新执行上节完整的 `tsc --noEmit --skipLibCheck` 和 `taro build --type weapp` 命令：均 exit 0，构建 session 53955。构建仍有第三方 Taroify/taro-ui Sass 弃用、Browserslist 数据陈旧、推荐资源体积与 NoAsyncChunks 警告；未更改依赖。再次核对三份用户配置 SHA256 完全一致，`git diff --check ad93a51..df22c24` 无错误。

代码保留在原分支 `codex/practice-home-navigation` 和原工作区，未合并、推送、部署、发布或清除真实录音。下述真机门槛仍需完成。

## 恢复与数据安全边界

- 本机正常回听不调用云端；仅用户明确点击恢复才获取该条记录的云端恢复源。
- 本人身份来自微信云函数的可信上下文，用户不需要填写身份信息。朋友可持原分享口令正常收听，但不能用口令代替本人身份授权恢复。
- 本地管理预算仍为 100 MiB，预留 10 MiB；单个恢复文件最大 8 MiB。保留旧音频意味着恢复可能临时增加空间占用，空间不足时应停止恢复，不自动腾挪或删除旧文件。
- 索引快照不是录音文件备份。未分享录音没有云副本；云副本过期、已删除或归属不能确认时，不得虚报恢复成功。
- 不能保证清除微信数据、换机、系统清理或设备损坏后仍可恢复。普通版本升级的代码路径不应清理录音，但真实原生行为须按下列步骤验收。

## 真机验收顺序（尚未执行）

前置部署顺序：先部署包含 `recoverySource` 的 `checkIn` 并验证权限、精确记录和短期来源，再部署客户端。恢复修复不需要部署或启用 cleanup。恢复链路使用 `wx.downloadFile` 下载已授权的短期 HTTPS URL，需要核对实际返回的云存储主机已满足 `downloadFile` 合法域名要求。当前项目 `urlCheck=true`，不要关闭校验来替代验收。具体配置参见 [腾讯云开发 downloadFile 域名配置指引](https://docs.cloudbase.net/lowcode/practices/miniapp-guide/downloadfile-guide)。只记录/核对域名，不把带签名参数的完整 URL 放入日志或配置。尚未访问真实后台检查此项。

1. 不删除、不清缓存、不覆盖故障录音，在受影响手机安装诊断修复版。
2. 从“我的录音”打开原失败记录，播放一次，记录诊断中的固定阶段、来源类别、错误码和分类。不要导出原始路径、分享口令、URL、用户标识或音频。
3. 若本机失败且有有效本人分享，点击“从分享恢复”；验证不弹额外身份输入、不重新上传、不延长分享期限。
4. 恢复成功后关闭小程序，断网重新进入本人录音列表，播放该录音。
5. 验证新版新录音保存、重启回听、分享、回到教材、播放中离页停止均正常。
6. 在 Android、iOS、Pad 分别验证原生录音和播放；Pad 竖横屏恢复提示及按钮不得遮挡。
7. 使用独立测试样本验证断网、空间不足、分享过期、他人链接、保存失败重试。不得修改真实故障样本的期限或先清空数据。

Android、iOS、Pad 的上述步骤均尚待实际执行，尤其是“旧录音播放诊断 → 本人主动恢复 → 关闭小程序 → 断网重启回听”。没有完成第 2 步的实际设备证据时，不宣称已经查明或修复“升级导致旧本机文件不可读”的根因。自动化通过不替代真机验收，也不能保证永久存储。

## 故障手机诊断判读

使用开发者工具真机调试收集 `[recording]` 分类日志，仅回传固定阶段、关联短编号、错误码、平台/版本以及校验结果；不要另行打印完整 error、录音路径或 storage 原始内容。

| 只读检查结果 | 可以确认什么 | 不能直接断言什么 |
| --- | --- | --- |
| 原生明确返回文件不存在 | 此次检查时原路径没有文件 | 不能仅凭此判断是谁删除、是否由版本更新造成 |
| 可访问，实测大小/指纹与旧基准一致 | 该路径的文件仍在，字节内容与已知基准一致 | 播放失败不等于录音已经丢失；仍需排查原生解码/播放器环境 |
| 可读，但与有效旧指纹不一致 | 内容完整性存在矛盾 | 不可将任意同书、同时长的文件作为替代 |
| 权限、IO 或未知访问错误 | 本次检查无法确认可用性 | 不可当作不存在，更不能删除索引 |
| 旧记录没有指纹 | 无法与历史字节基准比对 | 不能输出“历史内容校验通过”；只能基于精确且授权的云记录恢复并建立新基准 |

请在清除任何测试数据前保留一次故障诊断证据。用户以后即使确认清除，也必须另行展示具体云环境、记录/文件数量、截止范围和本机执行边界；本验收文档不构成删除授权。
