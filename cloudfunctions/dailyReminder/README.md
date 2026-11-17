# 每日微信一次性提醒

当前小程序云环境中的云函数支持按用户设置的时间预约微信一次性提醒；新版「我的 → 学习提醒」提供开关、调时和预约状态，设置按当前微信账号保存，小程序启动时读回。新用户默认关闭；旧体验版若没有设置文档，原有 09:00 一次性订阅请求仍可继续处理，用户明确关闭后服务端会取消待发并阻止后续发送。发送对象是授权时使用的微信账号，不会自动发送到另一个家长账号。手机日历每日重复提醒的代码和测试保留，首页暂不显示入口。

开关长期开启只保存用户意愿，不能代替微信的一次性授权。微信不提供剩余次数查询接口；`wx.getSetting` 的模板选择状态不能证明还有额度，发送接口返回的 `43101` 只能说明本次未能发送。孩子每天在小程序中点击练习时可再次申请一条授权；若不再点击，服务器无法自动补充。云函数已于 2026-11-11 更新到小程序共用云环境 `cloud1-6geu18jg425a604e`，开发版 `1.0.20261111.1` 已上传并生成扫码预览。11 月 11 日 16:00 的测试消息已由用户确认收到，点击后正常进入小程序。2026-11-16 曾按用户要求暂停正式通道触发器；2026-11-17 用户确认已重新上传正式通道的每 10 分钟规则，并要求暂停测试触发器。本地配置现保留 `dailyReminderDispatch`，将 `dailyReminderTrial` 的触发器置空；本地配置与云端生效情况须分别核对。新版提醒客户端尚未作为正式版开放。

此前 2026-11-07 的旧流程测试：09 时段的定时调用已验证；用户完成练习并允许订阅后，将唯一待发记录临时改到当天 23:50，云端 `sent:1`，用户确认收到且点开进入体验版首页。测试后触发规则恢复为每日 09 时段。这些记录不代表新版开关与调时已通过真机验收。

## 体验版提醒隔离（2026-11-17）

同一云开发环境中，开发版和体验版只调用 `dailyReminderTrial`。新版客户端在正式版或无法识别版本时隐藏提醒并跳过云调用。测试设置、回执和预约只写入 `dailyReminderTrialDeliveries`，集合权限为 `ADMINONLY`，索引为 `status, dueAtMs`。旧缓存及旧集合中的授权和预约不迁移。测试函数对用户操作和每条待发记录都校验云端 `DAILY_REMINDER_TESTER_HASHES`（逗号分隔的测试账号 OpenID 的 SHA-256 十六进制摘要），拒绝空名单，测试消息固定跳体验版。11 月 17 日晚曾开启试用函数的微信定时触发器 `dailyReminderTrialDispatch`，随后用户要求暂停。本地 `dailyReminderTrial/config.json` 现为 `"triggers": []`；云端对应触发器停用后，测试预约不会定时发送。正式通道 `dailyReminder/config.json` 保留 `dailyReminderDispatch`，北京时间每小时的 00、10、20、30、40、50 分运行，共 144 次/天。开启正式触发器不等于开放正式版客户端入口；客户端仍保持上述测试隔离。正式通道消息的跳转版本取决于原有 `DAILY_REMINDER_MINIPROGRAM_STATE` 环境变量。

`npm run build:weapp` 会将共用实现复制到试用函数目录。只更新试用函数代码时先运行 `node scripts/prepare-reminder-trial.cjs`，再部署 `dailyReminderTrial`。「我的 → 学习提醒」默认收起。点击开启或在开启状态下确认时间时，优先调整已有预约，需要新额度时从该点击直接申请。「继续跟读」、书库中的具体教材和录音详情的「我也来跟读」可预约次日提醒。完成练习时可补上缺少的次日预约，录音保存成功后登记当日完成。关闭开关会取消待发提醒。

