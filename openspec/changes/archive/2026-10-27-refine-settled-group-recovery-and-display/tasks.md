# Tasks

本清单追溯已实现的 0.1.1 行为及本次规格补充；勾选表示完成对应源码、证据或文档核对，不表示下面列出的未录制边界已经通过真机验收。

## 1. 规格与设计

- [x] 1.1 在既有 `transcript-group-folding` 能力域复制并扩展五个完整要求块；用脚本逐条比较修改前后的原场景，确认 20 个原场景均逐字保留。
- [x] 1.2 记录恢复视图交接、通知重判、批处理、单行标题条和命令反馈的技术决策与取舍；核对 `design.md` 与现有源码及用户已确认的方向一致。

## 2. 已实现行为核对

- [x] 2.1 核对首次恢复和会话替换的生命周期与弱引用交接；运行 `resume-initial-render.test.ts` 和 `resume-session-replacement.test.ts`，确认正常历史绑定及新旧分支隔离。
- [x] 2.2 核对通知来源、尾行迁移、实际复用更新、keep、不可证明来源与清理；运行 `notification-adapter.test.ts`、`notification-tail-move.test.ts` 和 `notification-source-fallback.test.ts`。
- [x] 2.3 核对折叠/展开箭头、实时主题取色、窄宽降级及成员原展示；运行 `header-style.test.ts` 与 `disclosure-arrow.test.ts`。
- [x] 2.4 核对组命令的成功/无操作反馈、实际状态改变后的重绘和非法参数提示；运行 `command-feedback.test.ts`。
- [x] 2.5 核对一次状态变化的批量通知移除和片段拆分；运行 `notification-batch.test.ts`，以 N 和 2N 的段/成员访问次数验证线性扫描，而非声称帧率。

## 3. 证据与归档准备

- [x] 3.1 核对隔离真实 Pi/TUI 录屏与主包 14 个运行时 TS 的来源哈希；引用 `artifacts/pi-group-collapse/e2e/bugfix-style-20261027/report.md`，并在 `design.md` 如实记录 `/fork`、拖选复制、独立 keep/core 状态和真实 OM 后台未由最终隔离录屏覆盖。
- [x] 3.2 复验既有 0.1.1 候选 tarball 的 SHA-256 和已录制运行时源码身份；校验 `artifacts/pi-group-collapse/release-prep/0.1.1/packs/SHA256SUMS`。
- [x] 3.3 对本变更执行 `openspec validate --strict --no-interactive` 与格式检查，确认全部任务完成后再归档。

归档后另以 CLI 验证主规格内容、严格校验和活跃变更列表。
