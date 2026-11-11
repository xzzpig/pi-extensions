# 目标调整差异审核验收记录

## 交付范围与主代理审查

两个隔离 worker 分别实现模型/差异与审核 UI；首次 30 分钟超时后保留现场，按用户明确恢复要求在原上下文继续，两者均完成。主代理未直接采信报告：读取实现、白名单复制、独立复跑测试，亲自完成 `goal-drafting.ts` 接缝、候选/提交等价校验、执行局部审核记录与结果重放、测试入口及元数据维护。

主代理审查修复：

1. 新增/删除任务的差异原先未列出验证契约和 lightweight 规则，现已补充及测试。
2. 新审核模块最初使用的 TS 参数属性不支持项目的 Node strip-only 测试模式，已改为普通字段。
3. 初始调用行使用同一候选/差异生成器展示明确待校验的内存差异，确认前以磁盘协调后的结果为准。审核后 draft 清除或会话重放可能使工具调用行退回创建式全文；现以同一工具行 renderer state 保持 tweak 分类，结果触发一次刷新，并有重放测试及真实 reload 验证。
4. 异常路径保留审核快照，明确错误/未确认应用结果，不伪报成功或隐藏失败；展开记录继续保留反馈与失败说明。
5. 超长正文通过数组参数展开可能触发 JS 参数数量上限；改为逐项追加，以 130000 行插入、一对多 diff 和真实组件渲染单测覆盖。
6. 两个原有上游测试使用旧问卷返回夹具，已通过 fork-only `fork-tweak-draft-fixture.ts` 和最小测试接缝适配新调整决策 API，没有删减持久化/预算/进度断言。

未改 README、版本、锁文件或其他包源码，未提交、推送、发布或归档。用户原 `.pi/pi-goal-x-settings.json` 的 SHA-256 与实施前一致；只在隔离测试目录设置自主运行上限为 0，避免 UI 测试触发实质工作。

## 可重复执行的检查

命令从仓库根或明确注明的包目录执行，当前 Node 为 Nix 环境的 v24。曾尝试 `direnv exec . pnpm --filter @xzzpig/pi-goal-x typecheck`，pnpm 的依赖检查尝试自动 install 并因非 TTY 失败，因此下列检查直接运行已安装工具及 package scripts 对应的 Node 入口，不改变依赖/锁文件。

| 检查                        | 实际命令与位置                                                                                                                                                                                                          | 结果 / 原始记录                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 包级类型                    | 包目录：`node ../../node_modules/typescript/bin/tsc --noEmit`                                                                                                                                                           | 0；后续改动后再次通过                                                                                                |
| 完整单元                    | 包目录：`node scripts/run-unit-tests.mjs`                                                                                                                                                                               | 0；1663/1663 通过，0 skip/cancel；`/tmp/goal-tweak-unit-delivery.log`                                                |
| 新模型/UI/记录与 tweak 回归 | 包目录：`node --import ./scripts/test-adapter-hooks.mjs --experimental-strip-types --test tests/goal-tweak-*.test.ts`；后补极长边界用例再跑对应三套测试                                                                 | 原 91 项通过；最终完整单元包含全部新增用例；`/tmp/goal-tweak-all-current.log`、`/tmp/goal-tweak-edge-final.log`      |
| 草拟创建兼容                | 包目录：同 adapter，`--test tests/goal-drafting.test.ts`                                                                                                                                                                | 49/49 通过；亦包含于最终完整单元；`/tmp/goal-tweak-drafting-regression.log`                                          |
| 测试清单                    | 包目录：`node scripts/run-unit-tests.mjs --selfcheck`                                                                                                                                                                   | 0；127 unit、4 integration、12 e2e 条目一致                                                                          |
| 新代码 lint                 | 包目录：`node ../../node_modules/eslint/bin/eslint.js extensions/goal-tweak-*.ts tests/goal-tweak-{review,diff,projection,confirmation}.test.ts tests/fork-tweak-draft-fixture.ts tests/e2e/goal-tweak-live-assert.mjs` | 0                                                                                                                    |
| 全仓库格式                  | `node node_modules/prettier/bin/prettier.cjs --check .`                                                                                                                                                                 | 0；`/tmp/goal-tweak-prettier-all.log`，遵循原 subtree ignore，未格式化上游文件                                       |
| 二开全仓库审计              | `bash .agents/skills/pi-fork-divergence/scripts/audit-fork-divergence.sh --all`                                                                                                                                         | 0；`/tmp/goal-tweak-audit-all.log`；pi-goal-x：checked=757、noise=7、deleted=1、declared=8、undeclared=0、stale=0    |
| 元数据                      | `node env/ensure-upstreams.mjs`                                                                                                                                                                                         | 0；只校验，不提交其环境导出                                                                                          |
| 差异与规划                  | `git diff --check`；`openspec validate show-goal-tweak-diff --strict`                                                                                                                                                   | 0                                                                                                                    |
| 主动 LSP                    | 显式检查 12 个改动 TS 路径，waitMs=10000、并发4                                                                                                                                                                         | 0 条诊断但 12 个未确认（7 超时、5 push-only 无 clean 确认）；**不宣称 LSP clean**。包级 tsc 通过作为实际类型检查证据 |

