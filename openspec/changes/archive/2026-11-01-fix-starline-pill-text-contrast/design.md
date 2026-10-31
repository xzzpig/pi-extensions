# Design

## Context

见 `proposal.md - Why`。影响实现的现状：

- `extensions/starline/pill.ts` 的 `contrastTextSgr()` 是唯一的自动文字色来源：`backgroundSgrToRgb()` 把背景 SGR 反解成 RGB（支持 `48;2`、`48;5`、`40–47`/`100–107`），亮度 ≥128 取 `TEXT_DARK`，否则取 `TEXT_LIGHT`，反解失败时回退 `TEXT_DARK`。两个常量当前是 ANSI 基础色 `\x1b[30m` / `\x1b[97m`。
- 调用点三处：`prepare()` 在 spec 未显式给 `fg:` 时用它；相邻同背景 pill 的细分隔符用它；`pill-bubble.ts` 用它给气泡选中行。前两处与气泡一处各需要一个取值 seam（见 D2、D6），判定与 SGR 拼装本身放在 fork-only 模块。
- 现场环境：herdr（`COLORTERM=truecolor`、`TERM=xterm-256color`），其调色板把 ANSI black 渲染为 `#616161`；pi 主题 `light/one-dark` 使 `muted` 解析为 `#828997`，被当作 pill 背景。
- `pill.ts` 是 upstream 文件（subtree `v0.9.0`，commit `84e7106`），按 `pi-fork-divergence` 必须以最小 seam 改动，并在 `subtrees/pi-starline.json` 的 `reapplyOnSync` 记录。

## Goals / Non-Goals

**Goals:**

- 自动对比色在任意终端调色板下都成立：已知 RGB 的背景用标准固定的深浅色，终端自有的 16 色背景用反色，两种情况都不需要猜终端调色板。
- 保持深/浅判定、未知背景回退、pill 背景与几何完全不变。
- 让分歧在下次 upstream sync 时可被机械重放与复审。

**Non-Goals:**

- 不引入可配置的 pill 文字色（`fg:` 手写覆盖已存在，本变更不扩展它）。
- 不改 `colors.extensionStatus` 默认值、不改 `extensionStatuses` 逐项配色策略、不改第三方状态的分组/分隔呈现。
- 不处理终端不支持 256 色或用户主题改写 256 立方的极端情形（见 Risks）。
- 不改 upstream 的其它文件、不重排 import、不动格式。

## Decisions

### D1：深/浅文字使用 256 色立方的 16 / 231，而非 ANSI 基础色或真彩色

`16`（黑）与 `231`（白）是 xterm-256 立方里由标准固定的两个端点，不参与 16 色主题映射，这正是问题根源所在；同时它不要求终端支持 truecolor，也不会与背景常用的 `48;5` 编码族冲突。

- 备选：真彩色 `38;2;16;16;16` / `38;2;255;255;255`。绝对可控，但引入对 truecolor 的硬依赖，且背景可能是 256 索引编码，混用没有收益。
- 备选：按背景编码族挑同族前景（`48;2`→`38;2`，`48;5`→`38;5`）。实现更复杂，收益只落在非 truecolor 终端的边缘情况，违背最小 seam。
- 备选：把 `97` 保留、只换深色侧。浅色侧本来问题较小，但同一个常量对里只改一半会让语义不对称，成本相同。

### D2：常量只改取值与注释，反色逻辑走 fork-only 模块 + 最小 seam

阈值、反解、回退都属于既有行为，已被现有用例覆盖；常量行及其注释同属一个 hunk，注释原文（"basic named codes, which every terminal renders correctly"）在改动后已不成立，必须同步改写成"取值由标准固定"的理由。

D6 引入的反色逻辑不写在这里：它整体住在 `fork-pill-legibility.ts`，`pill.ts` 只新增一个 import、一个 `PreparedPill.reverse` 字段、一处 `prepare()` 赋值，以及正文/细分隔符两处前缀取值；`pill-bubble.ts` 只新增一个 import 与选中行前缀取值。

- 备选：反色逻辑直接写进 `pill.ts`。可读性相当，但把可复用的 SGR 判定沉进 upstream 文件，sync 时冲突面更大。
- 备选：把常量也搬进 fork 模块。需要删除两行常量并新增 import，hunk 反而更大，而这里没有可复用的逻辑可搬。

### D3：upstream 测试只改既有断言，新场景放 fork-only 测试文件

`test/pill.test.ts` 中 4 处断言直接写着 `\x1b[30m` / `\x1b[97m`，它们属于"被改动行为的既有用例"，原地更新；"终端把 ANSI black 映射成中灰仍可读"、分隔符与气泡一致性等新增场景写入 fork-only 的 `test/fork-pill-contrast.test.ts`，避免把 fork 专属用例塞进 upstream 文件。

### D4：分歧以 `reapplyOnSync` 记录，不进 `knownDebt`

