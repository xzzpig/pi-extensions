## Why

`bash-wrapper-floors` spec 的“包装器识别范围”列出了 indirection 包装器词表，但不含 `rtk`。RTK 是一个透明输出代理：它把 `git push origin main` 改写为 `rtk git push origin main` 后再执行，并且在真实环境里它的 `tool_call` 处理器先于本扩展注册，因此本扩展读到的是**改写后**的命令串。由于 `bash` 规则按 `^…$` 锚定匹配，未剥离的 `rtk git add x` 只命中兜底 `*`，使 `git add *: ask` / `git commit *: ask` / `git push *: ask` / `find /: deny` 静默失效（其中 `find /: deny` 是 deny 逃逸）。

实现已修复（`rtk` 已加入 fork-only 分类器的 indirection 词表，单测与真机 e2e 均已通过），但**规范仍是旧的**：`subtrees/pi-permission-system.json` 的 `notes` 声明行为契约由本 spec 承载，契约过期会让同步时的取舍失去依据。本 change 只补规范，不改变运行行为。

## What Changes

- **MODIFIED** `bash-wrapper-floors` 的“包装器识别范围”：indirection 词表加入 `rtk`（透明输出代理），并明确判定不依赖调用方是否已被代理改写。
- 新增三个 Scenario：代理按被代理命令门控 / 代理先改写调用也不改变判定 / 代理自身子命令形不继续解包（已知边界）。
- **不改变任何运行行为**：实现、单测、真机 e2e 均已完成，本 change 只把既有行为写进规范。
- 不新增 `reapplyOnSync` 条目：修复位于 fork-only 文件 `wrapper-floors.ts`，`git subtree pull` 不会触碰它。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `bash-wrapper-floors`: “包装器识别范围”的 indirection 词表加入透明输出代理 `rtk`，并补充“判定与调用方是否改写无关”与“代理自身子命令形不继续解包”的场景。

## Impact

- 归档后更新 `openspec/specs/bash-wrapper-floors/spec.md` 的“包装器识别范围”要求。
- 相关实现（本 change 只读引用，不修改）：`packages/pi-permission-system/src/access-intent/bash/wrapper-floors.ts`（fork-only 包装器分类器，`INDIRECTION_WRAPPER_NAMES` 含 `rtk`）。
- 对外文档已同步：`packages/pi-permission-system/README.md`（Fork notice）、`docs/configuration.md`（indirection 词表）、`CHANGELOG.md`（`[Unreleased]` Fixed）。
- 验证证据：fork-only 单测 `packages/pi-permission-system/test/access-intent/bash/wrapper-floors.fork.test.ts`；真机 e2e 记录 `/tmp/pi-e2e-rtk/EVIDENCE.md`。
- 无 API、依赖或运行行为变化。
