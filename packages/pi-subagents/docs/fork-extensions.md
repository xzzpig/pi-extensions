# Fork extensions

Documentation for `@xzzpig/pi-subagents`-specific extensions that are not part
of upstream `pi-subagents`. These chapters were moved out of
[`agents.md`](agents.md) and [`extension-api.md`](extension-api.md) so those
files stay byte-identical to upstream.

## Sandbox profiles

Use `sandbox: <profile-name>` only for a native Pi child. The profile is resolved
from the global `pi-sandbox` configuration, never from an agent file or a project
profile registry:

```yaml
---
name: security-reviewer
description: Review changes with a constrained filesystem and no network
sandbox: reviewer-strict
extensions: ./review-tools.ts
---

Review the requested change.
```

`pi-subagents` validates the scalar name and passes only that name to the child.
It automatically resolves and injects the installed `pi-sandbox` extension and a
startup guard even when `extensions` is an explicit allowlist; an explicit empty
allowlist does not remove these required runtime extensions. The guard requires
`pi-sandbox` to acknowledge successful profile initialization before the child
can enter its first model turn. The launch fails before the model's first turn when the package or manifest is missing, a capability ceiling denies child
extensions, the profile cannot be loaded, or sandbox initialization fails. A
blocked child publishes that reason through its startup diagnostics, so the
caller sees the profile error (and the available profile names) instead of a
generic empty-output message; a startup block is never recorded as a model
failure and never excludes the model from later runs.

The field is rejected for `external-cli` and `external-job` runners because they
do not host a Pi child extension. It also cannot be an object, `false`, an empty
value, or an inline allow/deny policy. Define the actual network and filesystem
rules in global `pi-sandbox` `profiles` instead.

