// Host-only integration: real managers, Pi bash tool and real KVM/TUN processes.
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import assert from "node:assert/strict";

import extension from "../src/extension.ts";
import { registerSandboxProfiles } from "../src/fork-profile-registry.ts";
import { getSandboxService } from "../src/service.ts";

const root = mkdtempSync(join(tmpdir(), "pi-device-concurrent-real-"));
console.log(`EVIDENCE=${root}`);
const agent = join(root, "agent");
mkdirSync(agent);
process.env.PI_CODING_AGENT_DIR = agent;
for (const key of [
  "PI_SUBAGENT_SANDBOX_PROFILE",
  "PI_SUBAGENT_SANDBOX_PROJECT_TRUSTED",
  "PI_SUBAGENT_SANDBOX_IN_PROCESS_CHILD",
])
  delete process.env[key];
writeFileSync(
  join(agent, "sandbox.json"),
  JSON.stringify({
    network: { disabled: true },
    filesystem: { denyRead: [], allowRead: [], allowWrite: ["/tmp"], denyWrite: [] },
  }),
);
registerSandboxProfiles({
  concurrent_kvm: { filesystem: { allowDevices: ["/dev/kvm"] } },
  concurrent_tun: { filesystem: { allowDevices: ["/dev/net/tun"] } },
  concurrent_off: { filesystem: { allowDevices: [] } },
});
const probe = join(root, "probe.py");
writeFileSync(
  probe,
  `import os,sys,json,fcntl,struct,time\nkind=sys.argv[1]; device='/dev/kvm' if kind=='kvm' else '/dev/net/tun'\ntry:\n fd=os.open(device,os.O_RDWR|os.O_CLOEXEC|os.O_NOFOLLOW)\n try:\n  s=os.fstat(fd)\n  if len(sys.argv)>2:\n   gate=sys.argv[2]\n   open(gate+'.entered','w').close()\n   deadline=time.monotonic()+20\n   while not os.path.exists(gate+'.release'):\n    if time.monotonic()>deadline: raise TimeoutError('gate timeout')\n    time.sleep(.02)\n  value=fcntl.ioctl(fd,0xAE00,0) if kind=='kvm' else struct.unpack('I',fcntl.ioctl(fd,0x800454cf,bytes(4)))[0]\n  print(json.dumps(dict(device=device,major=os.major(s.st_rdev),minor=os.minor(s.st_rdev),value=value,ok=(value==12 if kind=='kvm' else value>0))))\n finally: os.close(fd)\nexcept OSError as e:\n print(json.dumps(dict(device=device,ok=False,errno=e.errno,error=str(e))))\n sys.exit(1)\n`,
);
type Handler = (event: unknown, ctx: ExtensionToolContext) => unknown;
async function session(id: string) {
  const cwd = join(root, id);
  mkdirSync(cwd);
  const handlers = new Map<string, Handler>();
  let bash: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
  // SAFETY: this headless harness supplies every context member used by startup,
  // SandboxService and Pi's bash tool; no UI or agent/model operations are invoked.
  const ctx = {
    cwd,
    hasUI: false,
    isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => id, getSessionFile: () => undefined },
    ui: {
      notify: () => {},
      setStatus: () => {},
      theme: { fg: (_color: string, value: string) => value },
    },
  } as unknown as ExtensionToolContext;
  // SAFETY: registration-only API adapter captures production hooks and bash;
  // all execution uses the real manager/core tool, never absent API members.
  extension({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
      if (tool.name === "bash") bash = tool;
    },
    registerFlag: () => {},
    registerCommand: () => {},
    registerShortcut: () => {},
    getFlag: () => false,
  } as unknown as ExtensionAPI);
  await handlers.get("session_start")!({ reason: "startup" }, ctx);
  const service = getSandboxService(id);
  assert.ok(service);
  return {
    service,
    async run(name: string, kind: string, gate?: string) {
      const command = `python3 ${probe} ${kind}${gate ? ` ${gate}` : ""}`;
      const profileAtStart = service.getProfile();
      let output: string;
      let failed = false;
      try {
        const result = await bash!.execute(
          name,
          { command, timeout: 25 },
          undefined,
          undefined,
          ctx,
        );
        output = result.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n");
      } catch (error) {
        failed = true;
        output = error instanceof Error ? error.message : String(error);
      }
      // Pi can return a nonzero shell result as content rather than throwing.
      failed ||= /Command exited with code [1-9]/.test(output);
      writeFileSync(
        join(root, name + ".json"),
        JSON.stringify({
          session: id,
          profileAtStart,
          profileAtFinish: service.getProfile(),
          command,
          output,
          failed,
        }),
      );
      const data = JSON.parse(output.split("\n").find((line) => line.startsWith("{"))!);
      assert.equal(failed, !data.ok, output);
      return data;
    },
    async stop() {
      await handlers.get("session_shutdown")!({}, ctx);
    },
  };
}
async function waitFor(path: string) {
  const deadline = Date.now() + 15000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`missing gate ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const a = await session("real-concurrent-a");
const b = await session("real-concurrent-b");
const gateA = join(root, "gate-a");
const gateB = join(root, "gate-b");
let oldA: Promise<any> | undefined;
let oldB: Promise<any> | undefined;
try {
  assert.equal((await a.service.setProfile("concurrent_kvm")).ok, true);
  assert.equal((await b.service.setProfile("concurrent_tun")).ok, true);
  oldA = a.run("old-a", "kvm", gateA);
  oldB = b.run("old-b", "tun", gateB);
  await Promise.all([waitFor(gateA + ".entered"), waitFor(gateB + ".entered")]);
  assert.equal((await a.service.setProfile("concurrent_off")).ok, true);
  const revoked = await a.run("revoked-a", "kvm");
  assert.equal(revoked.ok, false);
  assert.equal(revoked.errno, 2);
  const unaffected = await b.run("unaffected-b", "tun");
  assert.equal(unaffected.ok, true);
  writeFileSync(gateA + ".release", "");
  writeFileSync(gateB + ".release", "");
  const prior = await Promise.all([oldA, oldB]);
  assert.equal(prior[0].ok, true);
  assert.equal(prior[0].value, 12);
  assert.equal(prior[1].ok, true);
  assert.equal(a.service.getProfile(), "concurrent_off");
  assert.equal(b.service.getProfile(), "concurrent_tun");
  assert.equal((await a.service.setProfile("concurrent_kvm")).ok, true);
  assert.equal((await a.run("restored-a", "kvm")).value, 12);
  writeFileSync(
    join(root, "summary.json"),
    JSON.stringify(
      {
        pass: true,
        revoked,
        unaffected,
        prior,
        gates: [gateA, gateB],
        evidence: readFileSync(join(root, "old-a.json"), "utf8"),
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS two concurrent real device sessions; A revoked for new commands, old A and B retained grants; A restored",
  );
} finally {
  writeFileSync(gateA + ".release", "");
  writeFileSync(gateB + ".release", "");
  await Promise.allSettled([oldA, oldB]);
  await a.stop();
  await b.stop();
}
