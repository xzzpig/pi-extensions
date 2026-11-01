// Fork-only compile-time fixture: `tsc` checks it through the package
// tsconfig (`tests/**/*.ts`), the node test runner never executes it. It
// proves the published `@xzzpig/pi-tool-display/tool-display-api-consumer`
// subpath resolves its `.d.ts` and that the documented capability probe
// type-checks for consumers.

import {
  getToolDisplayApi,
  type ToolDisplayApi,
  type ToolPresentationRenderContext,
  type ToolPresentationSnapshot,
} from "@xzzpig/pi-tool-display/tool-display-api-consumer";

export function probeToolPresentation(
  name: string,
): ToolPresentationSnapshot | undefined {
  const api = getToolDisplayApi();
  return typeof api?.getToolPresentation === "function"
    ? api.getToolPresentation(name)
    : undefined;
}

export function readPresentationRevision(
  api: ToolDisplayApi | undefined,
): number | undefined {
  return api?.presentationRevision;
}

export function createConsumerContext(): ToolPresentationRenderContext {
  return {
    args: {},
    toolCallId: "consumer-1",
    cwd: process.cwd(),
    argsComplete: true,
    isPartial: true,
    capabilities: { localWorkspace: false, executionMetadata: false },
  };
}
