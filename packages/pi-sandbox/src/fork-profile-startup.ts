/**
 * Fork-only profile startup helpers for pi-sandbox.
 *
 * Why this file exists: the profile launch path (startup acknowledgement file,
 * startup diagnostics, one-shot warnings, trust resolution and the "profile
 * could not initialize" state) is fork-only behaviour that used to sit in the
 * upstream `src/extension.ts` factory — the largest single fork block left in
 * that file. It only needs a small, explicit set of state accessors, so it
 * lives here and the upstream file keeps one factory call.
 *
 * The launcher passes the acknowledgement path/token and the trust flag through
 * the environment for the child-session creation window only and restores them
 * right after, so every launch value is captured once at construction.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { SandboxConfig } from "./config.ts";

import { isDeviceConfigError } from "./fork-devices.ts";

export const SANDBOX_STARTUP_ACK_PATH_ENV = "PI_SUBAGENT_SANDBOX_STARTUP_ACK_PATH";
export const SANDBOX_STARTUP_ACK_TOKEN_ENV = "PI_SUBAGENT_SANDBOX_STARTUP_ACK_TOKEN";
export const PROJECT_TRUST_ENV = "PI_SUBAGENT_SANDBOX_PROJECT_TRUSTED";
export const IN_PROCESS_CHILD_ENV = "PI_SUBAGENT_SANDBOX_IN_PROCESS_CHILD";
export const SANDBOX_DIAGNOSTICS_PATH_ENV = "PI_SUBAGENT_SANDBOX_DIAGNOSTICS_PATH";

export interface ProfileStartupDeps {
  /** Profile selected for this session (env or in-process service). */
  selectedProfile(): string | undefined;
  deviceAccessRequested?(): boolean;
  /** Current startup error, if the profile failed to initialize. */
  startupError(): string | undefined;
  setStartupError(error: string | undefined): void;
  /** True once the sandbox manager finished initializing for this session. */
  sandboxInitialized(): boolean;
  /** Mark the sandbox unusable after a failed initialization. */
  setSandboxUnavailable(): void;
  /** Trust already resolved for this session. */
  profileTrusted(): boolean;
  /** Session context that owns the status line (may be unset). */
  lastStatusContext(): ExtensionContext | undefined;
  notifySafely(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void;
}

export interface ProfileStartupHelpers {
  writeProfileStartupAcknowledgement(): void;
  profileLabel(): string;
  profileBlockReason(): string | undefined;
  profileScopedReason(reason: string): string;
  writeSandboxDiagnostic(message: string): void;
  resolvedProfileTrust(ctx?: ExtensionContext): boolean;
  reportProfileWarning(warning: string): void;
  /** Pin the context used for one-shot warnings (set at session_start). */
  setProfileWarningContext(ctx: ExtensionContext | undefined): void;
  writeStartupFailureDiagnostic(reason: string): void;
  recordProfileStartupFailure(error: unknown, ctx?: ExtensionContext): void;
  recordSandboxInitializationFailure(
    error: unknown,
    config: SandboxConfig,
    ctx: ExtensionContext,
  ): void;
}

