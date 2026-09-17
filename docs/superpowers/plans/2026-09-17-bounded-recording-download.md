# 录音核验限长读取 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** commit/shareStatus 不再使用先完整读取 Buffer 的 downloadFile；实际读取流按8MiB限制并计算摘要，异常保留可恢复状态。

**Architecture:** SDK为已经过owner/ref校验的fileID签名，Node16内置HTTPS进行一次可中止GET；仅累计长度和SHA1，不拼接/保存整个录音。一个私有helper供两调用复用。平台第二参数context给出总时间预算；软预算留有保守事务余量，但不声称已满足线上最大文件耗时。

## Global Constraints

- 保持8MiB上限、30天首次commit、owner/请求/文件引用预检、幂等、墓碑及未知错误保留本机引用；不能为耗时删减授权检查或减少允许文件大小。
- 签名URL不返回给这两个操作的调用者、不落日志；仅固定错误类别，不记录原始异常/URL/口令/fileID/openid。
- 不改detail公开URL签发、quota、v1、依赖/运行时/权限/费用/清理配置；只改任务文件与报告。
- 真实3秒目前仍需验收；已请用户改20秒，尚未收到答复。代码可本地完成，但上线应先做源码复审及明确记录运行配置/网络格式/最大文件测试缺口。不将mock当真机或云性能证据。
- 中文本地commit，不部署不push，由主控处理上线。保留IDE配置及其他任务。

### Task 1: 流式限长摘要与真实handler接线

**Files:**
- Create: `cloudfunctions/checkIn/recordingDownload.js`
- Modify: `cloudfunctions/checkIn/index.js`
- Create: `scripts/test-bounded-recording-download.cjs`
- Modify: `scripts/test-check-in-function.cjs`
- Modify: `scripts/test-local-share-lifecycle.cjs`
- Modify: `cloudfunctions/README.md`

**Interfaces:** helper导出 `MAX_RECORDING_BYTES = 8 * 1024 * 1024` 与 `readRecordingDigest(cloud, fileID, { deadlineAtMs })`，成功仅 `{ fileSizeBytes, contentSha1 }`；固定内部类别 UNAVAILABLE/LIMIT/TIMEOUT/MISSING 映射为既有外部码，不新增客户端协议。生产仅使用Node16自带https/crypto/url和计时器。

- [ ] Step 1: 读 .superpowers/sdd/full-audit-bounded-download-design.md 中SDK源码证据和测试风险，核对实际已安装wx-server-sdk封装。先更新真实handler测试，禁止调用cloud.downloadFile并断言签名+流读取实际发生，实际大小越界时不激活pending；未改生产前取得行为RED，不能只把新helper文件不存在作为唯一RED。
- [ ] Step 2: 新helper签名调用 `cloud.getTempFileURL({fileList:[{fileID,maxAge:600}]})`。成功必须是对象、顶层errMsg精确getTempFileURL:ok、fileList恰一项且fileID匹配、status数值0、条目errMsg精确ok；任何额外errCode/code/errno若存在也必须数值0。矛盾/缺失/非数值状态不得当成功。URL只能取此SDK响应，接受https、无用户名密码/fragment、默认或443端口，不从event/数据库URL/Location取，不重复编码query。
- [ ] Step 3: 仅签名阶段无矛盾的typed缺失（-503003/STORAGE_FILE_NONEXIST）可归MISSING。多个状态/代码必须一致，成功字段与缺失码、权限与缺失码、失败条目带URL等矛盾一律UNAVAILABLE；不能用错误原文、HTTP404、XML或URL判断缺失。同步throw/异步reject均消毒，不携带cause/stack原文传播。
- [ ] Step 4: HTTPS request固定GET、agent:false、Accept-Encoding:identity，不跟重定向、不解压、不重试。只接受statusCode===200、encoding缺失或identity；头长度可缺失，若有必须合法非负安全整数，冲突重复头失败；头大于MAX即LIMIT并destroy。每个Buffer chunk先检查 `chunk.length > MAX - bytes`，再计数/hash.update；超限块不hash，后续不处理。正常end须res.complete===true，若头存在须实际长度一致，才digest返回；aborted/error/早close/不完整/非Buffer均UNAVAILABLE。
- [ ] Step 5: 单一settled终止门控制resolve/reject、clearTimeout和req/res销毁；先标settled再destroy，所有事件带门禁且迟到response立即销毁。保留安全error监听到close，不能removeAllListeners导致迟发未捕获error。对URL解析、request/end、hash创建/update/digest同步异常同样清理。签名RPC不能真取消，但超时后晚到成功不能启动GET、晚到reject不能unhandled。
- [ ] Step 6: handler入口记录startedAt，第二个可信runtimeContext的time_limit_in_ms为正安全整数时取min(value,20000)，缺失/无效回退已核实3000；客户端event同名字段完全不参与。设reserve=min(1000,floor(limit/4))，读取deadline=startedAt+min(15000,limit-reserve)。这些是明确的保守软策略，不是实测SLA。helper计时包含签名等待，不给每阶段新预算，进入/签名完成/chunk/end都检查绝对deadline。commit读取完成且deadline已过时不得新开激活事务；已发出的DB/SDK RPC不可假称已取消。
- [ ] Step 7: commit保持原预检和已提交幂等早返；调用helper后匹配size/hash才激活。LIMIT/MISSING/完整不匹配→已有RECORDING_FILE_MISMATCH，TIMEOUT→ETIMEDOUT，其他→CHECK_IN_ERROR固定文案。shareStatus在签名之前先验证记录size为1..MAX安全整数、sha1为既有40位hex；无效元数据→SHARE_STATUS_UNAVAILABLE、零签名/GET。只有完整可信内容不符→invalid，签名纯明确缺失→missing；LIMIT/超时/协议异常/权限/404/截断均UNAVAILABLE，保留本机引用和文件。
- [ ] Step 8: 两个集成harness加载真实helper到VM并注入假的https、真实crypto/url与受控计时器；不得stub恒定摘要绕过实际流。修正签名fixture为实际SDK成功包；只允许example.test合成URL映射内存文件，禁止真实网络。删除已无调用的downloadResult控制假用例，迁移为签名矛盾/HTTP协议用例，并保留原状态/owner/后页引用/本机保留/幂等断言含义。
- [ ] Step 9: 聚焦用例包括1字节/恰8MiB/9MiB分块、跨块超限与头超限、无长度/伪长度/截断、完整内容不匹配、元数据不合法、签名各矛盾字段和精准缺失、https与凭据/端口/fragment/redirect/压缩、滴流超deadline、签名永不完成及迟到结果、destroy同步error/迟到end、同步throw、调用重试独立状态。断言实际hash字节不超过MAX、销毁、timer清空、无未捕获错误/敏感日志，不宣称内核/TLS网络缓冲恰好8MiB。
- [ ] Step 10: 运行新helper测试、checkIn协议、local-share-lifecycle、cloud-check-in-service、cloud-error、Node语法检查；更新README解释处理上限/动态预算/未知保留/发布需验收项。依据官方context说明 https://cloud.tencent.com/document/product/583/9694 记录来源；Node24测试不是Node16真运行验收。
- [ ] Step 11: 自查仅任务文件和报告，显式暂存，提交 `fix: 限制云端录音读取大小与等待时间`。报告完整RED/GREEN命令、输出、文件、commit、剩余线上验收缺口，等待独立复审。部署必须主控先上传helper再入口，不并行、不重装依赖。
