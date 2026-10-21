# Tasks

## 1. 数据层:正文人读摘要

- [x] 1.1 在 `packages/pi-goal-x/extensions/goal-audit-supervisor-handoff.ts` 实现 `formatSupervisorCoordination()`:分组(原因 · 状态 / 问题 / 答复或未解决 / 短身份)、中文状态与原因映射、未知值保留原文(`Object.hasOwn`)、空答复与缺失原因的确定措辞。验证:`node --experimental-strip-types --import ./packages/pi-goal-x/scripts/test-adapter-hooks.mjs --test packages/pi-goal-x/tests/goal-audit-supervisor-handoff.test.ts` 通过,且断言输出不含 `undefined`/`null` 字面量。
- [x] 1.2 实现 JSON 扁平化与花括号中和:`braceFree()` 用于键名与字符串值,`renderValue()` 对 JSON 对象/数组产出 `key=value`(嵌套同规则、数组「、」、null→「空值」)。验证:单测覆盖对象、嵌套、数组、键/值内花括号、转义空白五类输入,断言正文 ASCII 花括号计数为 0。

## 2. 显示层:goal 结果卡片

- [x] 2.1 在 fork-only 模块实现 `goalCardCoordination(result, text, expanded)`:无结构化记录时原样返回、suffix 为空;有记录时按**确切附录文本**剥离(`formatSupervisorCoordination` 的结果 + `lastIndexOf`)并给出折叠一行摘要 / 展开完整记录。验证:单测断言"正文含标题引用但无记录"时折叠与展开输出\*\*逐字节等于输入"。
- [x] 2.2 在 `packages/pi-goal-x/extensions/goal-format.ts` 接入最小接缝(一行 import + `first`/`card`/`firstText`/`out(text + card.suffix)`),数据提取与剥离逻辑不得留在该文件。验证:`pnpm --filter @xzzpig/pi-goal-x run typecheck` 退出 0,且 `grep -c supervisorCoordination packages/pi-goal-x/extensions/goal-format.ts` 为 0。
- [x] 2.3 新增 fork-only 测试 `packages/pi-goal-x/tests/goal-audit-supervisor-card.test.ts`:生产形态(经 `withAuditSupervisorHandoff` 包装)折叠态 0 个记录块 + 恰好 1 行摘要、展开态恰好 1 个记录块、generic 分支(如 `Audit aborted — …`)展开仍带记录、同输入两次渲染逐字节相等。验证:`node --experimental-strip-types --import ./packages/pi-goal-x/scripts/test-adapter-hooks.mjs --test packages/pi-goal-x/tests/goal-audit-supervisor-card.test.ts` 全部通过。

## 3. 自动化消费方

- [x] 3.1 `packages/pi-goal-x/tests/e2e/goal-audit-supervisor-live.mjs` 改为从 `message.details.supervisorCoordination.records` 读取记录,正文断言接受「答：」或「未解决：」且要求无 ASCII 花括号,标题定位使用 `lastIndexOf`。验证:`node --check packages/pi-goal-x/tests/e2e/goal-audit-supervisor-live.mjs` 通过,且用真实捕获的工具结果离线复算未解决谓词为真。

## 4. 真实 TUI 核验

- [x] 4.1 在隔离工作区(独立 cwd、`--session-dir`、tmux、真实 provider)完成一次产生监督问答的审计,存证折叠态与展开态 pane、session JSONL 与录像。验证:折叠态 pane 含且仅含一行 `审计协调记录 N 条（…）` 且无记录块;`ctrl+o` 后 pane 恰好含一个记录块(问题/答复/短身份);session 中该 tool result 的正文 ASCII 花括号计数为 0、details 结构完整。

## 5. 门禁与文档

- [x] 5.1 更新 `packages/pi-goal-x/docs/audit-supervisor-sidechannel.md` §7:记录数据层版式与渲染层折叠/展开行为。验证:`pnpm exec prettier --check .` 通过。
- [x] 5.2 跑齐门禁:两包 `typecheck`、`pnpm --filter @xzzpig/pi-goal-x run test:unit`、`node ./packages/pi-goal-x/scripts/fork-test-runner.mjs`、`pnpm run audit:fork-divergence`、`git diff --check`。验证:全部退出 0,且 fork-divergence 的 `undeclared` 为 0。
