# 教材页首页导航 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 教材页顶部加入与回听页一致的纯房子图标，直接返回首页并验证录音离页安全。

**Architecture:** 参数化现有 CheckInNavigation 的标题；在 Practice 路由容器加入全宽导航外壳，不改 PracticeSession 的录音状态机；沿用已实现的 hide/unload 收尾。

**Tech Stack:** Taro / React / TypeScript / SCSS，现有 Node 组件运行测试与 Edge WXSS 审计。

## Global Constraints

- 教材页正常与错误状态均显示“返回箭头＋房子图标”；房子无底色、无阴影，正文不变。
- 教材导航标题为“听力跟读训练”，回听页默认标题仍为“跟读打卡”。
- 房子直接回 `/pages/Home/Home`；返回箭头有上一页时保留页面栈，无上一页时回首页。
- 保持 44px 命中区、状态栏/胶囊/横屏安全区；导航全宽，位于正文限宽和内边距之外。
- 不改录音、保存、分享、删除业务逻辑；实际点击离页测试必须覆盖活动录音、暂停录音与播放，不能只断言源代码字符串。
- 不修改 project.config.json / project.private.config.json，不操作用户真实录音、不清缓存、不上传、不推送或部署。
- 手机、Pad 横竖屏受控测量与截图验证不能宣称为微信真机验收。

## Task 1: 复用导航并覆盖教材离页行为

**Files:**
- Modify: `src/pages/CheckInDetail/CheckInNavigation.tsx`
- Modify: `src/pages/Practice/Practice.tsx`, `src/pages/Practice/Practice.config.ts`, `src/pages/Practice/Practice.scss`
- Test: `scripts/test-ui-navigation.cjs`, `scripts/test-practice-book-route.cjs`

**Interfaces:** CheckInNavigation 增加 `title?: string`，默认“跟读打卡”；原 onBack 与首页按钮接口/行为不变。PracticeSession props、useUnload 和 useDidHide 均不改变。

- [x] Step 1: 增加 RED 测试。复用 createUiPage / createPage、byClass 和 textOf，先断言教材页 config 为 custom；正常与错误页都有导航，位于 `practice-screen` 而不在 `.practice-page` / `.practice-empty` 内；标题正确、图标无文本。示例断言：

```js
const app = page('Practice', {params: {bookId:'3', practice:'0'}, pageStack:[{route:'pages/Home/Home'},{route:'pages/Practice/Practice'}]});
const tree = app.render();
const controls = navigation(tree);
assert.equal(textOf(byClass(tree,'check-in-navigation__title')), '听力跟读训练');
await controls.back.props.onClick();
assert.equal(app.navigationMethods.at(-1),'navigateBack');
await controls.home.props.onClick();
assert.equal(app.navigationMethods.at(-1),'reLaunch');
assert.equal(app.navigations.at(-1),'/pages/Home/Home');
```

另用 pageStack 空数组测试返回兜底，用无效 bookId 验证错误页。保留所有 CheckInDetail 测试。活动录音和暂停录音场景实际点击新增房子，再触发 hide/unload 和 Stop 回调，断言 recorderReleaseCalls/terminalSink/savedRecordings/原教材页信息；示范与回听播放离页断言停止。复用已有 `scripts/test-practice-book-route.cjs` 的 leavingPage 和音频案例，不另建复杂假录音机。

- [x] Step 2: 运行 `node scripts/test-ui-navigation.cjs`，应因教材页尚无 custom config/导航而失败；记录原因。运行扩充的教材离页案例观察缺失按钮失败。
- [x] Step 3: 最小实现。为 CheckInNavigation 添加可选 title 与默认值：

```tsx
type CheckInNavigationProps = { onBack: () => void; title?: string };
export default function CheckInNavigation({onBack, title = "跟读打卡"}: CheckInNavigationProps) {
  // 既有尺寸、按钮、图标与导航行为保持不变，标题节点内容改用 title。
}
```

Practice 导入 `../CheckInDetail/CheckInNavigation`，顶层路由组件定义：

```tsx
const goBack = () => {
  const pages = Taro.getCurrentPages?.() ?? [];
  return pages.length > 1
    ? Taro.navigateBack({ delta: 1 })
    : Taro.reLaunch({ url: "/pages/Home/Home" });
};
```

顶层只保留一次 return，用下面的外壳包住原错误节点与原 PracticeSession；原 Hook 顺序和会话 key 不变：

```tsx
<View className={`practice-screen ${layoutClassName}`}>
  <CheckInNavigation title='听力跟读训练' onBack={goBack} />
  {route.bundle ? <PracticeSession key={`${route.bundle.book.id}:${route.practiceIndex}`} bundle={route.bundle} initialPracticeIndex={route.practiceIndex} initialPractice={route.practice} layout={layout} layoutClassName={layoutClassName} /> : (
    <View className={`practice-empty device-layout__content ${layoutClassName}`}>
      <Text>暂时无法打开训练</Text>
      <Text>{route.errorMessage}</Text>
      <Button className='practice-empty__button device-touch-target' onClick={() => Taro.navigateTo({url:'/pages/BookLibrary/BookLibrary'})}>选择教材</Button>
    </View>
  )}
</View>
```

配置增加 `navigationStyle: "custom"`，样式增加：

```scss
.practice-screen {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background: #f4f7f5;
  > .practice-page,
  > .practice-empty { flex: 1; min-height: 0; width: 100%; }
}
```

不得删除正文原有 padding 或把导航放入正文；不得重写录音状态机。若新增测试暴露业务层缺陷，先报告具体证据。

- [x] Step 4: 运行 `node scripts/test-ui-navigation.cjs`、`node scripts/test-practice-book-route.cjs`、`node scripts/test-responsive-page-contract.cjs`、`node scripts/test-check-in-return-navigation.cjs`、`node scripts/test-recording-interaction.cjs`、`node scripts/test-ui-layout.cjs`；全部应通过。若既有测试硬编码旧页面根节点，定向更新为实际新版外壳契约，不弱化录音断言。
- [x] Step 5: 精确暂存授权文件、`git diff --check`，提交 `feat: 教材页增加返回首页导航`；写报告记录 RED/GREEN、风险和文件，不推送。构建与 Edge 审计由主代理完成。

## Controller verification

- [x] 独立任务审查通过。
- [x] 扩充 `scripts/audit-ui-layout.cjs` 的 Practice 外壳/导航与正文边界检查，沿用18状态×8窗口矩阵；构建后运行144场景，检查代表截图。
  构建后发现共享组件样式被提取为 `app.wxss` 引用 `app-origin.wxss` / `common.wxss`，增加 `scripts/helpers/read-wxss.cjs` 和 `scripts/test-wxss-imports.cjs` 递归展开本地引用，保持原次序与重复引用，循环/缺失时报错；避免受控截图漏掉公共导航样式。仅验证工具变更。
- [x] 类型检查沿用兼容参数、相关文件 ESLint 与 git diff --check；运行全39脚本，进程停滞必须记录并单独重跑，不能误报一次全绿。新增WXSS测试另有通过证据。
- [x] 最终全分支复核、写验收记录，保留本地分支和工作树，不合并/推送/部署。
