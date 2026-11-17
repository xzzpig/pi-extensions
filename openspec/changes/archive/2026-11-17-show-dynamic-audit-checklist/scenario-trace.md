# 场景与证据追踪

本增量共 43 个场景。表中测试均已执行，最终输出见 `/tmp/dynamic-checklist-final-tests.log`；真实 SDK 10/10、单元 1691/1691、回归 E2E 39/39 通过。设置集成组的 9 个既有失败已在 HEAD 独立快照中复现，不属于本次新增差异；详见 validation.md，不将聚合命令的非零退出伪报为通过。

测试文件名默认相对 `packages/pi-goal-x/tests/`；生产代码核查项明确单列，不冒充额外的联网测试。

## 增量规格逐场景

| 要求                           | 场景                                       | 证据                                                                                                                                               |
| ------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 改造差异与兼容性基线           | 实现全部预期差异                           | goal-auditor.test.ts；goal-auditor-package.test.ts；goal-delegation-completion.test.ts；本表下方 D/I 基线追踪                                      |
| 改造差异与兼容性基线           | 保持全部兼容行为                           | goal-auditor.test.ts；goal-auditor-package.test.ts；goal-delegation-completion.test.ts；本表下方 D/I 基线追踪                                      |
| 改造差异与兼容性基线           | 检测未声明的行为变化                       | goal-auditor.test.ts；goal-auditor-package.test.ts；goal-delegation-completion.test.ts；本表下方 D/I 基线追踪                                      |
| 保留结构化审计可视化 Dashboard | 五阶段进度依次推进                         | fork-audit-dashboard.test.ts；goal-audit-dashboard.test.ts；goal-widget.test.ts；真实 TUI 02–06 步                                                 |
| 保留结构化审计可视化 Dashboard | Host Tool-result Event Shape Is Normalized | fork-audit-dashboard.test.ts；goal-audit-dashboard.test.ts；goal-widget.test.ts；真实 TUI 02–06 步                                                 |
| 保留结构化审计可视化 Dashboard | 展开 Dashboard 显示工具诊断                | fork-audit-dashboard.test.ts；goal-audit-dashboard.test.ts；goal-widget.test.ts；真实 TUI 02–06 步                                                 |
| 保留结构化审计可视化 Dashboard | 审计结果卡后恢复正常视图                   | fork-audit-dashboard.test.ts；goal-audit-dashboard.test.ts；goal-widget.test.ts；真实 TUI 02–06 步                                                 |
| 保留结构化审计可视化 Dashboard | Dashboard 在不同终端宽度内稳定             | fork-audit-dashboard.test.ts；goal-audit-dashboard.test.ts；goal-widget.test.ts；真实 TUI 02–06 步                                                 |
| 保留结构化审计可视化 Dashboard | 当前项与覆盖度                             | fork-audit-dashboard.test.ts；goal-audit-dashboard.test.ts；goal-widget.test.ts；真实 TUI 02–06 步                                                 |
| 保留结构化审计可视化 Dashboard | 显式空清单                                 | fork-audit-dashboard.test.ts；goal-audit-dashboard.test.ts；goal-widget.test.ts；真实 TUI 02–06 步                                                 |
| 详细审计观察统一使用 Fleet     | 审计启动不再自动弹出 Transcript            | goal-auditor-package.test.ts（D-08）；原生 Fleet 在真实录制中显示 1 active agent；生产未增加自有 transcript                                        |
| 详细审计观察统一使用 Fleet     | Fleet 查看详细 Review 过程                 | goal-auditor-package.test.ts（D-08）；原生 Fleet 在真实录制中显示 1 active agent；生产未增加自有 transcript                                        |
| 详细审计观察统一使用 Fleet     | `/goal-audit` 从命令面移除                 | goal-auditor-package.test.ts（D-08）；原生 Fleet 在真实录制中显示 1 active agent；生产未增加自有 transcript                                        |
| 详细审计观察统一使用 Fleet     | 删除面板不改变审计事务                     | goal-auditor-package.test.ts（D-08）；原生 Fleet 在真实录制中显示 1 active agent；生产未增加自有 transcript                                        |
| 详细审计观察统一使用 Fleet     | Goal 包不再保留 Transcript Runtime         | goal-auditor-package.test.ts（D-08）；原生 Fleet 在真实录制中显示 1 active agent；生产未增加自有 transcript                                        |
| 审计进度和取消保持可观察       | 显示子代理进度                             | goal-auditor.test.ts（timeout/取消/预览/身份）；goal-delegation-completion.test.ts（park/resume/bypass/焦点）；真实 TUI 02–03 步                   |
| 审计进度和取消保持可观察       | Dashboard 显示委派进度                     | goal-auditor.test.ts（timeout/取消/预览/身份）；goal-delegation-completion.test.ts（park/resume/bypass/焦点）；真实 TUI 02–03 步                   |
| 审计进度和取消保持可观察       | 展示摘要不丢失 Auditor 进度                | goal-auditor.test.ts（timeout/取消/预览/身份）；goal-delegation-completion.test.ts（park/resume/bypass/焦点）；真实 TUI 02–03 步                   |
| 审计进度和取消保持可观察       | Esc 取消当前审计                           | goal-auditor.test.ts（timeout/取消/预览/身份）；goal-delegation-completion.test.ts（park/resume/bypass/焦点）；真实 TUI 02–03 步                   |
| 审计进度和取消保持可观察       | 继续审计复用同一子代理                     | goal-auditor.test.ts（timeout/取消/预览/身份）；goal-delegation-completion.test.ts（park/resume/bypass/焦点）；真实 TUI 02–03 步                   |
| 审计进度和取消保持可观察       | 直接完成时才取消                           | goal-auditor.test.ts（timeout/取消/预览/身份）；goal-delegation-completion.test.ts（park/resume/bypass/焦点）；真实 TUI 02–03 步                   |
| 审计进度和取消保持可观察       | 挂起期间焦点丢失                           | goal-auditor.test.ts（timeout/取消/预览/身份）；goal-delegation-completion.test.ts（park/resume/bypass/焦点）；真实 TUI 02–03 步                   |
| 审计进度和取消保持可观察       | 取消确认缺失时有界收敛                     | goal-auditor.test.ts（timeout/取消/预览/身份）；goal-delegation-completion.test.ts（park/resume/bypass/焦点）；真实 TUI 02–03 步                   |
| 审计进度和取消保持可观察       | 取消后迟到批准不能授权完成                 | goal-auditor.test.ts（timeout/取消/预览/身份）；goal-delegation-completion.test.ts（park/resume/bypass/焦点）；真实 TUI 02–03 步                   |
| 审计进度和取消保持可观察       | 挂起期间子代理已完成                       | goal-auditor.test.ts（timeout/取消/预览/身份）；goal-delegation-completion.test.ts（park/resume/bypass/焦点）；真实 TUI 02–03 步                   |
| 审计进度和取消保持可观察       | 挂起超时按 fail closed 收敛                | goal-auditor.test.ts（timeout/取消/预览/身份）；goal-delegation-completion.test.ts（park/resume/bypass/焦点）；真实 TUI 02–03 步                   |
| 审计进度和取消保持可观察       | 恢复阶段重复中断不生效                     | goal-auditor.test.ts（timeout/取消/预览/身份）；goal-delegation-completion.test.ts（park/resume/bypass/焦点）；真实 TUI 02–03 步                   |
| 审计进度和取消保持可观察       | 配置的审计时长上限生效                     | goal-auditor.test.ts（timeout/取消/预览/身份）；goal-delegation-completion.test.ts（park/resume/bypass/焦点）；真实 TUI 02–03 步                   |
| 审计进度和取消保持可观察       | 未设置时保持默认上限                       | goal-auditor.test.ts（timeout/取消/预览/身份）；goal-delegation-completion.test.ts（park/resume/bypass/焦点）；真实 TUI 02–03 步                   |
| 审计进度和取消保持可观察       | 非法值回退默认                             | goal-auditor.test.ts（timeout/取消/预览/身份）；goal-delegation-completion.test.ts（park/resume/bypass/焦点）；真实 TUI 02–03 步                   |
| 审计进度和取消保持可观察       | project 层覆盖 global 层                   | goal-auditor.test.ts（timeout/取消/预览/身份）；goal-delegation-completion.test.ts（park/resume/bypass/焦点）；真实 TUI 02–03 步                   |
| 审计进度和取消保持可观察       | 防挂死兜底不受配置影响                     | goal-auditor.test.ts（timeout/取消/预览/身份）；goal-delegation-completion.test.ts（park/resume/bypass/焦点）；真实 TUI 02–03 步                   |
| 审计清单使用同一生效快照       | 默认与条件项                               | fork-audit-checklist.test.ts（默认条件项、替换/附加/重复项、不可变性、prompt 和首次委派、park/resume）                                             |
| 审计清单使用同一生效快照       | 替换及附加                                 | fork-audit-checklist.test.ts（默认条件项、替换/附加/重复项、不可变性、prompt 和首次委派、park/resume）                                             |
| 审计清单使用同一生效快照       | 空替换与仅附加                             | fork-audit-checklist.test.ts（默认条件项、替换/附加/重复项、不可变性、prompt 和首次委派、park/resume）                                             |
| 审计清单使用同一生效快照       | 审计中修改配置并继续                       | fork-audit-checklist.test.ts（默认条件项、替换/附加/重复项、不可变性、prompt 和首次委派、park/resume）                                             |
| 逐项进度上报保持有界和隔离     | 按 ID 更新及修正                           | fork-audit-progress.test.ts（schema、边界、去重、非法、Unicode、独立 reducer）；fork-audit-checklist.test.ts（错误 attempt、终态冻结、观察者隔离） |
| 逐项进度上报保持有界和隔离     | 未知及非法上报                             | fork-audit-progress.test.ts（schema、边界、去重、非法、Unicode、独立 reducer）；fork-audit-checklist.test.ts（错误 attempt、终态冻结、观察者隔离） |
| 逐项进度上报保持有界和隔离     | 跨 attempt 与迟到事件                      | fork-audit-progress.test.ts（schema、边界、去重、非法、Unicode、独立 reducer）；fork-audit-checklist.test.ts（错误 attempt、终态冻结、观察者隔离） |
| 逐项进度上报保持有界和隔离     | 仅预览参数不能更新状态                     | fork-audit-progress.test.ts（schema、边界、去重、非法、Unicode、独立 reducer）；fork-audit-checklist.test.ts（错误 attempt、终态冻结、观察者隔离） |
| 检查项展示不得成为新的完成门槛 | 批准但上报不全                             | fork-audit-completion-gate.test.ts（7 个实际完成事务/账本组合）；fork-audit-dashboard.test.ts（终态不补勾）；首次真实超时录制                      |
| 检查项展示不得成为新的完成门槛 | 全项通过不能授权完成                       | fork-audit-completion-gate.test.ts（7 个实际完成事务/账本组合）；fork-audit-dashboard.test.ts（终态不补勾）；首次真实超时录制                      |
| 检查项展示不得成为新的完成门槛 | 超时及取消不补勾                           | fork-audit-completion-gate.test.ts（7 个实际完成事务/账本组合）；fork-audit-dashboard.test.ts（终态不补勾）；首次真实超时录制                      |

