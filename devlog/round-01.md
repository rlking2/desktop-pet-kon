# 第 1 轮：阶段 0 跑通（透明置顶 + 能拖能跑 + 自检闭环）

日期：首轮开发
目标：从零做出一只可运行的鲸鱼娘桌宠，并让开发过程能自我验证

## 本轮交付

| 文件 | 作用 |
|---|---|
| `main.js` | 主进程：透明/无边框/永远置顶窗口、右键菜单、自检(16 断言)、交互测试 |
| `preload.js` | 最小 IPC 暴露（contextIsolation 开启） |
| `renderer/index.html` | 结构 + CSP（`script-src 'self'`） |
| `renderer/style.css` | 深海蓝主题、呼吸/眨眼/蹦跳/摸头/生气动画、drag 区域 |
| `renderer/renderer.js` | 台词表、动画状态机、`window.__petTest` 测试入口 |
| `scripts/autotest.js` | 一键自检入口 |
| `scripts/inspect-image.js` | 自研 PNG 解码 + 像素结构分析（10 断言，零依赖） |
| `README.md` | 使用说明 + 主人亲测验收清单 + 已知限制 |

## 自检发现并修掉的问题（这就是闭环的价值）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | 渲染层完全没跑，`animationName=none` | CSP `default-src 'none'` 把 `renderer.js` 拦了 | 加 `script-src 'self'` |
| 2 | 自检崩在日志回调里 | Electron 44 的 `console-message` 改成事件对象，旧形参全 undefined，`path.basename(undefined)` 抛错 | 改用 `event.level / event.message` |
| 3 | `尾鳍元素存在` 一直 FAIL | SVG 里那条 path 忘了写 `id="tail"` | 补 id |
| 4 | 断言把 260×320 判成错误尺寸 | Windows 150% 缩放把窗口吸到整数物理像素网格 → 实际 264×324 | 改用页面视口判定 + ±4 逻辑像素容差 |
| 5 | `截图未被污染` — 红色自检边框被画进截图 | 自检开着 debug overlay，辅助线污染被检对象 | 自检默认关闭红框，改用 `DSH_PET_DEBUG=1` 单独启动 |
| 6 | 提示文字贴到窗口底边（bbox 底边 = 485/486） | `.hint` 用 `position:absolute; bottom:-22px` 溢出到窗口外 | 改成 flex 纵向布局 + margin |

## 本轮数据

- 自检断言：**16/16 PASS**（几何 11 + 交互 5）
- 像素分析：**10/10 PASS**（覆盖率 30.4%，上半身重心 x=0.539）

## 已知限制（照实记）

1. 动画相位不可复现 → 截图覆盖率每次 ±2% 波动，几何断言已做容差
2. 高 DPI 尺寸取整属系统行为，不是 bug
3. **审美未验证**：当前模型无图片输入能力，只能靠像素数学 + 主动上报可疑项
4. 形象仍是 SVG 占位图，未接真实立绘

## 下一轮候选

- 接入真实立绘 / 多表情
- 鼠标穿透：只在实体像素响应，透明区域可点桌面
- 系统托盘 + 开机自启
- 多屏位置记忆
