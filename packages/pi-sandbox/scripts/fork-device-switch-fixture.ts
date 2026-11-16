// Test-only companion for real Pi print-mode lifecycle E2E. Not a package entry.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { Type } from "typebox";

import { registerSandboxProfiles } from "../src/fork-profile-registry.ts";
import { getSandboxService } from "../src/service.ts";

export default function (pi: ExtensionAPI) {
  registerSandboxProfiles({
    "runtime-device-on": { filesystem: { allowDevices: ["/dev/kvm"] } },
    "runtime-device-off": { filesystem: { allowDevices: [] } },
  });
  pi.registerTool({
    name: "device_test_profile",
    label: "Device test profile",
    description:
      "Test-only: choose runtime-device-on or runtime-device-off for THIS Pi session using SandboxService.",
    parameters: Type.Object({
      name: Type.Union([Type.Literal("runtime-device-on"), Type.Literal("runtime-device-off")]),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const service = getSandboxService(ctx.sessionManager.getSessionId());
      if (!service) throw new Error("sandbox service is unavailable");
      const result = await service.setProfile(params.name);
      if (!result.ok) throw new Error(result.message ?? "profile selection failed");
      return {
        content: [
          { type: "text", text: JSON.stringify({ ...result, profile: service.getProfile() }) },
        ],
        details: {},
      };
    },
  });
}
