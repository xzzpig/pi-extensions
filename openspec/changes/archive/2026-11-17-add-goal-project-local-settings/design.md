# 技术设计：Goal-X 项目本地配置层

## Context

动机见 proposal.md。现状由源码确认：`goal-settings.ts` 以 sparse layer 解析 global/project，`resolveLeaf` 逐项解析，`track` 记录来源；快照包含两个原始层。文件缓存与解析缓存分离，后者依赖两个层的身份及既有配置项环境变量。缓存在明确的会话/操作边界失效，不是文件监听器。

`mutateSettingsLayer` 已有路径锁、锁内重读、校验、原子写入与权限保护；旧整文件保存 API 明确写 project。`goal-commands.ts` 默认编辑 project，在两个范围间切换。`widgets/goal-controls-dialog.ts` 自行计算继承和来源，且在锁内比较 global、global+project 的修改前后冲突；不能只给主设置菜单增加选项。

pi-goal-x 来自 subtree。已运行 inventory，`goal-settings.ts` 与 `goal-commands.ts` 是修改过的上游文件。新增辅助逻辑、测试和详细文档应尽量隔离到 fork-only 文件，避免把整个设置系统重写成框架。

## Goals / Non-Goals

**目标：**

- 让三层文件共用 schema、别名规范化、安全写入与既有生效时机。
- 有效配置、本层内容、来源显示保持一致，既能安全编辑又可恢复继承。
- 在缺少 local 时保持有效值和运行行为兼容，接受设置界面新增范围及更准确的来源展示。

**非目标：**

- 不新增 include、任意配置文件链、模型环境变量、null 删除标记或数组合并策略。
- 首期不增加 local 路径环境变量，local 始终为 cwd 下固定路径。
- 不新增文件监听、跨文件事务、强制团队策略或凭据管理能力。
- 不修改其他插件或 pi-subagents；不改变 per-goal override、审计批准与运行授权逻辑。

## Decisions

### D1：固定 local 层及向后兼容的公开模型

增加 `local` 范围、来源及快照原始层，保留已有 global/project 字段。新增本地路径解析入口，既有两个路径环境变量不改义。默认编辑范围按用户选择保持 project；范围切换顺序固定为 project → local → global → project，Controls 使用同一范围描述和选择逻辑。

不采用替换全局文件或启动前生成合并文件：二者要么丢失全局来源，要么使编辑器写入派生产物。也不恢复 auditor 模型环境变量：它不能解决全部配置的第三来源问题。

### D2：在 sparse 层组合，不在最终运行配置上打补丁

新增 fork-only 辅助模块（建议 `extensions/fork-settings-layers.ts`），集中提供层顺序、路径/标签、已校验 sparse 层组合、逐路径来源/继承查询。组合仅作用于解析后的 schema 数据：对象递归覆盖，数组和标量替换，以 undefined 表示缺省；不处理未校验任意 JSON，不产生共享可变数组引用。

优先让既有逐字段解析器接收 project+local 的内部覆盖视图，复用当前默认值和环境变量处理；在记录来源时检查规范化字段路径是否在 local 中显式存在，将文件来源精确标注为 local 或 project。快照中的 project 必须仍是原始项目层，不能被内部覆盖视图冒充；快照增加原始 local 层。命令配置的存在性判断、keybindings 和 Oracle 等嵌套字段同样使用组合视图，不能只修 auditor。

拒绝在 `loadGoalSettings` 最后直接展开 local：那会绕过校验、默认值、来源及嵌套字段继承。也不复制另一套完整配置解析器。实现时以最小接缝接入上述辅助逻辑，并以逐字段覆盖测试证明内部组合没有扭曲来源。

### D3：缓存、诊断和运行消费者一起扩展

解析缓存加入 local 层身份；路径缓存不得因不同范围引用相同自定义路径而返回错误范围诊断，缓存读取结果需按路径及范围区分或正确重新标注。既有失效入口清理全部相关缓存，local 修改后同步刷新有效值与来源。

复用现有 parser：非法值不参与覆盖、有效兄弟字段仍保留；损坏 JSON 有范围与路径诊断，设置界面拒绝覆盖非法目标。保持现有刷新边界，不宣称外部修改无条件立即生效。

