# vibeguard-mapping-view Specification

## Purpose

为 pi-vibeguard 提供映射查看能力：让用户能逐条查看当前会话中被保护内容（原文）与其 placeholder、触发 category 的对应关系及剩余有效期，并按 category 汇总概况，用于排查脱敏误报与配置污染。

## Requirements

### Requirement: 映射数据范围为当前会话存活映射

`/vibeguard:list` SHALL 仅展示当前会话中存活的映射——即此刻仍存在于插件内存映射表中、未因 TTL 过期或容量驱逐被移除的条目。它 MUST NOT 展示已过期、已驱逐或历史会话的条目。

#### Scenario: 展示全部存活条目

- **WHEN** 会话中已发生敏感值脱敏，用户执行 `/vibeguard:list`
- **THEN** 列表展示此刻映射表中的全部存活条目，每条包含 category、placeholder、original（按打码策略展示）与剩余 TTL

#### Scenario: 过期条目不可见

- **WHEN** 某映射的 TTL 已到期并被插件清理后，用户执行 `/vibeguard:list`
- **THEN** 该条目不出现在列表中，且总数相应减少

#### Scenario: 会话隔离

- **WHEN** 用户新开一个 pi 会话后执行 `/vibeguard:list`
- **THEN** 列表为空（新会话尚无映射），不显示其他会话的任何条目

### Requirement: category 从 placeholder 解析展示

系统 SHALL 从每个条目的 placeholder 字符串中解析其内嵌 category（格式 `__VG_<CATEGORY>_<hash12>__`，含 hash 碰撞时可能带 `_<N>` 数字后缀），并在列表与统计中展示该 category。无法按格式解析的条目 SHALL 以 `UNKNOWN` 类别展示，MUST NOT 因此丢弃该条目。

#### Scenario: 常规格式解析

- **WHEN** 某条目的 placeholder 为 `sk-a0d309c77dd44d57be0f1a675c0zzzzz`
- **THEN** 该条目的 category 展示为 `OPENAI_KEY`

#### Scenario: 碰撞后缀解析

- **WHEN** 某条目的 placeholder 为 `__VG_JWT_aabbccddeeff_2__`
- **THEN** 该条目的 category 展示为 `JWT`（数字后缀不参与解析）

#### Scenario: 异常格式降级

- **WHEN** 某条目的 placeholder 不符合预期格式（如自定义 `placeholder_prefix` 变更导致）
- **THEN** 该条目仍出现在列表中，category 展示为 `UNKNOWN`

### Requirement: 原文默认打码并支持按键切换

`/vibeguard:list` 的原文列 SHALL 默认打码展示：保留前 3 个与后 4 个字符、中间以省略号代替；原文长度不足以安全打码时（≤7 字符）SHALL 整体以 `•` 代替。用户按 `r` 键 SHALL 在打码与明文之间即时切换，且 MUST NOT 打断列表的浏览状态（滚动位置、选中项）。

#### Scenario: 默认打码

- **WHEN** 用户打开 `/vibeguard:list`
- **THEN** 所有原文默认以打码形式展示，界面提示可按 `r` 切换明文

#### Scenario: 按键切换明文

- **WHEN** 用户在列表界面按 `r` 键
- **THEN** 原文列切换为明文显示，再次按 `r` 恢复打码；滚动位置与条目顺序保持不变

#### Scenario: 短原文不可推断

- **WHEN** 某条目原文长度 ≤ 7 字符
- **THEN** 该条目原文无论明暗状态均整体显示为 `•`，不泄露长度以外的任何信息

### Requirement: /vibeguard:stats 按 category 汇总

`/vibeguard:stats` SHALL 按 category 分组统计当前存活映射数量，并以降序展示（含条形图与计数）。

#### Scenario: 分类汇总排序

- **WHEN** 当前存活映射为 4 条 OPENAI_KEY、12 条 SECRET_VALUE、2 条 JWT，用户执行 `/vibeguard:stats`
- **THEN** 统计按数量降序展示：SECRET_VALUE 12、OPENAI_KEY 4、JWT 2

#### Scenario: 与 list 数据一致

- **WHEN** 同一时刻分别执行 `/vibeguard:list` 与 `/vibeguard:stats`
- **THEN** 统计中各 category 计数之和等于列表条目总数

### Requirement: 空态与未启用态提示

当无数据可展示时，命令 SHALL 给出明确提示而非空白或报错。

#### Scenario: 无存活映射

- **WHEN** 当前会话尚无任何脱敏发生，用户执行 `/vibeguard:list` 或 `/vibeguard:stats`
- **THEN** 界面提示"当前会话暂无存活映射"

#### Scenario: 插件未启用

- **WHEN** 配置缺失或 `enabled=false` 时，用户执行任一命令
- **THEN** 界面提示插件未启用及其原因（如配置文件路径），不渲染空表格

### Requirement: 命令输出不进入 LLM 上下文

两个命令的展示 SHALL 仅通过本地 TUI 渲染，MUST NOT 向会话消息流写入任何内容（无论明文或打码形式），MUST NOT 触发 provider 请求。

#### Scenario: 上下文零污染

- **WHEN** 用户执行 `/vibeguard:list` 并查看明文后关闭
- **THEN** 会话未新增任何消息条目，后续发送给 LLM provider 的请求中不包含命令输出内容

### Requirement: 命令注册形态

插件 SHALL 以冒号命名空间注册命令：`/vibeguard:list` 与 `/vibeguard:stats`，两个命令 MUST 在 pi 命令面板中可见并带有描述文案。

#### Scenario: 命令可见

- **WHEN** pi 加载插件后用户在输入框键入 `/vibeguard`
- **THEN** 命令面板展示 `/vibeguard:list` 与 `/vibeguard:stats` 及其描述
