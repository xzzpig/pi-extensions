## Context

见 `proposal.md` 的 Why。只补充与设计相关的现状：

- 本扩展的 `tool_call` 处理器与 RTK 的处理器注册在同一个事件上；pi 按扩展加载顺序顺序 await 各处理器且共享同一个 event 对象，而 `~/.pi/agent/extensions/*`（precedence rank 3）先于任何 package（rank 4）加载。真实环境里因此是 **RTK 先改写、本扩展后读取**。
- `bash` 规则按 `^…$` 锚定匹配（`src/policy/wildcard-matcher.ts` 的 `compileWildcardPattern`，last-match-wins），所以命令前缀多一层就会落到兜底 `*`。
- fork 已有一等公民概念“会执行内层命令的包装器”，其分类器 `src/access-intent/bash/wrapper-floors.ts` 是 **fork-only 文件**，注释明确写着 “Extend this set to cover another always-invoking wrapper”。
- `subtrees/pi-permission-system.json` 的 `reapplyOnSync` 语义是“sync 时必须手工重新应用的适配”，只对 upstream 文件成立。

## Goals / Non-Goals

Goals：

- 让**被代理命令**而不是代理本身成为 `bash` 规则的匹配对象。
- 判定不依赖“谁先注册”，从而不依赖加载顺序这一隐式契约。
- 保留 RTK 的输出压缩能力，且不改动由 nix 模块生成的 `~/.pi/agent/extensions/rtk.ts`。

Non-Goals：

- 不为“代理子命令形”（`rtk err <cmd>`）建立子命令表。
- 不引入新的扩展配置项（可配置 wrapper 列表留作后续独立变更）。
- 不改 RTK 的 rewrite 规则，也不用 `exclude_commands` 排除命令。

## Decisions

### D1：把 `rtk` 加入 indirection 包装器词表

理由：`rtk` 的语义就是“把自身 argv 重写为真实命令”，与 `sudo`/`env`/`xargs` 同属 indirection 类别；分类器已有“剥离包装器、把内层命令作为独立单元门控”的完整机制与测试，且 `fallback` 模式下无法静态解析时兜底为 `ask`（方向只会更严）。改动落在 fork-only 文件，1 个词 + 注释。

被否方案与代价：

- `[hooks] exclude_commands`（RTK 侧）：牺牲 RTK 对 git/find 的输出压缩。
- 双写 `rtk git add *` 等规则（本扩展侧）：每条规则配两遍，易漏。
- 把 `rtk.ts` 改成 package 并排在 permission 之后：`rtk.ts` 由 nix home-manager 模块生成，不可行；且依赖 rank 隐式契约。
- 新增 `indirectionWrappers` 配置项：更通用，但要改 schema/类型并把配置穿到 `BashProgram.parse` 的选项管线，超出本次范围。

### D2：只修判定层，不动显示层

`executedUnit`（对话框/日志里“实际会执行的命令”）对 `rtk` 保持 `null`。让它显示内层命令需要改 upstream 的 `wrapper-analysis.ts`（fork 已 modified 的文件），会新增一处 fork 分歧，收益仅为显示更友好。已知并接受。

### D3：不新增 `reapplyOnSync` 条目

`wrapper-floors.ts` 是 fork-only 文件，`git subtree pull` 不会覆盖、删除或冲突它，因此不存在“sync 必须手工重新应用”的适配。`--inventory` 已把它列为 `fork-only`，代码注释也说明了 `rtk` 为何在此；再往 `reapplyOnSync` 写一条属于记录别处已有的东西。对比：既有的 `wrapper-floors readWrapperCommand skips REDIRECT_NODE_TYPES children` 记录的是上游 v35.0.0 重构逼出的手工再对齐，性质不同。

## Risks / Trade-offs

- [代理子命令形不被解包] `rtk err git push origin main` 的内层头部是 `err`，落到兜底 `*` → 记为已知边界并写进 spec 场景；`rtk rewrite` 不产生该形态，且修复前后行为一致（非回归）。
- [代理自身选项影响内层定位] `findInnerCommandStart` 会把 `-` 开头的词当作包装器自身语法跳过，因此 `rtk --ultra-compact git add x` 仍按 `git add x` 门控 → 单测固化该断言。
- [包装器词表被上游覆盖] 该表是 upstream 名字表的 fork 复制品；upstream 新增包装器时需手工镜像。缓解：spec 场景、单测、代码注释三处都写明 `rtk` 的存在理由。
- [判定变严导致误提示] 词表新增成员只会把原本落到兜底 `*` 的判定升级为按内层规则或 `ask`，不会放松任何既有规则 → 真机 e2e 用 `rtk ls -al` 验证非门控命令仍无提示。

## Migration Plan

无迁移：纯增量词表项，无配置、无数据、无 API 变化。回滚 = 删掉该词表项与对应测试。

## Open Questions

无。
