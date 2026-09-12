# fleet-native-transcript Specification

## Purpose

pi-subagents fleet inspector 的结构化会话视图改由 `@xzzpig/pi-components` 的原生渲染链路呈现：消息使用 Pi 原生消息组件（含 thinking 与 Markdown），工具调用使用 Pi 原生工具执行组件（diff、文件预览等富输出），提升内容直观性，同时保留既有的安全读取、缓存与交互行为。

## Requirements

### Requirement: 结构化会话视图采用原生渲染

当 fleet inspector 详情面板成功解析出结构化 transcript 时，系统 SHALL 使用与主界面一致的渲染方式展示会话内容：用户/监督者消息、助手消息（含 Markdown 与代码高亮）由 Pi 原生消息组件呈现，工具调用由 Pi 原生工具组件呈现其富输出。

#### Scenario: 查看包含代码编辑的后台运行

- **WHEN** 用户在 fleet inspector 中选中一个产生过文件编辑记录的运行
- **THEN** 详情面板以差异对比形式展示该编辑，而非纯文本参数预览

#### Scenario: 查看包含命令执行的运行

- **WHEN** 所选运行的 transcript 中存在 bash 工具记录
- **THEN** 命令及其输出按主界面一致的样式呈现，且支持折叠/展开

### Requirement: 助手 thinking 内容可见

transcript 记录中携带的助手思考内容 SHALL 在详情面板中呈现；默认为收起状态，用户可展开查看。

#### Scenario: 展开思考内容

- **WHEN** 助手消息包含 thinking 内容且用户展开该消息
- **THEN** 思考文本以区别于正文的样式显示

### Requirement: 全局工具输出展开切换

在 fleet inspector 中触发展开切换（现有 `x` 键位语义）时，所有工具输出的展示 MUST 在折叠与展开两种状态之间整体切换，切换结果立即反映在当前视图中。

#### Scenario: 切换全部工具输出

- **WHEN** 用户对任意选中项按下展开切换键
- **THEN** 该项 transcript 中全部工具条目的输出同时进入相反的展示状态

### Requirement: 渲染缓存随内容与视口失效

详情面板的渲染结果 MUST 在以下任一条件变化后反映最新内容：transcript 文件大小或修改时间变化、面板宽度变化、全局展开状态切换。不得向用户展示陈旧的渲染缓存。

#### Scenario: 运行期间内容持续追加

- **WHEN** 选中的后台运行正在写入新的 transcript 记录
- **THEN** 面板随刷新周期展示新增内容，无需手动刷新

### Requirement: 安全读取行为不回退

fleet inspector 对 transcript 文件的读取 MUST 保持既有安全约束：仅读取可信根目录内的常规文件，拒绝符号链接与路径逃逸；校验失败时给出明确警告而非静默失败或崩溃。

#### Scenario: 试图读取可信根之外的路径

- **WHEN** 某条目指向的 transcript 路径解析后位于可信根之外
- **THEN** 面板展示警告信息，不渲染该路径内容，其余部分不受影响

### Requirement: 渲染界面的快捷键切换

在 fleet inspector 中，用户 MUST 能够通过可配置快捷键（默认 `v`，纳入 fleet 键位重映射体系）在本能力引入的原生渲染界面与原有文本渲染界面之间来回切换；切换 MUST 立即生效且作用于当前选中的结构化会话视图；页脚提示 SHALL 展示该键位。

#### Scenario: 从原生界面切回原有界面

- **WHEN** 用户在原生渲染的结构化会话视图中按下切换键
- **THEN** 详情面板立即以原有文本样式重新呈现同一运行的 transcript 内容

#### Scenario: 切回原生界面

- **WHEN** 处于文本渲染状态且共享组件可用时，用户再次按下切换键
- **THEN** 详情面板恢复原生渲染

#### Scenario: 组件不可用时按键

- **WHEN** 共享组件包缺失或加载失败时用户按下切换键
- **THEN** 视图保持原有文本渲染并给出明确提示，无异常中断

#### Scenario: 切换不影响选中与操作

- **WHEN** 用户切换渲染界面后继续操作
- **THEN** 当前选中项保持不变，steer/stop/Herdr/Prompt Audit 等操作行为不受影响

### Requirement: 宿主能力缺失时降级回退

当宿主环境缺少本能力依赖的组件 API 或加载失败时，fleet inspector MUST 回退到现有的文本式 transcript 渲染器，检视器的选择、操作（steer/stop/Herdr）、Prompt Audit 等其余功能不受影响。

#### Scenario: 组件库不可用

- **WHEN** 共享组件包无法加载或缺少所需导出
- **THEN** 结构化视图以原有文本样式呈现，无异常中断

### Requirement: 超限参数的工具条目仍可展示

当某工具调用的参数载荷因超过持久化上限而无法还原完整参数对象时，该工具调用 MUST 仍然出现在渲染结果中（至少包含工具名称与执行结果），且不得导致整条 transcript 渲染失败。

#### Scenario: 存在被截断的大参数调用

- **WHEN** transcript 中某个工具调用的参数载荷带截断标记
- **THEN** 该调用以降级形态展示，同屏其他条目正常渲染

### Requirement: 其余详情视图行为保持

foreground-active、foreground-recent、external 三类详情视图以及 Prompt Audit 视图的展示内容与交互 MUST 保持现状；本次变更仅替换"结构化会话 transcript"这一种渲染模式。

#### Scenario: 外部任务详情不受影响

- **WHEN** 用户选中的是外部注册任务
- **THEN** 详情面板仍展示其只读元数据与预览，无渲染链路变化