本次只改 upstream 文件里的语义取值与取值 seam，不产生 `NOISE`/`DELETED` 审计发现，因此 `knownDebt` 不新增条目；在 `reapplyOnSync` 写一条“常量 + 反色 seam + 三处测试断言”的重放说明，并在 `FORK-CHANGELOG.md` 记一条 fork 变更。若 upstream 后续自行采用等价方案，删除该分歧并撤掉条目。

### D5：保持阈值 128 与未知背景回退不变

深/浅选择依据背景亮度，与既有实现一致；`\x1b[49m` 等无法反解的背景仍回退深色。顺带改阈值会改变其它段的观感，且缺乏需求依据。

### D6：终端自有的 16 色背景改用反色渲染

真机验证推翻了 D1 的隐含假设。`light/one-dark` 把 `syntaxFunction`、`success`、`muted` 等声明为调色板槽位（`{kind:"indexed", index:3}`），`backgroundSgrToRgb()` 只能按标准表把 `48;5;3` 猜成 `(128,128,0)`；herdr 实际把它画成 `#61AFEE`，于是“深/浅”判断整个失效：旧深字 2.62:1，新白字 2.37:1，两个都不可读。

反色渲染把两侧都交给调色板：`\x1b[49m` + `38;5;N` + `\x1b[7m` 后，背景仍是该槽位颜色，正文变成终端默认背景色。调色板作者保证该色在默认背景上可读，反转后同理（实测 8.61:1 与 10.11:1），且程序不需要知道任一 RGB。已知 RGB 的背景（真彩色、256 立方索引 ≥16）仍走 D1 的对比色。

- 备选：未知背景保持旧深色文字——不回归，但仍停在 2.6–3.1:1。
- 备选：把未知索引色换成中性背景——改变观感，超出“背景不变”约束。
- 备选：用 OSC 4 查询终端调色板——需要终端应答通道，pi 只提供前景/背景检测，成本远超收益。

实现上，判定与 SGR 拼装放在 fork-only 的 `fork-pill-legibility.ts`，`pill.ts` 与 `pill-bubble.ts` 各只加取值 seam（正文前缀与选中行前缀）。

### D7：显式 `fg:` 优先于反色，包括只写 `fg:` 的配置

反色只在 spec 没有自行指定前景色时启用。仅写 `fg:blue`（无 `bg:`）时，该前景仍会被提升为 pill 背景，但用户已选定文字色，反色会把它覆盖掉——因此判定看的是 spec 里是否出现 `fg:` token，而不是“是否同时给了 bg 与 fg”。这条规则让文档承诺的“设了 `fg:` 就由你决定文字色”在反色路径上依然成立。

## Risks / Trade-offs

- **终端不支持 256 色** → `38;5` 被忽略，文字回落默认前景。Starline 的主题色与 `48;5` 背景本来就依赖 256/真彩色，且目标环境 `TERM=xterm-256color`；作为非目标记录。
- **用户主题改写 256 立方端点** → `16`/`231` 不再是纯黑/纯白。仍比 `30`/`97` 更接近标准端点，且深/浅判定只看背景亮度，不会翻转选择。
- **upstream 后续自行修改 `contrastTextSgr`** → 该 hunk 在 sync 时冲突。`reapplyOnSync` 条目给出重放步骤；若 upstream 方案等价则直接采用并删除分歧。
- **视觉回归**：白字变纯白、黑字变纯黑，同背景下观感更“硬”。这是可读性换来的，属于预期取舍。
- **反色依赖终端对 `\x1b[7m` 的实现** → 少数终端用自定义 highlight 色渲染反色。它仍会给出可读的一对颜色，且只影响调色板槽位背景；已知 RGB 的背景不受影响。
- **浅色终端上的反色** → 正文变成浅色终端默认背景色（深字），正是期望方向。

## Migration Plan

无配置、存储或 API 迁移：用户现有 `~/.pi/agent/starline.json` 无需修改，显式 `fg:` 仍然优先。回滚等于还原两行常量、删除 `fork-pill-legibility.ts` 与两处取值 seam，并回退三处测试断言。

验证方式（与本变更新增的验收口径一致）：

- `pnpm --filter pi-starline run typecheck`、`pnpm --filter pi-starline test`。
- 真机证据用 `tmux capture-pane -p -e` 的终端网格 SGR 与 asciinema cast 的原始 SGR，不用真实显示器像素截图（无图形环境）：
  - 已知 RGB 背景的对比度仅凭 SGR 即可算出（立方黑 on `#F5C2E7` = 13.75:1；立方白 on `#45475A` = 9.12:1）。
  - 反色情形必须标注依赖：终端默认背景与调色板槽位 RGB 取自用户截图（`#61AFEE`/`#98C379`/`#050505` → 8.61:1 / 10.11:1），不得表述为“仅凭 SGR 可证”。
- `pnpm run audit:fork-divergence` 退出 0，`checked` 非零、`undeclared=0`。

## Open Questions

- 是否把该修复拆成 upstream PR 由上游吸收（可延后，不改变本次实现与任务拆分）。
