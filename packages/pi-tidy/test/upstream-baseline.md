# pi-tidy v0.9.6 上游测试基线

- 上游 ref：`v0.9.6`
- 上游 commit：`ea4ca7c36d2501e630a7e84b41b9f6dd75c50827`
- 执行方式：在该仓库 commit 的干净 detached worktree 中，从 `packages/pi-tidy` 运行 `node --test`。
- 结果：515 tests，513 pass，2 fail，0 skipped。
- `test/config.test.ts` 的配置读取、默认值、旧键兼容及 README 默认值检查全部通过。
- 两个失败均在 `test/third-party-edit.test.ts`：`the file the box names comes from the result when the call has no path` 与 `no diff in the result keeps what the renderer drew`。原因是测试以 `process.cwd()` 作为渲染路径，worktree 的绝对路径较长，100 列边框发生换行，旧断言假设路径/摘要在单行且完整出现在边框上。
- fork 测试改为使用固定短项目路径，并允许摘要跨行；在实际仓库路径运行的 fork 套件为 520/520 pass。其余上游测试文件未改动。
