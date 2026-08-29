# 跟读录音暂停与分组目录实施计划

> **执行要求：** 使用 `executing-plans` 按任务顺序在当前会话内实施；每个任务遵循测试先行、红灯确认、最小实现、绿灯确认和独立提交。

**目标：** 删除重复的示范听力信息框，让录音与示范音频并行工作，支持暂停/继续录音，并提供按章节分组的训练目录快速跳转。

**架构：** 从现有 `SAMPLE_BOOK_PRACTICES` 派生只包含有音频训练页的目录模型，使用独立底部弹层组件展示。录音页面继续连接微信 `RecorderManager`，但把计时和切页策略提取为纯函数，以便用 Node 脚本做回归测试。

**技术栈：** Taro 4、React 18、TypeScript、微信小程序 `RecorderManager` / `InnerAudioContext`、Node `assert` 测试脚本、SCSS。

## 全局约束

- 工作分支固定为 `codex/listening-checkin`，不修改 `master`。
- 所有新增业务注释使用中文。
- 不使用 `using-superpowers`，不引入新的运行时依赖。
- 目录只包含 `SAMPLE_BOOK_PRACTICES` 中有示范音频的页面，不恢复整本书连续翻阅。
- 示例音频由用户手动播放；最终录音仍由麦克风采集，不做数字混音。
- 云端打卡、分享和删除的数据结构保持不变。
- 保留开发者工具对 `project.config.json`、`project.private.config.json` 的本地修改，不纳入功能提交。

---

## 文件结构

- 新建 `src/features/listeningPractice/practiceDirectory.ts`：目录分组与当前分组定位纯函数。
- 新建 `src/features/listeningPractice/recordingInteraction.ts`：录音有效时长与切页策略纯函数。
- 新建 `src/pages/Practice/PracticeDirectory.tsx`：底部弹层目录组件。
- 修改 `src/pages/Practice/Practice.tsx`：接入目录、录音暂停/继续、并行示范音频和统一切页确认。
- 修改 `src/pages/Practice/Practice.scss`：删除旧信息框样式，增加目录与暂停状态样式。
- 新建 `scripts/test-practice-directory.cjs`：目录模型回归测试。
- 新建 `scripts/test-recording-interaction.cjs`：录音计时与切页策略回归测试。
- 新建 `scripts/test-practice-directory-component.cjs`：目录组件渲染与选择回调测试。
- 修改 `package.json`：增加三个明确的测试命令。

---

### 任务 1：训练目录模型

**文件：**

- 新建：`src/features/listeningPractice/practiceDirectory.ts`
- 新建：`scripts/test-practice-directory.cjs`
- 修改：`package.json`

**接口：**

- 输入：`buildPracticeDirectoryGroups(practices: readonly ListeningPractice[])`
- 输出：`PracticeDirectoryGroup[]`
- 定位：`findPracticeDirectoryGroupId(groups, practiceIndex): string`

- [ ] **步骤 1：先写失败测试**

在 `scripts/test-practice-directory.cjs` 中用 TypeScript 的 `transpileModule` 加载真实模块，并断言分组保持输入顺序：

```js
/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const sourcePath = path.resolve(
  __dirname,
  "../src/features/listeningPractice/practiceDirectory.ts",
);
assert.equal(fs.existsSync(sourcePath), true, "训练目录模型文件应存在");

const compiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2017,
  },
});
const moduleContainer = { exports: {} };
vm.runInNewContext(compiled.outputText, {
  module: moduleContainer,
  exports: moduleContainer.exports,
});

const {
  buildPracticeDirectoryGroups,
  findPracticeDirectoryGroupId,
} = moduleContainer.exports;
const practices = [
  { id: "p1", pageNumber: 4, sectionTitle: "Unit 1 课文", tracks: [{}, {}] },
  { id: "p2", pageNumber: 5, sectionTitle: "Unit 1 课文", tracks: [{}] },
  { id: "p3", pageNumber: 12, sectionTitle: "Unit 1 练习", tracks: [{}] },
  { id: "p4", pageNumber: 25, sectionTitle: "Unit 2 课文", tracks: [{}, {}, {}] },
];
const groups = buildPracticeDirectoryGroups(practices);
const plainGroups = JSON.parse(JSON.stringify(groups));

assert.deepEqual(plainGroups, [
  {
    id: "practice-directory-group-0",
    title: "Unit 1 课文",
    items: [
      { id: "p1", practiceIndex: 0, pageNumber: 4, trackCount: 2 },
      { id: "p2", practiceIndex: 1, pageNumber: 5, trackCount: 1 },
    ],
  },
  {
    id: "practice-directory-group-1",
    title: "Unit 1 练习",
    items: [{ id: "p3", practiceIndex: 2, pageNumber: 12, trackCount: 1 }],
  },
  {
    id: "practice-directory-group-2",
    title: "Unit 2 课文",
    items: [{ id: "p4", practiceIndex: 3, pageNumber: 25, trackCount: 3 }],
  },
]);
assert.equal(findPracticeDirectoryGroupId(groups, 2), "practice-directory-group-1");
assert.equal(findPracticeDirectoryGroupId(groups, 999), "");
console.log("训练目录测试通过：章节分组、页码、音频数与当前分组定位正确。");
```

