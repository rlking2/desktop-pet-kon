# 第 24 轮：做出"能发给别人下载"的安装包

主人的原话：**「现在打包软件，如何打包成安装包让别人也可以下载使用」**。

前面 23 轮做的一直是**便携版**（`npm run exe` → 一个 370MB 的文件夹，双击里面的 `桌宠.exe` 就跑）。
便携版自己用挺好，但**发给别人很难看**：得把整个文件夹压缩发过去，对方还得进文件夹找 exe。

这一轮做了**真正的安装包**：一个 110MB 的 `.exe`，双击进安装向导，装完自动启动，
带桌面/开始菜单快捷方式，能在「应用和功能」里卸载。

## 选型：还是上了 electron-builder

第 1 轮时人家拒绝过 electron-builder，理由写在 README 里（要联网下工具链、NSIS 自解压每次启动解压到 `%TEMP%`）。
那是**对"便携版"的判断**，现在需求变了 —— 要的是"给别人下载安装"，那就得用业界标准的安装包工具：

- 自己写 NSIS 脚本 + 手动改注册表 + 手动建卸载程序 → 能行，但每加一个功能（快捷方式、卸载项、
  可选安装目录）都要手搓，出错面很大；
- electron-builder 一条 `npm run installer` 全做完，而且**它包的 app 和便携版一模一样**
  （`resources\app\` 摊开 + 自带 Electron 运行时），**启动不解压、不写 `%TEMP%`**，
  第 1 轮担心的那个问题在新方案里根本不存在。

产物对比：

| | 便携版 | 安装包 |
|---|---|---|
| 体积 | 370 MB 文件夹 | **110 MB 单文件** |
| 发给别人 | 整个文件夹 | ✅ 一个文件 |
| 安装 | 免安装 | 向导 + 快捷方式 + 卸载程序 |
| 首次构建 | 不联网 | 下载 NSIS/7zip 工具链（之后有缓存） |

## 踩到的坑（按发生顺序）

### 坑 1：`electron` 不许待在 `dependencies` 里

```
⨯ Package "electron" is only allowed in "devDependencies".
Please remove it from the "dependencies" section in your package.json.
```

electron-builder 认为 Electron 运行时是"构建期依赖"（它自己会打包一份进去），
放在 `dependencies` 会被当成"应用运行时要装的依赖"。→ 把 `electron` 挪到 `devDependencies`，`npm install` 重锁。

### 坑 2（最阴的）：安装在别人机器上会"看不见自己的待办事项"

打包出来的 `package.json` 里 `name` 还在，但 electron-builder 额外注入了 `productName: "桌宠"`。
而 Electron 是这么定数据目录的：

```
%APPDATA%\<app.getName()>  →  app.getName() 会优先取 productName
```

也就是说**安装版的数据目录会变成 `%APPDATA%\桌宠`**，而便携版用的是 `%APPDATA%\dsh-desktop-pet`。后果两条：

1. 便携版里存好的**待办事项（localStorage）在安装版里一条都看不见**；
2. 两份 userData = **两把单实例锁** = 能同时跑出两只桌宠（第 1 轮特意防过这件事）。

修法：配置里加 `extraMetadata: { productName: 'dsh-desktop-pet' }`，
把打包产物里的名字钉回仓库包名（快捷方式名不受影响，走 `nsis.shortcutName`）。

**并且加了断言盯着它**（第 23 轮那条老经验：改坏了要有人喊）：

```
PASS  打包身份未被改（app.getName() 仍是仓库包名，userData 才不会被分家）
      app.getName()=dsh-desktop-pet；userData=...（自检用了 --user-data-dir 隔离，属正常）
