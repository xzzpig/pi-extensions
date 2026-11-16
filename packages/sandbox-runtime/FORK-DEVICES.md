# Linux 设备白名单

`filesystem.allowDevices` 是独立设备授权，默认省略或空数组，不开放额外宿主设备。Linux Manager 保留最小 `/dev` 并在其后逐节点执行 `--dev-bind`，不是把整个宿主 `/dev` 暴露给子进程。

```json
{
  "network": { "disabled": true, "allowedDomains": [], "deniedDomains": [] },
  "filesystem": {
    "denyRead": [],
    "allowWrite": ["/tmp"],
    "denyWrite": [],
    "allowDevices": ["/dev/kvm"]
  }
}
```

设备路径必须是 `/dev/` 下已存在的规范绝对路径，且为字符或块设备；不允许目录、通配符、路径穿越、任何符号链接组件、普通文件、FIFO 或套接字。重复节点去重，缺失节点明确报错。每次执行都会重新校验，不静默跳过挂载失败。

普通文件策略启用时，授权若命中 denyRead/denyWrite 的节点、祖先或模式，报配置冲突；allowRead/allowWrite 不能代替设备授权。`filesystem.disabled` 仅禁用普通规则，仍保留最小设备视图和显式设备白名单。其他网络、进程和已启用的文件限制不因设备授权取消。

仅 Linux 支持非空设备列表；其他平台明确报不支持，空列表兼容旧行为。低层 Linux 包装函数保留未请求任何隔离的历史快速路径；Manager 显式要求设备隔离，防止文件和网络规则均关闭时漏出宿主设备。

设备 API 可影响宿主，块设备尤其危险。宿主文件权限、设备 cgroup 和外层容器限制仍生效，运行时不会自动提权或更改权限。设备源目录必须由可信系统管理：校验与挂载之间存在 TOCTOU 窗口，本实现不抵御有权改写宿主 `/dev` 的对手。列表更新只影响后续命令，不撤销既有进程或打开的 fd。

真实设备验收通过 pi-sandbox 的真实 Pi bash 工具执行，优先 KVM 的安全 API 版本查询，不创建 VM。单元 mock、基础节点测试和参数快照不是额外设备验收。见 `packages/pi-sandbox/FORK-DEVICE-E2E.md` 及 OpenSpec `add-sandbox-device-passthrough`。
