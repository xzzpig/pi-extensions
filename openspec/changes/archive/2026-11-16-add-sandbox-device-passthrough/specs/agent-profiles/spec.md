# Profile 设备权限规范增量

## ADDED Requirements

### Requirement: sandbox profile 支持设备白名单字段

sandbox profile SHALL 接受 `filesystem.allowDevices`，并应用设备节点校验与项目信任约束。用户全局及已信任项目的 profile 可声明该字段；运行时注册 profile 采用既有扩展信任级别。agent frontmatter MUST 仍只能传递 profile 名称，不得嵌入设备规则。新增字段 MUST NOT 改变其他 profile 字段的合并和信任行为。

#### Scenario: 全局和可信项目 profile 可授权

- **WHEN** 选择来自全局或已信任项目的合法 profile，且其中声明合法设备列表
- **THEN** 设备字段通过校验并传至运行时，在实际沙箱命令中生效

#### Scenario: 未信任项目 profile 不授予设备

- **WHEN** 项目未受信任或信任未知，其 profile 声明额外设备
- **THEN** 项目 profile 不参与设备授权；全局同名 profile 仍可解析，仅项目存在的名称沿用既有失败关闭行为

#### Scenario: agent 不能嵌入设备规则

- **WHEN** agent frontmatter 以对象形式在 `sandbox` 中嵌入 `allowDevices`
- **THEN** 选择器校验拒绝该定义，不解释内嵌设备规则

### Requirement: 设备列表的 profile 合并结果确定且可撤销

无 profile 时，全局与可信项目的设备列表 SHALL 去重取并集。选中 profile 时，省略 `allowDevices` SHALL 继承有效基线，显式列表 SHALL 替换基线（空数组清空）；全局与可信项目同名 profile 的设备列表由项目显式值替换，省略则继承。`inheritGlobalConfig: false` MUST 不继承全局顶层设备授权。硬拒绝冲突 MUST 仍按设备策略拒绝。

#### Scenario: profile 继承或清空设备

- **WHEN** 全局基线允许设备 A，选中的 profile 省略设备字段或显式设为空数组
- **THEN** 省略时继承 A，空数组时不透传 A；后续新命令使用新的有效列表

#### Scenario: 同名项目 profile 替换设备列表

- **WHEN** 全局同名 profile 允许 A，已信任项目同名 profile 显式允许 B
- **THEN** 最终设备列表仅包含 B，不因合并自动保留 A

#### Scenario: 禁止全局继承

- **WHEN** profile 设置 `inheritGlobalConfig: false`，全局顶层允许 A，而 profile 和可信项目基线都未声明 A
- **THEN** A 不进入最终设备白名单

#### Scenario: 会话与并发执行隔离

- **WHEN** 不同会话使用不同设备 profile，或某会话在已有命令运行时切换 profile
- **THEN** 各会话的新命令仅使用各自当前有效列表，已运行命令保留启动时挂载；系统不宣称能撤销已经打开的设备描述符
