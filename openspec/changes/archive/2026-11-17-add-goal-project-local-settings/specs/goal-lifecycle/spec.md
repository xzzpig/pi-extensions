# 目标生命周期增量规格：项目本地配置

## ADDED Requirements

### Requirement: Goal-X 支持项目本地配置来源

系统 SHALL 自动读取 `<cwd>/.pi/pi-goal-x-settings.local.json`，对所有受支持的 Goal-X 配置按“已有配置项环境变量 > local > project > global > 默认值”解析。local MUST 以当前工作目录定位，不随 `PI_GOAL_SETTINGS_FILE` 改变；既有全局及项目路径覆盖保持原义。未提供 local 时 MUST 保持原有有效配置和生命周期行为，不自动创建配置文件。

#### Scenario: 三个文件同时提供不同字段

- **WHEN** global 提供通用设置，project 提供 `auditor.checklistExtra`，local 提供 `auditor.provider` 和 `auditor.model`
- **THEN** 三类字段同时生效，模型选择来自 local，审计清单来自 project，全局其他设置继续生效

#### Scenario: 同一字段存在多层覆盖

- **WHEN** 同一受支持字段在 global、project、local 中均有合法值
- **THEN** 使用 local 值；该字段如果已有且提供了有效配置项环境变量，则环境变量值优先

#### Scenario: 全部配置域可本地覆盖

- **WHEN** local 提供合法的任务设置、auditor、Oracle、网络恢复、命令或快捷键配置
- **THEN** 各域均使用相同三层优先级，不限制为审计模型专用配置

#### Scenario: 自定义共享配置路径

- **WHEN** `PI_GOAL_SETTINGS_FILE` 指向其他位置的项目配置文件
- **THEN** project 从该路径读取，local 仍从当前工作目录的固定本地文件读取，global 路径规则不变

#### Scenario: 缺少本地文件

- **WHEN** 本地文件不存在
- **THEN** 有效配置与原两层解析相同，不为缺失文件告警，也不因读取设置创建本地文件

### Requirement: 三层配置延续字段继承语义

系统 SHALL 在已有 schema 与校验规则内按字段继承，对数组整体覆盖而非拼接。合法 false、0、空数组 SHALL 保持显式覆盖语义；缺省字段继续继承。删除本层字段 SHALL 恢复向低层解析，MUST NOT 引入以 null 清除继承值的新协议。旧别名规范化规则 SHALL 在每个来源内部保持一致。

#### Scenario: 嵌套对象只覆盖一个字段

- **WHEN** project 设置审计清单和模型，local 只设置审计模型
- **THEN** local 模型覆盖 project 模型，但 project 审计清单仍保留

#### Scenario: 数组及假值覆盖

- **WHEN** local 对允许相应取值的字段配置 false、0 或空数组，而低层配置其他合法值
- **THEN** local 值生效；数组不与低层拼接，空数组不会被当成未配置

#### Scenario: 删除后逐层继承

- **WHEN** 用户删除 local 中的模型字段，再删除 project 中同一字段
- **THEN** 首先恢复 project 模型，随后恢复 global 或默认值，未修改其他层内容

#### Scenario: 兼容旧别名

- **WHEN** 不同层使用受支持的旧平面别名与嵌套规范键
- **THEN** 各层先沿用既有别名规则，再应用层级优先级；同层嵌套规范键优先

### Requirement: 设置界面完整支持三个编辑范围

`/goal-settings` SHALL 支持 global、project、local 三个编辑范围，首次打开默认仍为 project。界面 MUST 明示当前范围与目标路径，并区分最终生效值、来源、本层值或未设置状态；被高优先级来源覆盖时 SHALL 明确提示。Controls 子菜单 SHALL 支持同样范围与来源语义。范围切换和查看 MUST NOT 写文件或触发模型回合。

#### Scenario: 保留默认项目共享编辑

