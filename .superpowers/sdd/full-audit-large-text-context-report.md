# 大字号教材与录音标题修复报告

## 结论

- Home 的继续教材标题与系列标题、MyCheckIns 的章节标题与教材名已取消省略/两行截断，改为自然换行并允许长词断行；手机与 Pad 的原字号、图片尺寸、动作、导航、安全区和断点未改。
- `scripts/audit-ui-layout.cjs` 在原 160 场景上增加 8 个受控文字压力场景：Home recent、MyCheckIns records × 390×844/1024×768 × 150%/200%。文字倍率先统一快照字号与像素行高再放大，不使用页面 zoom，也不重复放大继承值。
- 新场景检查四类标题的 `scrollWidth/clientWidth`、`scrollHeight/clientHeight`，以及卡片按钮是否被视口或裁切祖先真实裁掉、卡片内容/按钮是否重叠。默认倍率仍为 1，原 160 场景检查保持不变。
- 另加 `home-bottom` 聚焦模式：390×844、Home recent、200% 下真实滚到页面末尾，验证末个系列位于固定底栏上方、命中区不小于 44px，并以 `elementFromPoint` 验证中心仍可命中。
- 已同步 `test-bookshelf-polish.cjs` 的旧“两行 clamp”契约：精确提取 `.continue-card__title` 规则，正向要求 `overflow-wrap:anywhere`、`white-space:normal`，反向禁止 WebKit box/clamp；其余书架契约未动。

## 文件

- `src/pages/Home/Home.scss`
- `src/pages/MyCheckIns/MyCheckIns.scss`
- `scripts/audit-ui-layout.cjs`
- `scripts/test-bookshelf-polish.cjs`
- `.superpowers/sdd/full-audit-large-text-context-report.md`

## TDD 证据

### RED：旧构建产物确认标题截断

先只扩展审计脚本，未改 SCSS、未重建 dist。命令：

```powershell
$env:NODE_PATH='C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'; & 'C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' scripts/audit-ui-layout.cjs red
```

退出码 `1`，`scenes: 168`。与本任务直接相关的预期失败：

```text
390 Home recent 150%: 大字号标题被截断:.continue-card__title[0]
390 Home recent 200%: 大字号标题被截断:.continue-card__title[0]
                       大字号标题被截断:.series-row__title[0]
390 MyCheckIns records 150%: 大字号标题被截断:.check-in-list-card__section[0]
390 MyCheckIns records 200%: 大字号标题被截断:.check-in-list-card__section[0]
                              大字号标题被截断:.check-in-list-card__book[0..2]
```

RED 同时暴露两类不是实际裁切的旧检查候选：固定底栏在文字压力下超出其原固定内容区；删除文字超出按钮自身盒子、但按钮 `overflow` 可见且文字仍位于卡片裁切边界内。逐图确认后，大字场景的按钮完整性改为检查视口与 `overflow:hidden/clip` 祖先是否真实裁切；原倍率 1 的底栏/删除按钮检查原样保留。

### RED：旧静态契约与新需求冲突

生产 SCSS 按新需求取消 clamp 后运行：

```powershell
& 'C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' scripts/test-bookshelf-polish.cjs
```

退出码 `1`：

```text
AssertionError [ERR_ASSERTION]: 首页真实书名最多显示两行
```

该失败准确证明旧契约仍要求 `display:-webkit-box` 和 `-webkit-line-clamp:2`。经任务 brief 明确扩围后，将其替换为完整标题的新正向/反向契约，没有仅删除断言。

### GREEN：新 dist 的完整布局审计

构建成功后运行：

```powershell
$env:NODE_PATH='C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'; & 'C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' scripts/audit-ui-layout.cjs green
```

最终退出码 `0`：

```json
{
  "scenes": 168,
  "failed": []
}
```

一次提交前重复运行曾因 768px 视口的前四个场景在 5 秒内未加载远程教材图而退出 `1`，错误仅为 `教材图片未加载成功`；同轮后续图片恢复，没有文字或重叠错误。未修改等待阈值，随后在同一新 dist 上重跑得到上述 168/168 结果。

### GREEN：真实滚到底部的聚焦检查

```powershell
$env:NODE_PATH='C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'; & 'C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' scripts/audit-ui-layout.cjs home-bottom
```

退出码 `0`：

```json
{
  "scenes": 1,
  "failed": []
}
```

测量结果：`scrollY=194`；末个系列 `top=645.52`、`bottom=716.67`、`354×71.16px`；固定底栏 `top=746`；中心 hit-test 命中 `.series-row__title`。因此末项完整停在底栏上方，44px 点击区和可命中性均保留。

## 构建证据与环境异常

固定 Node：`C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`（v24.19.0）。

默认 worker 模式下，以下命令连续两次停在 `Webpack (0%)`，dist 只生成 `project.config.json`，分别在约 6 分钟和约 3 分钟确认不再推进后，核对并只终止各自的 Node/esbuild 子进程；两个 session 均退出 `1`，没有构建错误栈：

