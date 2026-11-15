import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  createHostHarness,
  createIsolatedEnvironment,
  createTuiContext,
} from "./harness.ts";

for (const tidyFirst of [false, true]) {
  test(`Tool Display write diff appears once with tidy loaded ${tidyFirst ? "first" : "last"}`, async () => {
    const environment = createIsolatedEnvironment();
    try {
      const configPath = join(
        environment.agentDir,
        "extensions",
        "pi-tool-display",
        "config.json",
      );
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      for (const name of ["read", "write", "edit", "grep", "find", "ls"])
        config.registerToolOverrides[name] = true;
      writeFileSync(configPath, JSON.stringify(config));
      const host = createHostHarness();
      if (tidyFirst) await host.load("pi-tidy");
      await host.load("pi-tool-display");
      if (!tidyFirst) await host.load("pi-tidy");
      const ctx = await createTuiContext(environment.home);
      await host.fire("session_start", ctx);
      const resolve = (name: string): any => {
        const visit = (i: number): any =>
          i < host.toolRenderers.length
            ? host.toolRenderers[i]!.resolver(name, () => visit(i + 1))
            : host.tools.get(name);
        return visit(0);
      };
      for (const name of ["read", "write", "edit", "grep", "find", "ls"]) {
        assert.ok(host.tools.get(name), `${name} is owned by Tool Display`);
        assert.strictEqual(
          resolve(name),
          host.tools.get(name),
          `${name} renderers pass through tidy`,
        );
      }
      const sdk = await import("@earendil-works/pi-coding-agent");
      const { stripTerminalSequences } = await import("@earendil-works/pi-tui");
      const write = resolve("write");
      const args = {
        path: join(environment.home, "example.txt"),
        content: "write-content-once-marker",
      };
      const component = new sdk.ToolExecutionComponent(
        "write",
        "write-ownership-id",
        args,
        {},
        write,
        { requestRender() {} } as any,
        environment.home,
      );
      component.setArgsComplete();
      component.markExecutionStarted();
      const result = await write.execute(
        "write-ownership-id",
        args,
        undefined,
        undefined,
        ctx,
      );
      component.updateResult({ ...result, isError: false }, false);
      assert.equal(readFileSync(args.path, "utf8"), args.content);
      for (const expanded of [false, true]) {
        component.setExpanded(expanded);
        const rows = stripTerminalSequences(component.render(100).join("\n"));
        assert.match(rows, /created/);
        assert.equal(rows.split(args.content).length - 1, 1, rows);
      }
      component.updateResult(
        {
          content: [{ type: "text", text: "Write failed: permission denied" }],
          isError: true,
        },
        false,
      );
      assert.match(
        stripTerminalSequences(component.render(100).join("\n")),
        /permission denied/,
      );
    } finally {
      environment.cleanup();
    }
  });
}
