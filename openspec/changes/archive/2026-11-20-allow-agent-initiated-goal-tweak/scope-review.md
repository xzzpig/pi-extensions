# 范围核对：模型发起目标调整

本表以本变更的 `proposal.md`、`design.md`、`specs/goal-lifecycle/spec.md`
和 `tasks.md` 为依据。实施开始时的工作区状态记录只包含五个已暂存的
OpenSpec 文件；原先已提交的 fork 分歧属于基线，不因本次任务恢复。
本次没有整体重置工作区或改动其他插件。

## 已收回的越界部分

- `extensions/goal-service.ts`：收回对所有事务共享的无缓存读取、定义比较和
  `mutate` 签名变更。现只在模型提案 flush 使用权威对账和焦点保护；锁内
  候选复核由现有 `apply` 回调中的 fork helper 完成。手动及其他事务使用
  原有路径。
- `tests/goal-tweak-status-persistence.test.ts`：还原为实施前字节；原有
  手动 revision 冲突行为及断言保留。
- 删除未使用的 fork helper、参数及导出；审核基线的新增严格比较仅应用于
  模型提案，不改变手动调整的比较规则。

## 保留项与规范对应关系

| 路径                                                                                  | 保留原因                                                                                  |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `extensions/goal-agent-tweak.ts`                                                      | 1.1：显式目标 ID、理由净化、执行门禁和续拟绑定。                                          |
| `extensions/fork-agent-tweak-orchestration.ts`                                        | 1.1–1.3：不启动用户命令地进入既有草稿/审核流程，保护用户草稿，续拟保留目标。              |
| `extensions/fork-agent-tweak-decision.ts`                                             | 1.2–1.3：提案归属、取消/继续、焦点与候选复核，防止过期或中止后提交。                      |
| `extensions/fork-goal-authority.ts`                                                   | 1.1–1.2：模型提案读取当前目标并在锁内验证候选；只供模型事务接缝及测试使用。               |
| `extensions/fork-goal-draft-validation.ts`                                            | 1.1：复用提案参数规则，在审核前检查目标、任务和预算。                                     |
| `extensions/goal-drafting.ts`                                                         | 1.1–1.3：可选参数、提示、现有审核/事务接入、会话重水合及工具调用预览。                    |
| `extensions/goal-service.ts`                                                          | 1.1–1.2：仅模型提案 flush 的锁内一致性和焦点保护；维持原 `mutate` 签名与其他 flush 行为。 |
| `extensions/goal-tweak-confirmation.ts`                                               | 2.1：既有确认框中的理由、基础宿主回退、安全显示及中断时关闭。                             |
| `extensions/goal-tweak-review.ts`、`extensions/goal-tweak-projection.ts`              | 1.2、2.1–2.2：模型候选与既有存储规范化一致，独立理由、结果快照与预览。                    |
| `extensions/prompts/goal-prompts.ts`、`extensions/prompts/fork-model-view-prompts.ts` | 1.1：两个执行提示允许显式提案并尊重取消。                                                 |
| `docs/goal-tweak-diff.md`                                                             | 2.2：记录调用、理由与确认策略。                                                           |
| `tests/fork-agent-initiated-tweak.test.ts`                                            | 1.1–3.2：独立回归覆盖准入、事务、展示和兼容性。                                           |
| `scripts/fork-test-runner.mjs`、`tests/.test-manifest.json`                           | 3.2：将专属测试纳入既有测试运行器和自检。                                                 |
| `tests/goal-controls.test.ts`、`tests/goal-update-objective.test.ts`                  | 1.1：原提示断言需跟随规范要求的提示变化。                                                 |
| `subtrees/pi-goal-x.json`                                                             | 3.2：记录上游同步接缝与声明的分歧。                                                       |
| 本目录的 proposal、design、spec、tasks、`e2e-evidence.md`                             | 变更规范、任务和验证证据；不涉及其他变更。                                                |

## 上游格式边界

上游 v0.34.1 将 `## Progress` 用作目标正文与状态区的分隔符；当正文自身含有
同名独立标题时，现有解析器会在第一个标题处截断。该行为在本次修改之前已
存在，不能未经上游契约证明认定为缺陷。用户明确选择保持上游行为：本变更
不修改共享解析器，也不新增专门的正文标题限制。上次审计指出的正文往返
边界因此仍然存在，不能声称本变更修复了该边界。模型提案若只有验证契约而
没有目标正文，会被拒绝，因为本变更规范要求提交完整目标；手动路径不变。

具体验证命令、运行结果、录制和当前代码与录像之间的差异见 `e2e-evidence.md`；
本表仅是范围说明，不单独构成通过测试或完成验收的证据。