```powershell
& 'C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' node_modules/@tarojs/cli/bin/taro build --type weapp
```

诊断边界：

- 两份改动 SCSS 用固定 Node 的 `sass.compile` 均成功（Home 8390 bytes，MyCheckIns 9653 bytes）。
- esbuild 0.21.5 的最小 `transformSync`（84.9ms）与异步 `transform`（48.7ms）均成功，因此不能声称 esbuild 服务完全失效。
- 仅对当前构建进程设置 `ESBUILD_WORKER_THREADS=0` 后，完全相同的 Taro 构建从 0% 正常推进并成功：

```powershell
$env:ESBUILD_WORKER_THREADS='0'; & 'C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' node_modules/@tarojs/cli/bin/taro build --type weapp
```

退出码 `0`：

```text
√ Webpack
  Compiled successfully in 15.30s
```

仅保留既有 Browserslist 过旧、第三方 Sass 弃用和包体积建议警告。该变量没有写入项目配置，新的命令进程不会继承它。证据只能说明“本机本次完整构建路径与 worker 模式相关，进程级禁用 worker 的绕过有效”，不能据单次对照断言 Node 24、esbuild 或某个底层锁存在确定缺陷。

## 其他验证

以下命令均使用固定 Node，退出码均为 `0`：

```powershell
& 'C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' node_modules/typescript/bin/tsc --noEmit --skipLibCheck
& 'C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' scripts/test-home-navigation.cjs
& 'C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' scripts/test-local-recording-pages.cjs
& 'C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' scripts/test-responsive-page-contract.cjs
& 'C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' scripts/test-ui-layout.cjs
& 'C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' scripts/test-bookshelf-polish.cjs
& 'C:\Users\23237\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' scripts/test-reading-progress-pages.cjs
```

关键输出：

```text
首页导航测试通过：胶囊尺寸、阅读进度入口与录音空状态契约正确。
本地录音页面契约测试通过。
响应式页面契约通过：核心配置、布局、触控、教材图与目录规则均符合要求。
全页面布局回归通过：压缩后留白、Pad封面、底栏文字、目录和空态契约。
书架精修契约通过：标签、真实进度、留白、筛选触区和列表分隔均符合要求。
阅读进度页面测试通过：实际 Home/Practice/BookLibrary 路由、重显刷新、取消切页、存储失败及筛选保持。
```

未加 `--skipLibCheck` 的标准 `tsc --noEmit` 退出 `1`，失败均来自既有第三方声明，例如 `@tarojs/components` 缺少 `CommonEventFunction`/`react-native`、Taro runtime 导出不完整、Node 与微信类型重复声明；没有修改第三方包或 `tsconfig`。按本轮基线和更新后的 brief，源码检查使用上面的 `--skipLibCheck` 命令并通过。

## 截图人工检查

- 200% 手机 Home：`.superpowers/sdd/ipad-ui-green/390x844-Home-recent-text-200.png`
- 200% 手机 MyCheckIns：`.superpowers/sdd/ipad-ui-green/390x844-MyCheckIns-records-text-200.png`
- 正常字号 iPad Home：`.superpowers/sdd/ipad-ui-green/1024x768-Home-recent.png`
- 200% 手机 Home 实际滚底视口：`.superpowers/sdd/ipad-ui-home-bottom/390x844-Home-recent-text-200-bottom.png`

四张均已用 `view_image` 打开。200% 手机下标题完整、卡片自然增高、按钮完整且无重叠；正常 iPad 保持既有字体密度和宽屏布局。Home 的 `Foundations` 在极窄 200% 列中按 `overflow-wrap:anywhere` 断开，这是完整内容优先的明确要求，不是截断。

## 边界、自查与关注项

- 这些是 Edge 中使用真实组件输出和新构建 WXSS 的受控 DOM 文字压力检查，不等同微信真机系统字体档位、读屏、动态字体 API 或完整 WCAG 验收。
- 导航栏自己的极大字省略策略未改；没有挤压微信胶囊，也没有加高标题栏。
- 没有缩小字体，没有改文案、配色、图片、导航、动作、录音、分享、依赖、锁文件或部署配置。
- `project.config.json`、`project.private.config.json` 和根工作树的计划/QA 文件是既有 IDE/用户改动，未编辑、未暂存。
- 构建 worker 模式挂起仍是环境关注项；本任务只采用一次进程级绕过生成新 dist，不把候选当成已证实根因，也未固化 workaround。
- 自查确认标题规则在原定义处修改，360px 下重复标题规则已删除，手机/Pad字号、44px 点击区、安全区与断点保留；新增检查只复用既有 fixture、Playwright 与截图目录，没有增加依赖或新通用框架。

## 提交

提交主题：`fix: 保留大字号下完整教材与录音标题`。最终短 SHA 由交接消息提供；报告与实现同提交，避免在提交内容中写入不稳定的自指 SHA。