11 月 17 日 09:54 的体验版预约于 10:15:57 单独补发，微信返回码为 0，临时补发函数已删除。补发结束时两套每日触发器均为空。腾讯云按函数统计，11 月 12–15 日旧提醒函数每天调用 1,443–1,449 次；全天每分钟扫描即使没有到期预约，每天也会调用 1,440 次。

## 旧通道配置与测试记录

1. 当前小程序 AppID `wxdb6824b2da985a21` 已在微信公众平台「一次性订阅」选用「打卡提醒」模板，专属模板 ID 为 `5bDl7Ao7kzSPmLXCHJZuHyy93dlzUNzZBQz-9TZz1TI`。关键词依次是「打卡日期」`date5`、「打卡内容」`thing6`、「提醒时间」`time23`，场景说明为「每日学习打卡提醒」。该模板在平台归属「办公」类目；一次体验版真机测试已成功下发。
2. `.env.development` 和 `.env.production` 都配置了 `TARO_APP_DAILY_REMINDER_TEMPLATE_ID`。Taro 将此值编进客户端；模板 ID 不是密钥。构建脚本会检查产物里没有未替换的 `process.env`。真机预览和体验版须使用重新构建、上传的版本。
3. 微信云开发环境 `cloud1-6geu18jg425a604e` 已创建集合 `dailyReminderDeliveries`，权限为 `ADMINONLY`（客户端不可读写）；已创建 `status` 升序、`dueAtMs` 升序组合索引。`_id` 为按用户 OPENID 和目标日期计算的摘要。
4. `dailyReminder` 云函数已部署，超时 30 秒，并设置了以下服务端环境变量：
   - `DAILY_REMINDER_TEMPLATE_ID=5bDl7Ao7kzSPmLXCHJZuHyy93dlzUNzZBQz-9TZz1TI`
   - `DAILY_REMINDER_TEMPLATE_FIELDS_JSON={"date5":"{{date}}","thing6":"今日英语练习待打卡","time23":"{{time}}"}`。字段名必须与已选用模板一致；`{{date}}` 为提醒当天的北京时间日期，`{{time}}` 为设定的提醒时间。
   - `DAILY_REMINDER_MINIPROGRAM_STATE=trial` 用于当前体验版测试；正式版才用 `formal`。
5. 2026-11-11 至 2026-11-16 曾使用全天每分钟 `0 * * * * *` 的触发器。11 月 16 日已删除云端 `dailyReminderDispatch`，并将本地 `config.json` 设为 `"triggers": []`。暂停前云函数日志证实 11 月 11 日 15:19–15:25 均按分钟运行，包括 15:23 的 `examined:0`；当时云库唯一 `pending` 的到期日期是 **2026-11-12 15:23**，当天不发送符合预约记录。微信开发者工具 CLI 上传云函数代码不会更新触发器；普通 CloudBase CLI 定时器经实测触发后返回 `FORBIDDEN`，已删除。
6. 真机允许一次性订阅并完成录音练习后，云端响应 `tomorrowScheduled:true`，云库曾有 2026-11-08 09:00 的 `pending`。为当天验收，将这一条记录临时改为 2026-11-07 23:50；23:50:11 云函数日志显示 `examined:1, sent:1, failed:0, unknown:0`，云库状态为 `sent`，用户确认体验版微信收到消息且点开进入首页。这次额度已用于测试，不能再期待同一条记录在 11 月 8 日 09:00 重发。
7. 最新云函数与开发版 `1.0.20261111.1` 已上传，扫码预览已生成，尚未确认设为新的体验版。用户明确授权取消原 **2026-11-12 16:00** 的唯一已授权待发记录，并改约 **2026-11-11 16:00** 作一次发送测试；16:00:01 云函数日志为 `examined:1, sent:1, failed:0, unknown:0`，云库状态 `sent`，微信接口码 `0`。用户确认手机收到，点开正常。另需用新版验证：首页主动开启时按最近未来时间排期，状态显示实际日期；调时后仅首页来源的待发记录可在今天和明天间重排；完成练习后的提醒保持次日；关闭后待发取消。还需检查旧体验版在未创建设置文档时仍按 09:00 工作，及孩子微信授权不会转给家长微信。

