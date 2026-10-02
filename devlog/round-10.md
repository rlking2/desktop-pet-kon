# 第 10 轮：打成「双击就能开」的桌宠.exe

主人的原话：**「一直需要打开控制台才能打开桌宠太麻烦了，能不能制作一个exe文件，可以一键打开」**。

## 结论先放这儿

| 产出 | 路径 |
|---|---|
| 主程序 | `dist\桌宠便携版\桌宠.exe` |
| 整个便携包（可挪走 / U 盘） | `dist\桌宠便携版\`（**370.7 MB**，Electron 运行时占绝大部分） |
| 桌面快捷方式 | `C:\Users\18075\Desktop\桌宠.lnk` → 上面那个 exe（带自制图标） |
| 打包脚本 | `scripts/make-exe.js`（`npm run exe`），**零依赖、不联网、约 3 秒** |

双击即开，**不弹控制台窗口**。打包版**自检 94/94 全绿**（见下面"验证"）。

## 为什么不装 electron-builder（技术选型）

主人一开始的说法是"exe 文件"，最容易想到的是 `electron-builder`。人家没用，理由有三条，
其中第 2 条是**实打实影响日常使用**的：

| # | electron-builder / electron-packager | 人家这次的做法 |
|---|---|---|
| 1 | 要联网下载几百 MB 工具链（nsis / winCodeSign / app-builder-bin），慢且容易失败 | **完全不联网**：Electron 发行版本身就是运行时 |
| 2 | 产物是 NSIS **自解压**包：**每次启动都要解压到 `%TEMP%`** → 启动变慢；而 `ROOT` 在临时目录里，**`artifacts\` 日志每次启动都换一个地方，等于丢了** | 直接跑，启动即开；日志稳定写在包内 `resources\app\artifacts\` |
| 3 | 要额外维护一套 `build` 配置（files / asar / target） | 一个 200 行的脚本，逻辑全看得见，出问题好查 |

**核心认识**：Electron 的发行版**已经是一个完整可运行的运行时**——

```
dist\桌宠便携版\
  桌宠.exe                  ← 就是 electron.exe 改了个名
  *.dll / *.pak / locales/  ← Chromium 那一套
  resources\app\            ← Electron 优先加载它（而不是自带的 default_app.asar）
      main.js  preload.js  lib\  renderer\  assets\（manifest.json + build\对齐帧）
