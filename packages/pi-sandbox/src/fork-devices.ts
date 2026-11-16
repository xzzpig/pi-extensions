import { FilesystemConfigSchema } from "@xzzpig/sandbox-runtime";

import type { SandboxConfig, SandboxConfigFile } from "./config.ts";

export function deviceList(config: SandboxConfigFile, source: string): string[] | undefined {
  const value = config.filesystem?.allowDevices;
  const result = FilesystemConfigSchema.shape.allowDevices.safeParse(value);
  if (!result.success) {
    throw new Error(`${source}.filesystem.allowDevices: ${result.error.message}`);
  }
  return result.data;
}

export function mergeDeviceLists(
  result: SandboxConfig,
  global: SandboxConfigFile,
  project: SandboxConfigFile,
): SandboxConfig {
  const a = deviceList(global, "Global sandbox configuration");
  const b = deviceList(project, "Project sandbox configuration");
  if (a === undefined && b === undefined) return result;
  return {
    ...result,
    filesystem: {
      denyRead: [],
      allowWrite: [],
      denyWrite: [],
      ...result.filesystem,
      allowDevices: [...new Set([...(a ?? []), ...(b ?? [])])],
    },
  };
}

export function trustedDeviceConfig(
  project: SandboxConfigFile,
  trusted: boolean | undefined,
  onWarning?: (message: string) => void,
): SandboxConfigFile {
  if (trusted === true || project.filesystem?.allowDevices === undefined) return project;
  onWarning?.(
    "Project filesystem.allowDevices was not applied (project is not explicitly trusted).",
  );
  const { allowDevices: _ignored, ...filesystem } = project.filesystem;
  return { ...project, filesystem };
}

export function devicePlatformError(
  config: SandboxConfig,
  platform: NodeJS.Platform,
): Error | undefined {
  if (config.filesystem?.allowDevices?.length && platform !== "linux" && platform !== "android") {
    return new Error(`filesystem.allowDevices: device passthrough is not supported on ${platform}`);
  }
  return undefined;
}

export function isDeviceConfigError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("allowDevices");
}
