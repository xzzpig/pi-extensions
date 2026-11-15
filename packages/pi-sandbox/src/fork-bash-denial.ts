/**
 * Fork-only sandboxed-bash write-denial handling for pi-sandbox.
 *
 * Why this file exists: after a sandboxed bash run, the fork attributes a
 * blocked write to a path (seccomp violation monitor first, kernel denial text
 * as the fallback), offers the permission prompt for paths that are not
 * `denyWrite`, grants a one-shot retry and otherwise explains the failure. That
 * block was the largest fork region left in the upstream `src/extension.ts`;
 * it only needs the state accessors passed in `deps`, so it lives here and the
 * upstream wrapper keeps one call per attempt.
 *
 * The retry path is deliberately single-shot per tool call: on Linux, bwrap
 * cannot mount write access for a path that does not exist yet, so retrying the
 * same newly granted path fails identically and would loop forever.
 */

import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { SandboxConfig } from "./config.ts";
import { withToolAbortSignal } from "./fork-prompt-signal.ts";
import { canonicalizePath, matchesPattern, resolveWritePermission } from "./policy.ts";
import { promptWriteBlock, type PermissionPromptResult } from "./ui.ts";
import {
  extractBlockedWritePath,
  extractDeniedWritePathFromOutput,
  hasSandboxWriteDenialText,
  type BlockedWrite,
  type SandboxWriteDenialNoticeOptions,
} from "./write-denial.ts";

export interface SandboxWriteDenialDeps<T> {
  /** Extension API used for the permission prompt. */
  pi: Parameters<typeof promptWriteBlock>[0];
  /** Resolve the effective sandbox config for the session cwd. */
  resolveConfig(cwd: string): SandboxConfig;
  /** Record a failed profile/config initialization (flips sandbox state off). */
  recordStartupFailure(error: unknown, ctx?: ExtensionContext): void;
  /** Why the selected profile blocks all commands, if it does. */
  blockReason(): string | undefined;
  /** Prefix a reason with the profile label when one is selected. */
  scopeReason(reason: string): string;
  /** Effective writable paths for the session. */
  effectiveWritePaths(cwd: string): string[];
  /** Persist a granted/denied write permission for the session. */
  saveWriteChoice(
    choice: Exclude<PermissionPromptResult["action"], "abort">,
    value: string,
    cwd: string,
  ): Promise<void>;
  /** Re-initialize the manager after a new path was granted. */
  refresh(cwd: string): Promise<void>;
  /** Append the sandbox attribution block to a result. */
  decorate(result: T, options: SandboxWriteDenialNoticeOptions): T;
  /** Build the "blocked before execution" result. */
  blockedResult(reason: string): T;
}

export interface SandboxWriteDenialInput<T> {
  result: T;
  /** Combined text content of the attempt's result. */
  output: string;
  /** Writes the violation monitor reported for this attempt. */
  blockedWrites: BlockedWrite[];
  ctx: ExtensionContext;
  signal: AbortSignal | undefined;
  onUpdate?: (update: AgentToolResult<Record<string, never>>) => void;
  /** Canonical paths already retried within this tool call. */
  retriedPaths: Set<string>;
  /** Re-run the bash attempt (single recursion per granted path). */
  retry: () => Promise<T>;
}

/**
 * Attribute and handle a sandbox write denial; returns the result to hand back
 * to the tool call.
 */
export async function handleSandboxWriteDenial<T>(
  input: SandboxWriteDenialInput<T>,
  deps: SandboxWriteDenialDeps<T>,
): Promise<T> {
  const { result, output, blockedWrites, ctx, signal, onUpdate, retriedPaths, retry } = input;
  // The violation monitor is primary; when it is unavailable (kernels without
  // seccomp user notification, e.g. WSL2) recover the path from the output's
  // own denial text, upstream's macOS shape first.
  const outputExtractedPath =
    blockedWrites.length === 0
      ? (extractBlockedWritePath(output) ?? extractDeniedWritePathFromOutput(output))
      : null;
  if (blockedWrites.length === 0 && outputExtractedPath === null) {
    // Degraded mode with an unrecognized denial format: attribute it to the
    // sandbox without a path, so the agent never misreads EROFS.
    if (hasSandboxWriteDenialText(output)) {
      return deps.decorate(result, {});
    }
    return result;
  }

  let config: SandboxConfig;
  try {
    config = deps.resolveConfig(ctx.cwd);
  } catch (error) {
    deps.recordStartupFailure(error, ctx);
    return deps.blockedResult(
      deps.blockReason() ?? deps.scopeReason("sandbox configuration could not be loaded."),
    );
  }
  const denyWrite = config.filesystem?.denyWrite ?? [];
  const pathIsDeniedByConfig = (path: string) => matchesPattern(path, denyWrite, ctx.cwd);
  // denyWrite paths are never prompted; pick the first promptable one and let
  // the notice name the explicitly denied ones.
  const promptablePath =
    blockedWrites.length > 0
      ? blockedWrites.find((write) => !pathIsDeniedByConfig(write.path))?.path
      : (outputExtractedPath ?? undefined);

  const denialNoticeOptions: SandboxWriteDenialNoticeOptions = {
    blockedWrites: blockedWrites.length > 0 ? blockedWrites : undefined,
    outputExtractedPath: outputExtractedPath ?? undefined,
  };

  if (promptablePath !== undefined && ctx?.hasUI) {
    const path = canonicalizePath(promptablePath, ctx.cwd);
    const writePermission = await resolveWritePermission({
      path,
      allowWrite: deps.effectiveWritePaths(ctx.cwd),
      denyWrite,
      baseCwd: ctx.cwd,
      prompt: (path) =>
        promptWriteBlock(deps.pi, withToolAbortSignal(ctx, signal), path, config.permissionPromptTimeoutSeconds),
      saveWritePermission: (choice, value) => deps.saveWriteChoice(choice, value, ctx.cwd),
    });
    if (writePermission.action === "allow" || writePermission.action === "granted") {
      // A path can only be retried once per tool call: on Linux, bwrap cannot
      // mount write access for paths that do not exist yet, so a retry after
      // granting a new file's path fails identically and would loop forever.
      if (retriedPaths.has(path)) {
        return deps.decorate(result, { ...denialNoticeOptions, allowedStillFailingPath: path });
      }
      retriedPaths.add(path);
      await deps.refresh(ctx.cwd);
      if (writePermission.action === "granted") {
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `\n--- Write access granted for "${writePermission.value}", retrying ---\n`,
            },
          ],
          details: {},
        });
      }
      return retry();
    }
    if (writePermission.action === "deny") {
      return deps.decorate(result, { ...denialNoticeOptions, allDeniedByConfig: true });
    }
    return deps.decorate(result, { ...denialNoticeOptions, promptDeclinedPath: path });
  }

  return deps.decorate(result, {
    ...denialNoticeOptions,
    allDeniedByConfig:
      blockedWrites.length > 0 && promptablePath === undefined ? true : undefined,
  });
}