export function createProfileStartupHelpers(deps: ProfileStartupDeps): ProfileStartupHelpers {
  const acknowledgementPath = process.env[SANDBOX_STARTUP_ACK_PATH_ENV];
  const acknowledgementToken = process.env[SANDBOX_STARTUP_ACK_TOKEN_ENV];
  const inheritedProjectTrust = process.env[PROJECT_TRUST_ENV];
  const startupDiagnosticsPath = process.env[SANDBOX_DIAGNOSTICS_PATH_ENV];

  const profileLabel = (): string =>
    deps.selectedProfile() ? `Sandbox profile '${deps.selectedProfile()}'` : "Sandbox";

  const writeSandboxDiagnostic = (message: string): void => {
    process.stderr.write(`pi-sandbox: ${message}\n`);
  };

  const writeProfileStartupAcknowledgement = (): void => {
    if (!deps.selectedProfile()) return;
    if (acknowledgementPath === undefined && acknowledgementToken === undefined) return;
    if (!acknowledgementPath || !acknowledgementToken) {
      throw new Error("sandbox profile startup acknowledgement channel is incomplete.");
    }
    writeFileSync(
      acknowledgementPath,
      JSON.stringify({ version: 1, profile: deps.selectedProfile(), token: acknowledgementToken }),
      { mode: 0o600 },
    );
  };

  const profileBlockReason = (): string | undefined =>
    deps.startupError() ??
    (deps.selectedProfile() && !deps.sandboxInitialized()
      ? `${profileLabel()} is required but was not initialized.`
      : undefined);

  // Non-fatal profile notices (#project-profiles) are reported once per
  // message: an untrusted project's registry is skipped on every config
  // resolution, but the notice describes the session's policy, not each call.
  const reportedProfileWarnings = new Set<string>();
  let profileWarningContext: ExtensionContext | undefined;

  /**
   * Surface a non-fatal profile notice.
   *
   * A warning never blocks or fails a session. It goes to stderr, to the UI
   * when a session has one, and — for a headless child — into the startup
   * diagnostics file the launcher hands it, so the skipped project profiles are
   * visible instead of a silent change of effective policy.
   */
  const reportProfileWarning = (warning: string): void => {
    if (reportedProfileWarnings.has(warning)) return;
    reportedProfileWarnings.add(warning);
    writeSandboxDiagnostic(warning);
    const target = profileWarningContext ?? deps.lastStatusContext();
    if (target) deps.notifySafely(target, warning, "warning");
    if (!startupDiagnosticsPath || !deps.selectedProfile() || deps.startupError()) return;
    try {
      mkdirSync(dirname(startupDiagnosticsPath), { recursive: true, mode: 0o700 });
      writeFileSync(
        startupDiagnosticsPath,
        JSON.stringify({ version: 1, profile: deps.selectedProfile(), warnings: [warning] }),
        { mode: 0o600 },
      );
    } catch {
      // The stderr diagnostic above remains the fallback channel.
    }
  };

  /**
   * Publish the failure for the launcher: a blocked child ends before its first
   * model turn, so the parent otherwise only sees an empty session and cannot
   * report why the profile was refused.
   */
  const writeStartupFailureDiagnostic = (reason: string): void => {
    if (!startupDiagnosticsPath || !deps.selectedProfile()) return;
    try {
      mkdirSync(dirname(startupDiagnosticsPath), { recursive: true, mode: 0o700 });
      writeFileSync(
        startupDiagnosticsPath,
        JSON.stringify({ version: 1, profile: deps.selectedProfile(), reason }),
        { mode: 0o600 },
      );
    } catch {
      // The stderr diagnostic above remains the fallback channel.
    }
  };

  const recordProfileStartupFailure = (error: unknown, ctx?: ExtensionContext): void => {
    const detail = error instanceof Error ? error.message : String(error);
    // applySandboxConfigChange may already have reset the manager before the
    // failure, so the sandbox is unusable whether or not a profile is
    // selected. Marking it unavailable in both cases keeps the status line
    // honest instead of reporting an enabled sandbox with a reset manager.
    deps.setSandboxUnavailable();
    if (!deps.selectedProfile() && !deps.deviceAccessRequested?.() && !isDeviceConfigError(error))
      return;
    const message = `${profileLabel()} could not initialize: ${detail}`;
    deps.setStartupError(message);
    writeSandboxDiagnostic(message);
    writeStartupFailureDiagnostic(message);
    if (ctx) deps.notifySafely(ctx, message, "error");
  };

  return {
    writeProfileStartupAcknowledgement,
    profileLabel,
    profileBlockReason,
    profileScopedReason: (reason: string): string =>
      deps.selectedProfile() ? `${profileLabel()}: ${reason}` : reason,
    writeSandboxDiagnostic,
    resolvedProfileTrust: (ctx?: ExtensionContext): boolean => {
      const inherited = inheritedProjectTrust;
      if (inherited !== undefined) return inherited === "1";
      return ctx ? ctx.isProjectTrusted() : deps.profileTrusted();
    },
    reportProfileWarning,
    setProfileWarningContext: (ctx: ExtensionContext | undefined): void => {
      profileWarningContext = ctx;
    },
    writeStartupFailureDiagnostic,
    recordProfileStartupFailure,
    recordSandboxInitializationFailure: (error, config, ctx): void => {
      if (deps.selectedProfile() || config.filesystem?.allowDevices !== undefined) {
        recordProfileStartupFailure(
          config.filesystem?.allowDevices !== undefined
            ? new Error(
                `filesystem.allowDevices: ${error instanceof Error ? error.message : error}`,
              )
            : error,
          ctx,
        );
      } else {
        const message = `Sandbox initialization failed: ${error instanceof Error ? error.message : error}`;
        writeSandboxDiagnostic(message);
        deps.notifySafely(ctx, message, "error");
      }
    },
  };
}
