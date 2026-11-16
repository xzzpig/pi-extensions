import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Real Pi + real KVM, one process/session: allow -> service revoke -> restore.
import assert from "node:assert/strict";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(path.join(tmpdir(), "pi-device-switch-"));
console.log(`EVIDENCE=${root}`);
const agent = path.join(root, "agent");
const cwd = path.join(root, "work");
mkdirSync(agent);
mkdirSync(cwd);
for (const file of ["auth.json", "models.json"])
  symlinkSync(path.join(homedir(), ".pi/agent", file), path.join(agent, file));
writeFileSync(path.join(agent, "settings.json"), "{}");
writeFileSync(
  path.join(agent, "sandbox.json"),
  JSON.stringify({
    network: { disabled: true },
    filesystem: {
      denyRead: [],
      allowRead: [],
      allowWrite: ["/tmp"],
      denyWrite: [],
      allowDevices: ["/dev/kvm"],
    },
  }),
);
const probe = path.join(root, "probe.py");
copyFileSync(path.join(pkg, "scripts/fork-device-probe.py"), probe);
const command = `python3 ${probe}`;
const prompt = `Perform exactly these FIVE tool calls in order, waiting for each result. No other tools, no retries, no parallel calls. A failing probe at step 3 is intentional: continue to step 4.\n1. bash with this command (copy only the code block line):\n\`\`\`sh\n${command}\n\`\`\`\n2. device_test_profile with name runtime-device-off.\n3. bash with the identical command from step 1.\n4. device_test_profile with name runtime-device-on.\n5. bash with the identical command from step 1.\nThen report the three probe outputs.`;
const args = [
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--no-mcp",
  "--no-approve",
  "--session-dir",
  path.join(root, "sessions"),
  "-e",
  path.join(pkg, "index.ts"),
  "-e",
  path.join(pkg, "scripts/fork-device-switch-fixture.ts"),
  "--provider",
  process.env.DEVICE_E2E_PROVIDER ?? "axonhub",
  "--model",
  process.env.DEVICE_E2E_MODEL ?? "deepseek-v4-flash",
  "--thinking",
  "off",
  "--tools",
  "bash,device_test_profile",
  "--mode",
  "json",
  "-p",
  prompt,
];
const env = { ...process.env, PI_CODING_AGENT_DIR: agent };
for (const key of [
  "PI_SUBAGENT_SANDBOX_PROFILE",
  "PI_SUBAGENT_SANDBOX_PROJECT_TRUSTED",
  "PI_SUBAGENT_SANDBOX_IN_PROCESS_CHILD",
])
  delete env[key];
const host = spawnSync("python3", [probe], { encoding: "utf8" });
writeFileSync(path.join(root, "host.json"), host.stdout);
assert.equal(host.status, 0);
const identity = JSON.parse(host.stdout);
writeFileSync(path.join(root, "launch.json"), JSON.stringify({ args, command, agent, cwd }));
const result = spawnSync("pi", args, {
  cwd,
  env,
  encoding: "utf8",
  timeout: 240000,
  maxBuffer: 15 * 1024 * 1024,
});
writeFileSync(path.join(root, "pi.jsonl"), result.stdout ?? "");
writeFileSync(path.join(root, "pi.stderr"), result.stderr ?? "");
writeFileSync(
  path.join(root, "exit.json"),
  JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message }),
);
assert.equal(result.status, 0, result.stderr);
const events = result.stdout
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const calls = events.filter((e) => e.type === "tool_execution_start");
const ends = events.filter((e) => e.type === "tool_execution_end");
assert.deepEqual(
  calls.map((c) => c.toolName),
  ["bash", "device_test_profile", "bash", "device_test_profile", "bash"],
);
assert.equal(ends.length, 5);
const output = (index) =>
  ends[index].result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
const probes = [];
for (const index of [0, 2, 4]) {
  assert.equal(calls[index].args.command, command);
  const data = JSON.parse(
    output(index)
      .split("\n")
      .find((line) => line.startsWith("{")),
  );
  assert.equal(data.ok, index !== 2);
  if (data.ok) {
    assert.equal(data.apiVersion, 12);
    assert.equal(data.major, identity.major);
    assert.equal(data.minor, identity.minor);
  } else assert.equal(data.errno, 2);
  probes.push(data);
}
assert.equal(calls[1].args.name, "runtime-device-off");
assert.equal(calls[3].args.name, "runtime-device-on");
assert.deepEqual(JSON.parse(output(1)), { ok: true, profile: "runtime-device-off" });
assert.deepEqual(JSON.parse(output(3)), { ok: true, profile: "runtime-device-on" });
// Exactly one persisted Pi session must contain the complete sequence.
const { readdirSync } = await import("node:fs");
const sessions = readdirSync(path.join(root, "sessions")).filter((f) => f.endsWith(".jsonl"));
assert.equal(sessions.length, 1);
const persisted = readFileSync(path.join(root, "sessions", sessions[0]), "utf8");
assert.ok(persisted.includes("runtime-device-off") && persisted.includes("runtime-device-on"));
writeFileSync(
  path.join(root, "summary.json"),
  JSON.stringify(
    {
      pass: true,
      session: sessions[0],
      probes,
      calls: calls.map((c) => ({ tool: c.toolName, args: c.args })),
    },
    null,
    2,
  ),
);
console.log(
  "PASS same-session real KVM allow -> service revoke -> restore via runtime-registered profiles",
);
