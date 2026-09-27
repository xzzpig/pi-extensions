# bash-wrapper-floors Specification

## Purpose

定义 `@xzzpig/pi-permission-system` fork 对 bash 包装器命令的分级门控：会执行内层命令的包装器（`eval`、`bash -c`、`sudo`、`env`、`xargs`、`timeout`、`find -exec` 等）不再一律兜底为 `ask`，而是把内层命令解析出来作为独立命令单元门控；包装器自身的 `allow` 仅在其内层内容无法静态解析时兜底为 `ask`。`wrapperFloors` 扩展配置控制该行为（`fallback` 默认 / `always` 复现上游的全面兜底）。

## ADDED Requirements

### Requirement: 包装器识别范围

系统 SHALL 识别三类会执行内层命令的包装器，并 SHALL 把不执行内层命令的调用当作普通命令处理：

- opaque payload：`eval`，以及带 `-c` 的 `bash`/`sh`/`dash`/`zsh`/`ksh`；`env -S '…'` 按同一类处理。
- indirection：始终调用后续命令的包装器，包括 `sudo`、`env`、`xargs`、`time`、`nohup`、`timeout`、`nice`、`doas`、`setsid`、`stdbuf`、`watch`、`flock`、`parallel`、`rust-parallel`、`rush`。
- exec-conditional：带 `-exec`/`-execdir`/`-ok`/`-okdir` 的 `find`，带 `-x`/`--exec`/`-X`/`--exec-batch` 的 `fd`。

#### Scenario: 带 -c 的 shell 调用被识别为包装器

- **WHEN** 命令为 `bash -c "git status"`
- **THEN** 系统按 opaque payload 包装器处理，并用同一解析器重新解析引号内的 payload

#### Scenario: 裸 shell 调用不是包装器

- **WHEN** 命令为 `sh foo.sh`（没有 `-c`）
- **THEN** 系统按普通命令门控，不套用包装器兜底

#### Scenario: 不带 exec 标志的搜索不受影响

- **WHEN** 命令为 `find . -name '*.py'`（没有 `-exec` 类标志）
- **THEN** 系统按普通命令门控

#### Scenario: 重定向不影响包装器识别

- **WHEN** 重定向节点出现在命令词之前或之间（例如 `bash -c "git status" > out`）
- **THEN** 系统仍能识别该包装器及其内层命令，重定向节点不会被误当作命令名或参数

### Requirement: 内层命令作为独立单元门控

解析出内层命令后，系统 SHALL 把每个内层命令作为独立命令单元提交门控，使其按自身文本匹配 `bash` 规则；提示信息 SHALL 标注内层命令的来源（opaque payload 标注 `inside an opaque wrapper payload (eval/bash -c)`，indirection 标注 `inside an indirection wrapper (env/xargs/…)`）。

定位 indirection 包装器的内层命令时，系统 SHALL 跳过包装器自身的选项、选项取值、`env` 赋值、`timeout` 时长、`flock` 锁文件与 `--`。

#### Scenario: eval 的内层命令按自身规则匹配

- **WHEN** 配置含 `"bash": { "git status *": "allow", "*": "ask" }`，命令为 `eval "git status"`
- **THEN** 内层 `git status` 命中 `git status *`，命令被放行

#### Scenario: 内层命令的危险规则仍然生效

- **WHEN** 配置含 `"rm -rf *": "ask"`，命令为 `eval "rm -rf /"`
- **THEN** 内层命令命中 `rm -rf *` 并询问

#### Scenario: indirection 包装器由内层命令决定

- **WHEN** 命令为 `sudo aws s3 ls`
- **THEN** 判定由 `aws s3 ls` 的规则决定，而不是 `sudo` 的规则

#### Scenario: 包装器自身的选项取值不参与定位

- **WHEN** 命令为 `timeout 570 nix eval .#x` 或 `env -u HOME git status`
- **THEN** 内层命令分别被定位为 `nix eval .#x` 与 `git status`

### Requirement: 仅不可静态解析的内容兜底为 ask

`wrapperFloors` 为 `fallback`（默认）时，包装器命令的 `allow` SHALL 仅在该包装器的内层内容无法静态解析时被钳制为 `ask`，并以合成模式名记录（opaque payload 为 `<opaque-bash-wrapper>`，indirection 为 `<indirection-bash-wrapper>`）。