```

`electron.exe` 是 **GUI 子系统**程序 → **双击不弹控制台**（主人原来那条痛点就是这么解决的）。

## 关键取舍与坑

### 1) `package.json` 的 `name` 必须保持不变

Electron 用 `app.getName()` 决定 `userData` 目录（`%APPDATA%\<name>`）。
打包时人家把 `devDependencies` / `scripts` 都删了，但 **`name` 保持 `dsh-desktop-pet` 不动**：

- 换名字 = 待办事项（`localStorage`）**全部丢失**
- 而且**单实例锁是按 userData 目录分的** → 名字一换，`npm start` 和 exe 版会**同时跑出两只桌宠**

### 2) 「第二次双击没反应」是个会让人以为坏了的体验

单实例锁是**共用**的（见上），所以如果主人之前用 `npm start` 开着，再去双击 exe：
第二个进程拿不到锁 → 直接 `app.quit()` → **主人看到的是"双击了但什么都没发生"**。

人家把它改成"有反馈"：除了一直都有的*把已有窗口叫到前面*，现在还会**让她冒个气泡**
说「人家在这儿呢～（一次只能有一只哦）」，并往原始输入日志里记一条 `second-instance`。

```js
app.on('second-instance', () => {
  if (!win) return;
  win.show(); win.focus();
  logInput({ src: 'main', type: 'second-instance', detail: '第二次启动：已把现有窗口叫到前面' });
  win.webContents.send('pet:say', '人家在这儿呢～（一次只能有一只哦）');
});
```

**实测过**（起两只、查日志）：

```
[08:46:50.858] main      second-instance 第二次启动：已把现有窗口叫到前面
第二只退出码=0（马上退出）
```

### 3) 图标：自己写了个 PNG → 多尺寸 .ico

exe 的图标**改不了**（改 PE 资源要么用 rcedit，要么联网下工具），所以人家改了**快捷方式**的图标：
`scripts/make-exe.js` 里自带 PNG 解码 + 缩放 + ICO 封装，产出 6 档尺寸（256/128/64/48/32/16）的 `.ico`。

- 图标取的是**「开心」那张定格图**，但要的是**角色**不是整张画布：
  所以先做**连通块标记**取"最大连通块"（角色本体，319x694），而不是用含彩纸的内容包围盒（683x1086）
  —— 否则角色在图标里会缩成一小坨
- 缩放用**面积平均 + alpha 加权**（`sumR/sumA`），不然边缘会渗出黑边
- 256 那档也写成 **32bpp DIB**（`BITMAPINFOHEADER + 自下而上 BGRA + 全 0 AND 掩码`），不依赖"PNG 压缩条目"那套兼容性玄学

**人家看了导出结果**（把 `.ico` 的 256 档转回 PNG 再读）：角色居中、透明背景、比例舒服 ✅

### 4) ⚠️ 又一个编码坑：Node 写 `.ps1` **不带 BOM**

快捷方式是用 `WScript.Shell` COM 建的，脚本写成临时 `.ps1` 再执行（中文路径过命令行容易坏）。
第一次跑直接失败：

```
Unexpected token 'C:\Users\...\妗屽疇\dist\妗屽屽疇渚挎惡鐗圽妗屽疇.ico' in expression or statement.
```

**根因**：`fs.writeFileSync(ps, text, 'utf8')` **不写 BOM**，而 Windows PowerShell 5.1 读到
没有 BOM 的 `.ps1` 会按 **ANSI（中文系统 = GBK）** 解码 → 中文路径全乱码。
**修法**：手动加 `'\uFEFF'`。

> 老经验第 N 次生效：**中文 + 老工具 = 先怀疑编码**。

### 5) 打包脚本的自我保护

- `assets\manifest.json` 不存在就**拒绝打包**（否则打出来的是"空位提示"，没有形象）——并打印正确的按组命令
- 输出目录已存在时，**只允许覆盖"上次打出来的包"**（含 `resources\app` 或有 `.exe`）；
  否则报错退出，绝不 `rm -rf` 一个不像产物的目录
- 包内只放**运行时真正需要的**：`main.js / preload.js / lib / renderer / assets\{manifest.json, build}`
  （13 张挑图、`cutout\`、`scripts\`、`docs\`、`devlog\`、`node_modules\`、`.git` 都不进包）
- 包根目录生成 `使用说明.txt`（怎么开、怎么关、怎么挪、日志在哪、别同时开两只）

## 验证（这是本轮的重点）

### ① 打包版**自己跑自检** → 94/94

自检模式可以在携带版里跑（用独立的 `--user-data-dir`，避免和主人正在用的那只抢单实例锁）：

```powershell
$env:DSH_PET_AUTOTEST='1'
Start-Process ".\dist\桌宠便携版\桌宠.exe" -ArgumentList "--user-data-dir=...\dist\tmp-userdata" -Wait
# → 退出码 0，包内 resources\app\artifacts\selfcheck.json: passed 94 / total 94 / ok true
```

这条证据同时说明：**包内路径全对**（素材清单读到了四个动作组 `idle / interact / hover / happy`）、
右键菜单是新版（`桌宠·阶段1 / 开心 / 摸头 / 回到底部右侧 / 开发者工具 / 退出`）、
穿透掩码能算出来、窗口尺寸/位置断言全过。

### ② 单实例反馈实测（见上面第 2 条）

### ③ 快捷方式实测

```
目标    : C:\Users\18075\Desktop\桌宠\dist\桌宠便携版\桌宠.exe   （存在 ✓）
工作目录: ...\dist\桌宠便携版
图标    : ...\dist\桌宠便携版\桌宠.ico,0                        （存在 ✓）
```

### ④ 桌面快捷方式为默认行为

`npm run exe` 默认就在桌面放快捷方式；不想要就用 `npm run exe:noshortcut`（或 `--no-shortcut`）。

## 改动文件

| 文件 | 改动 |
|---|---|
| `scripts/make-exe.js` | **新增**：便携版打包（复制运行时/代码/素材 + 改 exe 名 + 生成 ico + 建快捷方式 + 使用说明） |
| `main.js` | 第二次启动时**冒气泡 + 记日志**（原来只是静默 focus） |
| `package.json` | 新增 `npm run exe` / `npm run exe:noshortcut` |
| `.gitignore` | 加 `dist/`（370 MB 产物绝不能进仓库） |
| `README.md` | 顶部加「启动方式（主人日常用这个）」+ 技术选型说明；快速开始加 `npm run exe`；目录结构补 `scripts/make-exe.js`、`dist/`、`shot-happy.png` |
| `dist\桌宠便携版\` | 产物（gitignore）；桌面 `桌宠.lnk` |

## 待主人确认

1. **双击桌面上的「桌宠」** —— 应该**不弹任何黑框**，她直接出现在右下角；
2. 右键 → **退出**，再双击一次，确认"能开也能关"；
3. 如果双击后什么都没发生，**先看看是不是已经有一只在她跑**（从 `npm start` 开的那只）：
   那只应该会冒气泡说「人家在这儿呢～」。把旧的那只退出即可。
4. 便携包想挪地方就整个文件夹挪（挪完快捷方式会指丢，直接进文件夹双击 exe，或重跑 `npm run exe`）。
