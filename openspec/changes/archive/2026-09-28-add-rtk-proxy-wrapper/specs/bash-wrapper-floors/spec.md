## MODIFIED Requirements

### Requirement: 包装器识别范围

系统 SHALL 识别三类会执行内层命令的包装器，并 SHALL 把不执行内层命令的调用当作普通命令处理：

- opaque payload：`eval`，以及带 `-c` 的 `bash`/`sh`/`dash`/`zsh`/`ksh`；`env -S '…'` 按同一类处理。
- indirection：始终调用后续命令的包装器，包括 `sudo`、`env`、`xargs`、`time`、`nohup`、`timeout`、`nice`、`doas`、`setsid`、`stdbuf`、`watch`、`flock`、`parallel`、`rust-parallel`、`rush`，以及透明输出代理 `rtk`（把自身 argv 重写为真实命令，例如 `rtk git push origin main` 执行 `git push origin main`）。
- exec-conditional：带 `-exec`/`-execdir`/`-ok`/`-okdir` 的 `find`，带 `-x`/`--exec`/`-X`/`--exec-batch` 的 `fd`。

包装器识别 SHALL 不依赖调用方是否已被代理改写：命令串中出现的代理前缀 SHALL 被剥离，其后的命令按自身规则门控，因此“原始命令”与“代理改写后的命令”SHALL 得到相同判定。

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

#### Scenario: 透明输出代理按被代理命令门控

- **WHEN** 配置含 `"bash": { "*": "allow", "git add *": "ask" }`，命令为 `rtk git add x`
- **THEN** 内层命令 `git add x` 命中 `git add *` 并询问，而不是由 `*` 放行整个 `rtk git add x`

#### Scenario: 代理先改写调用也不改变判定

- **WHEN** 代理的 `tool_call` 处理器在本扩展读取命令之前把 `git add x` 改写为 `rtk git add x`
- **THEN** 判定与未改写时一致（内层 `git add x` 命中 `git add *`），因为被代理命令作为独立命令单元门控

#### Scenario: 代理自身子命令形不继续解包

- **WHEN** 命令为 `rtk err git push origin main`（`err` 是代理自身的子命令词）
- **THEN** 内层命令的头部为 `err`，该调用按兜底规则（如 `*`）判定，不解析出 `git push origin main`
