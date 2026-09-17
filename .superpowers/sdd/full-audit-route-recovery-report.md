# 全量审计：无效训练路由恢复

## 摘要

无效或损坏教材路由的“选择教材”入口改用 `Taro.redirectTo`，恢复书库时替换当前错误页，避免错误页残留在返回栈。测试同时覆盖普通非法参数和教材构建失败分支。

## TDD 证据

### RED

命令：

```powershell
& 'C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' scripts/test-practice-book-route.cjs
```

结果：exit 1。新增断言按预期失败：`actual 'navigateTo'`、`expected 'redirectTo'`，位置为 `scripts/test-practice-book-route.cjs:1557:12`。

### GREEN

命令及结果：

```powershell
& 'C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' scripts/test-practice-book-route.cjs
# exit 0
# 教材路由测试通过：真实路由、首尾边界、恢复页、教材内容、打卡与历史回跳正确。

& 'C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' scripts/test-practice-recording-wiring.cjs
# exit 0
# 训练页录音接线测试通过：状态机、切页竞态、本地完成与详情路由已进入生产路径。

& 'C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' scripts/test-audio-playback.cjs
# exit 0
# 音频播放测试通过：首次停止保护、离页停止与分享进度均正确。
# 音频教材回归通过：换书、换训练停止两路音频，目录布局变化保持播放。

& 'C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' node_modules/typescript/bin/tsc --noEmit --skipLibCheck
# exit 0，标准输出为空
```

## 文件与变更

- `src/pages/Practice/Practice.tsx`：错误态“选择教材”从 `navigateTo` 改为 `redirectTo`。
- `scripts/test-practice-book-route.cjs`：普通非法路由与损坏教材均断言最后导航方法为 `redirectTo`。
- `.superpowers/sdd/full-audit-route-recovery-report.md`：本审计报告。

## 提交

本地提交 subject：`fix: 恢复教材时移除失效训练页`。

## 自查

- 仅修改 brief 允许的两个任务文件及本报告；保留其他既有 dirty 文件。
- 未修改文案、布局、数据模型、合法路由、录音或分享逻辑。
- `git diff --check` 无新增空白错误；未部署、未 push、未联网。
