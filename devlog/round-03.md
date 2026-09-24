# 第 3 轮：修复主人报告的「点击无气泡 + 右键无效」

日期：第 3 轮开发（主人真机反馈驱动）
现象：左键点击不出气泡、右键菜单不出来；拖动、穿透、穿透点击、窗口尺寸都正常。

## 结论先说

**自检 29 条全绿，但主人的两个功能是坏的。** 原因不是断言不够多，而是
**自动测试走的不是真人那条路**——`pet.click()` 是程序模拟，它**根本不触发 mousedown**。
所以「点击」这条链上的两个严重缺陷，自检 100% 覆盖不到。这是本轮最大的教训。

## 两个根因

### 根因 ①：mousedown 里 `preventDefault()` 会抑制 contextmenu

旧代码：
```js
pet.addEventListener('mousedown', (e) => {
  dragging = true;
  window.pet.dragStart({...});
  e.preventDefault();   // ← Chromium 会因此抑制 contextmenu 事件
});
```
Chromium 中 `mousedown` 被 `preventDefault()` 会阻止后续 `contextmenu` 派发。
所以人一右键，渲染层**根本收不到 contextmenu**，菜单自然不出来。
（左键点击的 `click` 也同理会被影响。）

### 根因 ②：无阈值拖动 → 点一下的微抖动就能让窗口跟着动

旧代码在 mousedown 里立刻 `dragging = true` 并启动拖动循环。
拖动循环用 DPI 取整后的整数坐标 setBounds，所以即使鼠标"没动"，
窗口也在鼠标底下**逐帧微动**（±1px）。
而 Chromium 只有在 mousedown 与 mouseup 落在**同一元素同一位置**时才产生 `click`。
窗口一动，click 就没了 → **点了没气泡**。

顺带一提：这两个 bug 都在 `mousedown` 处理器里，所以那个
「await getBounds() 的 race」只是第三个隐患（好在第 2 轮已修）。

## 修法

```js
const DRAG_THRESHOLD = 4;   // 逻辑像素
let pendingDrag = null;     // 只记按下起点，不启动拖动
let dragging = false;

pet.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  pendingDrag = { x: e.screenX, y: e.screenY };   // ← 不 preventDefault，不启动拖动
});

window.addEventListener('mousemove', (e) => {
  if (!pendingDrag || dragging) return;
  if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;  // ← 手抖不算拖动
  dragging = true;
  window.pet.dragStart({...});                      // ← 真拖了才启动
});
```

三条必须遵守的约束（都是踩坑换来的，已写进代码注释）：
1. 不能在 mousedown 里 `await getBounds()` 再启动拖动（race，第 2 轮修的）
2. 不能在 mousedown 里 `preventDefault()`（抑制 contextmenu，本轮修的）
3. 必须有移动阈值才开始拖动（微动会让窗口抖，click 丢失，本轮修的）

## 新增回归断言（能真正复现主人场景的）

| 断言 | 覆盖的根因 |
|---|---|
| 真实点击链(mousedown→mouseup→click)触发 click | 事件链完整性 |
| 真实点击后出气泡 | 主人报告的现象 |
| 快速点击后未卡在拖拽态 | 第 2 轮的 race |
| **微抖动点击(±3px)仍能出气泡** | **根因 ②** |
| **左键按下后紧接右键仍能打开菜单** | **根因 ①** |
| 拖动链仍可用（30px 移动触发拖动） | 防止修 A 坏 B |
| Ctrl+M 兜底入口可用 | 物理右键再出问题时的退路 |

## 人家自己犯的错（也要记）

1. **把正常行为当故障**：`dispatchEvent()` 在 `preventDefault` 生效时返回 `false`，
   这是 DOM 规范行为。人家一开始断言 `=== true`，白白 FAIL 了两轮。
   做了对照实验（取消/不取消 preventDefault 各测一次）才确认。
   ——**第一次犯是在第 1 轮（窗口尺寸被 DPI 取整）。同一个错误犯两次，说明人家该先做对照实验再写断言。**
2. **`report` 变量不在作用域**，写进 `runInteractionTest()` 里导致自检异常。
   连犯两次，同一个修复方式（从返回值带出去）。

## 兜底措施

- **Ctrl+M** 作为不依赖鼠标的菜单入口（已验证可用）
- 渲染层记录 `__petRightDiag`（物理右键的 mousedown / mouseup / contextmenu 计数），
  若主人再遇到问题，这个计数能直接告诉人家事件卡在哪一层

## 本轮数据

- 自检断言：**42/42 PASS**（第 2 轮 29 条 + 本轮新增 13 条）
- 未改动：穿透逻辑、像素分析（10/10 仍通过）

## 尚未验证的部分（照实说）

自检用**合成事件**逼近真人操作，能覆盖 DOM 事件链，但**无法替代真实物理鼠标**。
尤其是：点击穿透与鼠标事件分发的交互、菜单在 150% DPI 下的实际显示位置，
这两项**必须主人亲手确认**。

## 下一轮候选

- 主人验证结果反馈（若右键仍无效，按退路继续排查）
- 接入真实立绘
- 系统托盘 + 开机自启
