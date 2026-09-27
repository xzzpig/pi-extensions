## 1. 规范核对

- [x] 1.1 逐条核对 spec 与 `packages/pi-tool-display/README.md` 中该选项的说明一致；验证方式：每条要求都能在文档中找到对应描述，且无相互冲突的表述
- [x] 1.2 核对 spec 中的事实来自代码：`src/bash-command-display.ts`（折叠规则、宽度回退顺序与省略号、`auto` 的 `executionStarted && isPartial` 判定、展开优先）、`src/types.ts`（默认 `"full"`）、`src/config-store.ts`（`toBashCommandDisplay` 非法值回退）、`src/presets.ts`（`configsEqual` 与预设默认）；验证方式：`grep -n` 输出与 spec 逐项一致
- [x] 1.3 确认规范描述的行为已有测试覆盖；验证方式：`pnpm --filter @xzzpig/pi-tool-display test` 全绿

## 2. notes 精简与归档

- [x] 2.1 精简 `subtrees/pi-tool-display.json` 的 `notes`：删除本 spec 已承载的架构叙述（`bashCommandDisplay` 的三态行为、折叠与钳制细节、测试清单），只保留上游接缝位置、每次同步需重做的手工步骤、不要再引入的决定；验证方式：`jq -r .notes subtrees/pi-tool-display.json | wc -c` ≤ 1500，且 notes 不再描述显示模式行为契约
- [x] 2.2 归档本 change，使 spec 落到 `openspec/specs/bash-command-display/spec.md`；验证方式：`openspec validate` 通过，且该文件存在
- [x] 2.3 确认记录与代码仍然一致；验证方式：`pnpm run audit:fork-divergence` 退出 0（`undeclared=0`、`stale=0`）
