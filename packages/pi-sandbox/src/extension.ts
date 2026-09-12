import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  isToolCallEventType,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { SandboxManager } from "@xzzpig/sandbox-runtime";

import {
  addDomainToConfig,
  addReadPathToConfig,
  addWritePathToConfig,
  getConfigPaths,
  listGlobalSandboxProfiles,
  loadConfig,
  SANDBOX_PROFILE_ENV,
  type SandboxConfig,
} from "./config.ts";
import {
  canonicalizePath,
  domainIsAllowed,
  extractDomainsFromCommand,
  isNetworkUnrestricted,
  matchesPattern,
  resolveWritePermission,
} from "./policy.ts";
import {
  createSandboxedBashOps,
  extractBlockedWritePath,
  initializeSandbox,
  reinitializeSandbox,
  resolveAllowances,
  type SessionAllowances,
  supportsNodeEnvProxy,
} from "./sandbox-runtime.ts";
import {
  registerSandboxService,
  type SandboxProfileSelectionResult,
  type SandboxService,
} from "./service.ts";
import { maybeDecorateBashForToolDisplay } from "./tool-display-decoration.ts";

const SANDBOX_STARTUP_ACK_PATH_ENV = "PI_SUBAGENT_SANDBOX_STARTUP_ACK_PATH";
const SANDBOX_STARTUP_ACK_TOKEN_ENV = "PI_SUBAGENT_SANDBOX_STARTUP_ACK_TOKEN";
const PROJECT_TRUST_ENV = "PI_SUBAGENT_SANDBOX_PROJECT_TRUSTED";
const IN_PROCESS_CHILD_ENV = "PI_SUBAGENT_SANDBOX_IN_PROCESS_CHILD";
const SANDBOX_DIAGNOSTICS_PATH_ENV = "PI_SUBAGENT_SANDBOX_DIAGNOSTICS_PATH";

