import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { SandboxRuntimeConfig } from "@xzzpig/sandbox-runtime";

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import extension from "../src/extension.ts";
import { registerSandboxProfiles } from "../src/fork-profile-registry.ts";
import { sandboxManagerFactory } from "../src/sandbox-runtime.ts";
import { getSandboxService } from "../src/service.ts";

const KVM = "/dev/kvm";
const TUN = "/dev/net/tun";
type Handler = (event: any, ctx: ExtensionToolContext) => any;
const launchKeys = [
  "PI_SUBAGENT_SANDBOX_PROFILE",
  "PI_SUBAGENT_SANDBOX_PROJECT_TRUSTED",
  "PI_SUBAGENT_SANDBOX_IN_PROCESS_CHILD",
  "PI_SUBAGENT_SANDBOX_STARTUP_ACK_PATH",
  "PI_SUBAGENT_SANDBOX_STARTUP_ACK_TOKEN",
  "PI_SUBAGENT_SANDBOX_DIAGNOSTICS_PATH",
];

async function fixture(run: (f: ReturnType<typeof harness>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "pi-device-lifecycle-"));
  const keys = ["PI_CODING_AGENT_DIR", ...launchKeys];
  const saved = keys.map((key) => process.env[key]);
  const original = sandboxManagerFactory.create;
  const registryKey = Symbol.for("@xzzpig/pi-sandbox/session-profile-registry");
  const scope = globalThis as Record<symbol, unknown>;
  const oldRegistry = scope[registryKey];
  try {
    for (const key of keys) delete process.env[key];
    const agent = join(root, "agent");
    mkdirSync(agent);
    process.env.PI_CODING_AGENT_DIR = agent;
    writeFileSync(
      join(agent, "sandbox.json"),
      JSON.stringify({
        network: { disabled: true },
        filesystem: { allowDevices: [KVM] },
        profiles: {
          device: { filesystem: { allowDevices: [KVM] } },
          off: { filesystem: { allowDevices: [] } },
        },
      }),
    );
    const f = harness(root, original);
    try {
      await run(f);
    } finally {
      await f.shutdown();
    }
  } finally {
    sandboxManagerFactory.create = original;
    if (oldRegistry === undefined) delete scope[registryKey];
    else scope[registryKey] = oldRegistry;
    keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    });
    rmSync(root, { recursive: true, force: true });
  }
}

function harness(root: string, original: typeof sandboxManagerFactory.create) {
  const sessions: Array<{ stop(): Promise<void> }> = [];
  return {
    async shutdown() {
      for (const session of sessions) await session.stop();
    },
    async start(id: string, trust: boolean | undefined, child = false) {
      const cwd = join(root, id);
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(
        join(cwd, ".pi/sandbox.json"),
        JSON.stringify({
          filesystem: { allowDevices: [TUN] },
          profiles: { device: { filesystem: { allowDevices: [TUN] } } },
        }),
      );
      let current: SandboxRuntimeConfig | undefined;
      const snapshots: string[][] = [];
      const gates: Array<{ enter(): void; wait: Promise<void> }> = [];
      const real = original();
      sandboxManagerFactory.create = () => ({
        ...real,
        initialize: async (config) => {
          current = structuredClone(config);
        },
        updateConfig: (config) => {
          current = structuredClone(config);
        },
        waitForNetworkInitialization: async () => true,
        getConfig: () => current,
        reset: async () => {},
        cleanupAfterCommand: () => {},
        wrapWithSandbox: async () => {
          // Snapshot at command start, before any asynchronous interleaving.
          const devices = [...(current?.filesystem.allowDevices ?? [])];
          snapshots.push(devices);
          const gate = gates.shift();
          if (gate) {
            gate.enter();
            await gate.wait;
          }
          return `printf '%s' '${JSON.stringify(devices)}'`;
        },
      });
      const handlers = new Map<string, Handler>();
      let bash: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
      const ctx = {
        cwd,
        hasUI: false,
        isProjectTrusted: () => trust,
        sessionManager: { getSessionId: () => id, getSessionFile: () => undefined },
        ui: {
          notify: () => {},
          setStatus: () => {},
          theme: { fg: (_color: string, value: string) => value },
        },
      } as unknown as ExtensionToolContext;
      if (child) {
        process.env.PI_SUBAGENT_SANDBOX_PROFILE = "device";
        process.env.PI_SUBAGENT_SANDBOX_IN_PROCESS_CHILD = "1";
        if (trust !== undefined)
          process.env.PI_SUBAGENT_SANDBOX_PROJECT_TRUSTED = trust ? "1" : "0";
      }
      try {
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
      } finally {
        for (const key of launchKeys) delete process.env[key];
      }
      await handlers.get("session_start")!({ reason: "startup" }, ctx);
      const service = getSandboxService(id);
      assert.ok(service);
      const result = {
        service,
        snapshots,
        devices: () => [...(current?.filesystem.allowDevices ?? [])],
        async execute() {
          const output = await bash!.execute(
            "device-command",
            { command: "device-snapshot", timeout: 5 },
            undefined,
            undefined,
            ctx,
          );
          return JSON.parse(
            output.content
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n"),
          ) as string[];
        },
        holdNext() {
          let enter!: () => void;
          let release!: () => void;
          const entered = new Promise<void>((resolve) => {
            enter = resolve;
          });
          const wait = new Promise<void>((resolve) => {
            release = resolve;
          });
          gates.push({ enter, wait });
          return { entered, release };
        },
        async stop() {
          await handlers.get("session_shutdown")!({}, ctx);
        },
      };
      sessions.push(result);
      return result;
    },
  };
}

