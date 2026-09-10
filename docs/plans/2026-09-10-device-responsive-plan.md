# 手机与 Pad 响应式适配实施计划

> **执行要求：** 使用 `subagent-driven-development` 按任务实施；纯函数和页面契约均先写失败测试。

**目标：** 让 Home、BookLibrary、Practice、CheckInDetail、MyCheckIns 在手机、iPad、Android Pad 横竖屏和分屏窗口中保持完整、可读、可点击。

**架构：** 纯函数计算设备布局，Hook 只负责订阅窗口变化；页面通过共享 class 和局部 SCSS 响应。教材热点以实际图片盒子为坐标系，布局变化不重建音频或录音对象。

**技术栈：** Taro 窗口 API、React Hook、SCSS media/layout class、Node `assert`。

## 全局约束

- 横屏手机仍单栏；Pad 1024×768 与 1280×800 才进入双栏。
- 所有主要按钮与热点命中区不小于 44 CSS px。
- 教材页完整显示，快照使用 `aspectFit`。
- 五页均处理底部安全区和长文本。

---

### Task 1：设备与热点纯函数

**Files:**

- Create: `src/features/layout/deviceLayout.ts`
- Create: `src/features/listeningPractice/hotspotLayout.ts`
- Create: `scripts/test-device-layout.cjs`
- Create: `scripts/test-hotspot-layout.cjs`
- Modify: `package.json`

**Interfaces:**

```ts
export function calculateDeviceLayout(input: DeviceLayoutInput): DeviceLayoutProfile;
export function clampHotspotCenter(
  point: { left: number; top: number },
  imageSize: { width: number; height: number },
  hitRadiusPx?: number,
): { left: number; top: number };
```

- [ ] 写 320×568、430×932、844×390 手机，以及 768×1024、1024×768、800×1280、1280×800 Pad 的失败测试。
- [ ] 覆盖 960×599 Pad 降级、安全区缺失和零尺寸热点。
- [ ] 运行两个新测试并确认模块缺失导致失败。
- [ ] 最小实现设计中的短边、方向、双栏阈值和 22px 半径收敛。
- [ ] 运行测试确认通过。
- [ ] 提交 `feat: 增加设备布局与热点适配模型`。

### Task 2：窗口订阅与导航回退

**Files:**

- Create: `src/hooks/useDeviceLayout.ts`
- Modify: `src/features/bookLibrary/homeNavigation.ts`
- Modify: `src/pages/Home/Home.tsx`
- Modify: `scripts/test-home-navigation.cjs`

- [ ] 先测试无效状态栏/胶囊回退及 Hook 注册、解除同一 resize 回调。
- [ ] 运行测试确认失败。
- [ ] Hook 初始读取窗口信息并订阅 `onWindowResize`，只更新布局 state。
- [ ] Home 在 resize 后重新计算导航，但音频/录音组件不依赖布局 state。
- [ ] 运行测试确认通过。
- [ ] 提交 `feat: 响应窗口变化并兼容导航安全区`。

### Task 3：固化五页响应式契约

**Files:**

- Create: `scripts/test-responsive-page-contract.cjs`
- Modify: `package.json`

- [ ] 先断言 `app.config.ts` 启用 `resizable`，五页配置使用 `pageOrientation: "auto"`。
- [ ] 断言五页共享布局 class、最大宽度、安全区双声明、44px 触控和长文本策略。
- [ ] 断言 Practice 为 `widthFix`，CheckInDetail/MyCheckIns 教材快照为 `aspectFit`。
- [ ] 运行测试确认页面尚未接线导致失败。
- [ ] 提交 `test: 固化手机与Pad页面适配契约`。

### Task 4：实现五页布局

**Files:**

- Modify: `src/app.config.ts`
- Modify: `src/app.scss`
- Modify: `src/pages/{Home,BookLibrary,Practice,CheckInDetail,MyCheckIns}/*.config.ts`
- Modify: `src/pages/{Home,BookLibrary,Practice,CheckInDetail,MyCheckIns}/*.tsx`
- Modify: `src/pages/{Home,BookLibrary,Practice,CheckInDetail,MyCheckIns}/*.scss`
- Modify: `src/pages/Practice/PracticeDirectory.tsx`

- [ ] 在全局配置启用 iPad resize，各页面允许自动方向。
- [ ] 增加共享根 class、内容最大宽度和安全区规则。
- [ ] Home 保持单栏并限制 Pad 宽度；BookLibrary 和 MyCheckIns 在宽 Pad 使用双列。
- [ ] Practice 增加 `practice-workspace`：双栏为 `minmax(480px, 1fr) minmax(320px, 420px)` 与 24px 间距。
- [ ] 目录在手机/Pad 竖屏保持底部抽屉，在宽 Pad 横屏使用侧栏。
- [ ] 热点拆为 44px 命中外壳和视觉内圆，图片加载/resize 后用实际盒子收敛中心。
- [ ] CheckInDetail 改为 `aspectFit`，五页按钮/文本在 320px 和大字号下可折行。
- [ ] 运行响应式、热点、导航和既有 UI 测试。
- [ ] 提交 `feat: 适配手机与Pad横竖屏布局`。

### Task 5：响应式阶段回归

- [ ] 运行业务类型检查和微信构建。
- [ ] 用开发者工具覆盖规格中的 7 组窗口尺寸。
- [ ] 旋转 Pad 时检查训练索引、播放和录音状态不被布局 Hook 重建。
- [ ] 将无法自动验证的真机项目写入最终验收清单。
