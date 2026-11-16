# Proposal

## Why

Issue [#1](https://github.com/xzzpig/pi-extensions/issues/1) 指出沙箱无法访问 `/dev/kvm` 等额外 Linux 设备：运行时跳过 `/dev/*` 写允许项，并在文件系统挂载后通过 `--dev /dev` 创建最小设备目录。需要显式、最小授权的设备透传能力，并以真实设备操作而非参数快照证明修复有效。

## What Changes

- 新增可选 `filesystem.allowDevices: string[]`，默认不透传额外设备；不改变普通 `allowRead` / `allowWrite` 的语义。
- 全局配置及已受信任项目配置可授予设备访问；未受信任或信任未知的项目不得授予。支持命名 sandbox profile，agent frontmatter 仍只能选择名称。
- 仅接受 Linux `/dev` 下明确存在的字符或块设备节点；拒绝目录、通配符、符号链接及非法路径，挂载失败不得回退到未沙箱执行。
- 在最小 `/dev` 创建之后按白名单追加 `--dev-bind`，保留其他网络、文件系统、进程隔离，不透传整个 `/dev`。
- 明确 profile 合并、硬拒绝、非 Linux 兼容及文件系统禁用时的设备策略。
- E2E 必须在真实 Pi 的 bash 工具链路验证宿主真实额外设备，优先 `/dev/kvm`，执行安全的打开及设备操作；没有合适设备时验收阻塞，不用 mock、基础 `/dev/null` 或仅检查节点可见代替。

## Capabilities

### New Capabilities

- `sandbox-devices`：Linux 设备白名单、路径校验、挂载隔离、失败行为及真实设备验收。

### Modified Capabilities

- `agent-profiles`：新增设备白名单的 profile 字段与合并规则，沿用项目信任及名称选择协议。以 ADDED 要求补充新字段，不重写既有 profile 要求。

## Impact

- `packages/pi-sandbox`：配置来源信任、profile 字段校验/合并、运行时转换、设备配置诊断及文档。
- `packages/sandbox-runtime`：配置 schema、Linux 参数传递、设备校验与 bubblewrap 挂载；非 Linux 显式拒绝非空设备请求。
- fork-only 单元/集成测试、真实 Pi E2E 及打包产物验证；两包 subtree 元数据按实际 upstream seam 维护。
- 不增加设备管理服务，不自动创建设备节点，不提高宿主权限，不支持热插拔自动发现或关闭整个沙箱来满足请求。不提交、推送或发布本变更。
