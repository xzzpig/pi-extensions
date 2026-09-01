## 1. Subtree 导入与包规范化

- [ ] 1.1 确认工作树干净（`git status --short --branch`），添加 remote `upstream-pi-context-cap` → `https://github.com/lukeramsden/pi-context-cap.git`，fetch `main` 并记录 commit
- [ ] 1.2 `git subtree add --prefix="packages/pi-context-cap" --squash "upstream-pi-context-cap" <commit>`，验证 squash parent 的 `git-subtree-dir` / `git-subtree-split` trailers
- [ ] 1.3 写 `subtrees/pi-context-cap.json`（schema：name/prefix/source/remote/ref/upstreamCommit/squash/lastSyncedAt），`git config` 记录 `remote.upstream-pi-context-cap.pi-ref`，`direnv reload` 确认 helper 接受
- [ ] 1.4 npm 名改为 `@xzzpig/pi-context-cap`：更新 `package.json`（name、description、keywords、`pi.extensions` 指向 `./extensions`、peerDependencies 校验），README 注明 fork 来源（上游仓库、上游 license、本地改动范围）

## 2. 配置加载（config.ts）

- [ ] 2.1 新建 `extensions/config.ts`：定义配置形状 `{ models?: string[], budget?: number, reserve?: number }`；实现全局文件（pi agent 目录下 `context-cap.json`）与项目文件（`join(ctx.cwd, CONFIG_DIR_NAME, "context-cap.json")`，`ctx.isProjectTrusted()` 守卫）的读取
- [ ] 2.2 实现键级合并（项目覆盖全局）与校验：非正/非数字的 budget-reserve 拒绝并 notify 警告；`reserve >= budget` 视为配置错误，守护禁用并告知；JSON 解析失败警告并跳过该级
- [ ] 2.3 在 `session_start` 中接入：解析 flags + 全局/项目配置得出 effective budget/reserve/models；验证扩展能否获取全局 agent 目录，若不可达则按 design 回退为项目级 + flags，并同步修订 `specs/context-cap-config/spec.md` 的全局级场景

## 3. 模型白名单（whitelist.ts）

- [ ] 3.1 新建 `extensions/whitelist.ts`：minimatch 匹配 `provider/modelId` 与裸 `modelId`；空/缺失 `models` 匹配全部；无效 glob 模式按不匹配处理并警告
- [ ] 3.2 在 `compactIfOverBudget` 入口接入白名单判定（default 态下模型不匹配则不触发）；`ctx.model` 每次事件现场读取

## 4. 会话开关（三态 override）

- [ ] 4.1 将上游 `enabled` 布尔改为三态 `override: "default" | "on" | "off"`，`session_start` 重置为 default，不落盘；生效状态 = override 为 on（强制启用）或（default 且模型匹配白名单）
- [ ] 4.2 扩展 `/context-cap` 命令：`on`/`off` 设置 override，`status`（无参数）输出生效状态与原因（whitelist/override/熔断）、budget、threshold、usage；`<tokens>`/`resume on|off` 语义保持

## 5. 验证与注册

- [ ] 5.1 `pnpm install` && `pnpm --filter @xzzpig/pi-context-cap run typecheck` 通过
- [ ] 5.2 `pnpm exec prettier --check .` 通过
- [ ] 5.3 `direnv reload` 通过（subtree 元数据校验）
- [ ] 5.4 `pi -e ./packages/pi-context-cap/extensions/index.ts` 冒烟：status 显示状态；无白名单时默认生效；白名单外模型不触发；`on` 强制启用；构造超限会话验证轮中压缩 + followUp 恢复
- [ ] 5.5 `versions.json` 添加 `@xzzpig/pi-context-cap` 条目（0.1.0），仓库 README 包列表更新
