# 第 2 轮：窗口瘦身 + 逐像素鼠标穿透

日期：第 2 轮开发
目标：主人反馈窗口太大 → 先做鼠标穿透

## 本轮交付

| 文件 | 变更 |
|---|---|
| `lib/click-through.js` | **新增** 核心模块：alpha 掩码生成 + 定时命中检测 + 手动拖动 |
| `main.js` | 窗口 260×320 → **200×250**；接入穿透；拖动 IPC；自检扩到 29 条 |
| `renderer/style.css` | 全部尺寸缩小（角色 130×130）；去掉 CSS drag 区域 |
| `renderer/renderer.js` | mousemove 穿透上报（elementFromPoint）、手动拖动、穿透测试入口 |
| `renderer/index.html` | 边框标注更新为 200×250 |
| `preload.js` | 暴露 pointerHit / dragStart / dragEnd / getBounds |
| `scripts/probe-clickthrough.ps1` | **新增** 端到端 OS 层穿透验证 |
| `scripts/verify-windows-clickthrough.ps1` | **新增** Win32 读 WS_EX_TRANSPARENT |
| `scripts/list-windows.ps1` | **新增** 枚举可见窗口（排查用） |
| `scripts/start-debug.js` | **新增** 带红框启动 |

## 本轮自检发现的 4 个真问题

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | **窗口越拖越大**（5 轮 204×254 → 211×261） | 拖动循环把 `getBounds()` 的 DPI 取整结果当原尺寸回写，误差累积 | 拖动时固定用设计逻辑尺寸 200×250，不回写实测值 |
| 2 | 自检把桌宠**搬到了屏幕中间**（1477,787 → 681,837） | 拖动测试真调了 `setBounds` | 加 `dryRun` 模式：走完整链路但不搬窗口 |
| 3 | `FindWindow` 找不到窗口 | 高 DPI / 透明窗口下按标题查找不可靠 | 改用 `EnumWindows` 遍历匹配标题 |
| 4 | PowerShell 脚本中文乱码报错 | PS 5.1 按系统 ANSI 码页读 `.ps1` | 脚本存为 **UTF-8 with BOM** |
| 5 | 穿透断言失败（`isIgnoringMouseEvents` 不存在） | Electron 44 没这个查询 API | 主进程改验状态机；OS 层交给外部 Win32 探针 |

## 关键技术决策

**1. 为什么拖动必须自己实现**
CSS `-webkit-app-region: drag` 只认矩形，与逐像素穿透冲突（留白也会被当可拖动区域）。
改为：mousedown 记偏移 → 主进程 12ms 循环 setBounds → mouseup 结束。

**2. 穿透的判定用"双通道"**
- 渲染层 `elementFromPoint` → 即时响应（~60fps，限流 16ms）
- 主进程 60ms 轮询 alpha 掩码 → 兜底（窗口外、渲染层卡住时仍正确）

**3. `forward: true` 是穿透能工作的前提**
`setIgnoreMouseEvents(true, { forward: true })` 让窗口在穿透态下仍收到 mousemove，
否则鼠标一移入留白就再也收不到事件，无法判断何时该收回交互权。

**4. Electron 44 无法自证 OS 层状态**
没有 `isIgnoringMouseEvents()`。所以做了 Win32 探针：探针模式下主进程故意来回翻转穿透态，
外部脚本读 `GWL_EXSTYLE` 的 `WS_EX_TRANSPARENT (0x20)` 位。
**实测 EXSTYLE 在 `0x00280028`(穿透) ↔ `0x00200008`(可交互) 之间真实切换** —— 这是硬证据，
比任何"日志说成功了"都可信。

## 本轮数据

- 自检断言：**29/29 PASS**（几何 11 + 穿透 5 + 交互 13）
- 像素分析：**10/10 PASS**（覆盖率 24.3%，上半身重心 x=0.543）
- OS 级探针：**PASS**（双向切换 15:1）
- 窗口体积：260×320 → **200×250**（面积减少约 40%）
- 穿透掩码：306×381 → 77×96，实体占比 19.7%（bdbox 只覆盖角色本体区域）

## 已知限制

1. 穿透掩码是**启动时快照** —— 换立绘/改尺寸必须重新 `refreshMask()`
2. `.ps1` 必须是 UTF-8 BOM，否则 PS 5.1 乱码
3. 审美仍未验证（模型无图片输入能力）
4. 形象仍是 SVG 占位图

## 下一轮候选

- 接入真实立绘（同时解决掩码重算）
- 系统托盘 + 开机自启
- 多屏位置记忆
