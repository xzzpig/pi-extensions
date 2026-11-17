# 验证与规格追踪

## 已执行

- `direnv exec . pnpm --filter @xzzpig/pi-goal-x run typecheck`：退出 0。
- `direnv exec . pnpm --filter @xzzpig/pi-goal-x test`：1673 通过、0 失败，见 `/tmp/goal-local-unit-v6.log`。
- `direnv exec . pnpm --filter @xzzpig/pi-goal-x run test:settings-race`：1 通过，见 `/tmp/goal-local-settings-race.log`；local 两个 worker 并发测试在 `fork-local-race.test.ts`。
- `fork-local-controls.test.ts`：3 通过；`goal-controls.test.ts` 与全部 local 测试合跑 39 通过（日志 `/tmp/goal-local-test.log`，随后补充的 local 控制测试另行运行）。
- `fork-local-auditor.test.ts`、`goal-auditor-override.test.ts` 和 `goal-auditor-package.test.ts`：23 通过，见 `/tmp/goal-local-auditor.log`；local auditor 测试随后补充定义层快照检查并单独通过。
- `openspec validate add-goal-project-local-settings --strict`：通过。
- `direnv reload` 与 `pnpm run audit:fork-divergence`：退出 0；pi-goal-x `checked=757 noise=7 deleted=1 declared=8 undeclared=0 stale=0`，日志 `/tmp/goal-local-fork-audit.log`。
- `pnpm --filter @xzzpig/pi-goal-x pack --pack-destination /tmp`：退出 0；`/tmp/xzzpig-pi-goal-x-0.12.2.tgz` 包含 `docs/project-local-settings.md`，不包含个人 local 配置。`git check-ignore -v .pi/pi-goal-x-settings.local.json` 命中根 `.gitignore`；共享文件仍被跟踪。
- pi-lens 的 push-only LSP 检查不能证明空诊断，故另在 Nix 临时环境直接启动 `typescript-language-server` 并通过 LSP `textDocument/didOpen` 等待每个文件的 `publishDiagnostics`：`nix-shell -p typescript-language-server --run 'python3 openspec/changes/add-goal-project-local-settings/lsp-check.py'`。全部 16 个新增/变更 TypeScript 文件均确实收到推送，0 个 severity 1 错误；13 条 severity 4 提示是已有的废弃字段及未使用声明。完整逐文件结果见 `/tmp/goal-local-lsp-v7.log`。这一检查不把 silent-on-clean 当成成功。归档后脚本路径为 `openspec/changes/archive/2026-11-17-add-goal-project-local-settings/lsp-check.py`。

## 真实 Pi/TUI 与审计

- 隔离目录 `/tmp/pi-e2e-goal-local-20261117`，本地 `goal.ts` 与 `packages/pi-subagents/index.ts`，Pi 1.5.2，tmux `/tmp` host server，asciinema 3.2.1；临时 global 在 `/tmp/pi-goal-local-e2e-global.json`，不改真实全局配置。
- 录像 `/tmp/pi-e2e-goal-local-20261117/recordings/run-jWFWC2/session.cast`：asciicast v2、1589 条输出事件，`pi-exit=0`、`recorder-exit=0`。重放命令：`asciinema play /tmp/pi-e2e-goal-local-20261117/recordings/run-jWFWC2/session.cast`。以 `--speed 4 --idle-time-limit 2` 在独立 tmux pane 回放并观察了默认/遮蔽设置及审计运行片段；未逐帧视觉检查整段，完整录像保留供复核。
- `steps.tsv` 中 33–110 秒：启动 project，显示 `disableTasks: true (source: local; project: false; overridden by local)`，修改 project，并在 local 删除覆盖；111 秒切至 global。119–138 秒：Controls 切换 global/project/local，local 绑定 F6，检查 local 文件。对应各时间的 pane 快照与脚本同目录。
- 177–255 秒：真实模型完成目标并启动审计；audit UI 和 `sessions/subagent-artifacts/*_meta.json` 记录 `axonhub/gpt-6.1-sol:low`，child 的真实 `*_transcript.jsonl` user 消息包含共享清单 `Confirm the marker GOAL_LOCAL_E2E_CHECK in the workspace file.`；全局 thinking `low` 生效。子审计真实批准，目标归档。`*_input.md` 按框架策略被脱敏，不能用它证明 prompt。
- 补充 global 写入与恢复默认的独立录屏：`/tmp/pi-e2e-goal-local-global-20261117/recordings/run-byOeZQ/session.cast`，asciicast v2、37 条输出事件、Pi 与 recorder 均退出 0。`steps.tsv` 记录 32–43 秒将 global `showContextUsage` 由 true 保存为 false，61–64 秒删除 global 覆盖；实际读取临时 global JSON 证实两个状态。project 文件 SHA-256 始终为 `6161a5a9ad0bf0f63340c71e0bd1fb82c258ad32d255df780808e7c012c5d614`，local 始终为 `544114474446ebf821314343e8a623e1aafae5e36928f3153090b9799d0a4899`。以 `asciinema play --speed 2 --idle-time-limit 2 /tmp/pi-e2e-goal-local-global-20261117/recordings/run-byOeZQ/session.cast` 在独立 tmux pane 回放并观察 global 设置界面及回放结束。