### 独立审计反馈后的指定 pnpm 门禁补验

首次独立审计确认功能及直接脚本检查，但要求补齐指定 `pnpm run audit:fork-divergence` 的成功证据。现已实际执行：

```bash
pnpm_config_verify_deps_before_run=warn direnv exec . pnpm run audit:fork-divergence
pnpm_config_verify_deps_before_run=warn direnv exec . pnpm --filter @xzzpig/pi-goal-x run typecheck
pnpm_config_verify_deps_before_run=warn direnv exec . pnpm exec prettier --check .
```

三条命令均退出 **0**。原始记录分别为 `/tmp/goal-tweak-pnpm-audit-direnv.log`、`/tmp/goal-tweak-pnpm-typecheck.log` 与 `/tmp/goal-tweak-pnpm-prettier.log`。pnpm 明确打印依赖状态警告（`enableGlobalVirtualStore` 设置变化），继而真实执行仓库注册的全仓二开审计脚本和包级 `tsc --noEmit`；pi-goal-x 结果为 checked=757、undeclared=0、stale=0。

`pnpm_config_verify_deps_before_run=warn` 只对该进程把 pnpm 启动前的依赖状态处理从自动 install 改为告警；没有跳过或替换二开审计、修改其退出码，也没有改动持久配置、依赖、锁文件或其他包源码。保留依赖状态警告，不声称已经修复全局安装配置。随后 `git diff --name-only -- pnpm-lock.yaml pnpm-workspace.yaml package.json` 为空，用户 settings 哈希仍与实施前相同。此补验取代“仅以 bash 等价入口通过满足指定命令”的不足。

### 集成套件：明确保留的基线问题

`node scripts/run-unit-tests.mjs integration` 已执行但退出 1，不宣称集成全绿：

- stub integration 35 项中 26 通过、9 失败，为既有 tasks-disabled profile 与设置菜单夹具问题；在未集成新代码的 UI 工作树基线同样为 26/35，失败用例一致。日志：`/tmp/goal-tweak-integration-final.log` 和 `/tmp/goal-tweak-integration-baseline.log`。
- 并行 SDK 组有一个既有 workflow 子进程边界用例失败：5 秒内期望两个 child，实际 0。为排除本次接缝影响，读取 HEAD 原 `goal-drafting.ts`，在**同一主目录**通过临时 Node load hook 替换该模块后运行同一双 SDK 文件组合，仍复现相同错误：`/tmp/goal-tweak-sdk-pristine-root.log`。临时源与 hook 在 `/tmp/goal-tweak-pristine-{drafting.ts,loader.mjs}`，未改工作树。
- 单独 `NODE_OPTIONS= node --experimental-strip-types --test tests/integration/goal-auto-continue-gate-sdk.test.ts` 为 9/9 通过（`/tmp/goal-tweak-sdk-recheck.log`）；不将这个通过冒充完整集成通过，不修改无关生命周期或放宽旧断言。

## 规格场景到证据索引

