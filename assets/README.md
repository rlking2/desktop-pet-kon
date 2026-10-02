# 素材放这里（帧动画）

人家**看不见图片**（当前模型不支持图片输入），所以这套流程的设计目标是：
**主人只管把图丢进来，对齐 / 拆帧 / 计时 / 校验全部由程序完成，人家不需要用眼睛。**

---

## 一、目录约定（二选一）

### 方式 A：散帧 PNG 序列（推荐）

```
assets\
  idle\                 ← 目录名 = 动作名
    frame-01.png
    frame-02.png
    ...
  hop\                  ← 再来一个动作就再建一个目录
    frame-01.png
    ...
```

- 帧顺序 = 文件名自然排序（`frame-2.png` 会正确排在 `frame-10.png` 前面）
- **各帧尺寸可以不一致**（程序会自动按主体包围盒对齐到统一画布）
- **必须有 alpha 通道**（透明背景），否则会被体检拦下

### 方式 B：精灵图 spritesheet

```
assets\
  idle.png
  idle.json     ← 必须同名
```

`idle.json` 内容：

```json
{ "cols": 4, "rows": 2, "frameWidth": 128, "frameHeight": 128, "defaultDelayMs": 110 }
```

---

## 二、处理流程

```powershell
npm run assets          # 只体检，不生成任何文件（先看这套图能不能用）
npm run assets:write    # 体检 + 生成对齐帧和清单
npm start               # 启动桌宠，会自动读取清单并播放帧动画
```

### ⚠️ 加/换素材时必须**按组单独跑**（踩过的坑）

根目录那 13 张挑图用的 PNG（`assets\1.png` … `assets\Q.png`）会被扫描器当成
**13 个"单张图"动作组**，一起写进 `manifest.json`（人家实测过：跑完清单里多出
`1/2/…/10/J/K/Q` 这些组，还会给每组生成 `build\frames\<组名>\`）。

所以正确姿势是带上组名：

```powershell
node scripts\inspect-assets.js --write --normalize-height idle
node scripts\inspect-assets.js --write --normalize-height interact
node scripts\inspect-assets.js --write --normalize-height hover
node scripts\inspect-assets.js --write --normalize-height happy
```

**`--normalize-height` 不能省**：它把一组里的主体统一缩放到"该组最高帧的 85%"。
少了它，`idle` 三帧主体高度差 1.99 倍，播放时会**忽大忽小**；
而且它决定"屏上角色多大"——现在的四组都落在 127~145px，是一致的。

### 🧽 素材里有"页面残留"怎么办（书页照片素材常见）

这套图是从**书页照片**上裁的，所以画面里会混进页面自己的东西（主人 2026-09-24 反馈"待机动画下方有白线、右下有白线框"）：

```powershell
node scripts\clean-pagemarks.js            # 体检：列出每块残留的判据与结论（不写文件）
node scripts\clean-pagemarks.js --write    # 真的清掉（原图被覆盖，git 里可回滚）
```

它会清掉：页面边框的**灰色横线**、右下角的**粉色页码徽标**（圆角框 + 数字 + 水滴）、
左上角的淡粉圆弧、边角的灰色小印子。

⚠️ 它**不会**碰"白叶子"那类装饰 —— 那种叶子的叶肉偏白，抠背景时被吃掉了，
只剩深色轮廓，看着也像"淡色的东西"，但**它是画的一部分**。
判据靠的不是"淡不淡"，而是**形状**：线稿的填充率只有 0.01~0.18，叶子这类紧凑色块 ≥ 0.30。

`--write` 会产出：

```
assets\manifest.json                    ← 运行时读这份（可容纳多个动作组）
assets\build\frames\<动作名>\frame-000.png ...   ← 对齐后的统一尺寸帧
```

**没有 `assets\manifest.json` 时，桌宠自动退回内置的 SVG 占位形象**（零配置，不会白屏）。

---

## 三、体检会拦下这些问题

| 检出项 | 为什么必须拦 |
|---|---|
| PNG 没有 alpha 通道 | 桌宠会变成一块**方块**盖在桌面上，还会挡住鼠标穿透 |
| 背景没抠干净（整帧几乎不透明） | 同上，白底会跟着一起显示 |
| 有帧几乎是空的 | 那一帧角色"消失"了，动画会闪 |
| 帧尺寸不一致 | 会**警告**并自动对齐（不算致命） |
| 帧间主体面积波动过大 | **警告**：可能把不同动作混进了一组 |

---

## 四、帧率（每帧延时）怎么定

目前生成的清单里每帧统一 `120ms`（≈8fps）。

想改的话，两种办法：

1. 直接编辑 `assets\manifest.json` 里的 `delayMs`（改完重启桌宠即可）
2. 在动作目录里放一个 `meta.json`，内容 `{ "defaultDelayMs": 90 }`（需要人家改工具支持，告诉人家一声）

> 手绘逐帧动画常见 8~12fps；呼吸这类慢动作 6~8fps 就够。
> 帧率不合适的话主人直接跟人家说"太快/太慢"，人家改清单即可，不用重新导图。

---

## 五、人家为什么不做"自动抠图"

因为**抠图需要判断"什么是背景、什么是角色"，这需要眼睛**。人家看不见图，硬做只会把角色也抠掉。

主人如果用在线工具（比如 remove.bg）抠好再导出带透明通道的 PNG，丢进来就能用；
如果抠完还是残留白边，体检里的"整帧几乎不透明"会把这种问题抓出来。

---

## 六、想先试流程？

人家准备了一套合成测试素材（蓝色圆球，不是鲸鱼娘，只用来验证流水线）：

```powershell
npm run fixtures                 # 生成到仓库根 _fixtures\（不会进 assets）
copy _fixtures\idle\*.png assets\idle\   # 放进去试
npm run assets:write
npm start
```

验证完记得把 `assets\idle\` 清掉，不然主人会看到一堆蓝球。