- [ ] **步骤 2：运行测试并确认红灯**

运行：`node scripts/test-practice-directory.cjs`

预期：因 `practiceDirectory.ts` 尚不存在，在“训练目录模型文件应存在”断言处失败。

- [ ] **步骤 3：实现最小目录模型**

新建 `src/features/listeningPractice/practiceDirectory.ts`：

```ts
import type { ListeningPractice } from "./book3Practice";

export interface PracticeDirectoryItem {
  id: string;
  practiceIndex: number;
  pageNumber: number;
  trackCount: number;
}

export interface PracticeDirectoryGroup {
  id: string;
  title: string;
  items: PracticeDirectoryItem[];
}

export const buildPracticeDirectoryGroups = (
  practices: readonly ListeningPractice[],
): PracticeDirectoryGroup[] => {
  const groups: PracticeDirectoryGroup[] = [];
  const groupByTitle = new Map<string, PracticeDirectoryGroup>();

  practices.forEach((practice, practiceIndex) => {
    let group = groupByTitle.get(practice.sectionTitle);
    if (!group) {
      group = {
        id: `practice-directory-group-${groups.length}`,
        title: practice.sectionTitle,
        items: [],
      };
      groupByTitle.set(practice.sectionTitle, group);
      groups.push(group);
    }
    group.items.push({
      id: practice.id,
      practiceIndex,
      pageNumber: practice.pageNumber,
      trackCount: practice.tracks.length,
    });
  });

  return groups;
};

export const findPracticeDirectoryGroupId = (
  groups: readonly PracticeDirectoryGroup[],
  practiceIndex: number,
) =>
  groups.find((group) =>
    group.items.some((item) => item.practiceIndex === practiceIndex),
  )?.id || "";
```

在 `package.json` 的 `scripts` 中增加：

```json
"test:practice-directory": "node scripts/test-practice-directory.cjs"
```

- [ ] **步骤 4：运行测试并确认绿灯**

运行：`npm run test:practice-directory`

预期：输出“训练目录测试通过”。

- [ ] **步骤 5：提交目录模型**

```powershell
git add -- package.json scripts/test-practice-directory.cjs src/features/listeningPractice/practiceDirectory.ts
git commit -m "feat: 增加跟读训练目录模型"
```

---

### 任务 2：录音计时与切页策略

**文件：**

- 新建：`src/features/listeningPractice/recordingInteraction.ts`
- 新建：`scripts/test-recording-interaction.cjs`
- 修改：`package.json`

**接口：**

- `startRecordingTimeline(nowMs): RecordingTimeline`
- `pauseRecordingTimeline(timeline, nowMs): RecordingTimeline`
- `resumeRecordingTimeline(timeline, nowMs): RecordingTimeline`
- `getRecordingElapsedMs(timeline, nowMs): number`
- `getPracticeSwitchPolicy(state): "allow" | "confirm-discard" | "block-uploading"`

- [ ] **步骤 1：先写失败测试**

新建完整的 `scripts/test-recording-interaction.cjs`：