## 既有 D/I 基线与 D-17 的明确替代

下表保留既有自动化证据与未改动路径核查边界；不为本次变更扩大到外部服务联网测试或修复已登记的设置菜单基线债务。D-17 明确替代旧五阶段及旧 prompt 字节基线，其余执行/裁决不变。

| ID   | 验证证据                                                                                                                                                  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-01 | goal-auditor.test.ts；goal-delegation-completion.test.ts（fresh delegation）                                                                              |
| D-02 | goal-auditor.test.ts（missing bridge）                                                                                                                    |
| D-03 | goal-auditor-package.test.ts；goal-auditor.test.ts（标准配置/请求继承）                                                                                   |
| D-04 | goal-auditor-package.test.ts（定义层及隔离）                                                                                                              |
| D-05 | goal-auditor-package.test.ts；fork-audit-progress.test.ts（协议工具）                                                                                     |
| D-06 | goal-fork-settings.test.ts；goal-auditor-registration.ts 的 MCP 定义合并路径未改动（结构核查，不声称真实 MCP 联网测试）                                   |
| D-07 | goal-auditor.test.ts；fork-audit-completion-gate.test.ts（有效/无效 verdict）                                                                             |
| D-08 | goal-auditor-package.test.ts（移除自有 transcript）；真实录制原生 agent 行                                                                                |
| D-09 | goal-auditor.test.ts（不序列化 runtime-only 父状态）                                                                                                      |
| D-10 | goal-delegation-completion.test.ts；真实 TUI 同一 request 恢复                                                                                            |
| D-11 | goal-auditor-package.test.ts；goal-auditor.test.ts（preflight/错误）                                                                                      |
| D-12 | goal-auditor-package.test.ts（默认注册/自定义 agent）                                                                                                     |
| D-13 | goal-auditor-package.test.ts；goal-tool-names.test.ts（工具/命令面）                                                                                      |
| D-14 | goal-auditor.test.ts；fork-audit-checklist.test.ts（提示注入顺序及转义）                                                                                  |
| D-15 | goal-audit-supervisor-completion.test.ts；goal-audit-sidechannel.test.ts；integration/goal-audit-sidechannel-sdk.test.ts                                  |
| D-16 | fork-audit-persistence.test.ts（audit_started/result/skipped 写入失败）                                                                                   |
| D-17 | fork-audit-checklist.test.ts；fork-audit-progress.test.ts；fork-audit-dashboard.test.ts；fork-audit-completion-gate.test.ts；真实 TUI 11 项和唯一真实批准 |
| I-01 | goal-service.test.ts；goal-features.test.ts（完成前置校验）                                                                                               |
| I-02 | integration/extension.test.ts 中 legacy skipAuditor 与 disabled 路径通过；goal-ledger.test.ts；既有 9 个失败另列                                          |
| I-03 | goal-auditor.test.ts（显式证据/UNTRUSTED）                                                                                                                |
| I-04 | goal-auditor.test.ts；goal-auditor-package.test.ts（fresh/隔离）                                                                                          |
| I-05 | fork-audit-completion-gate.test.ts；goal-delegation-completion.test.ts                                                                                    |
| I-06 | fork-audit-completion-gate.test.ts；首次真实超时后 active                                                                                                 |
| I-07 | fork-audit-completion-gate.test.ts；goal-delegation-completion.test.ts（唯一账本终态）                                                                    |
| I-08 | goal-service.test.ts；goal-stabilization-lifecycle.test.ts（过期/归属保护）                                                                               |
| I-09 | goal-delegation-completion.test.ts；真实 TUI 02–03 步                                                                                                     |
| I-10 | goal-delegation-completion.test.ts（拒绝不自动重审）                                                                                                      |
| I-11 | goal-auditor.test.ts（resolveAuditorDelegationOverrides）；真实 child 使用既有 provider                                                                   |
| I-12 | goal-auditor.test.ts；fork-audit-dashboard.test.ts；实际录制                                                                                              |
| I-13 | goal-auditor-package.test.ts（只读工具定义）；生产 mutation allowlist 未改变                                                                              |
| I-14 | goal-auditor.test.ts（observer 抛错）；fork-audit-checklist.test.ts（观察者修改不能污染状态）                                                             |
| I-15 | goal-delegation-completion.test.ts（报告回流）；goal-audit-dashboard.test.ts（真实报告结果卡）                                                            |
| I-16 | goal-auditor.test.ts（监听/定时器清理）；原生命周期回归                                                                                                   |
| I-17 | fork-audit-dashboard.test.ts；goal-widget.test.ts；实际紧凑/展开/缩放/滚动                                                                                |
| I-18 | goal-audit-dashboard.test.ts（结果卡清除后恢复）；实际批准/错误结果                                                                                       |
| I-19 | fork-audit-checklist.test.ts；goal-auditor.test.ts（无设置与解析默认值相等）                                                                              |
| I-20 | goal-auditor-package.test.ts；fork-audit-checklist.test.ts（空清单、协议尾/工具保留）                                                                     |
| I-21 | goal-auditor-package.test.ts（同名配置 agent）                                                                                                            |