for (const trust of [true, false, undefined]) {
  test(`service device trust=${trust}: real session_start and setProfile refresh preserve boundary`, async () => {
    await fixture(async (f) => {
      const s = await f.start(`service-${trust}`, trust);
      assert.deepEqual(await s.execute(), trust === true ? [KVM, TUN] : [KVM]);
      assert.equal((await s.service.setProfile("device")).ok, true);
      assert.deepEqual(await s.execute(), trust === true ? [TUN] : [KVM]);
      assert.equal((await s.service.setProfile("off")).ok, true);
      assert.deepEqual(await s.execute(), []);
    });
  });
  test(`child device trust=${trust}: launch env profile and inherited trust reach execution`, async () => {
    await fixture(async (f) => {
      const s = await f.start(`child-${trust}`, trust, true);
      assert.equal(s.service.getProfile(), "device");
      assert.deepEqual(await s.execute(), trust === true ? [TUN] : [KVM]);
      assert.equal((await s.service.setProfile("off")).ok, true);
      assert.deepEqual(await s.execute(), []);
    });
  });
}

test("runtime registered device profiles selected by service; concurrent sessions and old commands stay isolated", async () => {
  await fixture(async (f) => {
    registerSandboxProfiles({
      runtime_kvm: { filesystem: { allowDevices: [KVM] } },
      runtime_tun: { filesystem: { allowDevices: [TUN] } },
      runtime_off: { filesystem: { allowDevices: [] } },
    });
    const a = await f.start("concurrent-a", false);
    const b = await f.start("concurrent-b", false);
    assert.ok(a.service.listProfiles().includes("runtime_kvm"));
    assert.equal((await a.service.setProfile("runtime_kvm")).ok, true);
    assert.equal((await b.service.setProfile("runtime_tun")).ok, true);
    const gateA = a.holdNext();
    const gateB = b.holdNext();
    const oldA = a.execute();
    const oldB = b.execute();
    try {
      await Promise.all([gateA.entered, gateB.entered]);
      assert.deepEqual(a.snapshots, [[KVM]]);
      assert.deepEqual(b.snapshots, [[TUN]]);
      assert.equal((await a.service.setProfile("runtime_off")).ok, true);
      assert.deepEqual(await a.execute(), [], "new A command must use revoked devices");
      assert.deepEqual(await b.execute(), [TUN], "A switch cannot change B manager");
      assert.deepEqual(a.devices(), []);
      assert.deepEqual(b.devices(), [TUN]);
    } finally {
      gateA.release();
      gateB.release();
    }
    assert.deepEqual(await oldA, [KVM], "already-started A command retains its original snapshot");
    assert.deepEqual(await oldB, [TUN]);
    assert.equal(a.service.getProfile(), "runtime_off");
    assert.equal(b.service.getProfile(), "runtime_tun");
    assert.equal((await a.service.setProfile("runtime_kvm")).ok, true);
    assert.deepEqual(
      await a.execute(),
      [KVM],
      "same session can explicitly restore device authorization",
    );
  });
});