```js
/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const sourcePath = path.resolve(
  __dirname,
  "../src/features/listeningPractice/recordingInteraction.ts",
);
assert.equal(fs.existsSync(sourcePath), true, "录音交互模型文件应存在");

const compiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2017,
  },
});
const moduleContainer = { exports: {} };
vm.runInNewContext(compiled.outputText, {
  module: moduleContainer,
  exports: moduleContainer.exports,
});

const {
  getPracticeSwitchPolicy,
  getRecordingElapsedMs,
  pauseRecordingTimeline,
  resumeRecordingTimeline,
  startRecordingTimeline,
} = moduleContainer.exports;

const timeline = startRecordingTimeline(1000);
assert.equal(getRecordingElapsedMs(timeline, 2500), 1500);

const paused = pauseRecordingTimeline(timeline, 2500);
assert.equal(getRecordingElapsedMs(paused, 9000), 1500);

const resumed = resumeRecordingTimeline(paused, 9000);
assert.equal(getRecordingElapsedMs(resumed, 10000), 2500);

assert.equal(getPracticeSwitchPolicy("idle"), "allow");
assert.equal(getPracticeSwitchPolicy("recording"), "confirm-discard");
assert.equal(getPracticeSwitchPolicy("paused"), "confirm-discard");
assert.equal(getPracticeSwitchPolicy("recorded"), "confirm-discard");
assert.equal(getPracticeSwitchPolicy("uploading"), "block-uploading");

console.log("录音交互测试通过：暂停计时与切页策略正确。");
```

- [ ] **步骤 2：运行测试并确认红灯**

运行：`node scripts/test-recording-interaction.cjs`

预期：因 `recordingInteraction.ts` 尚不存在而断言失败。

- [ ] **步骤 3：实现最小纯函数**

```ts
export type RecordingState =
  | "idle"
  | "recording"
  | "paused"
  | "recorded"
  | "uploading";

export interface RecordingTimeline {
  accumulatedMs: number;
  activeSinceMs: number | null;
}

export const startRecordingTimeline = (nowMs: number): RecordingTimeline => ({
  accumulatedMs: 0,
  activeSinceMs: nowMs,
});

export const getRecordingElapsedMs = (
  timeline: RecordingTimeline,
  nowMs: number,
) =>
  timeline.accumulatedMs +
  (timeline.activeSinceMs === null
    ? 0
    : Math.max(0, nowMs - timeline.activeSinceMs));

export const pauseRecordingTimeline = (
  timeline: RecordingTimeline,
  nowMs: number,
): RecordingTimeline => ({
  accumulatedMs: getRecordingElapsedMs(timeline, nowMs),
  activeSinceMs: null,
});

export const resumeRecordingTimeline = (
  timeline: RecordingTimeline,
  nowMs: number,
): RecordingTimeline => ({
  accumulatedMs: timeline.accumulatedMs,
  activeSinceMs: nowMs,
});

export const getPracticeSwitchPolicy = (state: RecordingState) => {
  if (state === "uploading") return "block-uploading" as const;
  if (state === "idle") return "allow" as const;
  return "confirm-discard" as const;
};
```

在 `package.json` 中增加：

```json
"test:recording-interaction": "node scripts/test-recording-interaction.cjs"
```

- [ ] **步骤 4：运行测试并确认绿灯**

运行：`npm run test:recording-interaction`

预期：输出“录音交互测试通过”。

- [ ] **步骤 5：提交录音交互纯函数**

```powershell
git add -- package.json scripts/test-recording-interaction.cjs src/features/listeningPractice/recordingInteraction.ts
git commit -m "feat: 增加录音暂停计时与切页策略"
```

---

### 任务 3：底部弹层训练目录

**文件：**

- 新建：`src/pages/Practice/PracticeDirectory.tsx`
- 新建：`scripts/test-practice-directory-component.cjs`
- 修改：`src/pages/Practice/Practice.tsx`
- 修改：`src/pages/Practice/Practice.scss`
- 修改：`package.json`

**接口：**

```ts
interface PracticeDirectoryProps {
  groups: readonly PracticeDirectoryGroup[];
  currentPracticeIndex: number;
  open: boolean;
  onClose: () => void;
  onSelect: (practiceIndex: number) => void;
}
```

- [ ] **步骤 1：先写失败的组件测试**

新建完整的 `scripts/test-practice-directory-component.cjs`：

