# 微信云开发部署说明

当前小程序固定使用云环境 `cloud1-6geu18jg425a604e`。仓库只包含云函数源码，不会直接修改线上云环境。

## 首次部署

1. 用微信开发者工具打开项目，确认 AppID 为 `wxdb6824b2da985a21`。
2. 在“云开发”中选择环境 `cloud1-6geu18jg425a604e`。
3. 在云数据库中新建集合 `checkins`。
4. 为 `checkins` 添加组合索引：`_openid` 升序、`createdAt` 降序，供“我的打卡”按时间读取。
5. 将 `checkins` 的客户端权限设置为“所有用户不可读写”。小程序不直接访问数据库，新增、查询和删除均由 `checkIn` 云函数按 OPENID 鉴权。
6. 在开发者工具左侧找到 `cloudfunctions/checkIn`，右键选择“上传并部署：云端安装依赖”。
7. 在真机上完成“录音 → 回听 → 完成 → 分享”，验证完成仅保存在本机、点击分享才上传，并检查下述新版分享配置。

## 数据内容

`checkins` 每条记录保存：用户 OPENID、教材/训练位置、录音时长、云存储文件 ID、创建时间和单条分享口令。题目、答案以及教材示范音频都不会作为打卡内容提交。

用户删除云打卡时，云函数先使分享失效，再确认删除文件。新协议保留不可复活的墓碑；旧 create 记录仍删除数据库文档。

## 新版 30 天分享（源码已实现，尚未部署）

`prepare` / `commit` 请求携带 `shareVersion: 2`。prepare 在事务中预留 `pending` 记录，保存 `cloudPath`、`payloadDigest` 和 `pendingExpiresAtMs`（服务端当前时间加 24 小时）。首次 commit 验证实际文件后，在事务中激活并写入 `expiresAtMs`（服务端当前时间加 30 天），幂等重试不会续期。返回的 `expiresAtMs` 是毫秒数。预留到期返回 `SHARE_EXPIRED`，客户端必须在用户再次分享时生成新请求编号；已删除请求也不能复活。

listMine复用 `_openid` 升序 / `createdAt` 降序索引，每页100条，持续读取到50条有效记录或真正末页。永久墓碑和pending超过100条不会把旧云历史伪装成空列表。无需增加列表索引，但墓碑非常多时读取成本会上升，须监测函数耗时/额度；数据库失败会返回错误，不用固定扫描上限伪造“没有历史”。

新文件只在 `expiring-shares-v2/` 前缀，旧 `checkins/` 录音及教材不迁移。旧 create 和未携带新版协议的 prepare/commit 沿用原语义，无新协议期限的数据不自动清理。数据库客户端仍必须禁止读写；不要用 TTL 删除预留或墓碑，TTL 不会删除存储文件，还会丢失孤儿定位信息。

## 独立清理函数的上线准备

`cleanupExpiredShares` 默认不删除：仓库 `config.json` 未配置定时器，环境变量 `SHARE_CLEANUP_ENABLED` 未设为精确的 `true` 时只 dry-run。此次未部署、未配置线上触发器、未启用删除，也未变更套餐。

1. 创建 `shareCleanupState` 集合，客户端权限设为所有用户不可读写。正式清理的分页游标保存在 `v2` 文档。为 `checkins` 添加 `shareVersion` 升序、`_id` 升序组合索引；保留已有 owner/时间索引。
2. 从当前环境一次真实上传的 fileID 确认环境和 bucket，配置函数环境变量 `SHARE_STORAGE_FILE_ID_PREFIX=cloud://<当前环境ID>.<真实bucket>/`。不能根据环境名猜 bucket。代码严格校验当前 SDK ENV、完整前缀和每个新版路径；缺失或无效配置会返回 `STORAGE_PREFIX_REQUIRED` 并强制 dry-run，连数据库状态都不修改。即使已提交记录有 fileID，也不绕过此部署核验。
3. 部署时先保持 `SHARE_CLEANUP_ENABLED` 未设置，单独配置平台定时触发器。入口只接受 SDK `getWXContext().SOURCE === "wx_trigger"` 且没有 OPENID；客户端、开发工具、HTTP 和 `wx_client,scf` 调用链均被拒绝。`event.Type`、`event.SOURCE`、`event.enabled` 不能授权删除。须在测试环境实际核验定时来源；若平台返回不同来源，保持停用并调查，不能放开为“没有 OPENID 就允许”。
4. 首轮 dry-run 检查日志中的 `scanned`、`candidates`、`nextCursor` 与 `STORAGE_PREFIX_REQUIRED`。dry-run 不写游标；审核后续页需由可信触发器携带上一页的 `cursor`，或通过测试环境构造多页数据验证正式游标。普通控制台模拟事件被拒绝是预期行为。
5. 在测试环境验证仅新版孤儿和过期文件会删除、未知删除错误留引用、再次运行可恢复，完成私有存储核验后，才由部署负责人显式设置 `SHARE_CLEANUP_ENABLED=true`。事件 `dryRun:true` 可以降级为只读，事件不能开启删除。不要未经核查就在生产启用。

