# Linux 设备配置与真实设备 E2E

本文件说明 pi-sandbox fork 的 `filesystem.allowDevices` 用法，并配套 OpenSpec `add-sandbox-device-passthrough` 的真实设备验收。本能力需要使用包含此修复的本地构建或安装产物；本变更不代表已经发布新版本。

## 全局设备授权

全局配置文件是 Pi agent 目录中的 `sandbox.json`，默认路径为 `~/.pi/agent/sandbox.json`；设置 `PI_CODING_AGENT_DIR` 时改用该目录下的 `sandbox.json`。以下是一个完整的最小配置文件，仅额外授权 KVM；其他未写出的选项仍采用既有默认值。已有配置应合并字段，不要直接覆盖自己的其他规则。

<!-- example: device-global -->

```json
{
  "filesystem": {
    "allowDevices": ["/dev/kvm"]
  }
}
```

省略 `allowDevices` 或使用空数组时，默认只保留最小 `/dev`，不会透传额外宿主设备。普通 `allowRead`、`allowWrite` 或写权限提示不能代替设备授权。

## 已信任项目的设备授权

项目文件位置是**当前会话工作目录**的 `.pi/sandbox.json`，即 `<cwd>/.pi/sandbox.json`；不要假定插件会为你搜索其他目录的配置。下面是完整的最小项目配置：

<!-- example: device-project -->

```json
{
  "filesystem": {
    "allowDevices": ["/dev/net/tun"]
  }
}
```

仅在平台明确确认项目受信任时，该设备列表才生效。用户审阅并决定信任项目后，可从该目录用 `pi --approve` 为本次启动明确授权项目文件；`pi --no-approve` 则不信任项目文件。不要为了运行陌生仓库而自动信任它。

未选择 profile 时，全局与可信项目的设备列表去重取并集：同时使用上面的两个文件时，可信项目得到 `[/dev/kvm, /dev/net/tun]`；项目不受信任或信任未知时，只保留全局的 `[/dev/kvm]`，并给出项目设备授权未应用的诊断。项目清空自己的顶层列表不会撤销全局授权；需要会话级撤销时使用下面的空 profile。

## 命名 profile：继承、替换与撤销

下例是可直接使用的**完整全局配置文件**。为了单独说明 profile 行为，下面的表格假定没有项目配置参与。

<!-- example: device-profiles -->

```json
{
  "filesystem": {
    "allowDevices": ["/dev/kvm"]
  },
  "profiles": {
    "device-inherit": {},
    "device-replace": {
      "filesystem": {
        "allowDevices": ["/dev/net/tun"]
      }
    },
    "device-off": {
      "filesystem": {
        "allowDevices": []
      }
    },
    "device-clean": {
      "inheritGlobalConfig": false
    }
  }
}
```

| 选择的 profile | 有效额外设备 | 含义 |
| --- | --- | --- |
| `device-inherit` | `/dev/kvm` | 省略字段，继承有效基线 |
| `device-replace` | `/dev/net/tun` | 显式列表替换基线，不自动保留 KVM |
| `device-off` | 无 | 显式空数组清空设备授权 |
| `device-clean` | 无 | 不继承全局顶层允许项；其他策略回到安全默认值，仍保留硬拒绝 |

可通过现有 profile 选择协议启动，例如：

```bash
PI_SUBAGENT_SANDBOX_PROFILE=device-inherit pi
```

自定义 agent 的 frontmatter 只能使用 `sandbox: device-inherit` 选择名称，不能内嵌设备规则。同一会话内的扩展可通过公开的 `SandboxService.setProfile("device-off")` 切换至空设备 profile；切换后的新命令不再获得设备，已经运行的进程和已打开的 fd 不会被强行撤销。其他并发会话的 profile 不受影响。

已信任项目也可在 `<cwd>/.pi/sandbox.json` 定义 profile。下例是与上述全局文件配套的**完整项目配置文件**：

<!-- example: device-project-profiles -->

```json
{
  "profiles": {
    "device-replace": {
      "filesystem": {
        "allowDevices": ["/dev/kvm"]
      }
    }
  }
}
```

同名 profile 的设备字段由项目的显式值替换：可信项目中选择 `device-replace` 得到 `/dev/kvm`，而非全局的 `/dev/net/tun`；项目省略该字段则继承全局同名 profile，显式 `[]` 则清空。未受信任或信任未知时，项目 profile 不参与解析，仍使用全局同名定义。只存在于未受信项目的名称不能被用来放宽权限。