- **WHEN** 用户首次打开设置界面
- **THEN** 默认编辑 project，即使 local 已存在也不自动改为 local；顶部显示项目共享文件路径

#### Scenario: 编辑被本地层覆盖的共享值

- **WHEN** project 模型为 A、local 模型为 B，用户查看 project 并将模型改为 C
- **THEN** 界面区分本层 C 与生效 B，提示 local 覆盖；只保存 project，不修改 local 或 global

#### Scenario: 本地层恢复继承

- **WHEN** 用户切换到 local 并选择删除某项本层覆盖
- **THEN** 仅移除 local 对应字段，界面显示新的有效值和 project、global 或默认来源

#### Scenario: Controls 使用本地配置

- **WHEN** 用户在 local 范围编辑命令、快捷键或暂停顺序
- **THEN** 只写本地文件，删除覆盖按字段恢复继承，适用的刷新或 reload 提示沿用原有机制

#### Scenario: 已有环境变量覆盖

- **WHEN** 某行由已有配置项环境变量控制
- **THEN** 显示环境来源及既有只读提示，不允许通过编辑 local 绕过该环境值

### Requirement: 本地配置遵循既有诊断与安全写入契约

系统 SHALL 对 local 复用既有字段校验与诊断规则，诊断可定位范围、路径及问题字段；非法字段不抹除同文件合法兄弟字段。设置编辑 MUST 拒绝覆盖非法目标文件，并使用既有路径锁、锁内重读、原子写入、权限及符号链接防护。有效配置来源报告 SHALL 纳入 local，刷新边界 SHALL 与现有配置保持一致。

#### Scenario: 非法本地字段

- **WHEN** local 包含非法字段值以及其他合法字段
- **THEN** 非法值被诊断且不参与覆盖，合法字段仍生效；向下继承或默认处理沿用既有规则

#### Scenario: 损坏文件不能被设置界面覆盖

- **WHEN** 本地文件为非法 JSON，或被既有校验判定为非法目标层
- **THEN** 界面写入失败并报告 local 路径与原因，原文件及其他层保持不变

#### Scenario: 修改与刷新

- **WHEN** 通过设置界面修改 local，或在外部修改后经过既有会话启动、恢复、reload 或显式缓存失效边界
- **THEN** 后续配置读取和来源报告使用刷新后的本地值；不额外承诺无刷新边界的文件热监控

#### Scenario: 并发与文件安全

- **WHEN** 两个进程修改 local 的不同字段，或目标文件命中既有符号链接拒绝规则
- **THEN** 并发写入经锁内重读不丢失字段；不安全目标按既有规则拒绝，不能因此改写 global 或 project

### Requirement: 新配置层保持运行与存储边界

三层配置 SHALL 作为既有目标生命周期兼容基线的明确补充。系统 MUST 保留旧 project 读写接口的范围、per-goal auditor override 的优先级及审计各字段的生效时机，不改变目标工具 schema、存储版本、审计裁决和执行授权。插件 MUST NOT 自动迁移用户设置、自动修改 Git 忽略规则，或把本地层宣称为强制团队策略或凭据存储。

#### Scenario: 实际审计使用本地模型及共享纪律

- **WHEN** local 设置合法审计 provider/model，project 设置附加审计清单，且没有更高层的 per-goal override
- **THEN** 审计请求使用该模型和共享附加清单，global 中其他审计字段继续生效，完成仍须通过原有门禁和真实审计裁决

#### Scenario: 定义层仍按原时机生效

- **WHEN** 用户修改 local 中请求层设置或默认审计 agent 定义层设置
- **THEN** 请求层沿用下次审计生效规则，定义层仍按新会话或 reload 生效，不因新增来源改变注册生命周期

#### Scenario: 不污染共享及个人配置

- **WHEN** 安装或加载插件、读取设置或关闭设置界面而未执行编辑
- **THEN** 不迁移已有模型字段、不写全局或共享文件、不修改用户仓库 Git 规则；忽略本地文件由仓库维护者显式配置
