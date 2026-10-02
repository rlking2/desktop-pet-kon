# 第 31 轮：把第 9–30 轮的改动补进 Git + 阶段 2 开工前的环境核验

主人这一轮的原话：

> **「既然能跑就先把之前的改动git弄完，然后准备进入阶段2」**

这一轮**没有改一行功能代码** —— 做的是两件事：给 22 轮的成果补上版本库兜底，和把阶段 2 的开工前置条件核验清楚。

## ① 补 Git：22 个文件、+5598/−329 行、55 个工作树条目

最后一次提交停在 **2026-09-24 16:13**（`b341f0e`，第 8 轮"固化播放速度 0.49×"）。
也就是说第 9–30 轮（资产管线、素材清理工具、安装包、布局重构、逐像素判定、接入大模型对话）
**全部没有版本库兜底**，只有一堆未跟踪文件躺在工作树里。

### 按细则第 9 条先盘工作树，再决定怎么切

盘完分四类：**源码**（main.js / renderer / lib / scripts）、**素材**（`assets/`，约 8 MB 立绘）、
**文档**（README / devlog / docs）、**可再生产物**（`dist/`、`dist-installer/`、`artifacts/`）。

产物类**确认全部命中 `.gitignore`**（逐个用 `git check-ignore -v` 验过）：

| 路径 | 结果 |
|---|---|
| `artifacts/selfcheck.json` | 忽略 ← `.gitignore:2:artifacts/` |
| `dist/桌宠便携版/resources/app/main.js` | 忽略 ← `.gitignore:3:dist/` |
| `dist-installer/桌宠-安装包-0.2.0.exe` | 忽略 ← `.gitignore:4:dist-installer/` |
| `dist-installer/琴吹紬.rar`（114 MB，主人自己放的） | 忽略 ← 同上 |
| `node_modules/`、`_fixtures/`、`assets/build/`、`assets/manifest.json` | 全部忽略 ✅ |

### 入库前的两道检查（**这不是形式**）

1. **密钥扫描**：正则扫 `sk-…` / `api_key=` / `PRIVATE KEY` / 个人绝对路径，**只命中 1 处** ——
   `main.js` 自检里的 `sk-selftest-not-real`（**假钥匙，故意写死**，专治"自检偷偷联网花钱"）。
   真钥匙在 `%APPDATA%\dsh-desktop-pet\api-config.json`，**不在仓库里**。
2. **体积审查**：最大的是 `assets/idle/frame-01.png` 1.2 MB、`assets/happy/frame-02.png` 1.5 MB，
   素材合计约 8 MB —— 属正常源码级资产，不是产物。

### 切了 5 个提交（为什么不切成更多）

| 提交 | 内容 | 为什么这么切 |
|---|---|---|
| `3bdf615` | 资产管线：立绘分组 + 6 个素材清理/预览工具 + `lib/assets.js` | 与主程序正交，单独可回退 |
| `581efd8` | 打包链：`make-exe.js` / `make-icon.js` / `electron-builder.config.js` / `package.json` | 与运行时逻辑正交 |
| `266386e` | devlog 第 9–30 轮 | 纯文档 |
| `06c5c5f` | `assets/README.md` + `docs/动画清单.md` | 纯文档 |
| `2bc2c0c` | **主程序**：`main.js` / `preload.js` / `renderer/*` / `lib/chat.js` / `lib/api-config.js` / `scripts/autotest.js` / `README.md` / `.gitignore` | **不能拆** —— 见下 |

**为什么主程序那坨必须是一个提交**：`main.js` / `renderer.js` / `style.css` 三个文件被
第 26→30 轮**反复互相修改**（布局撤网格、逐像素判定、悬停延时、气泡落位都是同时改这三处）。
按"功能"硬拆会造出 `main.js` 已改、`renderer.js` 没跟上的中间提交 ——
**那些提交是跑不起来的**，等于把"每个提交都可运行"这条底线换掉。
宁可提交粒度粗一点，也不要假历史。（人家把这句写进提交信息了，免得下次有人想"优化"它。）