```js
/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const sourcePath = path.resolve(
  __dirname,
  "../src/pages/Practice/PracticeDirectory.tsx",
);
assert.equal(fs.existsSync(sourcePath), true, "训练目录组件文件应存在");

const compiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2017,
  },
});
const moduleContainer = { exports: {} };
vm.runInNewContext(compiled.outputText, {
  module: moduleContainer,
  exports: moduleContainer.exports,
  require(moduleName) {
    if (moduleName === "@tarojs/components") {
      return { ScrollView: "scroll-view", Text: "text", View: "view" };
    }
    if (moduleName === "@/features/listeningPractice/practiceDirectory") {
      return {
        findPracticeDirectoryGroupId(groups, practiceIndex) {
          return (
            groups.find((group) =>
              group.items.some((item) => item.practiceIndex === practiceIndex),
            )?.id || ""
          );
        },
      };
    }
    return require(moduleName);
  },
});

const PracticeDirectory = moduleContainer.exports.default;
const groups = [
  {
    id: "practice-directory-group-0",
    title: "Unit 1 课文",
    items: [
      { id: "p1", practiceIndex: 0, pageNumber: 4, trackCount: 2 },
    ],
  },
];
const selected = [];
const props = {
  groups,
  currentPracticeIndex: 0,
  open: true,
  onClose() {},
  onSelect(practiceIndex) {
    selected.push(practiceIndex);
  },
};

assert.equal(PracticeDirectory({ ...props, open: false }), null);
const tree = PracticeDirectory({ ...props, open: true });
assert.match(JSON.stringify(tree), /Unit 1 课文/);
assert.match(JSON.stringify(tree), /第 4 页/);
assert.match(JSON.stringify(tree), /2 段音频/);

const flattenElements = (node) => {
  if (node === null || node === undefined || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(flattenElements);
  return [node, ...flattenElements(node.props?.children)];
};
const directoryItem = flattenElements(tree).find((element) =>
  String(element.props?.className || "").includes("practice-directory-item "),
);
assert.ok(directoryItem, "应渲染可点击的目录项");
directoryItem.props.onClick();
assert.deepEqual(selected, [0]);

console.log("训练目录组件测试通过：关闭状态、目录内容和选择回调正确。");
```

- [ ] **步骤 2：运行测试并确认红灯**

运行：`node scripts/test-practice-directory-component.cjs`

预期：在“训练目录组件文件应存在”断言处失败。

- [ ] **步骤 3：实现目录组件**

`PracticeDirectory.tsx` 的完整结构：

```tsx
import { ScrollView, Text, View } from "@tarojs/components";
import {
  findPracticeDirectoryGroupId,
  type PracticeDirectoryGroup,
} from "@/features/listeningPractice/practiceDirectory";

interface PracticeDirectoryProps {
  groups: readonly PracticeDirectoryGroup[];
  currentPracticeIndex: number;
  open: boolean;
  onClose: () => void;
  onSelect: (practiceIndex: number) => void;
}

export default function PracticeDirectory({
  groups,
  currentPracticeIndex,
  open,
  onClose,
  onSelect,
}: PracticeDirectoryProps) {
  if (!open) return null;

  const currentGroupId = findPracticeDirectoryGroupId(
    groups,
    currentPracticeIndex,
  );

  return (
    <View className='practice-directory-mask' onClick={onClose}>
      <View
        className='practice-directory-sheet'
        onClick={(event) => event.stopPropagation()}
      >
        <View className='practice-directory-header'>
          <Text className='practice-directory-title'>训练目录</Text>
          <Text className='practice-directory-close' onClick={onClose}>关闭</Text>
        </View>
        <ScrollView
          className='practice-directory-scroll'
          scrollY
          scrollIntoView={currentGroupId}
        >
          {groups.map((group) => (
            <View id={group.id} key={group.id} className='practice-directory-group'>
              <Text className='practice-directory-group__title'>{group.title}</Text>
              <View className='practice-directory-items'>
                {group.items.map((item) => (
                  <View
                    key={item.id}
                    className={`practice-directory-item ${
                      item.practiceIndex === currentPracticeIndex
                        ? "practice-directory-item--active"
                        : ""
                    }`}
                    onClick={() => onSelect(item.practiceIndex)}
                  >
                    <Text className='practice-directory-item__page'>第 {item.pageNumber} 页</Text>
                    <Text className='practice-directory-item__tracks'>{item.trackCount} 段音频</Text>
                  </View>
                ))}
              </View>
            </View>
          ))}
        </ScrollView>
      </View>
    </View>
  );
}
```

