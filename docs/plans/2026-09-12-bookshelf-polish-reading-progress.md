# 书架精修与真实阅读进度实施计划

> 使用 subagent-driven-development 分工实现和独立复核；用户已确认上一轮 UI 建议，直接执行，不重新设计视觉风格。

**Goal:** 手机与 Pad 的书架具有稳定留白、清晰册别，并能从首页继续最近一次实际阅读位置。

**Architecture:** 保留 Taro 页面、教材模型与路由；新增一个小型本机阅读进度模块。Practice 只在合法教材/实际训练位置变化时记录定位，Home 展示来自真实 bundle 的书名、封面、章节和教材页；不复制教材信息、不改录音协调器。

**Tech Stack:** Taro 4 / React / TypeScript / SCSS / 本机 Storage；Node 回归脚本。

## Global Constraints

- 保留现有绿色轻列表风格、真实封面、首页单栏和书库宽 Pad 双栏，不增加装饰性卡片。
- 手机主内容左右固定 18 CSS px，Pad 左右 28 CSS px；横屏安全区作为额外空间，不得使基础留白失效。
- 隐藏首页与书库全部“可跟读”“N 册可练”标签，只保留导航箭头；系列范围仍留在左侧副标题。
- CASA 专属筛选内主标题突出“第 N 册”，副标题为教材名称；全部教材仍显示完整书名。其他系列保留完整书名与级别/类型，避免误认版本。
- 保持封面 aspectFit；标题最多两行，正文清晰；筛选点击区至少 44 CSS px，不因为外观更轻而缩小命中区域。
- 阅读进度只保存在本机；不上传任何录音，不访问云端，不改变麦克风、录音暂停/恢复、文件保存、分享、音频热点映射。
- 首页没有有效进度时明确“选择教材”，不能声称已有学习历史；有进度时回到同一本书、实际训练页。
- 书库进入教材再返回必须保留系列、搜索词和原滚动位置；优先利用保留页面实例和原生页面栈，不新增全局列表状态仓库。
- 23 本书均保持可访问；未知教材、非整数/越界页码、版本不匹配或损坏的本机进度必须安全忽略。
- 代码中文注释，Conventional Commit 类型前缀保持英文（如 `feat:` / `fix:` / `test:` / `docs:`），冒号后使用中文；只提交任务文件，不推送、不合并、不部署云函数、不修改用户两份 project 配置。

## Task 1: 完成已确认的书架精修和真实继续跟读

**Files:**
- Create: `src/features/bookLibrary/readingProgress.ts`
- Modify: `src/pages/Home/Home.tsx`, `src/pages/Home/Home.scss`, `src/pages/BookLibrary/BookLibrary.tsx`, `src/pages/BookLibrary/BookLibrary.scss`
- Modify: `src/pages/Practice/Practice.tsx`（只新增进度模块 import 和保存当前合法训练位置的 Hook，不重构原录音逻辑）
- Test: 新增 `scripts/test-reading-progress.cjs`、`scripts/test-bookshelf-polish.cjs`；更新受影响的首页/书库/响应式测试。

**Interfaces:**

```ts
export type ReadingProgress = { version: 1; bookId: string; practiceIndex: number };
export const READING_PROGRESS_KEY = 'haisha:reading-progress:v1';
export function readReadingProgress(): ReadingProgress | null;
export function saveReadingProgress(bookId: string, practiceIndex: number): boolean;
```

模块读取/写入 Taro getStorageSync/setStorageSync，解析时验证真实 bookPractice bundle。储存不可用/写入失败不得阻断跟读，返回 null/false，不显示每页弹窗；不主动清理用户其他存储。不要引入计分/完成度或网络同步。Home 初始加载和 useDidShow 都重新读取定位；Practice 内部翻页只在 setCurrentPractice 实际生效后保存，取消切页不保存目标页。

- [x] 测试：模块与标签测试先 RED，真实组件 Hook harness 补充集成回归，覆盖空历史首页、翻页后保存、Home 返回刷新、损坏数据、Storage 失败、列表隐藏/重显后筛选保持。执行顺序与原计划略有不同，页面联动测试没有冒称实施前 RED。
- [x] GREEN：新增阅读定位模块，连接 Home 与 Practice；新用户展示选择入口，不显示虚假的“上次”；重返首页显示真实封面、章节与教材页。点击路由包含已验证的 bookId 和 practiceIndex。
- [x] RED：增加可见标签/册别呈现与 SCSS 编译后布局契约测试；旧标签断言失败，Pad 分隔线追加回归先失败再修正。
- [x] GREEN：统一主内容/标题/搜索/列表左对齐；弱化未选筛选边框与封面阴影；分隔线从文字区域开始。删除死状态选择器，保留 MyCheckIns 既有无录音引导语义。
- [x] 验证：36 个 `scripts/test-*.cjs` 各自独立进程通过；兼容类型检查、修改文件 ESLint、小程序无缓存构建通过。
- [x] 自查并提交；已记录 RED/GREEN 结果和既有依赖警告，浏览器替代验证与微信真机验收明确区分。

## 控制器验收与独立复核

- [x] 任务规格/质量与最终全分支独立复核均通过；最终复核发现的首页长标题两行限制已修复并窄范围复查，无遗留 Critical / Important / Minor。
- [x] 用生产组件与打包后 WXSS，在 Edge 无头浏览器验证 5 个尺寸、7 种状态，共 35 个场景（含英文/中文/中英混合长书名）；均满足留白、标题最多两行、封面/分隔线对齐、筛选触区和无横向溢出。微信原生安全区及页面栈滚动恢复保留真机验收。
- [x] 已更新本计划和 `docs/qa/2026-09-12-bookshelf-polish.md`，保留新分支，交用户编译验收，不自动推送。
