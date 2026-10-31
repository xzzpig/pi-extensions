# Tasks

## 1. 渲染层修复（upstream 最小 seam）

- [x] 1.1 在 `extensions/starline/pill.ts` 把 `TEXT_DARK` / `TEXT_LIGHT` 改为 `\x1b[38;5;16m` / `\x1b[38;5;231m`，并把上方"basic named codes"注释改写为"取值由 256 色立方标准固定"的理由；验证：`contrastTextSgr("\x1b[48;2;130;137;151m")` 返回 `\x1b[38;5;16m`，`pnpm --filter pi-starline run typecheck` 通过。
- [x] 1.2 更新 `test/pill.test.ts` 中依赖旧取值的断言（`contrastTextSgr` 三条、同背景细分隔符一条）与其用例标题；验证：`pnpm --filter pi-starline test` 全部通过。

## 2. 终端自有背景的反色渲染

- [x] 2.1 新增 fork-only `extensions/starline/fork-pill-legibility.ts`：`isTerminalOwnedBackground()` 识别 `40–47`/`100–107`/`48;5;0–15`，`reverseVideoSgr()` 返回 `\x1b[49m` + 前景孪生 + `\x1b[7m`，不可反解时返回 `undefined`；验证：单测覆盖命名色、槽位 0/15、立方 16/231、真彩色与 `\x1b[49m`。
- [x] 2.2 `pill.ts` 接入 seam：`PreparedPill.reverse`、正文前缀（`pill.reverse || pill.bg`）与同背景细分隔符；验证：槽位背景输出反色前缀、真彩色不输出 `\x1b[7m`。
- [x] 2.3 `pill-bubble.ts` 接入选中行 seam；`test/pill-click.test.ts` 的选中行匹配兼容反色形式；验证：气泡选中行在槽位背景下带反色前缀，`pnpm --filter pi-starline test` 通过。
- [x] 2.4 显式 `fg:` 门控：`hasExplicitForeground()` 识别 `fg:` token，仅写 `fg:blue` 时也不反色并使用该前景色；验证：`renderPillBar` 对 `fg:blue` 输出无 `\x1b[7m` 且含 `\x1b[34m`。
- [x] 2.5 扩展 `test/fork-pill-contrast.test.ts` 覆盖反色场景（槽位判定、反色前缀、同背景分隔符计数、气泡选中行、`bg:… fg:…`、仅 `fg:`、已知背景不反色）；验证：该文件 16 个用例全部通过。

## 3. fork 覆盖与记录

- [x] 3.1 在 `FORK-CHANGELOG.md` 记录该分歧（问题、常量、反色、覆盖范围、移除条件）；验证：条目与 `pill.ts` 实际取值一致。
- [x] 3.2 在 `subtrees/pi-starline.json` 的 `reapplyOnSync` 记录"重放两个常量、反色 seam 与三处测试断言"（不新增 `knownDebt`）；验证：`jq .reapplyOnSync subtrees/pi-starline.json` 可见该条，`audit-fork-divergence.sh --inventory pi-starline` 的 `modified` 列出被改 upstream 文件。
- [x] 3.3 change 产物与实现对齐：design 的 Context/D2/D4/D6/D7/Migration 描述真实 seam 与证据口径，tasks 勾选状态与已完成项一致；验证：`openspec validate --strict` 通过，且文档不再声称"函数结构不动"或"像素截图"。

## 4. 集成验证

- [x] 4.1 运行 `pnpm run audit:fork-divergence`，确认退出 0、`checked` 非零、`undeclared=0`、无 `STALE`；验证：`pi-starline: checked=162 noise=5 declared=5 undeclared=0 stale=0`。
- [x] 4.2 按 `pi-plugin-e2e-test` 跑 Level 1 print-mode 冒烟 + Level 2 tmux/asciinema 真机（含第三方状态 fixture 与临时 agent dir 的浅色 pill），解析 cast 与 `tmux capture-pane -p -e` 证明 `38;5;16` 与反色 SGR，并确认可见文本、分隔符、圆角、宽度与修复前逐字符一致；验证：`/tmp/pi-e2e-starline-light-pill/EVIDENCE.md`、各 run 的 `pi-exit`/`recorder-exit` 为 0。
- [x] 4.3 四份 cast 在 tmux 中用 `asciinema play` 回放并保存关键帧 capture；验证：各 run 目录下的 `replay-*-frame*.txt`，覆盖范围与未覆盖部分记录在 `EVIDENCE.md`。
- [x] 4.4 运行 `pnpm --filter pi-starline run verify` 与仓库根 `pnpm exec prettier --check .`；验证：两条命令退出 0。

## Workflow follow-up

- 归档（`openspec archive fix-starline-pill-text-contrast`）不在本次范围内，由用户决定时机；本次只做到验证通过即停，不提交、不推送、不发布。