- [ ] **步骤 4：接入训练页**

在 `Practice.tsx`：

1. 用 `useMemo` 生成 `directoryGroups`，增加 `isDirectoryOpen`。
2. 头部进度行增加“目录”按钮。
3. 页面根节点末尾渲染 `PracticeDirectory`。
4. 删除整个 `.practice-audio-status` JSX。
5. 目录项在本次提交中调用现有 `switchPractice`；任务 4 将其替换为统一确认流程。

关键代码：

```tsx
const directoryGroups = useMemo(
  () => buildPracticeDirectoryGroups(SAMPLE_BOOK_PRACTICES),
  [],
);
const [isDirectoryOpen, setIsDirectoryOpen] = useState(false);

<View className='practice-header__progress-row'>
  <Text className='practice-header__progress'>
    跟读训练 {practiceIndex + 1} / {SAMPLE_BOOK_PRACTICES.length}
  </Text>
  <Text className='practice-header__directory' onClick={() => setIsDirectoryOpen(true)}>
    目录
  </Text>
</View>

<PracticeDirectory
  groups={directoryGroups}
  currentPracticeIndex={practiceIndex}
  open={isDirectoryOpen}
  onClose={() => setIsDirectoryOpen(false)}
  onSelect={(nextIndex) => {
    setIsDirectoryOpen(false);
    switchPractice(nextIndex);
  }}
/>
```

- [ ] **步骤 5：增加目录样式并删除旧样式**

删除 `.practice-audio-status`，并加入以下样式：

```scss
.practice-header {
  &__progress-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 12rpx;
  }
  &__progress { color: #2f876b; font-size: 25rpx; font-weight: 600; }
  &__directory {
    padding: 8rpx 18rpx;
    border-radius: 999rpx;
    background: #e2f1eb;
    color: #276c58;
    font-size: 24rpx;
    font-weight: 700;
  }
}

.practice-directory-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: flex-end;
  background: rgba(18, 37, 31, 0.48);
}

.practice-directory-sheet {
  width: 100%;
  max-height: 78vh;
  padding-bottom: env(safe-area-inset-bottom);
  border-radius: 32rpx 32rpx 0 0;
  background: #f5f8f6;
}

.practice-directory-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 30rpx 30rpx 22rpx;
  background: #ffffff;
}

.practice-directory-title { font-size: 32rpx; font-weight: 800; }
.practice-directory-close { color: #2f876b; font-size: 25rpx; font-weight: 700; }
.practice-directory-scroll { height: 62vh; }
.practice-directory-group { padding: 26rpx 26rpx 0; }
.practice-directory-group__title { font-size: 27rpx; font-weight: 800; }
.practice-directory-items { display: flex; flex-wrap: wrap; gap: 16rpx; margin-top: 18rpx; }
.practice-directory-item {
  width: calc(50% - 8rpx);
  padding: 20rpx;
  box-sizing: border-box;
  border: 2rpx solid #d6e0dc;
  border-radius: 18rpx;
  background: #ffffff;
}
.practice-directory-item--active { border-color: #2f896c; background: #e4f3ed; }
.practice-directory-item__page { display: block; font-size: 26rpx; font-weight: 700; }
.practice-directory-item__tracks { display: block; margin-top: 8rpx; color: #78867f; font-size: 22rpx; }
```

- [ ] **步骤 6：运行测试与构建**

运行：

```powershell
npm run test:practice-directory
node scripts/test-practice-directory-component.cjs
npm run build:weapp
```

预期：两个目录测试通过，Webpack 编译成功；允许保留现有第三方 Sass 弃用与包体积警告。

- [ ] **步骤 7：提交目录界面**

```powershell
git add -- package.json scripts/test-practice-directory-component.cjs src/pages/Practice/PracticeDirectory.tsx src/pages/Practice/Practice.tsx src/pages/Practice/Practice.scss
git commit -m "feat: 增加分组跟读训练目录"
```

---

