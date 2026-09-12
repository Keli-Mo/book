# 首页跟读卡片标题验收记录

日期：2026-09-12。分支：`codex/home-card-heading`；变更基线：`09efe39`；实现：`51f4500`。

## 本次变更

- 无学习历史：卡片标题为“开始跟读练习”，删除卡片上方独立的“选择教材”。
- 有学习历史：删除卡片上方独立的“继续跟读”，保留真实书名、封面、章节、教材页码和卡片内的“继续跟读”按钮。
- 无历史说明“还没有跟读记录，先去书库选择教材”、按钮“选择教材”与导航行为不变。
- 业务源码仅改 Home.tsx / Home.scss；不修改其他页面 UI、录音、分享、删除或云函数。

## 验证结果

1. TDD：修改测试后先观察到旧独立标题存在导致失败，随后实现并通过。完整任务过程见 `.superpowers/sdd/home-heading-task-1-report.md`。
2. 运行全部 39 个 `scripts/test-*.cjs`，每个脚本均取得通过结果。最终批次为 38 个通过、1 个进程停滞后中止；停滞的 `test-pending-check-in-runtime.cjs` 单独执行退出码 0。此前带超时的批次曾有 `test-home-navigation.cjs` 超时，其单独重跑和最终批次均通过。未将批次中止写成一次性全绿，未因此修改生产逻辑。
3. `npm run build:weapp` 退出码 0。
4. `node node_modules/typescript/bin/tsc --noEmit --skipLibCheck --noUnusedLocals false --noUnusedParameters false`、Home ESLint、审计脚本语法和 `git diff --check` 通过。类型检查沿用既有兼容参数，不代表默认严格检查已消除存量问题。
5. Edge 受控布局：18 个状态 × 8 组窗口 = 144 场景，测量记录完整、144 张截图存在，布局错误 0、缺失教材图片 0。
6. 首页补充滚动验证：双态 × 8 组窗口 = 16 场景，按钮滚动到固定底栏上方后完整可见且中心可命中；列表末行滚动到底后不被底栏挡住。全部通过。
7. 任务级独立代码审查通过；最终全分支独立审查覆盖 `09efe39..92d308d`，并复核本地 144+16 场景测量产物，结论 Ready to merge: Yes，Critical / Important / Minor 均无发现。审查通过不表示已执行合并。

## 页面与窗口覆盖

- Home：有历史、无历史。
- BookLibrary：全部教材、无搜索结果。
- Practice：待录音、录音中、暂停、已保存、保存失败、目录、错误。
- CheckInDetail：本地、播放中、加载、错误。
- MyCheckIns：录音列表、空列表、离线。
- 窗口：320×740、390×844、844×390、768×1024、1024×768、1180×820、375×700、600×400。覆盖小屏手机、手机横屏、Pad 横竖屏及窄分屏，并模拟底部与横屏左右安全区。

检查包括：首页标题/说明/按钮排列和卡片内边界、横向溢出、正文留白、图标尺寸、44px 命中区、底栏标签、安全区、目录面板滚动边界、教材图片和播放时间状态。

人工查看了手机首页双态、320px 长书名、Pad 首页横竖屏、手机横屏滚动前后、600×400 目录、Pad 录音列表、分享播放态和窄分屏教材列表。手机横屏沿用现有 rpx 字号比例，需要纵向滚动；未为本次文案改动扩大范围重设计横屏字体。

## 本地证据与复现

- 标准测量与截图：`.superpowers/sdd/ipad-ui-home-heading/`。
- 补充滚动测量与截图：`.superpowers/sdd/ipad-ui-home-heading-scroll/`。
- 补充本机脚本：`.superpowers/sdd/check-home-scroll.cjs`，复用同一真实组件/WXSS 审计，检查按钮移动到固定底栏上方的可用视口，不将浏览器 `scrollIntoView` 忽略固定底栏的行为当作产品失败。
- 运行标准审计：设置 `NODE_PATH` 为本机已安装 Playwright 所在的 node_modules 后执行 `node scripts/audit-ui-layout.cjs home-heading`；必须先构建最新微信产物。

## 边界与交付

以上是实际组件与构建样式的 Edge 受控验证、脚本与构建检查，不等同微信模拟器或手机/iPad 真机验收。本次未操作用户真实录音、清缓存、上传或删除云端数据。

构建保留既有 Browserslist 数据过期、Taro UI Sass 弃用和包体积提示；未升级依赖。修正了上轮已删除空录音按钮对应的过期测试断言，没有恢复该按钮。

用户改动 `project.config.json`、`project.private.config.json` 保持不动；保留现有隔离工作区，不合并、推送或部署。
