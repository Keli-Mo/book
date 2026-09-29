# Oxford Discover 6 两册接入与云存储实施计划

**目标：** 把 Oxford Discover 6 学生书、练习册加入现有整本阅读与跟读框架，将统一尺寸页图和全部学生书音频上传到微信云存储，并确保翻页画布稳定、正式音频热点准确且不遮挡题目。

**来源：** `E:\project\haisha-book\OD2e L6 Audio`

**已确认边界：**

- 学生书展示 PDF 1–201 页；排除 PDF 202 版权致谢页。
- 练习册展示 PDF 1–185 页；排除 PDF 186 第三方二维码广告和 PDF 187 版权致谢页。
- 上传全部 165 个学生书 MP3；页面只映射 130 个正式音轨：`1.02–1.36`、`2.02–2.37`、`3.02–3.38`、`4.02–4.23`。
- `1.01 / 2.01 / 3.01 / 4.01` 和 `4.24–4.54` 不生成热点。
- 18 篇跨页 Reading 的第二页保留但不重复热点；翻页继续播放。

---

## 任务 1：先写新增教材契约测试

**修改：**

- `scripts/test-book-catalog.cjs`
- `scripts/test-book-practice.cjs`
- `scripts/test-book-audio-map-validator.cjs`
- `scripts/test-book-assets-remote.cjs`
- `scripts/test-full-book-practice.cjs`
- `scripts/test-full-book-directory.cjs`
- `scripts/test-reading-progress.cjs`
- `scripts/test-reading-progress-pages.cjs`
- `scripts/test-full-practice-route.cjs`
- `scripts/test-check-in-detail-page-route.cjs`
- `scripts/test-practice-stable-book-canvas.cjs`

**RED：** 断言 ID 30/31、两册页数、练习册零示范音频、学生书正式音轨范围、130 个热点、固定画布和非 Think 路由；运行专项测试并确认因数据尚未接入而失败。

## 任务 2：生成统一页图与素材清单

**生成目录：** `.temp/od6-assets/`（不提交大文件）

- 直接提取 PDF 每页唯一内嵌 JPEG，避免二次压缩。
- 学生书输出 `od6-sb_0.jpg` 至 `od6-sb_200.jpg`，统一 `1536×1987`。
- 练习册输出 `od6-wb_0.jpg` 至 `od6-wb_184.jpg`，统一 `1536×1984`。
- 音频按 `disc-1` 至 `disc-4` 复制并标准化为 `1-01.mp3` 等路径。
- 生成包含相对路径、字节数、SHA-256、图片尺寸的 manifest；验证页数、音频编号连续性和排除项。

## 任务 3：生成并复核学生书热点映射

**修改：**

- `src/pages/BookDetail/Components/BookPreview/constants/audioList.ts`

- 扫描所有页面上的印刷音轨号，生成百分比坐标候选。
- 每个正式音轨逐项反查页面与文件；同一页面多个标记分别保留。
- 热点只放在印刷音频标记附近；使用现有左移与边界约束，避免覆盖题干。
- 18 个 Reading 跨页只在第一页放置按钮。
- 用测试断言 130 个正式热点、35 个未挂页音频以及首/中/末页代表坐标。

## 任务 4：接入现有书架、目录和整本阅读

**修改：**

- `src/features/bookLibrary/bookCatalog.ts`
- `src/pages/BookDetail/Components/BookPreview/constants/images.ts`
- `src/pages/BookDetail/Components/BookPreview/constants/catalogList.ts`
- `src/features/listeningPractice/bookPractice.ts`
- `src/pages/Practice/PracticeSession.tsx`

- 追加 ID 30 学生书和 ID 31 练习册；Oxford Discover 更新为 Level 1–6。
- 添加两册云端页图 URL 和 18 单元目录；学生书增加 Dictionary，练习册增加 Student’s Writing Resource。
- 为 ID 31 增加明确的零示范音频白名单，整本阅读仍展开全部 185 页。
- 为 ID 30/31 配置固定竖屏画布；沿用现有预加载、节点复用、翻页续播和横屏边界。
- 修正把 `bookId >= 26` 当作 Think 的旧测试/路由假设。

**GREEN：** 运行新增专项测试，补最小实现直至通过。

## 任务 5：上传微信云存储并逐项核验

**云前缀：** `oxford-discover-2e-l6/`

- `student-book/pages/`
- `student-book/audio/disc-1..4/`
- `workbook/pages/`

上传 386 张页图和 165 个 MP3，共 551 个对象。上传后用云端列表核对路径与字节数；普通对象核对 ETag/MD5，分片对象完整下载核对 SHA-256；所有公开 URL 验证 HTTP 200 和 Range 206。

## 任务 6：完整回归与交付记录

**验证：**

- 音频映射、书架、全书目录、路由、阅读进度、固定画布专项测试。
- `yarn test:regression`
- `yarn build:weapp`
- 改动文件 ESLint 与 `git diff --check`
- 手机及 iPad 代表尺寸截图：封面、跨页 Reading、三热点页面、Testing 3、练习册首中末页。
- 新增 QA 文档记录来源 SHA-256、排除项、云端对象核验和未完成的真机边界。
