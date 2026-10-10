import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { type BashOperations, getShellConfig } from "@earendil-works/pi-coding-agent";
import {
  createSandboxManager,
  type ISandboxManager,
  pathEntryLstatExists,
  type SandboxRuntimeConfig,
} from "@xzzpig/sandbox-runtime";

import { type SandboxConfig } from "./config.ts";
import { canonicalizePath } from "./policy.ts";
import { collectBlockedWritePaths, type BlockedWrite } from "./write-denial.ts";

export interface SessionAllowances {
  domains: string[];
  readPaths: string[];
  writePaths: string[];
}

export interface EffectiveAllowances {
  domains: string[];
  readPaths: string[];
  writePaths: string[];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function resolveSshAgentSocketPath(sshAuthSock: string | undefined): string | undefined {
  if (!sshAuthSock) return undefined;
  try {
    const resolved = realpathSync(sshAuthSock);
    return statSync(resolved).isSocket() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function resolveUnixSockets(config: SandboxConfig): string[] | undefined {
  const sockets = [...(config.network?.allowUnixSockets ?? [])];
  if (config.network?.allowSSHAgentSocket) {
    const agentSocket = resolveSshAgentSocketPath(process.env.SSH_AUTH_SOCK);
    if (agentSocket) sockets.push(agentSocket);
  }
  if (sockets.length === 0) return config.network?.allowUnixSockets;
  return unique(sockets);
}

const canonicalizeFilesystemPattern = (path: string, baseCwd?: string) =>
  path.includes("*") ? path : canonicalizePath(path, baseCwd);

const canonicalizeFilesystemPatterns = (paths: string[], baseCwd?: string) =>
  unique(paths.map((path) => canonicalizeFilesystemPattern(path, baseCwd)));

function sandboxRuntimeReadPaths(platform: NodeJS.Platform): string[] {
  if (platform !== "linux") return [];

  // apply-seccomp executes inside the Bubblewrap namespace, so broad rules
  // such as denyRead: ["/home"] must not hide the runtime's bundled helper.
  const runtimeEntryUrl = import.meta.resolve("@xzzpig/sandbox-runtime");
  return [fileURLToPath(new URL("../vendor/seccomp", runtimeEntryUrl))];
}

export function resolveAllowances(
  config: SandboxConfig,
  allowances?: SessionAllowances,
): EffectiveAllowances {
  const writePaths = unique([
    ...(config.filesystem?.allowWrite ?? []),
    ...(allowances?.writePaths ?? []),
  ]);

  return {
    domains: unique([...(config.network?.allowedDomains ?? []), ...(allowances?.domains ?? [])]),
    readPaths: unique([
      ...(config.filesystem?.allowRead ?? []),
      ...(allowances?.readPaths ?? []),
      ...writePaths,
    ]),
    writePaths,
  };
}

export function buildRuntimeConfig(
  config: SandboxConfig,
  allowances?: SessionAllowances,
  platform: NodeJS.Platform = process.platform,
  baseCwd: string = process.cwd(),
): SandboxRuntimeConfig {
  const effective = resolveAllowances(config, allowances);

  // With protectNonexistentFiles=false, every literal denyWrite entry that
  // does not exist yet is dropped — whether it comes from the built-in
  // defaults (.env, .env.*, *.pem, *.key) or from user configuration. This
  // keeps bwrap from materializing placeholder mount points for paths that
  // are not there (e.g. an empty .env appearing in the project during every
  // command). Entries that exist keep full write protection, and glob
  // patterns pass through untouched (Linux drops them anyway; macOS is
  // unaffected by the flag).
  const rawDenyWrite = config.filesystem?.denyWrite ?? [];
  const canonicalDenyWrite = canonicalizeFilesystemPatterns(rawDenyWrite, baseCwd);
  const denyWrite =
    config.filesystem?.protectNonexistentFiles === false
      ? canonicalDenyWrite.filter((path) => path.includes("*") || pathEntryLstatExists(path))
      : canonicalDenyWrite;

  const { allowSSHAgentSocket: _allowSSHAgentSocket, ...networkConfig } = config.network ?? {};

  const runtimeConfig: SandboxRuntimeConfig = {
    network: {
      ...networkConfig,
      allowedDomains: effective.domains,
      deniedDomains: config.network?.deniedDomains ?? [],
      allowUnixSockets: resolveUnixSockets(config),
    } as SandboxRuntimeConfig["network"],
    filesystem: {
      disabled: config.filesystem?.disabled,
      denyRead: canonicalizeFilesystemPatterns(config.filesystem?.denyRead ?? [], baseCwd),
      allowRead: canonicalizeFilesystemPatterns(
        [...effective.readPaths, ...sandboxRuntimeReadPaths(platform)],
        baseCwd,
      ),
      allowWrite: canonicalizeFilesystemPatterns(effective.writePaths, baseCwd),
      denyWrite,
      protectNonexistentFiles: config.filesystem?.protectNonexistentFiles,
      // Forwarded for @carderne/sandbox-runtime PR #21. The cast is only
      // needed until a released runtime type carries the field.
      denyMandatoryCwdFiles: config.filesystem?.denyMandatoryCwdFiles,
    } as SandboxRuntimeConfig["filesystem"],
    ignoreViolations: config.ignoreViolations,
    credentials: config.credentials,
    enableWeakerNestedSandbox: config.enableWeakerNestedSandbox,
    allowBrowserProcess: config.allowBrowserProcess,
    allowPty: config.allowPty,
    enableWeakerNetworkIsolation: true,
  };

  return runtimeConfig;
}

export async function initializeSandbox(
  manager: ISandboxManager,
  config: SandboxConfig,
  allowances?: SessionAllowances,
  baseCwd: string = process.cwd(),
): Promise<void> {
  const runtimeConfig = buildRuntimeConfig(config, allowances, process.platform, baseCwd);
  // The runtime checks its live allowlist. Permission prompts happen before
  // execution; a callback capturing this initial list could re-allow removed domains.
  // The violation monitor (Linux) reports blocked write-intent syscalls per
  // command so a sandbox refusal can be explained instead of surfacing as a
  // bare kernel error. Diagnostic-only: it degrades gracefully and never
  // relaxes policy.
  await manager.initialize(runtimeConfig, undefined, process.platform === "linux");
}

export function updateSandboxConfig(
  manager: ISandboxManager,
  config: SandboxConfig,
  allowances: SessionAllowances,
  baseCwd: string = process.cwd(),
): void {
  // Permission updates must not tear down the proxy used by concurrent commands.
  // Network rules apply immediately; new commands pick up filesystem rules when wrapped.
  manager.updateConfig(buildRuntimeConfig(config, allowances, process.platform, baseCwd));
}

export function supportsNodeEnvProxy(version: string): boolean {
  const [major, minor] = version.split(".").map(Number);
  return (major === 22 && minor >= 21) || major >= 24;
}

export function extractBlockedWritePath(output: string): string | null {
  const match = output.match(
    /(?:\/bin\/bash|bash|sh): (?:line \d: )?(\/[^\s:]+): Operation not permitted/,
  );
  return match ? match[1] : null;
}

const EXIT_STDIO_GRACE_MS = 100;

/**
 * Wait for a child process to exit without hanging on inherited stdio handles.
 *
 * After exit, keep reading while output is active. If a detached descendant
 * holds the pipes open but leaves them idle, release them after a short grace.
 */
function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let postExitTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = () => {
      if (postExitTimer) {
        clearTimeout(postExitTimer);
        postExitTimer = undefined;
      }
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
    };

    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };

    const maybeFinalizeAfterExit = () => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) finalize(exitCode);
    };

    const armIdleTimer = () => {
      if (postExitTimer) clearTimeout(postExitTimer);
      postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
    };

    const onData = () => {
      if (exited && !settled) armIdleTimer();
    };

    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };

    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };

    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) armIdleTimer();
    };

    const onClose = (code: number | null) => {
      finalize(code);
    };

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

