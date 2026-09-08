# 分享页播放进度与首页入口实施计划

> **执行要求：** 使用 `subagent-driven-development`（推荐）或 `executing-plans` 按任务实施；每一步使用复选框跟踪，生产代码必须先有失败测试。

**目标：** 分享页仅在录音播放中显示“当前 / 总时长”，并在系统导航栏增加快速回首页按钮，同时让微信开发者工具当前使用的工作树拿到最新代码。

**架构：** 在 `checkInFormat.ts` 中增加可独立测试的播放时长标签纯函数，`CheckInDetail` 只负责把播放状态和时间传入该函数。顶部入口使用微信页面配置的原生 `homeButton`，不引入自定义导航。实现完成后先合并到 `master`，再把开发者工具使用的 `codex/multibook-home` 工作树安全快进到相同提交。

**技术栈：** Taro 4、React 18、TypeScript、微信小程序 `InnerAudioContext`、Node.js 断言脚本、Git worktree。

## 全局约束

- 未播放时只显示总时长，例如 `0:08`。
- 仅在 `isPlaying === true` 时显示当前进度和总时长，例如 `0:03 / 0:08`。
- 停止、结束、失败或离开页面后恢复只显示总时长。
- 顶部使用微信原生首页按钮，不改为自定义导航栏。
- 不修改录音上传、分享鉴权、云数据库结构或教材数据。
- Git 提交采用英文类型前缀和中文说明。
- 不提交开发者工具工作树已有的 `project.config.json`、`project.private.config.json` 本机改动。

---

### Task 1：用可测试的纯函数生成播放时长文本

**文件：**
- 修改：`scripts/test-audio-playback.cjs`
- 修改：`src/utils/checkInFormat.ts`
- 修改：`src/pages/CheckInDetail/CheckInDetail.tsx`

**接口：**
- 输入：`formatPlaybackDurationLabel(isPlaying: boolean, playbackPositionMs: number, durationMs: number)`
- 输出：未播放返回总时长；播放中返回 `${当前时长} / ${总时长}`。

- [ ] **步骤 1：先补充失败测试**

在 `scripts/test-audio-playback.cjs` 中加载 `src/utils/checkInFormat.ts`，并增加以下断言：

```js
const checkInFormatPath = path.join(
  projectRoot,
  "src/utils/checkInFormat.ts",
);
const formatCompiled = ts.transpileModule(
  fs.readFileSync(checkInFormatPath, "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2017,
    },
  },
);
const formatModule = { exports: {} };
vm.runInNewContext(formatCompiled.outputText, {
  module: formatModule,
  exports: formatModule.exports,
});
const { formatPlaybackDurationLabel } = formatModule.exports;

assert.equal(
  formatPlaybackDurationLabel(false, 3000, 8000),
  "0:08",
  "未播放时只显示总时长",
);
assert.equal(
  formatPlaybackDurationLabel(true, 3000, 8000),
  "0:03 / 0:08",
  "播放中应显示当前进度和总时长",
);
```

在脚本现有的 `checkInDetail` 读取语句之后增加页面接线断言：

```js
assert.match(
  checkInDetail,
  /formatPlaybackDurationLabel\(\s*isPlaying,\s*playbackPositionMs,\s*detail\.durationMs,?\s*\)/,
  "分享页应使用经过行为测试的播放时长标签函数",
);
```

- [ ] **步骤 2：运行测试并确认按预期失败**

运行：

```powershell
yarn test:audio-playback
```

预期：失败，并明确指出 `formatPlaybackDurationLabel` 不存在或不是函数。

- [ ] **步骤 3：实现最小纯函数**

在 `src/utils/checkInFormat.ts` 的 `formatRecordingDuration` 后增加：

```ts
export const formatPlaybackDurationLabel = (
  isPlaying: boolean,
  playbackPositionMs: number,
  durationMs: number,
) =>
  isPlaying
    ? `${formatRecordingDuration(playbackPositionMs)} / ${formatRecordingDuration(durationMs)}`
    : formatRecordingDuration(durationMs);
```

在 `CheckInDetail.tsx` 中导入该函数，并把时长节点改为：

```tsx
<Text className='shared-recording__duration'>
  {formatPlaybackDurationLabel(
    isPlaying,
    playbackPositionMs,
    detail.durationMs,
  )}
</Text>
```

- [ ] **步骤 4：运行测试确认通过**

运行：

```powershell
yarn test:audio-playback
yarn tsc --noEmit --skipLibCheck --noUnusedLocals false --noUnusedParameters false
```