- 为使文件差异可复核，又单独录制 `/tmp/pi-e2e-goal-local-global-proof-20261117/recordings/run-GTcJxm/session.cast`（`pi-exit=0`、`recorder-exit=0`）。同一目录保存 `global-before.json`、`global-after-set.json`、`global-after-unset.json`，以及 project/local 各自 before、after-set、after-unset 的字节快照：JSON 实际断言 global 从 true → false → 字段不存在，project/local 两组文件的三次快照字节相同。可用 `asciinema play --speed 2 --idle-time-limit 2 /tmp/pi-e2e-goal-local-global-proof-20261117/recordings/run-GTcJxm/session.cast` 重放；已在 tmux 回放并查看 global 编辑选项。

- 针对独立审计指出的 Oracle 两字段来源问题，另录 `/tmp/pi-e2e-goal-local-oracle-20261117/recordings/run-2yfQbA/session.cast`：project provider/model 分别为 `shared-provider`/`shared-model`，local 只覆盖 provider 为 `personal-provider`。32 秒的 pane 快照展示两行及各自的生效来源、本层值和 local 遮蔽提示；录屏 v2、25 个输出事件，Pi/recorder 退出码均为 0。以 `asciinema play --speed 0.5 --idle-time-limit 2 /tmp/pi-e2e-goal-local-oracle-20261117/recordings/run-2yfQbA/session.cast` 在独立 tmux pane 回放，实际看到两行。`fork-local-settings-ui.test.ts` 还验证 provider/model 分属不同来源、三种编辑范围及仅 model 被 local 覆盖的反向场景。

## 规格场景映射

| 规格行为                                              | 证据                                                                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 三来源、优先级、所有配置域、固定 local 路径、缺少文件 | `tests/fork-local-settings.test.ts`、`tests/fork-local-settings-extra.test.ts`、`tests/goal-layered-settings.test.ts`                                        |
| 嵌套继承、别名、合法 false/0/空数组、删除恢复         | `tests/fork-local-settings*.test.ts`、`tests/fork-local-mutation.test.ts`                                                                                    |
| 菜单默认 project、遮蔽值、范围写入与删除              | `tests/fork-local-settings-ui.test.ts`（含 local 文件缺失时 project/global 的本层值和遮蔽提示），首段真实录屏 33–111 秒及补充 global 写入与删除录屏 32–64 秒 |
| Controls 范围、继承、冲突与重载                       | `tests/fork-local-controls.test.ts`、`tests/goal-controls.test.ts`，真实录屏 119–138 秒                                                                      |
| 损坏文件、缓存、来源、并发、符号链接                  | `tests/fork-local-settings.test.ts`、`tests/fork-local-mutation.test.ts`、`tests/fork-local-race.test.ts`、`tests/goal-settings-race.test.ts`                |
| 审计模型、共享清单、全局设置、per-goal 以及定义快照   | `tests/fork-local-auditor.test.ts`、`tests/goal-auditor-override.test.ts`、`tests/goal-auditor-package.test.ts`，真实 child transcript 与 meta               |
| 未迁移用户设置、不改 Git、无新凭据存储                | 加载实现、隔离运行配置及最终 diff；根 Git 规则由仓库维护者显式添加                                                                                           |

## 集成基线修复与剩余核对

- 初次官方集成测试 9 项失败（`/tmp/goal-local-integrated-run.log`）；在未修改 HEAD 的隔离副本复现相同 9 项（`/tmp/goal-baseline-integration.log`、`/tmp/goal-baseline-official.log`）。用户随后明确授权修复过时历史断言；测试已按实际固定工具表、执行时禁用检查及规范的嵌套 auditor 字段校正，未改变生产行为。
- SDK 集成测试的 5 秒启动屏障存在间歇失败：不止并行 typecheck 时（`/tmp/goal-local-integrated-v6.log`），独立审计器连续两次及本机单独执行（`/tmp/goal-local-integrated-repro-1.log`）也复现 0/2。不能把原因仅归结为并行负载。新增失败诊断后再次复现（`/tmp/goal-local-investigate-1.log`）：真实 workflow 的 `status.json` 已记录两个 child 均为 running、workflow 已发出两条 started trace，但 5 秒屏障内 fake child-session 的调用数仍是 0；证据指向 runner/child 初始化尚未到达会话边界，并未证明更深层的操作系统调度根因。
- 保持两个真实 workflow children、真实 SDK EventBus、detached foreground、结果交接和调度预算的原有断言不变；仅把 fork-only 测试的进程启动与通知等待改为有限的 20–30 秒，并使测试 wait deadline 能覆盖这些等待；超时仍输出 runner status/stderr 和原断言失败，不跳过、不用新 mock 替代真实流程。修改后官方 `test:integration` 连续 10 次独立执行通过（`/tmp/goal-local-integrated-bounded-{1..5}.log`、`/tmp/goal-local-integrated-timing-{1..5}.log`），每次 integration 组 35/35、SDK 组 10/10；后五次实际 child 边界等待分别 3608、3093、3484、2116、3759ms。原先九项旧断言失败的 test knownDebt 已移除。
- 额外实验 `/tmp/goal-local-integrated-childenv.log` 故意设置 `PI_SUBAGENT_CHILD=1`：SDK 组 10/10 通过，但完整 suite 的普通 integration 组失败，因为该标志按设计禁用主会话插件工具；这不是通过的验收运行，也不代表正常运行时环境。
- 已对照增量规格复核上表；新增范围切换的上游测试断言、根目录格式检查、`git diff --check`、严格 OpenSpec 校验和最终 fork audit 均通过。长录像已在独立 tmux pane 回放并抽查关键状态，未逐帧目视回放；原始录制保留，状态不作夸大。
