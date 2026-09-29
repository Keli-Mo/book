# Oxford Discover 6 两册接入与云存储核验

日期：2026-09-29。源目录：`E:\project\haisha-book\OD2e L6 Audio`。执行依据为已复核的 OD6 接入方案和现有整本电子书规则。

## 素材来源与保留范围

| 教材 | ID | PDF 页数 | 保留 PDF 页 | 页图尺寸 | 源 PDF SHA-256 |
| --- | --- | ---: | --- | --- | --- |
| Oxford Discover 6 学生书 | 30 | 202 | 1–201 | 1536 × 1987 | `4d7bdacb89181bfce458328ad2b78efaaa8f0c067d664cc26b4b9bf06a0d0bde` |
| Oxford Discover 6 练习册 | 31 | 187 | 1–185 | 1536 × 1984 | `fe6f46981cd5240416843629f1ffa6f377cb8b43191f57db8e02ae532620359d` |

直接提取 PDF 的每页内嵌 JPEG，没有再次压缩、拉伸或裁掉题目。386 张页图逐一与 PDF 内嵌图像的 SHA-256 一致；所有保留页的尺寸分别一致。页图文件零基索引等于 PDF 页号减一，本书正式内容的印刷页号与图片索引一致。

按已确认方案排除学生书 PDF 第 202 页版权致谢；练习册 PDF 第 186 页第三方二维码广告、第 187 页版权致谢。其余官方页面全部可翻阅，包含无音频页及跨页续页。

## 音频与页面

原目录共有 165 个学生书 MP3，Disc 1–4 分别为 36、37、38、54 个。没有练习册配套音频。所有 MP3 与源文件 SHA-256 一致，全部上传保存。

页面只映射 130 个正式音轨，分布在 93 页：`1.02–1.36`、`2.02–2.37`、`3.02–3.38`、`4.02–4.23`。每个正式音轨仅映射一次，沿用历史音频键 `imageIndex + 2` 和百分比坐标。

以下 35 个音频已上传但不设置页面图标，供复核：

- `1-01 Oxford Discover Student Book 6.mp3`
- `2-01 Oxford Discover Student Book 6.mp3`
- `3-01 Oxford Discover Student Book 6.mp3`
- `4-01 Oxford Discover Student Book 6.mp3`
- `4-24 Oxford Discover Student Book 6.mp3` 至 `4-54 Oxford Discover Student Book 6.mp3`，共 31 个书内无正式印刷标记的额外音轨。

18 篇 Reading 的跨页续页保留，图标只放在第一页：10–11、18–19、30–31、38–39、50–51、58–59、72–73、80–81、92–93、100–101、112–113、120–121、134–135、142–143、154–155、162–163、174–175、182–183。

练习册明确登记为空音频映射，仅 ID 31 允许零示范音频；185 页均可自主录音、回听、完成练习。普通教材缺失音频数据仍被验证拒绝。

## 微信云存储

环境：`cloud1-6geu18jg425a604e`。独立前缀：`oxford-discover-2e-l6/`。

| 目录 | 对象数 |
| --- | ---: |
| `student-book/pages/` | 201 |
| `student-book/audio/disc-1/` | 36 |
| `student-book/audio/disc-2/` | 37 |
| `student-book/audio/disc-3/` | 38 |
| `student-book/audio/disc-4/` | 54 |
| `workbook/pages/` | 185 |
| 合计 | 551 |

图片为 189,440,964 字节，音频为 169,343,429 字节，总计 358,784,393 字节。上传前目标目录为空。批量上传期间 10 个对象遇到连接中断，CLI 串行重试成功；最终云清单证明所有对象完整。

远端路径、对象数、逐项大小、总字节数全部与 manifest 一致，无缺失或额外对象。551 个 ETag 均与本地 MD5 相同；没有分片对象。551 个公开地址的 HEAD 均返回 HTTP 200 且 Content-Length 正确，Range 首字节请求均返回 HTTP 206 且 Content-Range 总大小正确。

本地核验材料保存在忽略提交的 `.temp/od6-assets/`：`manifest.json`、六份 `cloud-list-*.json`、`prepare_od6_assets.py`、`verify_cloud_manifest.py`、`check_public_head.py`、`check_public_urls.py`。页面和音频大文件不进入 Git。

## 接入与验收

沿用现有 `PracticeSession` 页面及目录、录音、预加载与节点复用框架。Oxford Discover 书架更新为 Level 1–6，两册从封面进入完整阅读。固定画布在首帧预留比例，图片加载和翻页时保持同一外框；热点坐标以实际图面为准。

音频按钮使用原有播放、暂停及编号样式。OD6 的印刷音轨标签常位于题干末尾，坐标依据印刷标记确认对应题目后，放在同题旁的留白；Reading 按钮位于 Read 横幅音轨标签处，避开 Read 文字和故事标题。保留原有 44px 点击范围与边界约束。