正式执行每次最多扫描 50 条新版记录，用 `_id` 游标跨次推进，扫到末尾回绕；并发执行使用事务版本检查，较慢执行者不覆盖较新游标。每条删除前重新读记录并先标 `deletePending`，只有文件删除成功或 SDK 明确 `-503003` / `STORAGE_FILE_NONEXIST` 后才写 `deleted`。超时、权限、泛化 404 和未知返回保留引用与墓碑，下个完整扫描周期重试；日志 `failed > 0` 需告警排查。单次预算内的扫描速率要结合新版总记录量和函数超时核验，清理时间受完整轮询周期影响，不承诺第 30 天整点物理删除。

客户端直传后未 commit 的文件只留下预留 cloudPath，没有 fileID；可信前缀是定位这些孤儿的必要条件。清理永久保留新版墓碑的路径和原期限并重复扫描，因此删除后才完成的迟到上传也能再次清除。暂停定时器、遗漏配置或存储删除失败时不会保证物理删除。对于任意非协议路径上传，需另行审核存储上传规则/生命周期或存储触发器兜底；本函数不枚举整个 bucket，也不声称覆盖所有任意上传。不要直接对新版前缀设置“上传后 30 天删除”：有效期从 commit 开始，上传到 commit 的间隔可能导致提前删掉有效分享。

## 分享 URL 的实际安全边界

detail/list 按服务端期限拒绝或隐藏过期新版分享；过期 detail 不再请求文件 URL。有效期内 detail 通过 `fileList: [{ fileID, maxAge }]` 请求临时 URL，maxAge 取剩余秒数向下取整且最多 300 秒，不足一秒不再签发。已用锁定依赖实际安装核验 `wx-server-sdk 4.0.2` 包装器会原样传递对象 fileList，底层 Node SDK 会发送 `max_age`；单位依据 [CloudBase 官方存储文档](https://docs.cloudbase.net/api-reference/manager/node/storage) 的秒定义，接口见 [Node SDK 存储](https://docs.cloudbase.net/api-reference/server/node-sdk/storage)。这验证了参数支持，尚未做线上签名有效期实测。

上线必须检查新版录音路径是私有读取：只有 owner 可以按既定规则上传，客户端不能通过已知 fileID 直接获取他人文件，函数才可按口令签发。不能为了私有录音直接把教材公共读取规则一起关闭，需在目标环境验证路径规则和现有教材不冲突。如果存储或 CDN 仍公开返回永久 URL，maxAge 不会把公开文件变私有，30 天只控制应用入口；严格 URL 失效不能宣称已实现。须实测返回 URL 在签名到期后不能从源站/CDN匿名读取，并检查自定义域名和缓存策略。网络签名请求也存在时间误差。

已签出的 URL 在其自身有效期内可能继续工作，删除并不撤回浏览器/CDN缓存或朋友已下载的音频；服务端 30 天失效不删除用户本机录音，也不能撤回他人保存的副本。来源 SDK 实现参见 [微信官方仓库](https://github.com/wechat-miniprogram/wx-server-sdk)，定时来源的目标环境验证属于启用前必做项。

## 上线前控制台设置

- 在小程序隐私保护指引中说明麦克风用途和用户录音的云端存储、分享、删除方式。
- 检查云存储容量与云函数调用额度；当前“我的打卡”最多读取最近 50 条。
- 不要把 `checkins` 集合改成所有用户可读。分享访问由云函数的随机口令控制。