### 任务 4：录音暂停、继续与并行播放

**文件：**

- 修改：`src/pages/Practice/Practice.tsx`
- 修改：`src/pages/Practice/Practice.scss`

**依赖接口：** 使用任务 2 的 `RecordingState`、时间线函数和 `getPracticeSwitchPolicy`。

- [ ] **步骤 1：确认录音交互测试保持绿灯**

运行：`npm run test:recording-interaction`

预期：计时冻结/继续和切页策略全部通过。

- [ ] **步骤 2：接入暂停/继续事件与计时**

在 `Practice.tsx` 中：

```tsx
const recordingTimelineRef = useRef<RecordingTimeline>({
  accumulatedMs: 0,
  activeSinceMs: null,
});

const handleRecorderStart = () => {
  recordingTimelineRef.current = startRecordingTimeline(Date.now());
  setRecordingElapsedMs(0);
  setRecordingState("recording");
};
const handleRecorderPause = () => {
  recordingTimelineRef.current = pauseRecordingTimeline(
    recordingTimelineRef.current,
    Date.now(),
  );
  setRecordingElapsedMs(recordingTimelineRef.current.accumulatedMs);
  setRecordingState("paused");
};
const handleRecorderResume = () => {
  recordingTimelineRef.current = resumeRecordingTimeline(
    recordingTimelineRef.current,
    Date.now(),
  );
  setRecordingState("recording");
};

recorder.onPause(handleRecorderPause);
recorder.onResume(handleRecorderResume);
```

录音中的 250ms 定时器改为：

```tsx
setRecordingElapsedMs(
  getRecordingElapsedMs(recordingTimelineRef.current, Date.now()),
);
```

暂停状态不启动定时器。最终 `onStop` 仍使用 `result.duration`。

- [ ] **步骤 3：增加暂停、继续和结束按钮**

```tsx
const pauseRecording = () => {
  if (recordingState === "recording") recorderRef.current?.pause();
};

const resumeRecording = () => {
  if (recordingState === "paused") recorderRef.current?.resume();
};

const stopRecording = () => {
  if (recordingState === "recording" || recordingState === "paused") {
    recorderRef.current?.stop();
  }
};
```

`recording` 状态显示“暂停录音”“结束录音”；`paused` 状态显示“继续录音”“结束录音”。按钮点击后等待 `onPause` / `onResume` 事件更新状态，避免假成功。

- [ ] **步骤 4：允许录音与示范音频并行**

将 `playModelAudio` 改为同一热点点击停止、不同热点切换，并删除录音状态禁播：

```tsx
const playModelAudio = (trackId: string, url: string) => {
  const audio = modelAudioRef.current;
  if (!audio || recordingState === "uploading") return;

  recordingAudioRef.current?.stop();
  if (playingTrackId === trackId) {
    audio.stop();
    setPlayingTrackId(null);
    return;
  }
  // 示范音频由用户手动控制，录音中也允许播放和切换。
  audio.stop();
  audio.src = url;
  audio.play();
  setPlayingTrackId(trackId);
};
```

从 `startRecording` 删除 `modelAudio.stop()` 和 `setPlayingTrackId(null)`，保留停止用户录音回听。

- [ ] **步骤 5：统一目录、上一页和下一页切换确认**

新增异步入口：

```tsx
const requestPracticeSwitch = async (nextIndex: number) => {
  if (nextIndex === practiceIndex) {
    setIsDirectoryOpen(false);
    return;
  }

  const policy = getPracticeSwitchPolicy(recordingState);
  if (policy === "block-uploading") {
    Taro.showToast({ title: "打卡上传中，请稍候", icon: "none" });
    return;
  }
  if (policy === "confirm-discard") {
    const confirmation = await Taro.showModal({
      title: "切换训练？",
      content: "切换后将放弃当前录音，是否继续？",
      confirmText: "放弃并切换",
      confirmColor: "#d85b3f",
    });
    if (!confirmation.confirm) return;
  }

  setIsDirectoryOpen(false);
  performPracticeSwitch(nextIndex);
};
```

把现有 `switchPractice` 的实际清理和切换代码更名为 `performPracticeSwitch`。目录项、上一个训练和下一个训练全部调用 `requestPracticeSwitch`。`resetRecording` 同时处理 `recording` 与 `paused`。

