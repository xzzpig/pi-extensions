import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = path.join(root, "scripts/ci-sandbox-setup.sh");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-sandbox-setup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, "commands.log");
  const mocks = {
    sysctl: `printf 'sysctl %s\\n' "$*" >> "$TEST_LOG"
if [[ "\${TEST_MISSING:-}" == 1 ]]; then exit 1; fi
if [[ "\${TEST_WRONG:-}" == 1 ]]; then echo 99; exit 0; fi
case "$2" in
  kernel.apparmor_restrict_unprivileged_userns) echo 0 ;;
  kernel.unprivileged_userns_clone) echo 1 ;;
  *) exit 1 ;;
esac`,
    sudo: `printf 'sudo %s\\n' "$*" >> "$TEST_LOG"
[[ "\${TEST_SUDO_FAIL:-}" != 1 ]]`,
    bwrap: `printf 'bwrap %s\\n' "$*" >> "$TEST_LOG"
[[ "\${TEST_BWRAP_FAIL:-}" != 1 ]]`,
  };
  for (const [name, body] of Object.entries(mocks))
    fs.writeFileSync(path.join(dir, name), `#!/bin/bash\n${body}\n`, {
      mode: 0o755,
    });
  return (overrides = {}) => {
    const result = spawnSync("/bin/bash", [script], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: dir,
        TEST_LOG: log,
        GITHUB_ACTIONS: "true",
        RUNNER_ENVIRONMENT: "github-hosted",
        RUNNER_OS: "Linux",
        ...overrides,
      },
    });
    assert.ifError(result.error);
    return {
      ...result,
      commands: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "",
    };
  };
}
test("kernel setup refuses local, self-hosted and non-Linux environments", (t) => {
  for (const overrides of [
    { GITHUB_ACTIONS: "" },
    { RUNNER_ENVIRONMENT: "self-hosted" },
    { RUNNER_OS: "macOS" },
  ]) {
    const result = fixture(t)(overrides);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing kernel changes/);
    assert.equal(result.commands, "");
  }
});
test("hosted setup applies and verifies settings before nested namespace preflight", (t) => {
  const result = fixture(t)();
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.commands,
    /sudo -n sysctl -w kernel.apparmor_restrict_unprivileged_userns=0/,
  );
  assert.match(
    result.commands,
    /sudo -n sysctl -w kernel.unprivileged_userns_clone=1/,
  );
  assert.equal((result.commands.match(/--unshare-net/g) ?? []).length, 2);
  assert.equal((result.commands.match(/--unshare-user/g) ?? []).length, 2);
  assert.ok(
    result.commands.lastIndexOf("sysctl") < result.commands.indexOf("bwrap"),
  );
  assert.match(result.stdout, /preflight passed/);
});
test("failed sysctl update or ineffective setting fails before running bwrap", (t) => {
  for (const overrides of [{ TEST_SUDO_FAIL: "1" }, { TEST_WRONG: "1" }]) {
    const result = fixture(t)(overrides);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.commands, /bwrap/);
  }
});
test("missing optional kernel knobs still require successful namespace preflight", (t) => {
  const result = fixture(t)({ TEST_MISSING: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.commands, /sudo/);
  assert.match(result.commands, /bwrap/);
});
test("namespace preflight failure is blocking rather than an ignored warning", (t) => {
  const result = fixture(t)({ TEST_BWRAP_FAIL: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /namespace preflight failed/);
});
test("both workflows install native build prerequisites and explicitly prepare the runner", () => {
  for (const name of ["ci", "publish"]) {
    const workflow = fs.readFileSync(
      path.join(root, `.github/workflows/${name}.yml`),
      "utf8",
    );
    assert.match(workflow, /gcc libseccomp-dev/);
    assert.match(workflow, /run: bash scripts\/ci-sandbox-setup\.sh/);
    assert.ok(
      workflow.indexOf("bash scripts/ci-sandbox-setup.sh") <
        workflow.indexOf("node scripts/release.mjs"),
    );
    assert.doesNotMatch(workflow, /continue-on-error/);
  }
});
