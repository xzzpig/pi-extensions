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
import { Type } from "typebox";

import {
  addDomainToConfig,
  addReadPathToConfig,
  addWritePathToConfig,
  getConfigPaths,
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
import { listGlobalSandboxProfiles, loadConfig, SANDBOX_PROFILE_ENV } from "./profile-config.ts";
import { applySandboxConfigChange } from "./fork-profile-network.ts";
import { withToolAbortSignal } from "./fork-prompt-signal.ts";
import { warnIfLinuxUnenforcedGlobsSafely } from "./fork-ui-warnings.ts";
import {
  createSandboxedBashOps,
  initializeSandbox,
  sandboxManagerFactory,
  resolveAllowances,
  type SessionAllowances,
  supportsNodeEnvProxy,
  supportsSandboxPlatform,
  clearSessionAllowances,
} from "./sandbox-runtime.ts";
import {
  registerSandboxService,
  type SandboxProfileSelectionResult,
  type SandboxService,
} from "./service.ts";
import { maybeDecorateBashForToolDisplay } from "./tool-display-decoration.ts";
import {
  hasSandboxWriteDenialText,
  sandboxWriteDenialNotice,
  type BlockedWrite,
  type SandboxWriteDenialNoticeOptions,
} from "./write-denial.ts";
import { handleSandboxWriteDenial } from "./fork-bash-denial.ts";

import {
  createProfileStartupHelpers,
  IN_PROCESS_CHILD_ENV,
} from "./fork-profile-startup.ts";

import {
  cancelPermissionPrompts,
  resetPermissionPrompts,
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
  const sandboxManager = sandboxManagerFactory.create();
  pi.registerFlag("no-sandbox", {
    description: "Disable OS-level sandboxing for bash commands",
    type: "boolean",
    default: false,
  });

  // localBash supplies the tool metadata (name, description, params) via the spread
  // below. Its execute method is always overridden, and each invocation rebuilds the
  // bash tool against the session cwd, so this cwd is never used to run commands.
  const localBash = createBashToolDefinition(process.cwd());

  let sandboxEnabled = false;
  let sandboxInitialized = false;
  let sessionCwd = process.cwd();
  // Not a constant: an in-process extension can select a profile for the live
  // session through the SandboxService, exactly like a child launch selects one
  // from the environment before the session starts.
  let selectedSandboxProfile = process.env[SANDBOX_PROFILE_ENV];
  // The launcher applies the sandbox launch keys for the child-session creation
  // window only and restores them right after, so every launch value must be
  // captured here at registration instead of being read later from session_start.
  // An in-process child shares the host process, so it must never mutate host
  // state that only a standalone child process may own.
  const inProcessChild = process.env[IN_PROCESS_CHILD_ENV] === "1";
  let profileProjectTrusted = false;
  let profileStartupError: string | undefined;
  const allowances: SessionAllowances = { domains: [], readPaths: [], writePaths: [] };

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

  // Fork: the profile launch path lives in fork-profile-startup.ts; this file
  // only supplies the live state accessors.
  const profileStartup = createProfileStartupHelpers({
    selectedProfile: () => selectedSandboxProfile,
    startupError: () => profileStartupError,
    setStartupError: (error) => {
      profileStartupError = error;
    },
    sandboxInitialized: () => sandboxInitialized,
    setSandboxUnavailable: () => {
      sandboxEnabled = false;
      sandboxInitialized = false;
    },
    profileTrusted: () => profileProjectTrusted,
    lastStatusContext: () => lastStatusContext,
    notifySafely,
  });
  const {
    profileBlockReason,
    profileLabel,
    profileScopedReason,
    recordProfileStartupFailure,
    reportProfileWarning,
    resolvedProfileTrust,
    writeProfileStartupAcknowledgement,
    writeSandboxDiagnostic,
  } = profileStartup;

  const blockedSandboxResult = (reason: string): AgentToolResult<Record<string, never>> => ({
    content: [{ type: "text", text: `Error: ${reason}` }],
    details: {},
  });

  // Keep the original command output and append the sandbox attribution as its
  // own block so agents (and tool display) still see the raw failure.
  const withSandboxWriteDenialNotice = (
    result: Awaited<ReturnType<typeof localBash.execute>>,
    options: SandboxWriteDenialNoticeOptions,
  ): Awaited<ReturnType<typeof localBash.execute>> => ({
    ...result,
    content: [...result.content, { type: "text", text: sandboxWriteDenialNotice(options) }],
  });

  const resolveSandboxConfig = (cwd: string): SandboxConfig => {
    return loadConfig(cwd, {
      profileName: selectedSandboxProfile,
      projectTrusted: profileProjectTrusted,
      onWarning: reportProfileWarning,
    });
  };

  const effectiveAllowances = (cwd: string) =>
    resolveAllowances(resolveSandboxConfig(cwd), allowances);
  const effectiveDomains = (cwd: string) => effectiveAllowances(cwd).domains;
  const effectiveReadPaths = (cwd: string) => effectiveAllowances(cwd).readPaths;
  const effectiveWritePaths = (cwd: string) => effectiveAllowances(cwd).writePaths;

  async function refreshSandbox(cwd: string): Promise<void> {
    if (!sandboxInitialized) return;
    try {
      // Fork seam: applying a profile can turn network restriction on for a
      // manager initialized without a proxy; the helper re-initializes then.
      await applySandboxConfigChange(sandboxManager, resolveSandboxConfig(cwd), allowances, cwd);
    } catch (error) {
      recordProfileStartupFailure(error);
      if (selectedSandboxProfile) {
        throw new Error(
          profileBlockReason() ?? profileScopedReason("sandbox reinitialization failed."),
        );
      }
      writeSandboxDiagnostic(`Warning: Failed to update sandbox configuration: ${error}`);
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
          loadConfig(sessionCwd, {
            profileName,
            projectTrusted: profileProjectTrusted,
            onWarning: reportProfileWarning,
          });
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
        await refreshSandbox(sessionCwd);
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
    listProfiles: () =>
      listGlobalSandboxProfiles(sessionCwd, { projectTrusted: profileProjectTrusted }),
  };

  async function applyChoice(
    choice: Exclude<PermissionPromptResult["action"], "abort">,
    kind: "domain" | "read" | "write",
    value: string,
    cwd: string,
  ): Promise<void> {
    const { globalPath, projectPath } = getConfigPaths(cwd);
    const target = choice === "project" ? projectPath : globalPath;

    try {
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
    } catch (error) {
      // The grant still applies for this session (allowances updated above);
      // only persistence failed. Surface it instead of wiping the config.
      console.error(`Warning: ${error instanceof Error ? error.message : error}`);
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
    if (!supportsSandboxPlatform(platform)) {
      const message = `Sandbox not supported on ${platform}`;
      if (selectedSandboxProfile) recordProfileStartupFailure(message, ctx);
      else ctx.ui.notify(message, "warning");
      return false;
    }

    try {
      await initializeSandbox(sandboxManager, config, allowances, ctx.cwd);
      writeProfileStartupAcknowledgement();
      if (
        setProxyEnvironment &&
        !isNetworkUnrestricted(config) &&
        supportsNodeEnvProxy(process.versions.node)
      ) {
        process.env.NODE_USE_ENV_PROXY ??= "1";
      }
      resetPermissionPrompts(pi);
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
    warnIfLinuxUnenforcedGlobsSafely(ctx, config);
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

    cancelPermissionPrompts(pi);
    if (sandboxInitialized) {
      try {
        await sandboxManager.reset();
      } catch {
        // Ignore cleanup errors.
      }
    }
    sandboxEnabled = false;
    sandboxInitialized = false;
    clearSessionAllowances(allowances);
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

  async function requestAccess({
    kind,
    target,
    ctx,
    reason,
    signal,
    config: suppliedConfig,
  }: {
    kind: "domain" | "read" | "write";
    target: string;
    ctx: Parameters<typeof showPermissionPrompt>[1];
    reason?: string;
    signal?: AbortSignal;
    config?: SandboxConfig;
  }) {
    const config = suppliedConfig ?? resolveSandboxConfig(ctx.cwd);
    const configKey =
      kind === "domain" ? "allowedDomains" : kind === "read" ? "allowRead" : "allowWrite";
    const title = `Add ${target} to ${configKey}?`;
    const choice = await showPermissionPrompt(
      pi,
      withToolAbortSignal(ctx, signal),
      reason ? `${title}\nReason: ${reason}` : title,
      target,
      (value) => {
        if (!value) return "Rule cannot be empty.";
        const matches =
          kind === "domain"
            ? domainIsAllowed(target, [value])
            : matchesPattern(target, [value], ctx.cwd);
        return matches ? null : `Rule must match "${target}".`;
      },
      config.permissionPromptTimeoutSeconds,
    );
    if (signal?.aborted) throw new Error("Access request cancelled.");
    if (choice.action !== "abort") {
      await applyChoice(choice.action, kind, choice.value, ctx.cwd);
    }
    return choice;
  }

  function registerAccessTools() {
    pi.registerTool({
      name: "sandbox_status",
      label: "Sandbox status",
      description:
        "Inspect sandbox enabled state, effective allow and deny rules, and session-only grants. " +
        "Relative filesystem rules are resolved against cwd. Write access also grants read access; " +
        "denyWrite and deniedDomains override allows. Named profiles enforce denyRead; " +
        "otherwise allowRead overrides denyRead.",
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        const config = resolveSandboxConfig(ctx.cwd);
        const effective = resolveAllowances(config, allowances);
        const status = {
          enabled: sandboxEnabled,
          cwd: ctx.cwd,
          ...(selectedSandboxProfile ? { profile: selectedSandboxProfile } : {}),
          network: {
            disabled: config.network?.disabled ?? false,
            allowedDomains: effective.domains,
            deniedDomains: config.network?.deniedDomains ?? [],
          },
          filesystem: {
            disabled: config.filesystem?.disabled ?? false,
            allowRead: effective.readPaths,
            allowWrite: effective.writePaths,
            denyRead: config.filesystem?.denyRead ?? [],
            denyWrite: config.filesystem?.denyWrite ?? [],
          },
          sessionGrants: {
            domains: [...allowances.domains],
            readPaths: [...allowances.readPaths],
            writePaths: [...allowances.writePaths],
          },
        };
        return {
          content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
          details: status,
        };
      },
    });
    pi.registerTool({
      name: "sandbox_request_access",
      label: "Request sandbox access",
      description:
        "Request user approval for read or write access to a path, or network access to a domain. " +
        "Use sandbox_status to inspect current permissions. Already-allowed access does not prompt.",
      parameters: Type.Object({
        kind: Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("domain")]),
        target: Type.String({ minLength: 1, description: "Filesystem path or domain hostname" }),
        reason: Type.String({ minLength: 1, description: "Why this access is needed" }),
      }),
      async execute(_id, { kind, target: input, reason }, signal, _onUpdate, ctx) {
        if (!input.trim() || !reason.trim())
          throw new Error("Target and reason must not be empty.");
        if (signal?.aborted) throw new Error("Access request cancelled.");
        const target = kind === "domain" ? input.trim() : canonicalizePath(input, ctx.cwd);
        const config = resolveSandboxConfig(ctx.cwd);
        if (
          (kind === "write" &&
            matchesPattern(target, config.filesystem?.denyWrite ?? [], ctx.cwd)) ||
          (kind === "read" &&
            selectedSandboxProfile &&
            matchesPattern(target, config.filesystem?.denyRead ?? [], ctx.cwd)) ||
          (kind === "domain" && domainIsAllowed(target, config.network?.deniedDomains ?? []))
        ) {
          throw new Error(`Sandbox: ${kind} access to "${target}" is explicitly denied.`);
        }
        const effective = resolveAllowances(config, allowances);
        const alreadyAllowed =
          kind === "domain"
            ? domainIsAllowed(target, effective.domains)
            : matchesPattern(
                target,
                kind === "read" ? effective.readPaths : effective.writePaths,
                ctx.cwd,
              );
        if (alreadyAllowed) {
          return {
            content: [
              { type: "text", text: `Access already allowed: ${kind} ${JSON.stringify(target)}.` },
            ],
            details: { kind, target, alreadyAllowed: true },
          };
        }
        if (!ctx.hasUI) throw new Error("Sandbox access requests require an approval UI.");
        const choice = await requestAccess({ kind, target, ctx, reason, signal });
        if (choice.action === "abort")
          throw new Error(`Sandbox access request denied for "${target}".`);
        return {
          content: [
            {
              type: "text",
              text:
                `Access approved: ${kind} ${JSON.stringify(target)}.\n` +
                `Rule: ${JSON.stringify(choice.value)}\nScope: ${choice.action}`,
            },
          ],
          details: { kind, target, rule: choice.value, scope: choice.action },
        };
      },
    });
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
      // Blocked writes the violation monitor reported for the most recent exec.
      // Reset per execution so a retry never sees the previous attempt's events.
      let lastBlockedWrites: BlockedWrite[] = [];
      // Canonical paths already granted and retried within this tool call; a
      // second failure on the same path must not trigger another retry.
      const retriedPaths = new Set<string>();
      // Fork seam: write-denial attribution/prompting lives in
      // fork-bash-denial.ts; only these accessors are needed here.
      const writeDenialDeps = {
        pi,
        resolveConfig: (cwd: string) => resolveSandboxConfig(cwd),
        recordStartupFailure: (error: unknown, failureCtx?: ExtensionContext) =>
          recordProfileStartupFailure(error, failureCtx),
        blockReason: () => profileBlockReason(),
        scopeReason: (reason: string) => profileScopedReason(reason),
        effectiveWritePaths: (cwd: string) => effectiveWritePaths(cwd),
        saveWriteChoice: (
          choice: Exclude<PermissionPromptResult["action"], "abort">,
          value: string,
          cwd: string,
        ) => applyChoice(choice, "write", value, cwd),
        refresh: (cwd: string) => refreshSandbox(cwd),
        decorate: (
          res: Awaited<ReturnType<typeof localBash.execute>>,
          options: SandboxWriteDenialNoticeOptions,
        ) => withSandboxWriteDenialNotice(res, options),
        blockedResult: (reason: string) => blockedSandboxResult(reason),
      };

      const runBash = async (): Promise<Awaited<ReturnType<typeof localBash.execute>>> => {
        lastBlockedWrites = [];
        const profileFailure = profileBlockReason();
        if (profileFailure) return blockedSandboxResult(profileFailure);
        const settings = SettingsManager.create(ctx.cwd, undefined, {
          projectTrusted: profileProjectTrusted,
        });
        const userShellPath = settings.getShellPath();
        if (!sandboxEnabled || !sandboxInitialized) {
          return createBashToolDefinition(ctx.cwd, {
            shellPath: userShellPath,
            commandPrefix: settings.getShellCommandPrefix(),
          }).execute(id, params, signal, onUpdate, ctx);
        }
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
        return createBashToolDefinition(ctx.cwd, {
          operations: createSandboxedBashOps(
            sandboxManager,
            userShellPath,
            !isNetworkUnrestricted(config) && config.network?.sshProxy !== false,
            ({ blockedWrites }) => {
              lastBlockedWrites = blockedWrites;
            },
          ),
          commandPrefix: settings.getShellCommandPrefix(),
          shellPath: userShellPath,
        }).execute(id, params, signal, onUpdate, ctx);
      };

      // Post-process each execution and recurse on retries, so every attempt's
      // blocked writes converge into either a granted retry or an explained
      // failure instead of a bare kernel error.
      const runBashWithDenialHandling = async (): Promise<
        Awaited<ReturnType<typeof localBash.execute>>
      > => {
        let result: Awaited<ReturnType<typeof localBash.execute>>;
        try {
          result = await runBash();
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          // pi's bash tool throws on every nonzero exit with the command output
          // as the message. A sandbox write denial in that output must become a
          // result so the denial handling below can attribute it and offer the
          // permission prompt; every other failure keeps pi's native behavior.
          if (!hasSandboxWriteDenialText(error.message)) throw error;
          result = { content: [{ type: "text", text: error.message }], details: {} };
        }

        if (!sandboxEnabled || !sandboxInitialized) return result;
        const output = result.content
          .filter((content) => content.type === "text")
          .map((content) => content.text)
          .join("\n");
        return handleSandboxWriteDenial(
          {
            result,
            output,
            blockedWrites: lastBlockedWrites,
            ctx,
            signal,
            onUpdate,
            retriedPaths,
            retry: runBashWithDenialHandling,
          },
          writeDenialDeps,
        );

      };

      return runBashWithDenialHandling();
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

    const userShellPath = SettingsManager.create(ctx.cwd, undefined, {
      projectTrusted: profileProjectTrusted,
    }).getShellPath();
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
      operations: createSandboxedBashOps(
        sandboxManager,
        userShellPath,
        !isNetworkUnrestricted(config) && config.network?.sshProxy !== false,
      ),
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
      const path = canonicalizePath(event.input.path, ctx.cwd);
      if (selectedSandboxProfile && matchesPattern(path, config.filesystem?.denyRead ?? [], ctx.cwd)) {
        return {
          block: true,
          reason: profileScopedReason(`Sandbox: read access denied for "${path}" (in denyRead).`),
        };
      }
      if (!matchesPattern(path, effectiveReadPaths(ctx.cwd), ctx.cwd)) {
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
      const path = canonicalizePath((event.input as { path: string }).path, ctx.cwd);
      const writePermission = await resolveWritePermission({
        path,
        allowWrite: effectiveWritePaths(ctx.cwd),
        denyWrite: config.filesystem?.denyWrite ?? [],
        baseCwd: ctx.cwd,
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
    sessionCwd = ctx.cwd;
    disposeSandboxService?.();
    // Non-fatal profile notices surface through this session's UI (dedup means
    // the first config resolution wins).
    profileStartup.setProfileWarningContext(ctx);
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
    profileProjectTrusted = resolvedProfileTrust(ctx);
    let config: SandboxConfig;
    try {
      config = resolveSandboxConfig(ctx.cwd);
    } catch (error) {
      recordProfileStartupFailure(error, ctx);
      return;
    }
    if (config.enableAccessRequestTool === true) registerAccessTools();
    if (pi.getFlag("no-sandbox") as boolean) {
      sandboxEnabled = false;
      if (selectedSandboxProfile) {
        recordProfileStartupFailure("--no-sandbox cannot disable a required sandbox profile.", ctx);
      } else {
        ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
      }
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
    cancelPermissionPrompts(pi);
    disposeSandboxService?.();
    disposeSandboxService = undefined;
    if (!sandboxInitialized) return;
    try {
      await sandboxManager.reset();
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

      const target = kind === "domain" ? targetArg : canonicalizePath(targetArg, ctx.cwd);
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
      const choice = await requestAccess({ kind, target, ctx, config });
      if (choice.action === "abort") {
        ctx.ui.notify("Allow cancelled", "info");
        return;
      }

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
