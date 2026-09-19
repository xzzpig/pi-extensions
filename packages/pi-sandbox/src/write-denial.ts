import { dirname } from "node:path";

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
