/**
 * Based on https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts
 * by Mario Zechner, used under the MIT License.
 */

export { default } from "./src/extension.ts";
export {
  getSandboxService,
  listGlobalSandboxProfiles,
  registerSandboxService,
  type SandboxProfileSelectionResult,
  type SandboxService,
} from "./src/service.ts";
