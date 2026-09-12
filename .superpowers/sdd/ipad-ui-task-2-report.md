# Task 2 五页面布局缺陷修复报告

## 范围

- 仅修改五个页面 SCSS、`scripts/test-ui-layout.cjs` 与受影响的响应式契约。
- 未修改 TSX、导航、录音/云端逻辑、构建配置、QA helper 或截图工具；未运行 build。

## RED

在未修改生产样式时运行：

```text
node scripts/test-ui-layout.cjs
```

退出码为 1。原始 12 类断言按预期失败：6 条未保护 `constant()` padding、Pad 录音封面缺少 `flex-basis: 88PX`、底栏缺少固定行高与防压缩、基础目录面板/滚动区未使用剩余空间、空录音状态嵌套 `100vh`。补充视觉证据后先增加契约再运行，继续按预期失败：底栏缺少 `64PX` 基高、正文缺少 `76PX` 占位、Pad 打卡错误说明缺少 `12PX`/`9PX`、Pad 书库空态缺少 `260PX`/`17PX`/`12PX`。

## GREEN 与改动

- Home：底栏基础高度固定为 `64PX`，安全区在其上累加；项目 `line-height: 16PX`、`flex-shrink: 0`，文字间距 `4PX`；正文底部占位固定为 `76PX` 并同步安全区契约。
- Practice / CheckInDetail / MyCheckIns：基础 bottom padding 恢复为有效纯数值；`constant()` 与 `env()` 分别放入 `@supports`，横屏左右安全区同样保留数值回退与两级兼容。
- MyCheckIns：Pad 教材预览同时固定 `width` 与 `flex-basis` 为 `88PX`；嵌套空态改为父容器剩余区 `min-height: 0; flex: 1`。
- Practice：基础目录 sheet 统一为 `78vh` 有界 flex column；header 不收缩；scroll 使用 `height: auto; min-height: 0; flex: 1`。
- CheckInDetail：Pad 错误说明固定 `font-size: 12PX; margin-top: 9PX`。
- BookLibrary：Pad 空态固定 `min-height: 260PX`，标题/说明分别固定 `17PX`/`12PX`。

最终集中验证（退出码 0）：

```text
node scripts/test-ui-layout.cjs
全页面布局回归通过：压缩后留白、Pad封面、底栏文字、目录和空态契约。

node scripts/test-responsive-page-contract.cjs
响应式页面契约通过：核心配置、布局、触控、教材图与目录规则均符合要求。

node scripts/test-bookshelf-polish.cjs
书架精修契约通过：标签、真实进度、留白、筛选触区和列表分隔均符合要求。

node scripts/test-ui-refinements.cjs
界面收紧测试通过：提示文案、底栏、教材内页和按钮布局符合要求。
```

测试仅出现仓库既有的 `caniuse-lite is 17 months old` 提示，无断言失败。`git diff --check` 通过，仅对用户已有的两个 project config 文件报告 CRLF 提示，本提交不包含它们。

## 剩余设备边界

- CSS 与真实压缩产物契约已就绪，最终 128 场景 Edge bounds 由根任务统一 build 后复核。
- Edge 截图仅验证受控组件/样式；微信原生安全区、平台弹窗和录音硬件仍需真机验收。