## 新版设置语义（测试环境已部署）

- `getSettings` 和 `setSettings` 按当前微信 OPENID 保存开关与北京时间。「我的 → 学习提醒」展示下一条的实际日期和时间。新版提供「今天」或「明天」，设置预约时传入北京时间的绝对日期 `targetDate`。今天已过的时段禁用，确认和登记时再次校验时间。即使今天已完成或已送达，也可以主动再约今天的未来时间。旧版省略 `targetDate` 时继续采用就近排期规则。
- 设置会优先沿用目标日已有的预约，或移动可改期的设置预约。需要新额度时，由开关、选时确认或跟读按钮的点击直接调用 `requestSubscribeMessage`。设置使用 `subscribeNext` 的请求 ID 和云端回执重试登记，重试保留原来选定的日期。同日开始与完成练习共用次日预约。关闭时可先保存日期和时间，再打开开关预约。

## 旧体验版 09:00 流程的兼容语义

- 前端必须在用户主动点击「完成练习」时立即调用 `requestTomorrowSubscription()`；录音完成状态成功落盘后才调用 `recordCompletedTaskAndTomorrowReminder()`。前端先在本机保存待登记请求，云调用失败时下次进入首页自动重试；跨北京时间午夜的昨日请求只在 5 分钟宽限内重试，之后丢弃，避免错排到后天。服务端校验 `completionChinaDate`，按完成日取消待发送记录并安排次日提醒。客户端传入的授权结果仅表示申请意愿，微信平台最终决定是否有发送额度。
- 首页“订阅明日”按钮在点击时直接申请微信一次性订阅，允许后调用独立的 `subscribeTomorrow` 动作，按 `requestChinaDate` 为当前微信账号登记明日 09:00 提醒，不标记今天已完成，也不取消今天待发送的提醒。首页与完成练习的待登记请求分开保存在本机；云调用失败后重进首页会重试。只有云端确认 `tomorrowScheduled:true` 才显示“已订阅”，次日按钮恢复。一次授权只用于一条消息，不能长期自动续订。
- 每个微信 OPENID 和日期只保留一条提醒记录。无新版设置文档的旧体验版仍按 09:00 登记；整十分触发时每轮最多取最早到期的 10 条。旧版已有的非整十分预约保留原日期和时间，在下一个触发点处理。旧版 23:51 至 23:59 的预约由次日午夜首轮处理，00:10 起按过期处理。发送前通过事务把 `pending` 改为 `sending`，并发触发不能重复发送。微信明确拒绝记为 `failed`，接口异常或结果不明记为 `unknown`，发送后记录写入失败则可能停在 `sending`。这些状态都不自动重试，以免误用下一条额度；需监控并人工核查。
- 按每小时 6 轮、每轮最多 10 条计算，当前正式触发器配置每小时最多处理 60 条到期记录。超过上限时可能延后或过期。正式扩大使用范围前须按实际用户量提高吞吐并验证，当前代码不承诺分钟级送达。若用户当日未主动订阅或完成练习并允许订阅，下一条消息额度不能自动补充。旧体验版在没有新版设置文档时按 09:00 登记；手机日历功能暂不在首页提供入口。独立回执文档目前没有保留期清理，正式扩大使用前应制定清理策略。

参考：[微信小程序订阅消息](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/subscribe-message.html)、[订阅授权接口](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/subscribe-message/wx.requestSubscribeMessage.html)、[用户订阅设置接口](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/setting/wx.getSetting.html)、[发送接口](https://developers.weixin.qq.com/miniprogram/dev/server/API/mp-message-management/subscribe-message/api_sendmessage.html)、[腾讯云微信云调用提醒示例](https://docs.cloudbase.net/recipes/add-subscribe-message-cloud-function)、[微信云调用定时触发来源要求](https://docs.cloudbase.net/faq/knowledge/missing-wxcloudapitoken-error)。
