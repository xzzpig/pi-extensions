import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { type BashOperations, getShellConfig } from "@earendil-works/pi-coding-agent";
import {
  createSandboxManager,
  type ISandboxManager,
  type SandboxRuntimeConfig,
} from "@xzzpig/sandbox-runtime";

import { type SandboxConfig } from "./config.ts";
import { canonicalizePath } from "./policy.ts";

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

const canonicalizeFilesystemPattern = (path: string) =>
  path.includes("*") ? path : canonicalizePath(path);

const canonicalizeFilesystemPatterns = (paths: string[]) =>
  unique(paths.map(canonicalizeFilesystemPattern));

/**
 * lstat-based existence: a dangling symlink has a real directory entry and
 * counts as existing (mirrors the runtime's pathEntryLstatExists semantics).
 */
function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ENOENT";
  }
}

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
  const canonicalDenyWrite = canonicalizeFilesystemPatterns(rawDenyWrite);
  const denyWrite =
    config.filesystem?.protectNonexistentFiles === false
      ? canonicalDenyWrite.filter((path) => path.includes("*") || pathEntryExists(path))
      : canonicalDenyWrite;

  return {
    network: {
      ...config.network,
      allowedDomains: effective.domains,
      deniedDomains: config.network?.deniedDomains ?? [],
    },
    filesystem: {
      disabled: config.filesystem?.disabled,
      denyRead: canonicalizeFilesystemPatterns(config.filesystem?.denyRead ?? []),
      allowRead: canonicalizeFilesystemPatterns([
        ...effective.readPaths,
        ...sandboxRuntimeReadPaths(platform),
      ]),
      allowWrite: canonicalizeFilesystemPatterns(effective.writePaths),
      denyWrite,
      protectNonexistentFiles: config.filesystem?.protectNonexistentFiles,
    },
    ignoreViolations: config.ignoreViolations,
    enableWeakerNestedSandbox: config.enableWeakerNestedSandbox,
    allowBrowserProcess: config.allowBrowserProcess,
    allowPty: config.allowPty,
    enableWeakerNetworkIsolation: true,
  };
}

