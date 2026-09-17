# 大字号教材上下文可读性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 手机大字号下，首页和我的录音仍能读出完整教材/章节名称，特别是区分不同册数所需后缀。

**Architecture:** 解除内容卡片标题的单行省略/固定两行限制，让现有flex卡片自然增高；保持导航栏自己的省略策略，避免因工具里的200%文字压力贸然增加导航高度或挤压微信胶囊。

## Global Constraints

- 不缩小字体，不改文案、配色、图片大小、导航、按钮动作、录音或分享逻辑。
- 不用fixed height盖住增高文字；保留所有44px点击区、安全区和手机/iPad断点。
- 导航标题在极大字下的省略是明确保留的低风险行为，完整教材上下文仍在页面正文；不声明原生微信字体/读屏验收完成。
- 仅任务文件与报告。保留其他任务、IDE配置；中文本地commit，不部署不push。

### Task 1: 卡片文字自适应与可复跑布局断言

**Files:**
- Modify: `src/pages/Home/Home.scss`
- Modify: `src/pages/MyCheckIns/MyCheckIns.scss`
- Modify: `scripts/audit-ui-layout.cjs`
- Test: `scripts/test-bookshelf-polish.cjs`（既有“两行截断”断言必须按新的完整可读要求同步更新，其余契约保留）

- [ ] Step 1: 阅读 .superpowers/sdd/full-audit-extended-layout-report.md 并查看 text-Home-200-390x844.png / text-MyCheckIns-200-390x844.png；从既有scratch audit-extended-layout.cjs参考“一次快照字号/行高再乘倍率”的方法，不能重复放大继承或做全页zoom。
- [ ] Step 2: 在现有audit-ui-layout脚本的场景模型添加可选文字倍率，默认1不变。仅为Home recent和MyCheckIns populated新增390x844/1024x768下150%/200%场景，并在这些场景检查下面四个标题选择器的完整内容没有scrollWidth/scrollHeight截断、卡片按钮完整且无重叠。依照原脚本能力复用fixture、截图、检查器，不新建通用测试框架或增加依赖。先基于当前已构建CSS得到针对这些标题的RED。
- [ ] Step 3: Home .continue-card__title 解除-webkit-box和2行clamp，允许normal换行、overflow-wrap:anywhere；.series-row__title 同样解除nowrap/ellipsis。MyCheckIns .check-in-list-card__section 和__book同样默认换行、允许长词断行。尽量在原定义修改而非末尾堆叠覆盖。既有手机/Pad字体大小保持。删掉只为360px重复的同样文字规则如确实已冗余，其他断点不动。
- [ ] Step 4: 重新weapp构建，再跑新扩展audit-ui-layout保存JSON与截图；新字号场景与既有160场景均通过。主控会在最终整体验证再次运行，不使用旧dist声称新代码通过。
- [ ] Step 5: 自己view_image检查两页200%手机截图及一张正常字号iPad；跑固定Node的 `node_modules/typescript/bin/tsc --noEmit --skipLibCheck`（与本轮基线一致；第三方声明问题另记）、现有Home/MyCheckIns行为/响应式静态回归（用rg确定测试名）。将bookshelf-polish中已观察RED的旧两行clamp断言改为针对该选择器完整规则的正向换行/断词和无clamp限制断言，保留其余契约；不只删除测试。不把纯DOM检查当真实设备系统字体测试。
- [ ] Step 6: 自查并显式暂存四文件与实现报告，提交 `fix: 保留大字号下完整教材与录音标题`，报告RED/GREEN精确命令、截图、边界与commit供复审。