A profile chosen by a project-scoped agent or project override is used only when
the host marks that project trusted. Otherwise the launch reports an actionable
trust error. In a headless child, accesses outside the profile's preconfigured
network/read/write rules are blocked; pi-sandbox does not use Permission System
or supervisor forwarding to ask the parent for an approval. See
[`pi-sandbox`'s README](https://github.com/xzzpig/pi-extensions/tree/main/packages/pi-sandbox#named-profiles-for-subagents)
for profile inheritance and merge rules.

## Permission profiles

Use `permission-profile: <name>` to select a named policy profile from the
**global-only** `profiles` registry in `pi-permission-system`'s config
(`<agentDir>/extensions/pi-permission-system/config.json`). It is a selector
only — the actual rules (tool scalars, `bash`/`mcp`/`skill`/`external_directory`
pattern maps, `'*'` fallback) live in that registry and always resolve from the
child's own global config:

```yaml
---
name: reviewer
description: Review changes without write access
permission-profile: reviewer
---
Review the requested change and report findings.
```

`pi-subagents` validates the scalar name (same grammar as sandbox profiles),
passes only that name to the child via the transient
`PI_SUBAGENT_PERMISSION_PROFILE` environment variable, and injects the
installed `pi-permission-system` extension into the child launch even when
`extensions` is an explicit allowlist, so the child's permission system applies
the selected profile. The env channel carries a bare validated name — raw
policy is never transmitted — and the rules are always read from the child's
own global config, so the profile means the same policy regardless of which
host launches the agent. Selection precedence inside the permission system is
env > project agent file > global agent file.

The launch fails closed when a profile is declared but `pi-permission-system`
is not installed, when a capability ceiling denies child extensions, or when
the runner is not a native Pi child (the field is rejected for `external-cli`
and `external-job` runners). At runtime, selecting an unknown profile or an
empty ruleset clamps that agent's `allow` rules to `ask` with an explicit
`Permission profile '<name>' could not be resolved` diagnostic — it never
silently degrades to the unselected baseline. An agent without the field keeps
its pre-change behavior exactly.

The profile merges between the project config and the agent's own `permission:`
block: patterns the profile does not mention keep the lower scopes' rules
(global denies survive), and `permission:` overrides the profile per pattern.
A profile selected by a **project** agent file participates only when the host
marks that project trusted.

## Context injection

By default the parent agent learns which agents exist only by calling `subagent({ action: "list" })`. Context injection pre-declares selected agents in the parent system prompt through a compact `<available_subagents>` block, so routing decisions can happen without a discovery round trip.

Two sources contribute, and the union is advertised:

1. Agent files that opt in with `injectToContext: true` in their frontmatter.
2. The `subagents.injectAgents` setting, which lists agent names (canonical names or aliases; builtins allowed):

```json
{
  "subagents": {
    "injectAgents": ["worker", "reviewer", "security-reviewer"]
  }
}
```

Rendered block shape:

```text
<available_subagents>
The following pre-declared subagents are available.
Launch them with the subagent tool when a task matches their description.

- security-reviewer: Security review specialist
- worker: Implementation work, including approved oracle handoffs.
</available_subagents>
```

Semantics and guarantees:

- **Snapshot per session.** The list resolves once at session start (and on reload) and stays byte-identical for every turn, so provider prompt caching is never invalidated mid-session. Edits to agent files or settings take effect in a new session, not the current one; `{ action: "list" }` remains the runtime source of truth.
- **Only executable agents are advertised.** Disabled agents and agents restricted by the session capability ceiling are never injected.
- **Children never see it.** Spawned child sessions do not load the parent injection; fanout children can still call `{ action: "list" }`.
- **Unknown setting names are ignored** and reported by `/subagents-doctor` instead of failing startup.
- The block is appended only when it is not already present, so forked or resumed sessions never duplicate it.

## Agent discovery from independent extensions

An extension that wants to offer the same agent list the subagent launcher uses
— a session role picker, for example — can call the exported discovery helper
instead of re-implementing agent loading:

```typescript
import { discoverAgentsWithRuntime } from "pi-subagents/agents";

const result = discoverAgentsWithRuntime(pi, cwd, "both");
for (const agent of result.agents) {
  // agent.name, agent.description, agent.aliases, agent.source,
  // agent.sandbox, agent.permissionProfile, agent.override?.scope, agent.disabled
}
result.agentDiagnostics; // loader problems, per source
result.projectAgentsDir; // where project agents came from
```

The result is the merged view: builtin, package, user, and project agent files
plus anything registered at runtime through the contract above. With nothing
registered, it is exactly `discoverAgents(cwd, scope)`.

`scope` is `"user" | "project" | "both"`. Pass the caller's `cwd` so project
layering resolves against the right tree, and pass the caller's `ExtensionAPI`
because the runtime registry is keyed on it.

Two notes for consumers of an optional dependency:

- Treat the module as optional. A package that is not installed cannot be
  imported, so load it dynamically and report the failure rather than failing
  extension load.
- `agent.source === "project"` (or `agent.override?.scope === "project"`) means
  the definition comes from the current project. Gate such an agent behind the
  host's project-trust decision before adopting it for anything.

## Agent ejection API

Use `@xzzpig/pi-subagents/agent-management` when an extension needs to make a bundled agent editable without parsing model-facing management output:

```ts
import { ejectAgentDefinition } from "@xzzpig/pi-subagents/agent-management";

const result = ejectAgentDefinition({
  cwd: ctx.cwd,
  agent: "reviewer",
  scope: "project",
  projectTrusted: ctx.isProjectTrusted(),
});

if (!result.ok) throw new Error(result.message);
console.log(result.targetPath, result.verification.launchPreflighted);
```

The operation never overwrites an existing agent, chain, or conflicting file. Package-relative tool, extension, and skill paths are normalized before writing. After rediscovery, it validates copied skills and the static child launch tool plan; if that check fails, it removes only the new file created by that call and returns `preflight_failed`. Host-dependent checks such as the live model registry and actual child process startup remain the responsibility of the caller's normal launch preflight/execution path.
