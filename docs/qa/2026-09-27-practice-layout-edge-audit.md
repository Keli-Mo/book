# 跟读布局改动：追加边界测试

日期：2026-09-27。分支：`codex/stable-practice-layout`，对照提交：`a931613`。

初次排查只测试和记录。随后用户授权修复，以下发现保留为修复前证据，处理结果见文末；未提交或推送。

## 发现

### 1. 目录打开时，背景教材页仍可滚动（浏览器模拟已复现）

- 两个页面开放纵向滚动后，目录仍只有固定遮罩和点击关闭事件，没有阻止背景滚动。
- 320×568 打开目录，在遮罩上滚动：背景 `scrollY` 从 0 到 100；触摸仿真上滑从 0 到 49。
- 目录内部已滚至末尾（2968/2968）后继续滚动，背景从 0 到 100。640×360 也复现。
- 相同组件只换回 HEAD 原样式，对照操作均保持背景 `scrollY=0`；HEAD 页面配置也为 `disableScroll:true`。
- 影响：关闭目录后，教材可能不在打开目录前的位置。
- 位置：`src/pages/Practice/PracticeDirectory.tsx:31`、两个阅读页配置第 6 行，以及 `Practice.scss:379`。
- 结论限于 Chrome DOM 和触摸仿真，微信真机触摸仍需核验。

### 2. 测宽回调乱序时可能保留过期宽度（条件性风险）

- 人为保留旧测量回调，完成窗口变宽与新测量后，再投递旧回调。
- 当前代码图框从 `360×540` 到 `640×960`，收到旧回调后退回 `360×540` 并持续保留。
- HEAD 对照会再次测量并恢复；当前测宽没有代次校验，也不再因图框尺寸变化触发重测。
- 位置：`src/pages/Practice/PracticeSession.tsx:235–243`。
- 尚无证据证明微信原生测量接口在实际使用中会乱序返回；不得作为已确认的真机故障。

### 3. 原有 TypeScript 配置类型错误

- `npx tsc --noEmit --skipLibCheck` 退出码 2，只报告 `src/app.config.ts:5` 的 `componentPlaceholder` 不属于 `AppConfig`（TS2353）。
- 该行来自 2026-09-20 的 `e5211a9d`，本次没有改动该文件。
- 这是类型检查问题，不能据此断言当前小程序运行失败；上一轮小程序构建已通过。

## 已通过的测试

- 完整回归：112/112。
- 图片状态专项：14/14。覆盖普通和 Think 的异步尺寸、加载失败后恢复、不同宽高比切页、旧图回调迟到、窗口变化、无效尺寸及热点边界。
- 录音边界专项：16/16。覆盖权限/隐私拒绝、旧录音恢复、处理中按钮状态、保存失败重试、重复完成、取消切页与回听中切页。
- 11 组浏览器边界场景中，录音前后图框稳定、操作并排、底部可达及 44px 重录点击区检查通过。人为构造的超长无空格英文在 375 宽度下会横向溢出，属于已有断词限制，未作为新增实际缺陷。
- 普通与 Think 均通过 `1180→960→959→768→320→1180` 动态宽度检查；320 手机和 960 Pad 的 200% 文字仿真未见录音标题、重录按钮重叠。
- 差异格式检查通过。

## 可复查证据

以下仅为本机临时测试产物，不是小程序发布文件：

- `%TEMP%/codex-practice-layout-edge-qa/touch-resize-results.json`
- `%TEMP%/codex-practice-layout-edge-qa/oldcss-results.json`
- `%TEMP%/codex-practice-image-edge-audit.cjs`
- `%TEMP%/codex-practice-image-query-race.cjs`（加 `--baseline` 对照 HEAD）
- `%TEMP%/codex-practice-recorder-edge-qa/recorder-ui-edge.cjs`

测试使用真实页面代码，模拟 Taro、录音及存储接口；浏览器使用离线图片并只呈现当前 Swiper 项。未验证微信原生手势、真实麦克风和设备安全区。

## 用户授权后的修复与复验

- 目录：共享页面用 `PageMeta.pageStyle` 在目录打开时设置 `overflow: hidden;`，关闭时清空；目录遮罩增加 `catchMove`，两条路由开启 `enablePageMeta`。保留内部原生 `ScrollView.scrollY`。`catchMove` 的用途参考 [Taro 官方滚动穿透说明](https://docs.taro.zone/docs/react-overall#阻止滚动穿透)。
- 测宽：每次查询使用递增序号，仅接收最新测量结果，并忽略页面卸载后的回调。未恢复按剩余高度缩放或反复测量。
- 类型：`app.config.ts` 以局部窄类型和 `satisfies` 检查原对象。Taro 实际配置读取结果与 HEAD 的 JSON 完全相同；保留历史兼容项，不声称微信官方支持将该字段放在全局配置。
- 6 个新增修复回归先失败后通过：普通/Think 的旧测宽回调、卸载后回调、目录开启/关闭/选择练习。
- 最终完整回归 **118/118**，`tsc --noEmit --skipLibCheck`、`npm run build:weapp` 和两个页面注册检查均通过。录音边界专项再次 **16/16** 通过。
- 构建产物确认两页 WXML 均在主模板前输出 `page-meta` 与 `page-style` 绑定；公共模板包含原生 `catchtouchmove`。
- 修复后的浏览器目录专项 **12/12** 通过：320 样本打开前背景位置 70，遮罩滚轮/触摸、目录内部滚轮/触摸、触底和关闭全程仍为 70；目录自身从 0 滚至 2968，关闭后背景可继续滚至 170。图片尺寸及同排按钮检查仍通过。
- 浏览器只将真实 `PageMeta.pageStyle` 映射到页面样式，没有额外拦截事件伪造结果。微信原生 `ScrollView` 和 `catchMove` 组合仍需真机验收。

追加证据：`%TEMP%/codex-practice-directory-fix-qa/results.json`，以及 `%TEMP%/codex-app-config-type-qa/verify-app-config.cjs`。
