# 实施任务

## 1. 生效清单与提示词快照

- [x] 1.1 在 fork-only 模块实现清单快照与唯一 ID，保留默认条件项、替换、附加、空数组及重复文字语义；通过 fork-only 单测覆盖全部组合，断言原文与顺序。
- [x] 1.2 将委派启动和审计 prompt 接到同一快照，首次进度即携带完整清单；通过 prompt/委派测试断言 ID 一致、转义、注入顺序、两种未设置输入相等及协议尾始终保留。
- [x] 1.3 在详细文档中说明清单来源、条件项及同一 attempt 配置冻结规则；用配置示例和快照测试对照验证，不扩充 README。

## 2. 逐项协议与 attempt 状态

- [x] 2.1 扩展 child-only report_auditor_progress 以兼容旧调用并支持 ID/state/detail，工具结果输出 v2 sequence；通过工具 schema/执行测试证明旧调用有效、逐项字段成对校验、序号由工具生成及长度边界生效。
- [x] 2.2 在 fork-only 模块实现 v2/v1/旧文本解析、序号去重和逐项更新，通过测试覆盖多条记录、累计重放、重复、乱序、非法 ID/状态/JSON/超限字段、修正状态以及预览参数不能更新状态；验证内部记录不泄漏到普通审核输出。
- [x] 2.3 将清单状态接入精确 attempt 与现有 park/resume/终态生命周期；通过委派集成测试证明同一 child 继续保留状态、挂起期间上报恢复可见、配置修改不漂移、终态冻结、跨 attempt 隔离及资源清理。
- [x] 2.4 更新默认 auditor 的逐项上报指引及详细协议文档，移除固定百分比代表清单通过的指导；通过注册/提示词测试断言 ID/state/依据说明存在、必需工具不丢失且自定义 agent 仍获得任务级说明。

## 3. 动态模型、展示与滚动

- [x] 3.1 用真实条目替换 dashboard 固定五项及百分比推算，计算已检查/总数、通过/不通过、当前项；模型测试覆盖零项、部分上报、多个 running、状态修正、旧百分比不补勾与终态不补勾。
- [x] 3.2 实现紧凑汇总/当前项及展开完整清单/依据/工具诊断；渲染测试覆盖中文、控制字符、长标题/依据及多种终端宽度，确认旧估计明确标注、终态 running 不再显示活跃动画。
- [x] 3.3 将审计展开内容接入现有滚动按键和有界 viewport；键盘/渲染测试证明末项和完整依据可达、窗口缩放可用、同 attempt 偏移保留、新 attempt 重置且 header/汇总可见。
- [x] 3.4 调整批准结果卡的固定断言文案，保留三类卡片、findings 和恢复普通 dashboard 的时序；测试证明 approved 与未检查/失败项共存时不虚构全部通过，并更新详细使用文档与 CHANGELOG 的未发布条目。

## 4. 完成判定与兼容回归

- [x] 4.1 增加完成流程回归测试：合法 approved 加 pending/running/failed 仍按原事务完成；全项 passed 加拒绝、错误或无效 verdict 不完成；缺失/非法展示进度不成为新 gate，断言账本与唯一终态不变。
- [x] 4.2 核验旧 auditor、空清单、skip/bypass、焦点失效、timeout 和 park/resume 路径；运行原委派/完成/结果卡相关套件，只替换 D-17 明确淘汰的五阶段断言，保留安全和失败关闭断言，并记录逐场景证据。
- [x] 4.3 补齐 subtree reapplyOnSync、doNotReintroduce 和必要 knownDebt，重新生成 tests/.test-manifest.json；以测试自检、fork identity 检查及 fork-divergence 审计通过证明没有将新业务逻辑混入上游文件。

## 5. 综合验收

- [x] 5.1 在仓库 direnv/Nix 环境运行包 typecheck、全部相关单元与委派集成套件、改动文件格式检查和 pnpm run audit:fork-divergence；记录命令、退出码及场景追踪，失败不得标记完成。
- [x] 5.2 按 pi-plugin-e2e-test 与 pi-tmux-tmp-server 技能在隔离目录中运行真实 Pi/TUI 和真实模型审计，保留 asciinema 录制；自动证据验证 checklistExtra 可见、逐项进度、紧凑/展开与长列表滚动、继续同一审计和真实 verdict。缺工具/凭据时明确 blocked，不以模拟结果替代。
- [x] 5.3 核查规格中旧五阶段/字节不变引用已被 D-17 正确替代，逐项比对本增量所有场景与测试/真实运行证据；运行 openspec validate show-dynamic-audit-checklist 并产出最终验证记录，确认无包外代码修改、无版本升级、无发布。