93 个音频页、130 个点均按约 384px 图宽的手机尺度联系图逐页核验，高风险页另查原分辨率整页或圆圈加编号的轮廓图。10 页共 13 个点做人工覆盖：p14、23、42、55、85、97、104、124、179、186；18 篇 Reading 使用 `18.5% / 5.296%`。p186 的 Speaking 4.21 改为 `65% / 47%`，避免右下编号压到 C 题干；该缺陷已增加专项回归断言，先失败后通过。

供用户重点核验的取舍（均为学生书印刷页号）：

- p42、55、97、124、179、186 的长题干或紧凑标题旁间隙不足，按钮位于同一题标题行右侧，距原印刷标记较远，请核验对应关系是否直观。
- p42 的 B 按钮、p62 的编号略盖无字照片角；p23 可能覆盖辅助词典箭头，正式题干和答案均保留可读。
- 原始坐标、新坐标、选择原因和位移保存在 `.temp/od6-hotspot-review/candidate-audit.json`；93 张逐页 overlay、8 张联系图及 `final-risk-crops.jpg` 同目录保存。暗像素统计仅作提示，图片与装饰线会产生非零值，不作为遮字判断。

播放生命周期沿用现有规则：翻页继续当前音频；开始录音或离开阅读页停止示范音频。练习册没有示范音频，使用同一录音、回听和完成练习流程。

全书架汇总：29 册、4,958 张图片、1,694 个音频页、2,640 个音频热点。旧教材的音轨和页面映射保留。

两册 36 个单元起页逐项与源图 Unit 标识、页脚及原书目录核对；学生书 Dictionary 图片索引 192、练习册 Student’s Writing Resource 图片索引 182 正确。学生书奇数单元从原书目录所列的双单元 Big Question 封面开始。

使用生产数据实际运行学生书 p10 → p11：音频实例数仍为 1，进度保持 6.25 秒，翻页未产生 pause、stop 或 destroy；顶部播放器保留，续页无重复热点。隐藏页面后音频实例正常释放。

已完成的验收：

- `yarn test:regression`：215 项通过，0 失败、0 跳过。
- 6 个改动的生产 TypeScript/TSX 文件 ESLint 通过；`git diff --check` 通过。
- `yarn tsc --noEmit --skipLibCheck` 通过。直接运行不带 `skipLibCheck` 的类型检查会在既有 Taro/第三方依赖声明中报错，未修改依赖或放宽项目配置。
- 本机 `yarn build:weapp` 的包脚本未找到 `taro` 命令；使用同一个已安装 CLI 的入口 `node node_modules/@tarojs/cli/bin/taro build --type weapp` 完成最终构建（Webpack 6.96 秒），随后 `node scripts/validate-page-registration.cjs` 通过。构建保留既有 Sass、Browserslist 与包体大小警告，无编译错误。
- 生产音频校验器通过：29 本、4,958 图、1,694 音频页、2,640 热点；只有旧 ID 6/24 的 2 个轻微越界警告。

最终页面预览：12 个代表页面 × 手机/平板横竖屏，共 48 组通过；240 个主测量帧及 6 个书内滚动检查均无横向溢出，生成 58 张截图。样本包含学生书封面、Reading 首/续页、p14、p30、p104、p186、Testing 3，以及练习册封面、首/中/末页。

| 阶段 | 覆盖组数 | 外框最大变化 |
| --- | ---: | ---: |
| 竖屏首帧 → 原生测量返回 | 24 | 0.375 CSS px |
| 测量返回 → 图片信息返回 | 48 | 0 CSS px |
| 图片信息返回 → 翻页回调前 | 48 | 0 CSS px |
| 翻页回调前 → 新页回调完成 | 48 | 0 CSS px |

截图和测量执行生产 `Practice` TSX 与最终编译 WXSS，通过已有原生 API 测试夹具延迟测量及图片回调；云图片 URL 保留在页面 DOM，图片请求由本地提取的相同源文件响应。`results.json` 记录的生产源文件与 WXSS 哈希已重新核对当前文件一致。p14、p30、p104、p186 和 Testing 3 另做实际布局视觉抽查；横屏滚动后的 p186 圆圈和编号避开 B 第 5 句及 C 题干，p30 按钮仍在 Read 横幅内。

本机证据保存在 `.temp/od6-preview/`：`capture.cjs`、`output/results.json`、`output/summary.json`、PNG/HTML 预览、`regression-final.log` 与 `build-final.log`。这些临时素材不提交 Git。

验证边界：共享横屏框架在首次测量返回前外框为 `0×0`，测量后图片加载和翻页保持稳定；本次固定首帧画布覆盖两册竖屏。预览模拟原生回调，微信真机渲染、滑动动画、实际声音播放和麦克风录音仍需真机核验。