- [ ] **步骤 6：实现暂停状态样式和错误提示**

增加待执行动作引用，并在录音事件中清理：

```tsx
const pendingRecorderActionRef = useRef<"pause" | "resume" | null>(null);

const pauseRecording = () => {
  if (recordingState !== "recording" || !recorderRef.current) return;
  pendingRecorderActionRef.current = "pause";
  try {
    recorderRef.current.pause();
  } catch (_error) {
    pendingRecorderActionRef.current = null;
    Taro.showToast({ title: "暂停录音失败，请重试", icon: "none" });
  }
};

const resumeRecording = () => {
  if (recordingState !== "paused" || !recorderRef.current) return;
  pendingRecorderActionRef.current = "resume";
  try {
    recorderRef.current.resume();
  } catch (_error) {
    pendingRecorderActionRef.current = null;
    Taro.showToast({ title: "继续录音失败，请重试", icon: "none" });
  }
};
```

`handleRecorderPause` 和 `handleRecorderResume` 首行将 `pendingRecorderActionRef.current` 设为 `null`。`handleRecorderError` 使用下面的分支；暂停/继续失败不清空已有录音，普通录音错误仍回到 `idle`：

```tsx
const handleRecorderError = () => {
  const pendingAction = pendingRecorderActionRef.current;
  pendingRecorderActionRef.current = null;
  if (pendingAction === "pause") {
    Taro.showToast({ title: "暂停录音失败，请重试", icon: "none" });
    return;
  }
  if (pendingAction === "resume") {
    Taro.showToast({ title: "继续录音失败，请重试", icon: "none" });
    return;
  }
  setRecordingState("idle");
  Taro.showToast({ title: "录音失败，请检查麦克风权限", icon: "none" });
};
```

增加录音控制样式：

```scss
.recording-controls { display: flex; gap: 16rpx; }
.recording-controls .record-button { flex: 1; }
.record-button--pause { background: #fff0dd; color: #a9651f; }
.record-button--resume { background: #e4f3ed; color: #2f765f; }
.recording-indicator--paused { color: #a9651f; }
.recording-indicator--paused .recording-indicator__pulse {
  background: #e69a3b;
  box-shadow: none;
}
```

- [ ] **步骤 7：运行全量自动验证**

运行：

```powershell
npm run test:practice-directory
npm run test:recording-interaction
node scripts/test-practice-directory-component.cjs
node scripts/test-cloud-error.cjs
npm run test:check-in
npm run validate:book-audio
npm run build:weapp
```

预期：所有 Node 测试、映射校验和微信小程序构建退出码均为 0。

- [ ] **步骤 8：提交录音交互**

```powershell
git add -- src/pages/Practice/Practice.tsx src/pages/Practice/Practice.scss
git commit -m "feat: 支持跟读录音暂停与示范音频并行播放"
```

---

### 任务 5：真机验收与分支收尾

**文件：** 无新增生产代码；如真机发现问题，先补失败测试再修改对应任务文件。

- [ ] **步骤 1：模拟器冒烟测试**

检查：信息框已消失；目录可开关、滚动和跳转；当前页高亮；录音按钮状态正确；录音中能播放示范音频。

- [ ] **步骤 2：真机录音测试**

按以下顺序执行：录音 2 秒 → 播放第一段示范音频 → 暂停 3 秒 → 继续录音 2 秒 → 切换第二段示范音频 → 结束录音 → 回听。

验收：录音不中断；暂停期间录音时长冻结；回听文件可播放；外放声音仅通过麦克风自然进入录音。

- [ ] **步骤 3：真机切页保护测试**

分别在录音中、已暂停和已录制状态通过目录切页，验证取消后状态保留、确认后录音被丢弃并跳到正确教材页。

- [ ] **步骤 4：云端打卡回归**

完成一次打卡，检查“我的打卡”列表、录音回听、分享链接和删除功能。

- [ ] **步骤 5：最终验证并推送**

重新运行任务 4 的全量验证命令，确认 `git status --short` 只剩用户已有的两个项目配置改动，然后：

```powershell
git push origin codex/listening-checkin
```

记录最终提交 ID，并向用户说明真机测试结果及仍需人工确认的设备差异。
