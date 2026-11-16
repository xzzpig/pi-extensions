import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, copyFileSync } from "node:fs";
import net from "node:net";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Run on a real Linux host with KVM. Not a mock or an automatic CI skip.
import assert from "node:assert/strict";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = process.env.DEVICE_E2E_ENTRY ?? path.join(packageDir, "index.ts");
const root = mkdtempSync(path.join(tmpdir(), "pi-device-matrix-"));
console.log(`EVIDENCE=${root}`);
const agent = path.join(root, "agent");
mkdirSync(agent);
for (const file of ["auth.json", "models.json"])
  symlinkSync(path.join(homedir(), ".pi/agent", file), path.join(agent, file));
const provider = process.env.DEVICE_E2E_PROVIDER ?? "axonhub";
const model = process.env.DEVICE_E2E_MODEL ?? "deepseek-v4-flash";
writeFileSync(
  path.join(agent, "settings.json"),
  JSON.stringify({ defaultProvider: provider, defaultModel: model }),
);
const probe = path.join(root, "probe.py");
copyFileSync(path.join(packageDir, "scripts/fork-device-probe.py"), probe);
const host = spawnSync("python3", [probe], { encoding: "utf8" });
writeFileSync(path.join(root, "host.json"), host.stdout);
assert.equal(host.status, 0, host.stderr + host.stdout);
const identity = JSON.parse(host.stdout);
assert.equal(identity.apiVersion, 12);

const server = net.createServer((s) => s.end());
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const networkHost = spawnSync(
  "python3",
  [
    "-c",
    `import socket; socket.create_connection(('127.0.0.1', ${port}), 2).close(); print('HOST_NETWORK_OK')`,
  ],
  { encoding: "utf8" },
);
writeFileSync(path.join(root, "host-network.txt"), networkHost.stdout + networkHost.stderr);
assert.equal(networkHost.status, 0);
// spawnSync blocks JS but connecting to a listening socket still completes in the kernel.
writeFileSync(
  path.join(root, "isolation.py"),
  `import socket,sys,json,os\np=sys.argv[2]\ntry:\n f=open(p,'x'); f.close(); os.unlink(p); file_blocked=False\nexcept OSError:\n file_blocked=True\ns=socket.socket(); s.settimeout(2)\ntry:\n s.connect(('127.0.0.1',int(sys.argv[1]))); network_blocked=False\nexcept OSError:\n network_blocked=True\nfinally:\n s.close()\nprint(json.dumps(dict(file_blocked=file_blocked,network_blocked=network_blocked)))\nsys.exit(0 if file_blocked and network_blocked else 1)\n`,
);
const cases = [
  { name: "global-denied", devices: [], ok: false },
  { name: "global-allowed", devices: ["/dev/kvm"], ok: true },
  { name: "global-revoked", devices: [], ok: false },
  { name: "trusted-project", devices: [], project: true, trust: true, ok: true },
  { name: "untrusted-project", devices: [], project: true, trust: false, ok: false },
  { name: "profile-inherit", devices: ["/dev/kvm"], profile: {}, ok: true },
  {
    name: "profile-empty",
    devices: ["/dev/kvm"],
    profile: { filesystem: { allowDevices: [] } },
    ok: false,
  },
  { name: "other-isolation", devices: ["/dev/kvm"], isolate: true, ok: true },
];
const summary = [];
try {
  for (const scenario of process.env.DEVICE_E2E_CORE_ONLY === "1" ? cases.slice(0, 3) : cases) {
    const dir = path.join(root, scenario.name);
    mkdirSync(path.join(dir, ".pi"), { recursive: true });
    const config = {
      network: { disabled: !scenario.isolate, allowedDomains: [], deniedDomains: [] },
      filesystem: {
        denyRead: [],
        allowRead: [],
        allowWrite: ["/tmp"],
        denyWrite: [],
        allowDevices: scenario.devices,
      },
      ...(scenario.profile ? { profiles: { device: scenario.profile } } : {}),
    };
    writeFileSync(path.join(agent, "sandbox.json"), JSON.stringify(config));
    writeFileSync(path.join(dir, "global-config.json"), JSON.stringify(config));
    if (scenario.project)
      writeFileSync(
        path.join(dir, ".pi/sandbox.json"),
        JSON.stringify({ filesystem: { allowDevices: ["/dev/kvm"] } }),
      );
    const command =
      `python3 ${probe}` +
      (scenario.isolate
        ? `; python3 ${root}/isolation.py ${port} /var/tmp/${path.basename(root)}-forbidden`
        : "");
    const args = [
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-mcp",
      scenario.trust ? "--approve" : "--no-approve",
      "--session-dir",
      path.join(dir, "sessions"),
      "-e",
      entry,
      "--provider",
      provider,
      "--model",
      model,
      "--thinking",
      "off",
      "--tools",
      "bash",
      "--mode",
      "json",
      "-p",
      `Use the bash tool exactly once to execute the shell command below. Copy only the line inside the code block into the command argument; do not add quotation marks or backticks. Do not use any other tools. Do not retry on failure. Report the command output.\n\n\`\`\`sh\n${command}\n\`\`\``,
    ];
    writeFileSync(
      path.join(dir, "launch.json"),
      JSON.stringify({ entry, args, command, profile: scenario.profile ? "device" : null }),
    );
    const env = { ...process.env, PI_CODING_AGENT_DIR: agent };
    delete env.PI_SUBAGENT_SANDBOX_PROFILE;
    delete env.PI_SUBAGENT_SANDBOX_PROJECT_TRUSTED;
    if (scenario.profile) env.PI_SUBAGENT_SANDBOX_PROFILE = "device";
    const result = spawnSync("pi", args, {
      cwd: dir,
      env,
      encoding: "utf8",
      timeout: 150000,
      maxBuffer: 10 * 1024 * 1024,
    });
    writeFileSync(path.join(dir, "pi.jsonl"), result.stdout ?? "");
    writeFileSync(path.join(dir, "pi.stderr"), result.stderr ?? "");
    writeFileSync(
      path.join(dir, "exit.json"),
      JSON.stringify({
        status: result.status,
        signal: result.signal,
        error: result.error?.message,
      }),
    );
    assert.equal(result.status, 0, `${scenario.name}: Pi failed: ${result.stderr}`);
    const events = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const calls = events.filter((e) => e.type === "tool_execution_start");
    const ends = events.filter((e) => e.type === "tool_execution_end");
    assert.equal(calls.length, 1, `${scenario.name}: need actual single bash call`);
    assert.equal(calls[0].toolName, "bash");
    assert.equal(calls[0].args.command, command);
    assert.equal(ends.length, 1);
    const output = ends[0].result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    const lines = output.split("\n").filter((line) => line.startsWith("{"));
    assert.ok(lines.length, `${scenario.name}: no probe JSON: ${output}`);
    const data = JSON.parse(lines[0]);
    assert.equal(data.ok, scenario.ok, `${scenario.name}: ${output}`);
    if (scenario.ok) {
      assert.equal(data.apiVersion, 12);
      assert.equal(data.major, identity.major);
      assert.equal(data.minor, identity.minor);
    } else assert.equal(data.errno, 2, `${scenario.name}: expected device absent`);
    if (scenario.isolate)
      assert.deepEqual(JSON.parse(lines[1]), { file_blocked: true, network_blocked: true });
    summary.push({ scenario: scenario.name, pass: true, probe: data });
    writeFileSync(path.join(root, "summary.json"), JSON.stringify(summary, null, 2));
    console.log(`PASS ${scenario.name}`);
  }
} finally {
  server.close();
}