可证明不执行任何内层命令的调用 SHALL 按其自身文本作为普通命令门控，而不是兜底为 `ask`：裸 `eval`、缺失或空白 payload（`eval ""`）、解析后不含任何命令的 payload（仅注释或纯赋值）、无参数的 `sudo`/`env`/`xargs`、仅有操作数的 `timeout 5` 或 `flock lockfile`、仅有选项取值的 `env -u HOME` 或 `sudo -u root`，以及只带环境赋值的 `env FOO=bar BAZ=qux`。

例外：裸调用或仅带标志时会把标准输入逐行当作 shell 命令执行的包装器（`parallel`、`rust-parallel`、`rush`）SHALL 保持兜底为 `ask`。

#### Scenario: 不可解析的 payload 兜底为 ask

- **WHEN** 命令为 `bash -c "…"`，引号内 payload 非空但解析失败
- **THEN** 该包装器命令的判定被钳制为 `ask`，匹配模式记为 `<opaque-bash-wrapper>`

#### Scenario: 空 payload 不兜底

- **WHEN** 命令为 `eval ""`、裸 `eval`，或 `env FOO=bar BAZ=qux`
- **THEN** 命令按其自身文本匹配 `bash` 规则，不产生兜底 `ask`

#### Scenario: 逐行执行标准输入的包装器保持兜底

- **WHEN** 命令为 `echo rm x | parallel`
- **THEN** 该包装器命令的判定保持 `ask`，匹配模式记为 `<indirection-bash-wrapper>`

### Requirement: wrapperFloors 配置项

扩展配置 SHALL 支持 `wrapperFloors` 字段，取值为 `"fallback"`（默认）或 `"always"`：

- `"fallback"`：上文行为，内层命令逐个门控，仅在无法静态解析时兜底。
- `"always"`：每个包装器命令的 `allow` SHALL 被钳制为 `ask`，不提供任何自动放行途径；该取值 SHALL 复现上游 v24 的全面兜底行为。

调用方未提供该字段时，系统 SHALL 按 `"always"` 语义处理。

#### Scenario: always 模式全面兜底

- **WHEN** `wrapperFloors` 为 `"always"`，配置含 `"git status *": "allow"`，命令为 `eval "git status"`
- **THEN** 判定为 `ask`，内层 `allow` 不能放行该包装器命令

#### Scenario: 未配置时保持上游语义

- **WHEN** 调用方未提供 `wrapperFloors`
- **THEN** 包装器命令按 `"always"` 语义处理

### Requirement: 纯读取器豁免

当包装器运行的命令可证明为纯读取器时，系统 SHALL 在两种模式下都豁免兜底：内层命令按其自身 `bash` 规则决定，并在审查日志中记录 `floorExemption: "core-reader"`。

#### Scenario: 纯读取器不因包装器而升级为 ask

- **WHEN** `wrapperFloors` 为 `"always"`，配置含 `"cat *": "allow"`，命令为 `env cat README.md`
- **THEN** 判定为 `allow`，审查日志记录 `floorExemption: "core-reader"`

### Requirement: 与显式规则、yoloMode 和会话授权的交互

包装器命令上的显式 `deny` 或 `ask` SHALL 在兜底之前决定，兜底不得覆盖它，也不得因此读取内层规则。

`yoloMode: true` 时，由本 capability 产生的合成 `ask` SHALL 被自动批准，授权来源记为 `yolo` 并保留合成模式名；`yoloMode` 关闭时兜底行为 SHALL 不变。

兜底 SHALL 只钳制判定并保留既有授权的来源，因此会话内已批准过的命令不再重复提示。

#### Scenario: 显式 deny 不被兜底覆盖

- **WHEN** 配置含 `"sudo rm *": "deny"`，`wrapperFloors` 为 `"always"`，命令为 `sudo rm -rf /`
- **THEN** 判定为 `deny`

#### Scenario: yoloMode 自动批准兜底

- **WHEN** `yoloMode: true`，命令为 `eval "git status"` 且内层命令不匹配任何放行规则
- **THEN** 兜底产生的 `ask` 被自动批准，不弹出提示，授权来源记为 `yolo`

#### Scenario: 已批准的命令不重复提示

- **WHEN** 用户已在当前会话批准过同一包装器命令
- **THEN** 再次执行时不重复提示
