## 1. 规范核对

- [x] 1.1 逐条核对 spec 与三处权威文档一致（`packages/pi-subagents/docs/fork-extensions.md` 的 Context injection、`docs/agents.md` 的 `injectToContext` 字段说明、`README.md` 的相关段落）；验证方式：每条要求都能在文档中找到对应描述，且无相互冲突的表述
- [x] 1.2 核对 spec 中的事实来自代码：`src/extension/context-injection.ts` 的 `SUBAGENT_INJECTION_MARKER`、`resolveInjectableAgents`（别名解析、`disabled` 与 capability ceiling 过滤、稳定排序、`unknownNames`）、`renderInjectionBlock`（模板与描述折叠）、`applyInjectionBlock`（幂等）；验证方式：`grep -n` 输出与 spec 逐项一致
- [x] 1.3 确认规范描述的行为已有实现与测试覆盖；验证方式：`pnpm --filter @xzzpig/pi-subagents test` 结果与 `subtrees/pi-subagents.json` `knownDebt` 中记录的既有失败基线一致（不新增失败）

## 2. notes 精简与归档

- [x] 2.1 精简 `subtrees/pi-subagents.json` 的 `notes`：删除本 spec 已承载的架构叙述（上下文注入的来源与保证），只保留上游接缝位置、每次同步需重做的手工步骤、不要再引入的决定；验证方式：`jq -r .notes subtrees/pi-subagents.json | wc -c` ≤ 1500，且 notes 不再描述注入行为契约
- [x] 2.2 归档本 change，使 spec 落到 `openspec/specs/subagent-context-injection/spec.md`；验证方式：`openspec validate` 通过，且该文件存在
- [x] 2.3 确认记录与代码仍然一致；验证方式：`pnpm run audit:fork-divergence` 退出 0（`undeclared=0`、`stale=0`）