`effectiveSettingsReport` 增加 local 路径和来源。所有通过统一加载器读取的运行消费者自然得到三层值；`loadGoalSettingsWithAuditorOverride` 继续在完整配置解析后合并 per-goal override。请求/提示层下次审计生效，定义层仍需新会话或 reload。

### D4：显式范围写入和可解释的 UI

主设置菜单与 Controls 共用范围/来源辅助逻辑；主界面首次默认 project。列表显示最终值与来源，编辑详情明确本层值或未设置、继承候选和遮蔽提示；较长内容沿用既有摘要/展开方式，避免主列表铺开全部列表和文本。

编辑动作只传明确范围与 sparse 字段变更给既有安全写入入口。删除覆盖不能写入当前继承值。global 的删除动作回默认；project/local 的删除动作恢复向下继承。旧 `saveGoalSettingsFileConfig` 和 project-only 读取兼容函数不改变目标范围，不能把包含 local 的有效快照自动持久化到共享文件。

Controls 冲突校验分别比较修改前后 global、global+project、global+project+local 的视图；锁内重读当前目标层及其他来源，只拒绝新增冲突，保留原来不阻止既有冲突修复的规则。低层配置即便被 local 遮蔽也要校验其本层可见视图，不能让 local 隐藏共享配置新增的冲突。命令变更仍沿用原 reload 提示与恢复命令保护；键绑定与暂停操作不改变现有能力边界。

### D5：Git 和文档由维护者显式管理

实现阶段在本仓库根 `.gitignore` 添加 `/.pi/pi-goal-x-settings.local.json`；插件运行时不碰 Git。用户已有 `.pi/pi-goal-x-settings.json` 当前有未提交模型字段，本变更不得恢复、搬迁或覆盖它们，也不读写真实全局配置。

详细三来源说明放 fork-only `docs/project-local-settings.md` 并加入 package files；只在 README 现有 Settings 中作必要事实修正，CHANGELOG 记录功能。说明数组替换、定义层 reload、非凭据存储和手工忽略文件的边界。

### D6：验证由纯配置到真实交互分层执行

新测试放 fork-only 文件，覆盖所有规格场景，并回归既有 layered/race/controls/auditor 测试。重点含完整配置域、别名、false/0/空数组、路径覆盖、来源与缓存、并发安全、遮蔽提示、Controls 候选冲突校验以及 per-goal override。

真实 Pi TUI 验收使用隔离临时工作目录和临时全局文件，按 E2E 与 tmux 技能运行并保留 asciinema 录制；验证默认 project、三个范围、只写目标文件、删除覆盖及 Controls。另执行真实审计，证明模型来自 local、共享清单进入实际审计输入且全局其他值未丢失；凭据经现有受支持机制使用，不复制进配置或录屏。静态解析或 mock delegation 不能替代实际选模证据。运行条件不可用需明确报告阻塞，不能标记全项完成。

## Risks / Trade-offs

- [来源与有效值错位] → 保存原始三层，集中逐路径来源判断，测试同字段三层取值及遮蔽后的编辑。
- [遗漏某配置域或 Controls 独立合并路径] → 全域矩阵测试与源码消费者检查；每个嵌套控制域至少有覆盖/删除回归。
- [误改团队文件] → 默认 project 是用户明确选择；顶部必须明示文件，local 操作逐文件差异断言。
- [用户误认为团队清单不可覆盖] → 文档说明 local 是个人覆盖，不提供强制策略保证。
- [上游同步成本] → 新逻辑隔离到 fork-only 文件；按实际修改更新 reapplyOnSync/knownDebt，运行 fork-divergence gate，不因规划而预先虚构债务。
- [外部修改未被即时读取] → 沿用并说明既有刷新边界，测试会话/reload/显式失效，不扩大为实时文件监控。

## Migration Plan

1. 发布前完成自动化及真实运行验证；安装更新本身不创建或迁移用户配置。
2. 维护者按需忽略本地文件，用户主动在 local 填写当前项目个人覆盖；共享文件继续管理团队值，全局文件保持原样。
3. 本仓库既有未提交配置留待用户另行决定，不属于自动迁移任务。
4. 回滚时使用旧版本会忽略 local 并回到 global/project 行为；删除 local 也可立即退出第三层配置（按既有刷新边界生效）。无目标存储版本迁移。
