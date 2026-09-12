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
- 代码中文注释，提交为 `feat:` / `fix:` + 中文；只提交任务文件，不推送、不合并、不部署云函数、不修改用户两份 project 配置。

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

- [ ] RED：先用真实组件 Hook harness 构建空历史首页、翻页后保存、Home 返回刷新、损坏数据、Storage 失败、列表隐藏/重显后的筛选保持测试。先运行并记录旧代码失败的具体断言，不能仅断言 mock 调用。
- [ ] GREEN：新增阅读定位模块，连接 Home 与 Practice；新用户展示选择入口，不显示虚假的“上次”；重返首页显示真实封面、章节与教材页。点击路由必须包含已验证的 bookId 和 practiceIndex。
- [ ] RED：增加可见标签/册别呈现与 SCSS 编译后布局契约测试，验证手机/Pad 基础内边距、筛选最小触区、保留搜索/筛选和导航箭头。
- [ ] GREEN：统一主内容/标题/搜索/列表左对齐；弱化未选筛选边框与封面阴影；分隔线从文字区域开始。删除死状态选择器，清理被当前范围取代的固定默认入口测试，但保留 MyCheckIns 既有无录音引导语义。
- [ ] 验证：运行所有 `scripts/test-*.cjs`（每脚本独立进程），类型检查 `npx tsc --noEmit --skipLibCheck --noUnusedLocals false --noUnusedParameters false`，修改文件 ESLint、`npm run build:weapp -- --no-cache`。
- [ ] 自查并提交；报告精确 RED/GREEN 命令、结果及已知依赖警告，不将测试桩检查称作真机验收。

## 控制器验收与独立复核

- [ ] 独立 diff 复核规格与代码质量，检查阅读位置与录音会话隔离、样式覆盖、隐藏/重显行为；修复重要问题后复查。
- [ ] 尽可能做手机小屏/标准屏/Pad 的布局截图，核对左右留白、长标题、空/有历史和状态标签；如果原生 UI 控制不可用，明确截图验证的替代环境和真机待验项。
- [ ] 更新本计划和结果记录，保留新分支，交用户编译验收，不自动推送。