预期：音频播放测试和业务类型检查均退出码为 0。

- [ ] **步骤 5：提交本任务**

```powershell
git add -- scripts/test-audio-playback.cjs src/utils/checkInFormat.ts src/pages/CheckInDetail/CheckInDetail.tsx
git commit -m "fix: 修正分享页播放进度显示"
```

---

### Task 2：增加系统导航栏首页按钮

**文件：**
- 修改：`scripts/test-audio-playback.cjs`
- 修改：`src/pages/CheckInDetail/CheckInDetail.config.ts`

**接口：**
- 输入：微信页面配置 `homeButton: true`
- 输出：非首页的分享详情页在系统导航栏显示原生首页入口。

- [ ] **步骤 1：先补充失败测试**

在 `scripts/test-audio-playback.cjs` 中读取页面配置并增加：

```js
const checkInDetailConfig = fs.readFileSync(
  path.join(
    projectRoot,
    "src/pages/CheckInDetail/CheckInDetail.config.ts",
  ),
  "utf8",
);

assert.match(
  checkInDetailConfig,
  /homeButton:\s*true/,
  "分享详情页应在系统导航栏显示原生首页按钮",
);
```

- [ ] **步骤 2：运行测试并确认按预期失败**

运行：

```powershell
yarn test:audio-playback
```

预期：失败，信息为“分享详情页应在系统导航栏显示原生首页按钮”。

- [ ] **步骤 3：增加最小页面配置**

在 `src/pages/CheckInDetail/CheckInDetail.config.ts` 中增加：

```ts
homeButton: true,
```

不修改 `navigationStyle`，也不增加内容区重复按钮。

- [ ] **步骤 4：运行测试确认通过**

运行：

```powershell
yarn test:audio-playback
yarn build:weapp
```

预期：音频播放测试退出码为 0；微信小程序构建显示 `Compiled successfully`。

- [ ] **步骤 5：提交本任务**

```powershell
git add -- scripts/test-audio-playback.cjs src/pages/CheckInDetail/CheckInDetail.config.ts
git commit -m "feat: 增加分享页顶部首页入口"
```

---

### Task 3：全量验证并同步开发者工具工作树

**文件：**
- 不新增或修改生产文件。
- 保留：`E:/REPOSITORY/haisha/haisha-multibook-home/project.config.json`
- 保留：`E:/REPOSITORY/haisha/haisha-multibook-home/project.private.config.json`

**接口：**
- 输入：通过验证的功能分支提交。
- 输出：`master` 与开发者工具工作树包含相同的受跟踪代码，用户本机配置保持不变。

- [ ] **步骤 1：运行完整自动化验证**

依次运行：

```powershell
yarn validate:book-audio
yarn test:check-in
yarn test:practice-directory
yarn test:practice-directory-component
yarn test:recording-interaction
yarn test:audio-playback
yarn test:book-catalog
yarn test:book-library-pages
yarn test:home-navigation
yarn test:ui-refinements
yarn tsc --noEmit --skipLibCheck --noUnusedLocals false --noUnusedParameters false
yarn build:weapp
git diff --check
```

预期：全部命令退出码为 0；构建允许现有 Sass 弃用和包体积警告，但不得有编译错误。

- [ ] **步骤 2：快进合并功能分支到本地 `master`**

在主工作树 `E:/REPOSITORY/haisha/haisha` 中运行：

```powershell
git status --short --branch
git merge --ff-only codex/check-in-playback-home
```

预期：工作区干净并完成快进合并，不产生额外英文合并提交。

- [ ] **步骤 3：检查开发者工具工作树的本机改动范围**

```powershell
git -C E:/REPOSITORY/haisha/haisha-multibook-home status --short
```

预期：只允许现有 `project.config.json`、`project.private.config.json` 改动；若出现其他文件，停止同步并先核查。

- [ ] **步骤 4：安全快进开发者工具工作树**

```powershell
git -C E:/REPOSITORY/haisha/haisha-multibook-home merge --ff-only master
git -C E:/REPOSITORY/haisha/haisha-multibook-home status --short --branch
```

预期：受跟踪源码与 `master` 一致，本机两个配置文件仍保持原改动且未被提交。

- [ ] **步骤 5：在开发者工具工作树重新构建**

```powershell
yarn --cwd E:/REPOSITORY/haisha/haisha-multibook-home build:weapp
```

预期：构建显示 `Compiled successfully`。随后用户在微信开发者工具点击“编译”，播放录音时看到 `当前 / 总时长`，并能用顶部原生按钮回到首页。
