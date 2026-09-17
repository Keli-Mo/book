# 回听会话集成回归补强报告

## 原因与根因

基线 `2e1fd64` 下，返回导航测试仍把回听释放旧 API 假设为原生 `stop` 事件。Task4 已将回听迁入 `createTrackAudioController`：停止会话时先使会话失效，再直接 `destroy` 原生实例；详情页 `hide` 同步重置播放 UI，`unload`/`dispose` 只会再次释放空会话。因此失败是测试与当前生命周期契约不一致，不是生产控制器功能故障。

## TDD/验证证据

### RED

命令：

```powershell
& 'C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' scripts/test-check-in-return-navigation.cjs
```

输出：

```text
AssertionError [ERR_ASSERTION]: 离开详情时必须停止回听
    at E:\REPOSITORY\haisha\haisha\.worktrees\all-books-device-recording\scripts\test-check-in-return-navigation.cjs:46:10
...
EXIT=1
```

该 RED 精确落在旧的 `events.includes("stop")` 断言；生产路径实际应记录一次 `destroy`。

### GREEN

命令：

```powershell
& 'C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' scripts/test-check-in-return-navigation.cjs
```

输出：

```text
打卡返回测试通过：原书原页、继续录音、停止回听、显式首页与独立分享入口。
EXIT=0
```

精确断言当前保存路径对应的实际原生音频实例存在且已 `play`；`detail.hide()` 后该实例恰好 `destroy` 一次，按钮恢复 `▶播放本次跟读`，时长不再显示当前/总时长；随后 `unload`/`dispose` 不重复 `destroy`，也不创建新实例。原书原页、继续录音、首页/独立入口、原教材图片/进度、零上传和返回方法断言均保留。

## 指定回归结果

固定 Node：`C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`

命令：

```powershell
$node = 'C:/Users/23237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'; & $node scripts/test-check-in-return-navigation.cjs; $r1 = $LASTEXITCODE; & $node scripts/test-check-in-detail-runtime.cjs; $r2 = $LASTEXITCODE; & $node scripts/test-audio-playback.cjs; $r3 = $LASTEXITCODE; & $node scripts/test-practice-book-route.cjs; $r4 = $LASTEXITCODE; "EXIT return=$r1 detail=$r2 audio=$r3 route=$r4"; if (($r1 -ne 0) -or ($r2 -ne 0) -or ($r3 -ne 0) -or ($r4 -ne 0)) { exit 1 }
```

输出：

```text
打卡返回测试通过：原书原页、继续录音、停止回听、显式首页与独立分享入口。
录音详情运行时测试通过：本地零云请求、离页分享门闩、隐藏提交恢复、长计时器与云播放迟到均正确。
音频播放测试通过：首次停止保护、离页停止与分享进度均正确。
音频教材回归通过：换书、换训练停止两路音频，目录布局变化保持播放。
教材路由测试通过：真实路由、首尾边界、恢复页、教材内容、打卡与历史回跳正确。
EXIT return=0 detail=0 audio=0 route=0
```

任务 diff 检查：

```powershell
git diff --check -- scripts/test-check-in-return-navigation.cjs .superpowers/sdd/full-audit-return-release-report.md
```

输出：`git diff --check: clean`，退出码 `0`。

## 变更文件

- `scripts/test-check-in-return-navigation.cjs`：改为按保存路径定位实际回听实例，并精确验证 `play`、hide 后单次 `destroy`、UI 复位及卸载幂等性。
- `.superpowers/sdd/full-audit-return-release-report.md`：本报告。

## 自查与疑点

- 未修改生产控制器、既有 IDE 配置或其他 dirty 文件；未运行全套测试、未联网、未部署、未 push。
- 未进行真机验收；报告仅记录本地 Node 测试双桩对当前生命周期契约的验证。
- Commit：本地提交 `test: 对齐返回页面的音频会话释放断言`；最终短 SHA 由 `git rev-parse --short HEAD` 精确读取。
