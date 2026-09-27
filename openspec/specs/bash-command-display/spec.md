# bash-command-display Specification

## Purpose

定义 `@xzzpig/pi-tool-display` fork 的 bash 工具调用行显示模式：命令默认逐字渲染（上游行为），也可以折叠为单行并钳制到可用宽度，或在命令执行期间显示完整命令、结束后折叠。折叠只影响显示，绝不改变实际执行的命令。

## Requirements

### Requirement: 配置项与取值

系统 SHALL 支持配置项 `bashCommandDisplay`，取值为 `"full"`、`"collapsed"` 或 `"auto"`，默认值为 `"full"`。

- `"full"`：命令逐字渲染（上游行为）。
- `"collapsed"`：命令折叠为单行并钳制到可用宽度。
- `"auto"`：命令执行中按 `"full"` 渲染，执行结束后按 `"collapsed"` 渲染。

未配置该选项时（例如未提供配置对象），系统 SHALL 按 `"full"` 处理。

#### Scenario: 默认逐字渲染

- **WHEN** 未配置 `bashCommandDisplay`，bash 工具调用的命令为多行
- **THEN** 命令行按原样多行渲染

#### Scenario: collapsed 折叠

- **WHEN** `bashCommandDisplay` 为 `"collapsed"`，命令为多行
- **THEN** 命令行渲染为单行

#### Scenario: 未知取值回退默认

- **WHEN** 配置中的 `bashCommandDisplay` 不是三个合法取值之一
- **THEN** 系统按默认值 `"full"` 处理

### Requirement: 折叠规则

折叠 SHALL 把命令的换行（含 `\r\n`）连同其两侧的空格与制表符合并为一个空格，把其余制表符替换为空格，并去除首尾空白。

#### Scenario: 多行命令折叠为单行

- **WHEN** 命令为 `npm install \\\n  --save x`
- **THEN** 折叠结果为把换行与缩进替换为单个空格后的单行文本

#### Scenario: CRLF 与制表符被归一

- **WHEN** 命令含 `\r\n` 或制表符
- **THEN** 折叠结果不含换行与制表符，且不出现连续多余空格

### Requirement: 宽度钳制与宽度回退顺序

折叠后的命令行 SHALL 被钳制到该工具行可用的渲染宽度（而不是仅终端宽度），超出部分 SHALL 以省略号结尾。宽度按以下顺序解析：渲染时提供的宽度 → `process.stdout.columns` → 固定回退宽度 120。

钳制 SHALL 是 ANSI 感知的：已存在的颜色/样式转义序列不得被计入可见宽度，也不得被截断破坏。

#### Scenario: 超宽命令被截断并加省略号

- **WHEN** 折叠后的命令行可见宽度超过可用宽度
- **THEN** 输出被截断到可用宽度并以省略号结尾

#### Scenario: 渲染宽度优先于终端宽度

- **WHEN** 工具行提供的渲染宽度小于 `process.stdout.columns`
- **THEN** 钳制按渲染宽度进行

#### Scenario: 两者都不可用时使用回退宽度

- **WHEN** 既没有渲染宽度也没有可用的终端列数
- **THEN** 钳制按 120 列进行

#### Scenario: 带样式的命令不被破坏

- **WHEN** 命令文本含 ANSI 样式序列且需要截断
- **THEN** 可见宽度按去样式后的字符数计算，输出仍为完整合法的转义序列

### Requirement: auto 模式的时机判定

`"auto"` 模式 SHALL 在命令仍在执行时（`executionStarted` 为真且 `isPartial` 为真）按完整命令渲染，并在执行结束后折叠——包括执行失败结束的情况。

#### Scenario: 执行中显示完整命令

- **WHEN** `bashCommandDisplay` 为 `"auto"`，命令已开始执行且仍为部分输出
- **THEN** 命令行显示完整（未折叠）命令

#### Scenario: 执行结束后折叠

- **WHEN** 同一命令执行结束（无论成功或失败）
- **THEN** 命令行按折叠形式渲染

#### Scenario: 尚未开始的命令即折叠

- **WHEN** 命令尚未开始执行（`executionStarted` 为假）
- **THEN** 命令行按折叠形式渲染

### Requirement: 展开优先于折叠

当该工具行处于展开状态时，命令行 SHALL 渲染原始的多行命令，无论 `bashCommandDisplay` 取何值。

#### Scenario: 展开后恢复多行

- **WHEN** `bashCommandDisplay` 为 `"collapsed"` 且用户展开了该工具行
- **THEN** 命令行按原始多行命令渲染

### Requirement: 只影响命令行渲染

折叠 SHALL 只作用于 bash 工具调用的命令行渲染（`renderCall`）：命令输出渲染 SHALL 不受影响，实际执行的命令 SHALL 不因显示模式而改变。

#### Scenario: 输出渲染不变

- **WHEN** `bashCommandDisplay` 为 `"collapsed"`，命令产生多行输出
- **THEN** 输出部分仍按原样渲染

#### Scenario: 执行语义不变

- **WHEN** `bashCommandDisplay` 为 `"collapsed"` 或 `"auto"`，命令为多行
- **THEN** 实际执行的命令与 `"full"` 模式完全相同（折叠只发生在显示层）

### Requirement: 配置整合

该选项 SHALL 在配置面板中可切换、在设置检查器中可见（摘要形如 `bashCommand=<value>`），并 SHALL 参与配置相等性比较；内置预设 SHALL 保持 `"full"` 默认值，因此预设行为不变。

#### Scenario: 配置面板可切换

- **WHEN** 用户打开配置面板
- **THEN** 存在 `bashCommandDisplay` 项，可在三个取值间切换

#### Scenario: 设置检查器显示当前值

- **WHEN** 用户查看设置检查器
- **THEN** 摘要中包含 `bashCommand=<当前取值>`

#### Scenario: 预设行为不变

- **WHEN** 应用任一内置预设
- **THEN** `bashCommandDisplay` 仍为 `"full"`
