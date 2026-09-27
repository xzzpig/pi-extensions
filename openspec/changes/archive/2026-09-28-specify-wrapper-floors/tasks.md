## 1. 规范核对

- [x] 1.1 逐条核对 spec 与三处权威文档一致（`packages/pi-permission-system/README.md` 的 Fork notice、`docs/configuration.md` 的 `wrapperFloors` 段、`schemas/permissions.schema.json` 的 `wrapperFloors` 字段说明）；验证方式：每条要求都能在文档中找到对应描述，且无相互冲突的表述
- [x] 1.2 核对 spec 中的名称与取值来自代码事实：`src/access-intent/bash/wrapper-analysis.ts` 的包装器集合、`src/handlers/gates/bash-command.ts` 的 `WRAPPER_SENTINEL`（`<opaque-bash-wrapper>` / `<indirection-bash-wrapper>`）、`src/config/extension-config.ts` 的默认 `wrapperFloors: "fallback"`；验证方式：`grep -n` 输出与 spec 逐项一致
- [x] 1.3 确认规范描述的行为已有实现与测试覆盖；验证方式：`pnpm --filter @xzzpig/pi-permission-system test` 全绿（与既有基线一致）

## 2. notes 精简与归档

- [x] 2.1 精简 `subtrees/pi-permission-system.json` 的 `notes`：删除本 spec 已承载的架构叙述（wrapper-floor 重做、`wrapper-floors` 模块职责、解析递归与重定向跳过），只保留上游接缝位置、每次同步需重做的手工步骤、不要再引入的决定；验证方式：`jq -r .notes subtrees/pi-permission-system.json | wc -c` ≤ 1500，且不再描述 wrapper 行为契约
- [x] 2.2 归档本 change，使 spec 落到 `openspec/specs/bash-wrapper-floors/spec.md`；验证方式：`openspec validate` 通过，且 `openspec/specs/bash-wrapper-floors/spec.md` 存在
- [x] 2.3 确认记录与代码仍然一致；验证方式：`pnpm run audit:fork-divergence` 退出 0（`undeclared=0`、`stale=0`）