```

> 这条断言第一版是**错的**：它同时要求 `userData` 目录名等于 `dsh-desktop-pet`，
> 可自检为了不跟主人那只桌宠抢锁，必须加 `--user-data-dir` 做隔离 —— 那种情况下目录名
> 当然是临时的。结果自检报 `102/103`。改成"用了隔离参数就只查名字"后 103/103。

### 坑 3：自检"跑过了但没写报告"（其实是没跑）

`npm run autotest` 退出码 0、耗时 8 秒、`artifacts\selfcheck.json` 却是**上一轮的旧文件**。
原因就是上面第 2 条的反面：主人那只**便携版正在跑**，自检进程拿不到单实例锁 → `app.quit()` → 静默退出。
所以自检必须带 `--user-data-dir`：

```powershell
$env:DSH_PET_AUTOTEST='1'
node_modules\electron\dist\electron.exe . "--user-data-dir=$env:TEMP\petcheck"
```

（`scripts/autotest.js` 原来没带这个参数 —— 主人关掉桌宠时它能正常跑，但**桌宠开着的时候会假通过**。
本轮顺手修掉了：现在脚本自己 `mkdtemp` 一个隔离数据目录传 `--user-data-dir`，跑完删掉。
验证方式就是**主人那只便携版一直在跑的情况下**跑 `npm run autotest` → 103/103 ✅。）

### 坑 4：安装包会顶掉便携版的桌面快捷方式

人家静默装到临时目录做验证时，桌面「桌宠」快捷方式被**重定向到安装版**了。
卸载器把快捷方式删掉后，主人原来那份便携版快捷方式就没了 → 验证完**手动重建**回便携版：

```
桌面\桌宠.lnk → C:\Users\<用户名>\Desktop\桌宠\dist\桌宠便携版\桌宠.exe
```

## 验证（真跑，不是推理）

| 验证项 | 结果 |
|---|---|
| 安装包体积 / 哈希 | 109.7 MB，SHA256 `630B628174B0236FC6BDB7A2368897EFB1FBB1CC5E7FB9048F20BB20C74A26F9` |
| 开发版自检 | **103/103 ✅** |
| 打包后（`win-unpacked`）自检 | **103/103 ✅** |
| 静默安装到临时目录 | 退出码 0；程序目录 + `Uninstall 桌宠.exe` 齐全 |
| 装出来的快捷方式 | 桌面 `桌宠.lnk` + 开始菜单 `桌宠.lnk`（都指向安装目录） |
| 卸载注册项 | `HKCU\...\Uninstall\1190cc88-...` → `桌宠` |
| **已安装版**自检 | **103/103 ✅** |
| 默认身份目录 | 装出来的版本启动时创建的仍是 `%APPDATA%\dsh-desktop-pet`（改名实验取证） |
| 静默卸载 | 退出码 0；程序目录/快捷方式/注册表项**全部清干净** |
| 卸载后数据 | `%APPDATA%\dsh-desktop-pet` **保留**（`deleteAppDataOnUninstall: false`） |
| 自检脚本（桌宠开着时） | 103/103 ✅（`--user-data-dir` 隔离修好后） |

## 别人怎么装（写给主人的转述话术）

> 双击 `桌宠-安装包-0.1.0.exe` → 如果 Windows 弹「未知发布者」，点「更多信息 → 仍要运行」
> （没买代码签名证书，不是病毒）→ 一路下一步 → 装完她自己就出来了。
> 想卸载：开始菜单搜「桌宠」右键卸载，或「设置 → 应用 → 桌宠」。

**没做的**：代码签名（证书要钱，约 ¥1000+/年）。所以 SmartScreen 提示跑不掉，只能写进 README 讲清楚。

## 改动文件

| 文件 | 改动 |
|---|---|
| `electron-builder.config.js` | **新增**：NSIS 配置（按用户安装、可选目录、快捷方式、`extraMetadata` 钉名字） |
| `scripts/make-icon.js` | **新增**：从 idle 第一帧抠出角色连通块 → 生成 6 档尺寸的 `icon.ico` |
| `package.json` | `electron` 移进 devDependencies；新增 `icon` / `installer` / `installer:dir` |
| `main.js` | 新增"打包身份未被改"断言（102 → 103 条） |
| `scripts/autotest.js` | 自检改用隔离的 `--user-data-dir`（修掉"桌宠开着时假通过"） |
| `README.md` | 新增「📦 打包给别人用（安装包）」；已知限制补签名/x64/自检隔离 |
| `.gitignore` | 忽略 `dist-installer/`、`build-resources/` |
| `dist-installer\桌宠-安装包-0.1.0.exe` | **产物**（110 MB，发给别人的就是这个文件） |
