# 第 23 轮：拆掉描边的调试横条（数值已固化）

主人的原话：**「可以去掉调试线了」**。

跟当初调速滑条完全一样的流程：**主人调好 → 告诉数值 → 人家固化 → 拆掉临时的东西**。

## 拆了什么

| 位置 | 之前 | 现在 |
|---|---|---|
| `renderer/index.html` | 面板里一行两条横条（`#outlineRow` / `#outlineWidth` / `#outlineDepth`） | **删掉**（留一段注释说明为什么删、以后怎么加回来） |
| `renderer/style.css` | `.ol-row / .ol-label / .ol-value / .ol-slider` 及其轨道/滑块样式 | **删掉**（同样留注释） |
| `renderer/renderer.js` | 滑条接线块（`input` 事件 → 改 `OUTLINE` + 清缓存） | **删掉**，只留 `clearOutlineCache('启动')` |
| `renderer/renderer.js` | 自检入口 `__petTest.setOutline` | **删掉** |
| `main.js` | 4 条"滑条存在 / 拖粗细 / 拖深浅 / 默认值"断言 | 换成 2 条：**参数已固化** + **调试横条已拆除**（含反向断言） |

**没动的**：`OUTLINE` 里那两个数值（0.25px / 62%）—— 它们现在是唯一来源，写死在代码里。

副作用（好的）：面板不需要再为那两行留高度，**面板高度从 263 回到 221**（"面板完整在窗口内"这条断言本来就是盯着它的）。

## 自检 104 → 102/102 ✅

```
PASS  描边参数已固化（粗细 0.25px / 深浅 62% / 线色 rgb(97,97,97)）
PASS  描边调试横条已拆除（临时模块清理干净）
      (#outlineRow=false #outlineWidth=false #outlineDepth=false __petTest.setOutline=undefined)
PASS  部件描边掩码已接入（头发/眉毛/手/裙子外层/腿脚）
PASS  每一帧都套用描边，且描边真的画在轮廓上（画布像素取证）（取样点 67 个）
打包版自检 102/102 ✅（包内 index.html 里已搜不到 outlineWidth）
```

> 又用上了那条老经验：**删功能要配"它不该存在"的反向断言** ——
> 跟当初"调速滑条已删除（`#speedSlider` 不存在、`__petTest.setSpeed` 已移除）"一样，
> 以后谁手滑加回来，自检会立刻红。

## 以后想再调怎么办（写给以后的自己）

1. `renderer/index.html`：把面板里那两行 `<input type="range">` 加回去（注释里有原样代码的位置说明）
2. `renderer/style.css`：把 `.ol-*` 那几段加回来（注释里也留了说明）
3. `renderer/renderer.js`：把滑条接线块加回来（`input` → 改 `OUTLINE.width/depth` → `clearOutlineCache()`）
4. 或者更省事：直接改 `OUTLINE` 里那两个数，用
   `node scripts/preview-compose.js idle --width=0.25 --depth=62` 几秒看一次效果

## 改动文件

| 文件 | 改动 |
|---|---|
| `renderer/index.html` | 删两条横条 |
| `renderer/style.css` | 删 `.ol-*` 样式 |
| `renderer/renderer.js` | 删滑条接线 + `__petTest.setOutline`；保留固化值 |
| `main.js` | 断言：滑条那 4 条 → "已固化" + "已拆除" 2 条（104 → 102） |
| `README.md` | 断言条数 104 → 102 |
| `dist\桌宠便携版\` | 重新打包 |
