# 全教材统一训练引擎实施计划

> **执行要求：** 使用 `subagent-driven-development` 按任务实施；每项生产改动必须先看到对应测试按预期失败。

**目标：** 让 ID 3–25 的 23 本教材共用一套训练模型，并通过 `bookId + practice` 进入正确教材、目录、热点和打卡上下文。

**架构：** `bookPractice.ts` 统一读取 `concatImages`、`allAudioList`、`catalogLists` 和 `BOOKS`，输出不可变的 `BookPracticeBundle`。页面不再引用 `SAMPLE_BOOK_*`，所有入口显式传递 `bookId`。

**技术栈：** Taro 4、React 18、TypeScript、Node `assert`、腾讯云存储 URL。

## 全局约束

- 保留 23 本、4,056 张图片、2,081 段音频和 1,393 个训练页的数据范围。
- 目录 `page` 是图片数组零基索引；训练页号来自图片 URL 文件名。
- 不增加整本连续翻阅和独立音频入口。
- Git 提交使用英文类型前缀和中文描述。

---

### Task 1：锁定全教材数据契约

**Files:**

- Create: `scripts/test-book-practice.cjs`
- Modify: `scripts/validate-book-audio-map.cjs`
- Modify: `scripts/test-book-catalog.cjs`
- Modify: `package.json`
- Modify: `src/pages/BookDetail/Components/BookPreview/constants/audioList.ts`

**Produces:** `validateBookData()` 的逐书报告；`test:book-practice` 命令。

- [x] 在 `test-book-practice.cjs` 写入 23 本预期训练数：`100,96,96,96,54,12,67,14,84,64,56,39,99,99,90,90,93,24,24,24,24,24,24`，并断言总数 1,393。
- [ ] 增加 URL、页号、三类坐标、目录索引和 ID 11–14 封面白名单断言。
- [ ] 运行 `npm run test:book-practice`，确认因命令/实现不存在失败。
- [ ] 将校验器改为遍历 ID 3–25并输出每本图片、音频页、音频段、边界坐标和空目录区间。
- [ ] 修复 ID 22 第 94 页 `ttps://` URL。
- [ ] 运行 `npm run test:book-practice` 和 `npm run validate:book-audio`，确认全量通过。
- [ ] 提交 `test: 覆盖全部教材映射数据`。

### Task 2：实现通用教材构建器

**Files:**

- Create: `src/features/listeningPractice/bookPractice.ts`
- Modify: `src/features/listeningPractice/practiceDirectory.ts`
- Modify: `scripts/test-book-practice.cjs`

**Interfaces:**

```ts
export const DEFAULT_BOOK_ID = "3";
export type BookPracticeBundle = {
  book: BookCatalogItem;
  coverUrl: string;
  practices: ListeningPractice[];
};
export function buildBookPracticeBundle(bookId: string): BookPracticeBundle | null;
export function parseTrackCoordinate(track: OriginalAudioTrack): {
  leftPercent: number;
  topPercent: number;
  positionAdjusted: boolean;
};
```

- [ ] 先写 ID 3、11、22、25 和未知 ID 的失败断言，包括 `Percentage: ["42%", "87%"]`。
- [ ] 运行测试并确认缺少构建器导致失败。
- [ ] 实现严格页号解析、坐标转换、最近前置目录归属和无音频页过滤。
- [ ] 将目录类型导入切换到通用模块。
- [ ] 运行全教材测试并确认 23 本均生成正确训练数。
- [ ] 提交 `feat: 增加全教材统一训练模型`。

### Task 3：开放书库并传递教材 ID

**Files:**

- Modify: `src/features/bookLibrary/bookCatalog.ts`
- Modify: `src/pages/BookLibrary/BookLibrary.tsx`
- Modify: `src/pages/Home/Home.tsx`
- Modify: `src/pages/MyCheckIns/MyCheckIns.tsx`
- Modify: `scripts/test-book-catalog.cjs`
- Modify: `scripts/test-book-library-pages.cjs`
- Modify: `scripts/test-home-navigation.cjs`

- [ ] 先断言全部 `available`、系列数量 4/4/5/6/4、ID 25 路由为 `/pages/Practice/Practice?bookId=25&practice=0`。
- [ ] 运行三个现有脚本，确认旧门禁与缺少 `bookId` 导致失败。
- [ ] 开放全部教材、修正系列计数并统一 `resolveBookAction`。
- [ ] 首页和空打卡页显式使用 `bookId=3`。
- [ ] 运行相关测试确认通过。
- [ ] 提交 `feat: 开放全部教材跟读入口`。

### Task 4：Practice 与历史回跳消费通用模型

**Files:**

- Modify: `src/pages/Practice/Practice.tsx`
- Modify: `src/pages/CheckInDetail/CheckInDetail.tsx`
- Create: `scripts/test-practice-book-route.cjs`
- Modify: `scripts/test-audio-playback.cjs`
- Delete: `src/features/listeningPractice/book3Practice.ts`
- Modify: `package.json`

- [ ] 写失败测试，禁止 `Practice.tsx` 出现 `SAMPLE_BOOK_`，并覆盖所有入口的 `bookId`。
- [ ] 运行测试确认当前固定 CASA 数据导致失败。
- [ ] 从路由建立 bundle；非法教材、空训练和非法索引展示错误页并提供返回书库按钮。
- [ ] 标题、进度、目录、打卡快照全部读取 bundle；训练切换保持 `bookId`。
- [ ] 打卡详情使用历史 `bookId` 回跳；旧记录缺字段时进入书库。
- [ ] 删除无引用的 `book3Practice.ts`。
- [ ] 运行路由、目录、音频、打卡测试。
- [ ] 提交 `feat: 接入全教材训练与历史回跳`。

### Task 5：远端素材发布前诊断

**Files:**

- Create: `scripts/validate-book-assets-remote.cjs`
- Modify: `package.json`

- [ ] 先测试 URL 去重、允许域名、Range GET、超时、重试和错误分类纯函数。
- [ ] 运行测试确认诊断模块不存在而失败。
- [ ] 实现有限并发的 GET Range 检查；区分 404、权限拒绝和验证网络失败。
- [ ] 增加 `validate:book-assets-remote`，默认只输出报告，不修改数据。
- [ ] 运行快速模拟测试，再执行真实远端诊断并保存汇总输出。
- [ ] 提交 `test: 增加教材远端素材诊断`。

### Task 6：阶段回归

- [ ] 运行全教材、路由、目录、音频、云函数测试。
- [ ] 运行 `npx tsc --noEmit --skipLibCheck --noUnusedLocals false --noUnusedParameters false`。
- [ ] 运行 `npm run build:weapp` 和 `git diff --check`。