import {
  formatSandboxConfiguration,
  formatSandboxStatus,
  type PermissionPromptResult,
  promptDomainBlock,
  promptReadBlock,
  showPermissionPrompt,
  promptWriteBlock,
  warnIfAllDomainsAllowed,
} from "./ui.ts";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("no-sandbox", {
    description: "Disable OS-level sandboxing for bash commands",
    type: "boolean",
    default: false,
  });

  const localCwd = process.cwd();
  const userShellPath = SettingsManager.create(localCwd).getShellPath();
  const localBash = createBashToolDefinition(localCwd, { shellPath: userShellPath });

  let sandboxEnabled = false;
  let sandboxInitialized = false;
  // Not a constant: an in-process extension can select a profile for the live
  // session through the SandboxService, exactly like a child launch selects one
  // from the environment before the session starts.
  let selectedSandboxProfile = process.env[SANDBOX_PROFILE_ENV];
  // The launcher applies the sandbox launch keys for the child-session creation
  // window only and restores them right after, so every launch value must be
  // captured here at registration instead of being read later from session_start.
  const startupAcknowledgementPath = process.env[SANDBOX_STARTUP_ACK_PATH_ENV];
  const startupAcknowledgementToken = process.env[SANDBOX_STARTUP_ACK_TOKEN_ENV];
  const inheritedProjectTrust = process.env[PROJECT_TRUST_ENV];
  const startupDiagnosticsPath = process.env[SANDBOX_DIAGNOSTICS_PATH_ENV];
  // An in-process child shares the host process, so it must never mutate host
  // state that only a standalone child process may own.
  const inProcessChild = process.env[IN_PROCESS_CHILD_ENV] === "1";
  let profileProjectTrusted = false;
  let profileStartupError: string | undefined;
  const allowances: SessionAllowances = { domains: [], readPaths: [], writePaths: [] };

  const profileLabel = () =>
    selectedSandboxProfile ? `Sandbox profile '${selectedSandboxProfile}'` : "Sandbox";

  const writeProfileStartupAcknowledgement = (): void => {
    if (!selectedSandboxProfile) return;
    const acknowledgementPath = startupAcknowledgementPath;
    const token = startupAcknowledgementToken;
    if (acknowledgementPath === undefined && token === undefined) return;
    if (!acknowledgementPath || !token) {
      throw new Error("sandbox profile startup acknowledgement channel is incomplete.");
    }
    writeFileSync(
      acknowledgementPath,
      JSON.stringify({ version: 1, profile: selectedSandboxProfile, token }),
      { mode: 0o600 },
    );
  };

  const profileBlockReason = () =>
    profileStartupError ??
    (selectedSandboxProfile && !sandboxInitialized
      ? `${profileLabel()} is required but was not initialized.`
      : undefined);

  const profileScopedReason = (reason: string) =>
    selectedSandboxProfile ? `${profileLabel()}: ${reason}` : reason;

  const writeSandboxDiagnostic = (message: string): void => {
    process.stderr.write(`pi-sandbox: ${message}\n`);
  };

  // Notifications are cosmetic. A headless child session (print/json mode) has no
  // UI, and a failing notification must never change sandbox behavior.
  const notifySafely = (
    ctx: ExtensionContext,
    message: string,
    type: "info" | "warning" | "error",
  ): void => {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.notify(message, type);
    } catch {
      // Ignore cosmetic notification failures.
    }
  };

  const blockedSandboxResult = (reason: string): AgentToolResult<Record<string, never>> => ({
    content: [{ type: "text", text: `Error: ${reason}` }],
    details: {},
  });

  const resolvedProfileTrust = (ctx?: ExtensionContext): boolean => {
    if (!selectedSandboxProfile) return true;
    // Trust is resolved once at session_start from the launch env window (or
    // the host context) and then fixed for the session; the launcher restores
    // the transient trust env after the child session is created.
    const inherited = inheritedProjectTrust;
    if (inherited !== undefined) return inherited === "1";
    return ctx ? ctx.isProjectTrusted() : profileProjectTrusted;
  };

  const resolveSandboxConfig = (cwd: string): SandboxConfig => {
    if (!selectedSandboxProfile) return loadConfig(cwd);
    return loadConfig(cwd, {
      profileName: selectedSandboxProfile,
      projectTrusted: profileProjectTrusted,
    });
  };

  /**
   * Publish the failure for the launcher: a blocked child ends before its first
   * model turn, so the parent otherwise only sees an empty session and cannot
   * report why the profile was refused.
   */
  const writeStartupFailureDiagnostic = (reason: string): void => {
    if (!startupDiagnosticsPath || !selectedSandboxProfile) return;
    try {
      mkdirSync(dirname(startupDiagnosticsPath), { recursive: true, mode: 0o700 });
      writeFileSync(
        startupDiagnosticsPath,
        JSON.stringify({ version: 1, profile: selectedSandboxProfile, reason }),
        { mode: 0o600 },
      );
    } catch {
      // The stderr diagnostic above remains the fallback channel.
    }
  };

  const recordProfileStartupFailure = (error: unknown, ctx?: ExtensionContext): void => {
    if (!selectedSandboxProfile) return;
    const detail = error instanceof Error ? error.message : String(error);
    profileStartupError = `${profileLabel()} could not initialize: ${detail}`;
    sandboxEnabled = false;
    sandboxInitialized = false;
    writeSandboxDiagnostic(profileStartupError);
    writeStartupFailureDiagnostic(profileStartupError);
    if (ctx) notifySafely(ctx, profileStartupError, "error");
  };

  const effectiveAllowances = (cwd: string) =>
    resolveAllowances(resolveSandboxConfig(cwd), allowances);
  const effectiveDomains = (cwd: string) => effectiveAllowances(cwd).domains;
  const effectiveReadPaths = (cwd: string) => effectiveAllowances(cwd).readPaths;
  const effectiveWritePaths = (cwd: string) => effectiveAllowances(cwd).writePaths;

  async function refreshSandbox(cwd: string): Promise<void> {
    if (!sandboxInitialized) return;
    try {
      await reinitializeSandbox(resolveSandboxConfig(cwd), allowances);
    } catch (error) {
      recordProfileStartupFailure(error);
      if (selectedSandboxProfile) {
        throw new Error(
          profileBlockReason() ?? profileScopedReason("sandbox reinitialization failed."),
        );
      }
      writeSandboxDiagnostic(`Warning: Failed to reinitialize sandbox: ${error}`);
    }
  }

  let disposeSandboxService: (() => void) | undefined;
  // The session context that owns the status line, kept so a change made through
  // the service (which has no ctx of its own) can re-render it.
  let lastStatusContext: Parameters<typeof warnIfAllDomainsAllowed>[0] | undefined;

  // In-process extensions (a session role picker, for example) select a profile
  // by name through this service. Names only: the runtime resolves the name
  // against the same global registry a child launch uses, so no raw sandbox
  // configuration ever crosses the extension boundary.
  const sandboxService: SandboxService = {
    setProfile: async (profileName): Promise<SandboxProfileSelectionResult> => {
      if (profileName !== undefined) {
        try {
          // Validate before touching state: a rejected selection must leave the
          // session exactly as it was.
          loadConfig(localCwd, { profileName, projectTrusted: profileProjectTrusted });
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
      }
      const previousProfile = selectedSandboxProfile;
      selectedSandboxProfile = profileName;
      refreshStatus();
      if (!sandboxInitialized) {
        // The sandbox switch stays user-controlled: selecting a profile applies
        // the configuration but never forces isolation on by itself.
        return {
          ok: true,
          message:
            profileName === undefined
              ? "Sandbox profile cleared, but the sandbox is not enabled for this session, so no isolation is active."
              : `Sandbox profile '${profileName}' is selected, but the sandbox is not enabled for this session, so no isolation is active.`,
        };
      }
      try {
        await refreshSandbox(localCwd);
      } catch (error) {
        // Nothing changed: the profile was never applied, so the selection goes
        // back to the one the session was actually running. The recorded startup
        // failure keeps the session fail-closed until the sandbox recovers, so
        // this revert cannot re-open a looser policy.
        selectedSandboxProfile = previousProfile;
        refreshStatus();
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      return { ok: true };
    },
    getProfile: () => selectedSandboxProfile,
    listProfiles: () => listGlobalSandboxProfiles(localCwd),
  };

  async function applyChoice(
    choice: Exclude<PermissionPromptResult["action"], "abort">,
    kind: "domain" | "read" | "write",
    value: string,
    cwd: string,
  ): Promise<void> {
    const { globalPath, projectPath } = getConfigPaths(cwd);
    const target = choice === "project" ? projectPath : globalPath;

    if (kind === "domain") {
      if (!allowances.domains.includes(value)) allowances.domains.push(value);
      if (choice !== "session") addDomainToConfig(target, value);
    } else if (kind === "read") {
      if (!allowances.readPaths.includes(value)) allowances.readPaths.push(value);
      if (choice !== "session") addReadPathToConfig(target, value);
    } else {
      if (!allowances.writePaths.includes(value)) allowances.writePaths.push(value);
      if (choice !== "session") addWritePathToConfig(target, value);
    }
    await refreshSandbox(cwd);
    refreshStatus();
  }

  function updateStatus(
    ctx: Parameters<typeof warnIfAllDomainsAllowed>[0],
    config: ReturnType<typeof loadConfig>,
  ) {
    // Status rendering needs the TUI theme; headless child sessions (print/json)
    // have no initialized theme, and a cosmetic failure must never fail a launch.
    if (ctx.mode !== "tui") return;
    const status = selectedSandboxProfile
      ? `${formatSandboxStatus(config)} (${selectedSandboxProfile})`
      : formatSandboxStatus(config);
    try {
      ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", status));
    } catch {
      // Ignore cosmetic status failures.
    }
  }

  /**
   * Re-render the status line from the *effective* configuration.
   *
   * The status reports what the session is actually running under, so it must be
   * recomputed whenever the selection changes — otherwise a session that just
   * picked a profile keeps advertising the previous policy's write paths.
   */
  function refreshStatus(ctx?: Parameters<typeof warnIfAllDomainsAllowed>[0]): void {
    const target = ctx ?? lastStatusContext;
    if (!target) return;
    let config: SandboxConfig;
    try {
      config = resolveSandboxConfig(target.cwd);
    } catch {
      // The failure path already surfaced the real reason; a stale status line
      // must not become the only signal.
      return;
    }
    updateStatus(target, config);
  }

  async function enableSandbox(
    ctx: Parameters<typeof warnIfAllDomainsAllowed>[0],
    setProxyEnvironment: boolean,
  ): Promise<boolean> {
    if (sandboxEnabled) {
      notifySafely(ctx, "Sandbox is already enabled", "info");
      return false;
    }

    let config: SandboxConfig;
    try {
      config = resolveSandboxConfig(ctx.cwd);
    } catch (error) {
      recordProfileStartupFailure(error, ctx);
      return false;
    }
    const platform = process.platform;
    if (platform !== "darwin" && platform !== "linux") {
      const message = `Sandbox not supported on ${platform}`;
      if (selectedSandboxProfile) recordProfileStartupFailure(message, ctx);
      else ctx.ui.notify(message, "warning");
      return false;
    }

    try {
      await initializeSandbox(config, allowances);
      writeProfileStartupAcknowledgement();
      if (
        setProxyEnvironment &&
        !isNetworkUnrestricted(config) &&
        supportsNodeEnvProxy(process.versions.node)
      ) {
        process.env.NODE_USE_ENV_PROXY ??= "1";
      }
      sandboxEnabled = true;
      sandboxInitialized = true;
    } catch (error) {
      sandboxEnabled = false;
      if (selectedSandboxProfile) {
        recordProfileStartupFailure(error, ctx);
      } else {
        const message = `Sandbox initialization failed: ${error instanceof Error ? error.message : error}`;
        writeSandboxDiagnostic(message);
        notifySafely(ctx, message, "error");
      }
      return false;
    }
    // Cosmetic UI runs only after the sandbox state is committed, so a missing
    // theme or a failing notification can never invalidate a working sandbox.
    warnIfAllDomainsAllowed(ctx, config);
    lastStatusContext = ctx;
    updateStatus(ctx, config);
    return true;
  }

  async function disableSandbox(
    ctx: Parameters<typeof warnIfAllDomainsAllowed>[0],
  ): Promise<boolean> {
    if (selectedSandboxProfile) {
      notifySafely(
        ctx,
        `${profileLabel()} is required for this child and cannot be disabled.`,
        "error",
      );
      return false;
    }
    if (!sandboxEnabled) {
      notifySafely(ctx, "Sandbox is already disabled", "info");
      return false;
    }

    if (sandboxInitialized) {
      try {
        await SandboxManager.reset();
      } catch {
        // Ignore cleanup errors.
      }
    }
    sandboxEnabled = false;
    sandboxInitialized = false;
    if (ctx.mode === "tui") {
      try {
        ctx.ui.setStatus("sandbox", "");
      } catch {
        // Ignore cosmetic status failures.
      }
    }
    return true;
  }

  async function toggleSandbox(ctx: Parameters<typeof warnIfAllDomainsAllowed>[0]): Promise<void> {
    if (sandboxEnabled) {
      if (await disableSandbox(ctx)) notifySafely(ctx, "Sandbox disabled", "info");
      return;
    }
    if (await enableSandbox(ctx, false)) notifySafely(ctx, "Sandbox enabled", "info");
  }

  const bashTool = {
    ...localBash,
    label: "bash (sandboxed)",
    async execute(
      id: Parameters<typeof localBash.execute>[0],
      params: Parameters<typeof localBash.execute>[1],
      signal: Parameters<typeof localBash.execute>[2],
      onUpdate: Parameters<typeof localBash.execute>[3],
      ctx: Parameters<typeof localBash.execute>[4],
    ) {
      const runBash = () => {
        const profileFailure = profileBlockReason();
        if (profileFailure) return Promise.resolve(blockedSandboxResult(profileFailure));
        if (!sandboxEnabled || !sandboxInitialized) {
          return localBash.execute(id, params, signal, onUpdate, ctx);
        }
        let config: SandboxConfig;
        try {
          config = resolveSandboxConfig(ctx.cwd);
        } catch (error) {
          recordProfileStartupFailure(error, ctx);
          return Promise.resolve(
            blockedSandboxResult(
              profileBlockReason() ??
                profileScopedReason("sandbox configuration could not be loaded."),
            ),
          );
        }
        return createBashToolDefinition(localCwd, {
          operations: createSandboxedBashOps(userShellPath, config.network?.sshProxy !== false),
          shellPath: userShellPath,
        }).execute(id, params, signal, onUpdate, ctx);
      };

      let result: Awaited<ReturnType<typeof localBash.execute>>;
      try {
        result = await runBash();
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("Operation not permitted")) {
          throw error;
        }
        result = {
          content: [
            {
              type: "text",
              text: `Error: Command failed with OS-level sandbox restriction: ${error.message}`,
            },
          ],
          details: {},
        };
      }

      if (sandboxEnabled && sandboxInitialized && ctx?.hasUI) {
        const output = result.content
          .filter((content) => content.type === "text")
          .map((content) => content.text)
          .join("\n");
        const blockedPath = extractBlockedWritePath(output);

        if (blockedPath) {
          const path = canonicalizePath(blockedPath);
          let config: SandboxConfig;
          try {
            config = resolveSandboxConfig(ctx.cwd);
          } catch (error) {
            recordProfileStartupFailure(error, ctx);
            return blockedSandboxResult(
              profileBlockReason() ??
                profileScopedReason("sandbox configuration could not be loaded."),
            );
          }
          const writePermission = await resolveWritePermission({
            path,
            allowWrite: effectiveWritePaths(ctx.cwd),
            denyWrite: config.filesystem?.denyWrite ?? [],
            prompt: (path) =>
              promptWriteBlock(pi, ctx, path, config.permissionPromptTimeoutSeconds),
            saveWritePermission: (choice, value) => applyChoice(choice, "write", value, ctx.cwd),
          });
          if (writePermission.action === "deny") {
            return result;
          }
          if (writePermission.action === "allow") {
            await refreshSandbox(ctx.cwd);
            return runBash();
          }
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
            return runBash();
          }
        }
      }
      return result;
    },
  };
  pi.registerTool(bashTool);
  void maybeDecorateBashForToolDisplay(bashTool);

  pi.on("user_bash", async (event, ctx) => {
    const startupFailure = profileBlockReason();
    if (startupFailure) {
      return {
        result: {
          output: startupFailure,
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }
    if (!sandboxEnabled || !sandboxInitialized) return;

    let config: SandboxConfig;
    try {
      config = resolveSandboxConfig(ctx.cwd);
    } catch (error) {
      recordProfileStartupFailure(error, ctx);
      return {
        result: {
          output:
            profileBlockReason() ??
            profileScopedReason("sandbox configuration could not be loaded."),
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }
    if (config.sandboxUserShell === false) return;
    if (!isNetworkUnrestricted(config)) {
      for (const domain of extractDomainsFromCommand(event.command)) {
        if (!domainIsAllowed(domain, effectiveDomains(ctx.cwd))) {
          const choice = await promptDomainBlock(
            pi,
            ctx,
            domain,
            config.permissionPromptTimeoutSeconds,
          );
          if (choice.action === "abort") {
            return {
              result: {
                output: `Blocked: ${profileScopedReason(`network access to "${domain}" is not in allowedDomains.`)}`,
                exitCode: 1,
                cancelled: false,
                truncated: false,
              },
            };
          }
          await applyChoice(choice.action, "domain", choice.value, ctx.cwd);
        }
      }
    }
    return {
      operations: createSandboxedBashOps(userShellPath, config.network?.sshProxy !== false),
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    const startupFailure = profileBlockReason();
    if (startupFailure) return { block: true, reason: startupFailure };
    if (!sandboxEnabled) return;
    let config: SandboxConfig;
    try {
      config = resolveSandboxConfig(ctx.cwd);
    } catch (error) {
      recordProfileStartupFailure(error, ctx);
      return {
        block: true,
        reason:
          profileBlockReason() ?? profileScopedReason("sandbox configuration could not be loaded."),
      };
    }
    if (!config.enabled) return;
    const { projectPath, globalPath } = getConfigPaths(ctx.cwd);

    if (
      sandboxInitialized &&
      isToolCallEventType("bash", event) &&
      !isNetworkUnrestricted(config)
    ) {
      for (const domain of extractDomainsFromCommand(event.input.command)) {
        if (!domainIsAllowed(domain, effectiveDomains(ctx.cwd))) {
          const choice = await promptDomainBlock(
            pi,
            ctx,
            domain,
            config.permissionPromptTimeoutSeconds,
          );
          if (choice.action === "abort") {
            return {
              block: true,
              reason: profileScopedReason(
                `Network access to "${domain}" is blocked (not in allowedDomains).`,
              ),
            };
          }
          await applyChoice(choice.action, "domain", choice.value, ctx.cwd);
        }
      }
    }

    if (isToolCallEventType("read", event)) {
      const path = canonicalizePath(event.input.path);
      if (selectedSandboxProfile && matchesPattern(path, config.filesystem?.denyRead ?? [])) {
        return {
          block: true,
          reason: profileScopedReason(`Sandbox: read access denied for "${path}" (in denyRead).`),
        };
      }
      if (!matchesPattern(path, effectiveReadPaths(ctx.cwd))) {
        const choice = await promptReadBlock(pi, ctx, path, config.permissionPromptTimeoutSeconds);
        if (choice.action === "abort") {
          return {
            block: true,
            reason: profileScopedReason(`Sandbox: read access denied for "${path}"`),
          };
        }
        await applyChoice(choice.action, "read", choice.value, ctx.cwd);
        return;
      }
    }

    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      const path = canonicalizePath((event.input as { path: string }).path);
      const writePermission = await resolveWritePermission({
        path,
        allowWrite: effectiveWritePaths(ctx.cwd),
        denyWrite: config.filesystem?.denyWrite ?? [],
        prompt: (path) => promptWriteBlock(pi, ctx, path, config.permissionPromptTimeoutSeconds),
        saveWritePermission: (choice, value) => applyChoice(choice, "write", value, ctx.cwd),
      });
      if (writePermission.action === "deny") {
        return {
          block: true,
          reason: profileScopedReason(
            `Sandbox: write access denied for "${path}" (in denyWrite). ` +
              `To change this, edit denyWrite in:\n  ${projectPath}\n  ${globalPath}`,
          ),
        };
      }
      if (writePermission.action === "abort") {
        return {
          block: true,
          reason: profileScopedReason(
            `Sandbox: write access denied for "${path}" (not in allowWrite)`,
          ),
        };
      }
      if (writePermission.action === "granted") {
        return;
      }
    }
  });

  pi.on("input", (_event, ctx) => {
    const startupFailure = profileBlockReason();
    if (!startupFailure) return;
    writeSandboxDiagnostic(startupFailure);
    // Print/json children otherwise treat a handled input as a successful empty
    // turn. Mark the process failed while still preventing the first model call.
    // An in-process child shares the host process, where a non-zero exit code
    // would misreport the parent's own successful session as failed.
    if (!ctx.hasUI && !inProcessChild) process.exitCode = 1;
    return { action: "handled" as const };
  });

  pi.on("session_start", async (_event, ctx) => {
    disposeSandboxService?.();
    // Publishing the service is optional: a host that exposes no session
    // identity must not lose sandbox enforcement because of it.
    try {
      disposeSandboxService = registerSandboxService(
        ctx.sessionManager.getSessionId(),
        sandboxService,
      );
    } catch {
      disposeSandboxService = undefined;
    }
    if (selectedSandboxProfile) profileProjectTrusted = resolvedProfileTrust(ctx);
    if (pi.getFlag("no-sandbox") as boolean) {
      sandboxEnabled = false;
      if (selectedSandboxProfile) {
        recordProfileStartupFailure("--no-sandbox cannot disable a required sandbox profile.", ctx);
      } else {
        ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
      }
      return;
    }
    let config: SandboxConfig;
    try {
      config = resolveSandboxConfig(ctx.cwd);
    } catch (error) {
      recordProfileStartupFailure(error, ctx);
      return;
    }
    if (!config.enabled) {
      sandboxEnabled = false;
      ctx.ui.notify("Sandbox disabled via config", "info");
      return;
    }
    await enableSandbox(ctx, true);
  });

  pi.on("session_shutdown", async () => {
    disposeSandboxService?.();
    disposeSandboxService = undefined;
    if (!sandboxInitialized) return;
    try {
      await SandboxManager.reset();
    } catch {
      // Ignore cleanup errors.
    }
  });

  pi.registerShortcut(Key.alt("s"), {
    description: "Toggle sandbox on/off for this session",
    handler: toggleSandbox,
  });

  pi.registerCommand("sandbox-enable", {
    description: "Enable the sandbox for this session",
    handler: async (_args, ctx) => {
      if (await enableSandbox(ctx, false)) ctx.ui.notify("Sandbox enabled", "info");
    },
  });

  pi.registerCommand("sandbox-disable", {
    description: "Disable the sandbox for this session",
    handler: async (_args, ctx) => {
      if (await disableSandbox(ctx)) ctx.ui.notify("Sandbox disabled", "info");
    },
  });

  pi.registerCommand("sandbox-allow", {
    description: "Prompt to allow a domain or read/write access to a file path",
    handler: async (args, ctx) => {
      const [kind, ...targetParts] = args.trim().split(/\s+/);
      const targetArg = targetParts.join(" ");

      if ((kind !== "domain" && kind !== "read" && kind !== "write") || !targetArg) {
        ctx.ui.notify("Usage: /sandbox-allow <domain|read|write> <domain-or-path>", "error");
        return;
      }

      const target = kind === "domain" ? targetArg : canonicalizePath(targetArg);
      let config: SandboxConfig;
      try {
        config = resolveSandboxConfig(ctx.cwd);
      } catch (error) {
        recordProfileStartupFailure(error, ctx);
        ctx.ui.notify(
          profileBlockReason() ?? profileScopedReason("sandbox configuration could not be loaded."),
          "error",
        );
        return;
      }
      const configKey =
        kind === "domain" ? "allowedDomains" : kind === "read" ? "allowRead" : "allowWrite";
      const choice = await showPermissionPrompt(
        pi,
        ctx,
        `Add ${target} to ${configKey}?`,
        target,
        (value) => {
          if (!value) return "Rule cannot be empty.";
          const matches =
            kind === "domain" ? domainIsAllowed(target, [value]) : matchesPattern(target, [value]);
          return matches ? null : `Rule must match "${target}".`;
        },
        config.permissionPromptTimeoutSeconds,
      );
      if (choice.action === "abort") {
        ctx.ui.notify("Allow cancelled", "info");
        return;
      }

      await applyChoice(choice.action, kind, choice.value, ctx.cwd);
      ctx.ui.notify(`Added ${choice.value} to ${configKey}`, "info");
    },
  });

  pi.registerCommand("sandbox", {
    description: "Show sandbox configuration",
    handler: async (_args, ctx) => {
      if (!sandboxEnabled) {
        ctx.ui.notify("Sandbox is disabled", "info");
        return;
      }
      let config: SandboxConfig;
      try {
        config = resolveSandboxConfig(ctx.cwd);
      } catch (error) {
        recordProfileStartupFailure(error, ctx);
        ctx.ui.notify(
          profileBlockReason() ?? profileScopedReason("sandbox configuration could not be loaded."),
          "error",
        );
        return;
      }
      ctx.ui.notify(
        `${selectedSandboxProfile ? `${profileLabel()}\n` : ""}${formatSandboxConfiguration(config, getConfigPaths(ctx.cwd), allowances, selectedSandboxProfile)}`,
        "info",
      );
    },
  });
}