/**
 * Testable seam for the per-session sandbox manager. The extension creates
 * one manager per registration (upstream "isolate sandbox managers between
 * agent sessions", #84); tests replace `create` with a stub so session
 * startup does not spawn real proxies or bwrap commands.
 */
export const sandboxManagerFactory: { create: () => ISandboxManager } = {
  create: () => createSandboxManager(),
};

export interface SandboxCommandOutcome {
  /** The exact command string handed to the sandbox (violation correlation key). */
  command: string;
  /** Blocked writes the violation monitor reported for this execution. */
  blockedWrites: BlockedWrite[];
}

export function createSandboxedBashOps(
  manager: ISandboxManager,
  shellPath?: string,
  sshProxy = true,
  onCompleted?: (outcome: SandboxCommandOutcome) => void,
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);

      const { shell, args } = getShellConfig(shellPath);

      // OpenSSH does not honor ALL_PROXY, unlike most of the tools that use
      // the sandbox network proxy. Install a shell function so ordinary
      // `ssh host` commands use the runtime's local SOCKS proxy too. This is
      // deliberately opt-in at the config layer, but enabled by default.
      const socksProxyPort = sshProxy ? manager.getSocksProxyPort() : undefined;
      const sshProxyCommand =
        process.platform === "darwin" && socksProxyPort !== undefined
          ? `ssh() { /usr/bin/ssh -o 'ProxyCommand=/usr/bin/nc -X 5 -x localhost:${socksProxyPort} %h %p' "$@"; }; `
          : "";
      // The sandbox tags violation events with the wrapped input verbatim, so
      // the same string is the only reliable correlation key for the store.
      const sandboxedCommand = `${sshProxyCommand}${command}`;
      // Violations are filtered by host-side timestamps taken at exec entry,
      // so re-runs of an identical command never see each other's events.
      const startedAt = Date.now();
      const wrappedCommand = await manager.wrapWithSandbox(sandboxedCommand, shell);

      const child = spawn(shell, [...args, wrappedCommand], {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;

      const killProcessGroup = () => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };

      if (timeout !== undefined && timeout > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          killProcessGroup();
        }, timeout * 1000);
      }

      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      signal?.addEventListener("abort", killProcessGroup, { once: true });

      try {
        const exitCode = await waitForChildProcess(child);
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        if (onCompleted) {
          onCompleted({
            command: sandboxedCommand,
            blockedWrites: collectBlockedWritePaths(manager, sandboxedCommand, startedAt),
          });
        }
        return { exitCode };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", killProcessGroup);
        manager.cleanupAfterCommand();
      }
    },
  };
}
