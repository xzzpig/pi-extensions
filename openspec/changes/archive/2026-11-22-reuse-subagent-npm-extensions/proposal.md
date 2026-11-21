# 提案：复用并去重子代理的 npm 扩展

## Why

后台子代理会同时发现用户通过 `pi install` 安装的扩展，以及子代理显式 `npm:` 来源中的临时副本。两个副本的入口路径不同，Pi 会各自初始化；对 `pi-model-agents` 这类扩展，结果可能是同一段指令插入系统提示词两次。

## What Changes

- 本地前台、后台原生 Pi 子会话的显式 `npm:` 声明，优先复用兼容的用户级安装，不要求用户改写为机器相关的绝对路径。
- 不能复用时，继续用 Pi 的临时 npm 加载机制。后台会话中同名的自动发现扩展不再初始化：显式版本优先，而不是同时加载两个版本。重复的相同显式选择只处理一次；同一会话的多个不同显式选择需明确报错。
- 变更仅作用于子会话。保留其他扩展、非扩展包资源、项目信任、能力限制及宿主必需扩展的既有规则；不修改主会话设置，不用临时版本替换用户安装。

## Capabilities

### New Capabilities

- `subagent-extension-loading`：定义本地原生 Pi 子会话如何解析显式扩展、复用持久安装，以及协调显式来源与自动发现来源。

### Modified Capabilities

无。`agent-profiles` 管理 profile 的选择和安全约束，`subagent-context-injection` 管理代理清单注入；两者的要求均不改变。

## Impact

- 影响 `packages/pi-subagents` 的本地原生子会话加载路径，以及 `extensions`、`subagentOnlyExtensions` 和各自设置级默认值。不增加配置字段，不更改外部 runner 或远端加载协议。
- 过去依赖同一包的两个副本同时运行的配置将只得到显式副本。用户可不改现有声明即避免提示词钩子重复执行。
