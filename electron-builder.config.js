// 安装包（NSIS）配置：npm run installer
//
// 【和"便携版"的区别】
//   便携版（npm run exe → scripts/make-exe.js）：
//     一个 370MB 的文件夹，双击里面的 桌宠.exe 就跑。不用安装，但也"不像个软件"，
//     分享给别人得整个文件夹打包发过去。
//   安装包（本配置 → npm run installer）：
//     一个 ~90MB 的 .exe，双击进安装向导 → 装到用户目录、建开始菜单+桌面快捷方式、
//     自带卸载程序。**这才是别人下载安装的那一种**。
//
// 【为什么装到"当前用户"而不是 Program Files】
//   桌宠会把原始输入日志写在 artifacts\ 里。Program Files 需要管理员权限才能写，
//   而按用户安装（perMachine: false）不需要 UAC，日志也写得进去。
//
// 【代价：没有代码签名】
//   签名证书要花钱买，所以别人第一次运行安装包时，Windows SmartScreen 可能提示
//   "未知发布者"（点"更多信息 → 仍要运行"即可）。这条人家写在 README 里告诉主人了。
const path = require('node:path');

module.exports = {
  appId: 'com.dsh.desktop-pet',
  productName: '桌宠',
  // ★ 注意：productName 会影响 Electron 的 app.getName() → userData 目录名。
  //   人家特意在下面 extraMetadata 里保留 package.json 的 name，让 userData 还是
  //   %APPDATA%\dsh-desktop-pet —— 这样**便携版装过的待办事项，安装版照样能看到**。
  directories: {
    output: 'dist-installer',
    buildResources: 'build-resources',
  },
  // 只打"运行时真正需要的"：代码 + 渲染层 + 素材清单 + 对齐帧
  //（素材源图、cutout、scripts、docs、devlog、node_modules 的开发依赖都不进包）
  files: [
    'main.js',
    'preload.js',
    'lib/**/*',
    'renderer/**/*',
    'assets/manifest.json',
    'assets/build/**/*',
    '!**/*.md',
    '!**/*.txt',
  ],
  // ★ 把 app.getName() 钉死在包名上（不然它就等于 productName="桌宠"）
  //   实测取证：不加这一行，打包后的 package.json 里没有 name，只有 electron-builder 注入的
  //   productName:"桌宠" → app.getName()="桌宠" → userData 变成 %APPDATA%\桌宠。
  //   后果是"便携版装过的待办事项（localStorage 存在 userData 里）到了安装版看不见"，
  //   而且两份 userData = 两把单实例锁 = 能同时跑出两只桌宠。
  //   这里只改打包产物里的元数据，桌面/开始菜单快捷方式名走 nsis.shortcutName，仍是"桌宠"。
  extraMetadata: { productName: 'dsh-desktop-pet' },
  // 不开 asar：素材是按文件路径读出来交给 <img> 的，摊开最省事（体积差别可以忽略）
  asar: false,
  // 用本地已经装好的 Electron 运行时，省掉一次几百 MB 的重复下载
  electronDist: path.join(__dirname, 'node_modules', 'electron', 'dist'),
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build-resources/icon.ico',
    // 让 exe 的属性里也带上名字（右键属性→详细信息 里能看到）
    legalTrademarks: '',
    artifactName: '桌宠-安装包-${version}.${ext}',
  },
  nsis: {
    oneClick: false,                    // false = 走安装向导（可选安装目录），不像某些软件"一点就装"
    perMachine: false,                  // 按当前用户安装：不需要管理员
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: '桌宠',
    uninstallDisplayName: '桌宠',
    // 卸载时**保留** %APPDATA%\dsh-desktop-pet（待办事项在里面，误卸载不至于丢数据）
    deleteAppDataOnUninstall: false,
    // 安装完直接启动
    runAfterFinish: true,
  },
};
