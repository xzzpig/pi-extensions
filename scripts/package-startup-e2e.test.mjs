import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertPiStartupResult,
  buildPiStartupArgs,
  buildStartupEnvironments,
  getPackageLoadPath,
} from "./package-startup-e2e.mjs";

test("package startup smoke resolves the packed Pi extension entries", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "package-startup-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "extensions", "plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "extensions", "plugin", "index.ts"),
    "export default () => {};\n",
  );
  fs.writeFileSync(path.join(root, "index.ts"), "export default () => {};\n");

  assert.deepEqual(
    getPackageLoadPath(
      {
        name: "@xzzpig/pi-fixture",
        pi: { extensions: ["./index.ts", "./extensions"] },
      },
      root,
    ),
    root,
  );
  assert.throws(
    () =>
      getPackageLoadPath(
        { name: "fixture", pi: { extensions: ["../outside.ts"] } },
        root,
      ),
    /escapes package/u,
  );
  assert.throws(
    () =>
      getPackageLoadPath(
        { name: "fixture", pi: { extensions: ["./missing.ts"] } },
        root,
      ),
    /entry is missing/u,
  );
});

test("Pi startup uses an isolated environment without inherited secrets", () => {
  const { npmEnv, piEnv } = buildStartupEnvironments(
    {
      PATH: "/test/bin",
      HTTP_PROXY: "http://proxy.invalid",
      NPM_TOKEN: "must-not-leak",
      PI_AXONHUB_API_KEY: "must-not-leak",
    },
    {
      tempRoot: "/tmp/startup-test",
      agentDir: "/tmp/startup-test/agent",
      home: "/tmp/startup-test/home",
      npmrc: "/tmp/startup-test/empty.npmrc",
    },
  );
  assert.equal(piEnv.HOME, "/tmp/startup-test/home");
  assert.equal(piEnv.PI_CODING_AGENT_DIR, "/tmp/startup-test/agent");
  assert.equal(piEnv.PI_OFFLINE, "1");
  assert.equal(piEnv.NPM_TOKEN, undefined);
  assert.equal(piEnv.PI_AXONHUB_API_KEY, undefined);
  assert.equal(npmEnv.HTTP_PROXY, "http://proxy.invalid");
  assert.equal(npmEnv.npm_config_userconfig, "/tmp/startup-test/empty.npmrc");
  assert.equal(npmEnv.NPM_TOKEN, undefined);
});

test("Pi startup uses isolated RPC mode and only the explicit tarball package", () => {
  assert.deepEqual(buildPiStartupArgs("/tmp/package"), [
    "--mode",
    "rpc",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-mcp",
    "--offline",
    "--extension",
    "/tmp/package",
  ]);
});

test("successful RPC initialization is the startup smoke acceptance", () => {
  const result = assertPiStartupResult({
    status: 0,
    stdout: `${JSON.stringify({ id: "other", type: "response", command: "get_state", success: true })}\n${JSON.stringify({ id: "package-startup-smoke", type: "response", command: "get_state", success: true, data: {} })}\n`,
    stderr: "",
    name: "@xzzpig/pi-fixture@1.0.0",
  });
  assert.equal(result.success, true);
});

test("failed extension imports fail startup smoke even if Pi remains alive", () => {
  assert.throws(
    () =>
      assertPiStartupResult({
        status: 0,
        stdout: `${JSON.stringify({ id: "package-startup-smoke", type: "response", command: "get_state", success: true })}\n`,
        stderr:
          "Error: Failed to load extension: Cannot find module './missing.ts'",
        name: "@xzzpig/pi-fixture@1.0.0",
      }),
    /reported an extension load error/u,
  );
});

test("nonzero or missing get_state response fails startup smoke", () => {
  assert.throws(
    () =>
      assertPiStartupResult({
        status: 1,
        stderr: "Cannot find module",
        stdout: "",
        name: "fixture",
      }),
    /status 1/u,
  );
  assert.throws(
    () =>
      assertPiStartupResult({
        status: 0,
        stderr: "",
        stdout: "",
        name: "fixture",
      }),
    /did not confirm startup/u,
  );
});