| 增量要求 / 场景                                                         | 证据                                                                                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 正文局部修改、中文/重复行/空行、无变化及大文本退化                      | `tests/goal-tweak-diff.test.ts`；130000 行插入与一对多分支；真实录制步骤 02                            |
| 任务 ID 对应的增删改、移动、同级顺序、契约/lightweight、blockCompletion | `tests/goal-tweak-diff.test.ts`、`tests/goal-tweak-projection.test.ts`；真实录制步骤 04                |
| 任务进度/证据保留、当前任务清除、任务缺省/显式空列表                    | projection、review 单测；既有 `goal-tweak-status-persistence.test.ts` 全流程与 `goal-drafting.test.ts` |
| 预算保留/null/数值、暂停/阻塞恢复及预算受限准入                         | projection 单测、既有 status-persistence 全流程；review 单测在消费变化导致准入改变时拒绝未审核候选     |
| 目标契约保留、抽取/关闭、预览与提交同候选                               | projection 与 review 单测；真实 E2E oracle 比较已保存全文与磁盘重建全文逐字节一致                      |
| 审计开关实时更新、切回原值、反馈/选择保留                               | `tests/goal-tweak-confirmation.test.ts`；真实步骤 04、05，开关差异出现后恢复关闭                       |
| 只读全文切换、长内容/窄屏/resize、分页和控件可达                        | confirmation 单测（含130000行）；真实步骤 02、03、04                                                   |
| 基础宿主、无 UI、自动确认与不可用策略                                   | confirmation 单测；goal-drafting 的 headless 与 unavailable 回归                                       |
| 确认/继续讨论/取消与固定记录、不重复创建、重放/展开                     | review 单测、confirmation 单测；真实步骤 05、06、07，记录结果依次为 continue、cancel、applied          |
| 初始渲染仅待校验，确认前权威审核                                        | goal-drafting 回归中的 pending 标识、review 独立快照与等价检查；真实确认前完整差异                     |
| revision/焦点变化、存储失败和不误报应用                                 | 既有 goal-drafting/status-persistence 并发及注入失败测试；review 错误记录、revision 和消费准入变化测试 |
| 新建 goal 与 Sisyphus 不回归                                            | goal-drafting 49 项；真实步骤 01 的原创建确认与两任务展示                                              |

## 真实 Pi / tmux / asciinema

- 主环境：`/tmp/pi-e2e-goal-tweak-1104`，从隔离 cwd 启动真实 Pi v1.4.0，仅显式加载本地 `packages/pi-goal-x/extensions/goal.ts`；关闭扩展/skill/上下文等隐式发现。使用用户原有 axonhub / deepseek-v4-flash 实际模型，没有复制凭据、假 provider 或注入批准。
- 精确启动命令位于 `recordings/run-ZqIYpd/launch.sh`，通过仓库 `pi-e2e-env.sh start` 从进程启动起录制；用户主题缺失提示按技能视为预期 cosmetic fallback。
- 唯一录制：`/tmp/pi-e2e-goal-tweak-1104/recordings/run-ZqIYpd/session.cast`；步骤时间索引：同目录 `steps.tsv`，包含 01 创建、02 差异、03 全文、04 任务/设置/审计、05 反馈与取消、06 确认、07 reload/展开。
- 实际 `cmp` 证明继续讨论和取消后目标文件未变；完整会话 JSONL 保存真实模型提案与工具结果。
- 自动断言：在包目录运行 `node --experimental-strip-types tests/e2e/goal-tweak-live-assert.mjs /tmp/pi-e2e-goal-tweak-1104 /tmp/pi-goal-tweak-e2e-plan/replay-history.txt`，退出 0。检查三种结果顺序、反馈原文、任务/预算/审计、最终全文与磁盘等价、关键 UI 状态、v2 cast 与输出事件和两个退出码。
- Pi 与 recorder 均优雅退出 0。完整录制在独立 tmux 回放窗口使用 `asciinema play --speed 60 --idle-time-limit 0.2 <cast>` 播放完成，`REPLAY_EXIT=0`；回放历史捕获在 `/tmp/pi-goal-tweak-e2e-plan/replay-history.txt`。主代理检查了实机关键页面及回放捕获，不宣称逐帧检查所有动画。
- 人工重放命令：`asciinema play /tmp/pi-e2e-goal-tweak-1104/recordings/run-ZqIYpd/session.cast`。
- 录制、session 与模型内容仅保留本地临时目录，未上传或提交；`/tmp` 非长期存储，报告不承诺重启后仍可读取。

## 交付结论

新增行为的单元、类型、流程与真实 TUI 验收均有通过证据，主代理审查问题已修复。完整集成套件仍有上面明确复现的基线失败；LSP 不提供 clean 确认，这些限制不被隐藏。OpenSpec change 留待用户决定何时归档，不执行发布或 git 提交。