### 验证：提交后的 HEAD 仍是绿的

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE   # ← 见 ②，不清会崩
npm run verify
#   ===== 结果: 121/121 ✅ 全部通过 =====
#   ===== 5/5 ✅  → artifacts\image-inspect.json =====
```

`git status --short` **空**、`git diff --check` 与 `git diff --cached --check` **无输出**。
终态按细则第 9 条取的是**源码干净**：无未提交源码；`dist/`、`dist-installer/`、`artifacts/`
按设计留在本地（**没有**执行 `git clean`，也没删任何东西）。

> ⚠️ 只做了**本地 commit**，**没有 push**（主人没给这个授权，人家也不会自己推导）。
> 现在 `main` 比远端领先 5 个提交。

## ② **致命环境坑：`ELECTRON_RUN_AS_NODE=1` 会让桌宠根本起不来**

这是本轮最有价值的发现，因为**它的症状和"代码坏了"一模一样**：

```
main.js:82
const gotLock = app.requestSingleInstanceLock();
TypeError: Cannot read properties of undefined (reading 'requestSingleInstanceLock')
```

**根因**：DSH 会话环境里带着 `ELECTRON_RUN_AS_NODE=1`。这个变量要求 Electron
"只当纯 Node 跑"，于是 `require('electron')` **不返回 API 对象，只返回一个 exe 路径字符串** ——
`app` 自然是 `undefined`。实测：

```powershell
node -e "console.log(typeof require('electron'))"
# string "C:\...\node_modules\electron\dist\electron.exe"     ← 有毒时
# object                                                       ← 清掉之后
```

**它会继承给子进程**，所以 `npm start` / `npm run autotest` / `npm run verify` 全中招，而
`npm run exe`（纯 fs 拷文件、不启动 Electron）**不受影响** —— 这也解释了为什么"打包好好的、
一跑就崩"。

**修法**（在本会话里跑任何 Electron 命令之前）：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE
```

> 📌 **不是项目 bug，是环境寄生变量**。主人自己在普通终端里 `npm start` 不受影响；
> 但**以后任何 AI 会话**在本工作区跑自检/启动，都必须先清它 —— 所以记在这里。

## ③ 顺带发现的文档漂移（本轮只记录，未改）

| 位置 | 写的 | 实际 |
|---|---|---|
| `README.md` 目录结构里 `main.js` 那行 | `自检(102 断言)` | **121** 条 |
| README 「🔍 自检机制」小标题 | 「当前素材模式 102 条」 | **121** 条（同节下方又写 121，自相矛盾） |
| `scripts/inspect-image.js` 注释 | 「10 断言」 | 帧动画模式下实跑 **5/5**（配色/形状类按设计跳过） |

不改的理由：这几处**不影响任何功能与判据**，而 README 正被阶段 2 的改动覆盖 ——
留到阶段 2 那轮一起收口，免得现在改一次、下轮再改一次。

## ④ 阶段 2 开工前置核验

| 核验项 | 现场结果 |
|---|---|
| 工作记录连续性 | devlog 第 1–31 轮完整，第 30 轮已闭环 |
| 工具链 | Node v24.20.0 ✅、`node_modules\electron\dist\electron.exe` ✅ |
| 开发版自检 | **121/121 ✅** |
| 像素分析 | **5/5 ✅** |
| 便携版是否与源码同步 | `main.js`/`preload.js`/`renderer/*`/`lib/*` **逐个 SHA256 与仓库源码一致**，且含第 30 轮的 `HOVER_DELAY_MS = 300` ✅ |
| 安装包 | `dist-installer\桌宠-安装包-0.2.0.exe`（109.8 MB，2026-09-27 09:50）与便携版同源 |
| 主人正在跑的那只 | 在跑（本会话没打扰它：自检走 `--user-data-dir` 隔离，未触发单实例锁冲突） |

**阶段 2 候选**（README「下一步」原样保留，未删未改）：

1. 她会自己找主人说话（空闲随机开口，**必须带限频 + 静音开关**）
2. 对话历史落盘（重启还记得）
3. 语音：TTS / 语音输入
4. 换掉占位立绘、多表情状态（换形象后**必须**重算穿透掩码）
5. 系统托盘图标
6. 多屏支持 + 记住上次位置
7. 开机自启
8. 窗口缩放（拖拽改大小，掩码跟着重算）

## 改动文件

| 文件 | 改动 |
|---|---|
| （功能代码） | **一行没改** —— 本轮只做版本库收口与环境核验 |
| `devlog/round-31.md` | 本文件 |
| `README.md` | 进度摘要补第 31 轮；「已知限制」补 `ELECTRON_RUN_AS_NODE` 陷阱；「下一步」整理为阶段 2 候选 |
| `%APPDATA%\dsh-desktop-pet` | **未动**（主人正在跑的那只数据安全） |
| `dist/`、`dist-installer/`、`artifacts/` | **未重新打包、未删改** |