## 授权风险与限制

- 设备必须是 `/dev/` 下明确存在的字符或块设备节点；不支持 `/dev` 整目录、通配符、相对/穿越路径、任何符号链接组件或普通文件。不存在或无效的设备请求明确失败，不退回未沙箱执行。
- 设备 API 可能影响宿主，块设备尤其危险。仅允许确实需要的节点；宿主用户权限和外层容器限制仍有效，插件不会提权或修改设备权限。
- 非 Linux 平台的非空设备请求明确拒绝并阻断执行；空请求保持既有平台行为。Android 沿用已有 Linux 后端。
- 普通文件策略启用时，设备授权不能覆盖 `denyRead` / `denyWrite`（含祖先和模式）；冲突报错。`filesystem.disabled` 只禁用普通文件规则，不能隐式开放宿主设备。
- 设备授权不关闭其他已启用的网络、进程和文件隔离。若宿主能改写 `/dev`，校验与挂载间仍有 TOCTOU 窗口；设备源目录必须由可信系统管理。

以下 E2E 操作需使用专门的临时配置与真实设备，不要把测试配置写进用户的真实项目。

## 安全探测与前提

在独立 `/tmp` 工作目录中运行真实 Pi，仅显式加载被测插件及必要测试伴随扩展，禁用其他扩展、skills、prompt templates、themes 和 context files 发现，单独指定 session 目录。不要修改用户全局配置来做测试。

宿主必须存在真实额外设备，优先 `/dev/kvm`。以下程序不创建设备、虚拟机或 vCPU，不执行设备写入，只以当前用户打开 KVM 并查询 API：

```bash
python3 /absolute/path/to/packages/pi-sandbox/scripts/fork-device-probe.py
```

成功标准：退出码 0，JSON 包含 `ok: true`、`apiVersion: 12`、设备类型与主次设备号。退出码 1 表示失败，包含 errno/原因；缺失节点、权限不足和不支持 KVM 均不能算作成功。Python 仅是此测试探测程序的依赖，不是插件运行依赖。

先在宿主执行上述程序，保留输出作为对照；再在真实 Pi 会话中要求模型调用实际 bash 工具执行同一程序。必须在 session 中看到真实工具调用与结果，不能只采信模型总结。

如果当前代理处于最小 `/dev` 沙箱中，不应尝试绕过限制或更改设备权限。只有操作者明确授权后，才可使用已运行的宿主 `/tmp` tmux server，创建专用临时会话执行预检与测试，不操作已有用户会话。若用交互式 Pi，必须按仓库 E2E skill 从启动到退出录制 asciinema 并回放。

## 验收矩阵

1. 没有设备授权：同一探测在沙箱中失败。
2. 全局 `filesystem.allowDevices: ["/dev/kvm"]`：探测成功，API 值与设备身份匹配宿主。
3. 撤销设备授权后：下一条新命令再次失败。既有进程的 fd 不属于撤销范围。
4. 已明确受信任项目可授权；未受信或未知信任项目不能授权，且有诊断。
5. profile 省略字段继承设备，显式空数组撤销。多会话设备权限不得串扰。
6. 设备获准时，普通白名单外文件写入与受禁网络访问仍失败，防止因整体未沙箱执行而假通过。
7. 对打包 tarball（内含对应 sandbox-runtime）重复 1–3，记录 tarball 校验值和实际加载入口。

普通 `/dev/null` 别名、临时 mknod、mock、仅检查节点可见或仅检查 bwrap 参数，均不能代替真实额外设备测试。若 KVM 不可用，可选其他真实额外设备，但必须先审阅并记录非破坏探测语义，再完成相同对照；不得盲试磁盘写入或任意 ioctl。环境无合适设备时保持 E2E 未完成并报告阻塞，不以 skip 作为验收成功。

## 证据

每次运行保存宿主设备身份及探测输出、实际配置、启动命令、Pi session、bash 工具输入输出和退出码；tarball 场景另存校验值。print 模式保存文本；TUI 模式还要有完整录像、回放范围和干净退出证据。不要提交凭据、录像、session 或设备敏感数据，不擅自上传。
