# Tasks

## 1. 实现与文档（本 change 之前已完成，此处只做核对）

- [x] 1.1 在 fork-only 分类器的 `INDIRECTION_WRAPPER_NAMES` 加入 `rtk` 并写清理由；验证方式：`git diff` 仅含 `packages/pi-permission-system/src/access-intent/bash/wrapper-floors.ts`，`pnpm --filter pi-permission-system run typecheck` 退出 0
- [x] 1.2 补 fork-only 单测覆盖 `rtk git add/commit/push` → `ask`、`rtk find /` → `deny`、`rtk ls`/`rtk read` → `allow`、未解析 payload → `<indirection-bash-wrapper>`、代理自身选项被跳过；验证方式：`pnpm --filter pi-permission-system test` 0 failures，且该文件在移除词表项后失败
- [x] 1.3 真机 e2e：隔离环境（`-e` 顺序把 rtk 放前）跑真实 pi —— 对照组（已发布 1.4.0）静默放行，改动组 `git add`/`git commit` 弹 ask、`find /` 被 deny、`ls -al` 无对话框；验证方式：review-log 条目与 `/tmp/pi-e2e-rtk/EVIDENCE.md`
- [x] 1.4 同步对外文档：README 的 Fork notice、`docs/configuration.md` 的 indirection 词表、CHANGELOG 的 `[Unreleased]` Fixed；验证方式：三处都提到 `rtk` 且与 spec 表述一致

## 2. 规范核对与归档

- [x] 2.1 核对 delta 与主 spec：`### Requirement: 包装器识别范围` 头部逐字一致，且 delta 含原有 4 个场景（`-c` shell / 裸 shell / 无 exec 标志搜索 / 重定向）加上 3 个新场景；验证方式：`openspec validate add-rtk-proxy-wrapper --strict` 退出 0
- [x] 2.2 确认 `subtrees/pi-permission-system.json` 未新增 `reapplyOnSync` 条目；验证方式：`git diff --stat -- subtrees/pi-permission-system.json` 为空，`pnpm run audit:fork-divergence` 退出 0（`undeclared=0`、`stale=0`）
- [x] 2.3 归档本 change，使 delta 落到 `openspec/specs/bash-wrapper-floors/spec.md`；验证方式：归档成功，`grep -c rtk openspec/specs/bash-wrapper-floors/spec.md` ≥ 1，`pnpm exec prettier --check .` 退出 0