export async function initializeSandbox(
  manager: ISandboxManager,
  config: SandboxConfig,
  allowances?: SessionAllowances,
): Promise<void> {
  const runtimeConfig = buildRuntimeConfig(config, allowances);
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
): void {
  // Permission updates must not tear down the proxy used by concurrent commands.
  // Network rules apply immediately; new commands pick up filesystem rules when wrapped.
  manager.updateConfig(buildRuntimeConfig(config, allowances));
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

/**
 * Degraded-mode companion to the violation monitor: when the monitor cannot
 * run (kernels without seccomp user notification — every WSL2 kernel — or a
 * failed listener), the blocked path is recovered from the command's own
 * denial text. Coverage is deliberately limited to the standard shell and
 * coreutils denial shapes; on kernels where the monitor works this never
 * executes, so narrow coverage there costs nothing.
 */
const DENIED_WRITE_PATTERNS: RegExp[] = [
  // Path before the error: "bash: line 1: /path: Read-only file system",
  // "tee: /path: Operation not permitted", "/path: Read-only file system"
  /(?:^|\n)(?:[\w@./-]+: )?(?:line \d+: )?(\/[^\s:]+): (?:operation not permitted|read-only file ?system)(?=\s|$)/i,
  // zsh puts the path last: "zsh:1: read-only file system: /path"
  /(?:^|\n)zsh:\d+: (?:operation not permitted|read-only file ?system): (\/[^\s:]+)/i,
  // dash numbers the line: "sh: 1: cannot create /path: Read-only file system"
  /(?:^|\n)sh: \d+: cannot create (\/[^\s:]+): (?:operation not permitted|read-only file ?system)/i,
  // GNU coreutils quote the path: "touch: cannot touch '/path': Read-only file system"
  /(?:^|\n)[\w.-]+: [^'\n]*'(\/[^']+)': (?:operation not permitted|read-only file ?system)/i,
  // Node's errno spelling: "Error: EROFS: read-only filesystem, open '/path'"
  /(?:^|\n)(?:[\w.]*Error: )?EROFS: read-only file ?system, [^'\n]*'(\/[^']+)'/i,
];

export function extractDeniedWritePathFromOutput(output: string): string | null {
  for (const pattern of DENIED_WRITE_PATTERNS) {
    const match = output.match(pattern);
    if (match) return match[1]!;
  }
  return null;
}

/** A write the sandbox violation monitor reported as refused for a command. */
export interface BlockedWrite {
  syscall: string;
  path: string;
}

/**
 * Blocked writes the violation monitor recorded for this exact command since
 * `sinceMs`. The monitor reports write-intent syscalls the kernel resolved to
 * absolute paths and only keeps ones bwrap would refuse, so its output does
 * not depend on how the failing tool formatted its error. Diagnostic only, as
 * upstream documents the channel: it shapes notices, never policy decisions.
 */
export function collectBlockedWritePaths(
  manager: {
    getSandboxViolationStore: () => {
      getViolationsForCommand: (command: string) => Array<{ line: string; timestamp: Date }>;
    };
  },
  command: string,
  sinceMs: number,
): BlockedWrite[] {
  const blocked: BlockedWrite[] = [];
  const seen = new Set<string>();
  for (const violation of manager.getSandboxViolationStore().getViolationsForCommand(command)) {
    if (violation.timestamp.getTime() < sinceMs) continue;
    const match = violation.line.match(/^deny\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    const path = match[2]!;
    if (seen.has(path)) continue;
    seen.add(path);
    blocked.push({ syscall: match[1]!, path });
  }
  return blocked;
}

/**
 * Degraded-mode fallback: the violation monitor is unavailable (unsupported
 * kernel, listen failure) and only the output's own denial text is left to
 * attribute the failure to the sandbox. Single substring check by design —
 * anything more specific belongs to the monitor channel.
 */
export function hasSandboxWriteDenialText(output: string): boolean {
  return /read-only file ?system|operation not permitted/i.test(output);
}

export interface SandboxWriteDenialNoticeOptions {
  /** Blocked writes the violation monitor reported for this command. */
  blockedWrites?: BlockedWrite[];
  /** A path recovered from the output itself when the monitor is unavailable. */
  outputExtractedPath?: string;
  /** The permission prompt for this path was dismissed or timed out. */
  promptDeclinedPath?: string;
  /** Every blocked path is explicitly denied by denyWrite; retrying is futile. */
  allDeniedByConfig?: boolean;
  /** The path was allowed for the session but the retry still failed. */
  allowedStillFailingPath?: string;
}

/**
 * Agent-facing explanation appended to a sandboxed command whose write the OS
 * denied. The kernel error reads like a real disk problem; without this note
 * the agent misdiagnoses sandbox refusals as filesystem failures.
 */
export function sandboxWriteDenialNotice(options: SandboxWriteDenialNoticeOptions = {}): string {
  const base =
    "[pi-sandbox] This error was caused by the OS-level sandbox, not by the filesystem: " +
    "the sandbox mounts everything outside its allowWrite paths read-only, so a blocked write " +
    'surfaces as the kernel\'s "Read-only file system" (or "Operation not permitted") error. ' +
    "Do not diagnose this as a broken or read-only disk.";
  const denied = options.blockedWrites ?? [];
  const listing =
    options.outputExtractedPath !== undefined
      ? `Blocked path: "${options.outputExtractedPath}".`
      : denied.length > 0
        ? `Blocked write${denied.length === 1 ? "" : "s"}:\n${denied
            .map((write) => `  deny ${write.syscall} ${write.path}`)
            .join("\n")}`
        : "The write target is outside this session's allowWrite paths.";
  let guidance: string;
  if (options.allowedStillFailingPath !== undefined) {
    const parent = dirname(options.allowedStillFailingPath);
    guidance =
      `"${options.allowedStillFailingPath}" was allowed for this session but the write still fails: ` +
      "the sandbox can only mount write access for paths that already exist. " +
      `Allow the existing parent directory instead (e.g. "/sandbox-allow write ${parent}"), ` +
      "or write to a path already in allowWrite.";
  } else if (options.promptDeclinedPath !== undefined) {
    guidance =
      `The permission prompt for "${options.promptDeclinedPath}" was dismissed or timed out, so ` +
      "it stays blocked for now; do not retry the same write unprompted — ask the user, " +
      "or write to a path already in allowWrite.";
  } else if (options.allDeniedByConfig) {
    guidance =
      "These paths are explicitly denied by the sandbox's denyWrite config, so retrying the " +
      "same write will keep failing; remove the denyWrite entry to allow them " +
      "(run /sandbox to see the configuration).";
  } else {
    guidance =
      'To proceed, allow a path with "/sandbox-allow write <path>" (or ask the user to), ' +
      "or write to a path already in allowWrite.";
  }
  return `${base}\n${listing}\n${guidance}`;
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
