# Fork Changelog

Release history for `@xzzpig/pi-permission-system`; version headings refer only to this fork.
Upstream history: [CHANGELOG.md](./CHANGELOG.md).
Current upstream baseline (not a claim about older releases): [pi-permission-system-v42.0.0 / 112afd03558d](https://github.com/gotgenes/pi-packages/tree/112afd03558d89b55c12f92af90bce7fd21b96ce/packages/pi-permission-system).

Historical entries below were migrated from the repository's existing changelogs; missing dates and historical baselines have not been invented.

## [1.8.1] — 2026-11-15

### Fixed

- Fixed a fork-introduced parser-state loss in the bash command enumerator: an opaque payload (`bash -c`/`eval`/`flock -c`/`env -S`) is re-parsed by re-entering `collectCommands`, and the nested walk cleared the module-level parse program in `finally`, so every later wrapper in the same command was marked `payloadUnresolved` and floored to `ask`. The walk now saves and restores the previous parser; covered by `test/access-intent/bash/nested-parse-program.fork.test.ts` (the second sibling wrapper now resolves).

### Changed

- `pnpm run gen:schema` formats the generated JSON schema with `--indent-style=space --indent-width=2`, matching the upstream file's formatting; the schema's whitespace-only diff and its `knownDebt` entry are gone.

## [1.8.0] — 2026-10-28

### Changed

- Synced upstream `v40.1.2` → `v42.0.0`, including declared command effects,
  unanswered prompt timeouts, narrower wrapper session approvals, and option
  grammar and wrapper-exemption security fixes. Fork permission profiles,
  forwarded-decision events, and `fallback` inner-command gating remain.
- Adopted the upstream opt-in authorizer-chain exception for qualifying Bash
  `external_directory` asks whose paths name nothing on disk; the path family
  remains capped, and accepted exceptions are recorded in the review log.
- Config arrays are now limited to 1,000 entries and oversized configurations
  fail closed. The package requires Zod `^4.6.7`, the upstream security fix.
- Both wrapper-floor modes now ask when template-based execution, computed
  wrapper arguments, or uncertain option grammars prevent proving the command.
  Safely resolved wrappers retain fine-grained fork gating, and explicit inner
  denies still take precedence.

### Upstream provenance

- Upstream v40.1.2: [source dcb4cc3d9643](https://github.com/gotgenes/pi-packages/tree/dcb4cc3d96438652e824ff19fae15085cfeec2b0/packages/pi-permission-system); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/7ecf2299f09844d1730e6b86af8d791a6453e899/subtrees/pi-permission-system.json).
- Upstream v42.0.0: [source 112afd03558d](https://github.com/gotgenes/pi-packages/tree/112afd03558d89b55c12f92af90bce7fd21b96ce/packages/pi-permission-system); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/0d42c7f516b6b773c900c79ec964761bbe0accb2/subtrees/pi-permission-system.json).

## [1.7.0] — 2026-10-10

### Changed

- Synced upstream `v39.0.2` → `v40.1.2`: bash command home/absolute
  spellings, policy-issue reporting, per-unit forwarded asks and session grants,
  timed-subshell descent, and stricter sudo reader-exemption grammar.
- Adopted the upstream execution-modifier exemption in both wrapper-floor
  modes: proven `time`/`timeout`/`nice`/`stdbuf`/`setsid` wrappers resolve by
  the command they run. Explicit wrapper rules still take precedence.
- Hardened fallback sudo parsing with upstream's option grammar: normal long/clustered
  options locate the real inner command; edit, shell/login, chdir/chroot and
  unknown/ambiguous or computed command forms keep the ask floor, including
  literal quoted options and sudo layers inside recognized wrapper chains.
- Preserved fork fallback inner-unit gating, permission profiles and decision
  events. Synchronous advisory checks now use the shared `BashProgram.parseSync`
  builder so the fork payload parser and upstream command spellings are retained.

### Fixed

- Retained upstream home/absolute command spellings for source-aligned wrapper
  inner units and exempt execution-modifier/core-reader checks, so an absolute
  `bash` deny still applies to a relative command behind `sudo` or `timeout`.
  Opaque payloads and computed paths do not borrow unproven outer-scope aliases.

### Upstream provenance

- Upstream v39.0.2: [source cacad9475678](https://github.com/gotgenes/pi-packages/tree/cacad9475678b7f0537b99a222eff6b55294506d/packages/pi-permission-system); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/b533090e25805dcc153ce1e5f062bd845b69521d/subtrees/pi-permission-system.json).
- Upstream v40.1.2: [source dcb4cc3d9643](https://github.com/gotgenes/pi-packages/tree/dcb4cc3d96438652e824ff19fae15085cfeec2b0/packages/pi-permission-system); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/7ecf2299f09844d1730e6b86af8d791a6453e899/subtrees/pi-permission-system.json).

## [1.6.0] — 2026-10-03

### Changed

- **Synced upstream `v37.0.0` → `v39.0.2`**: Pi's built-in MCP tools are now gated
  on the `mcp` surface instead of top-level `mcp__` keys (legacy top-level keys keep
  working and trigger a port notice; server names also read from the trusted
  project's `.pi/mcp.json`), path rules apply to the file a built-in tool opens no
  matter how it is spelled (including file URLs), directory session approvals are
  scoped to that directory (not its parent) and share one glob label, and the
  breaking v39.0.0 narrowing of the Pi-infrastructure read bypass (targeted
  `external_directory` denies now block infrastructure reads; the bypass covers only
  Pi's harness entries — no longer the permission logs or all of `~/.pi/agent`);
  plus config/default-allowed bash external paths no longer logged as session
  approvals. Upstream CHANGELOG sections ([38.x]/[39.x]) are not adopted per
  doNotReintroduce. The fork's dual-layer profile-scope layer
  (`resolveProfileScopes`/`invalidProfileName`/`warnings`) was merged beside
  upstream's `legacyMcpToolKeys` relocation in `permission-manager.ts`, and the
  generated schema was regenerated with `gen:schema` over the fork sources.

### Upstream provenance

- Upstream v37.0.0: [source 7a32def79909](https://github.com/gotgenes/pi-packages/tree/7a32def799093efdf888d17661ee54397b4e42fc/packages/pi-permission-system); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/e9e8aa7f9d19846d1350bfe0059bd2ba11aa3f35/subtrees/pi-permission-system.json).
- Upstream v39.0.2: [source cacad9475678](https://github.com/gotgenes/pi-packages/tree/cacad9475678b7f0537b99a222eff6b55294506d/packages/pi-permission-system); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/b533090e25805dcc153ce1e5f062bd845b69521d/subtrees/pi-permission-system.json).

## [1.5.0] — 2026-10-02

### Changed

- **Synced the fork with upstream pi-permission-system v35.0.0 → v37.0.0**
  (upstream majors 36–37) while preserving the configurable wrapper-floor
  (fallback/always) divergence. Adopted upstream: the computed-word rules that
  withdraw find/fd/sort read claims (#992), the `$HOME`/`$PWD` rebinding
  resolution fixes (#995), prompt notifications with the session and requested
  tool named and the terminal bell (#906/#996), the prompt rewrite moving to
  Pi 1.0.0's `systemPromptOptions` (#999 — other extensions' sections such as
  `<mcp_servers>` and later sections after a denied skill are preserved), and
  the Pi ≥ 1.0.0 peer floor (#970).
- The wrapper-floor classifier reads words through upstream's WordReader
  (`collectCommands(node, words, { parseProgram })`) and slices an indirection
  wrapper's inner unit from the unit's word-joined text, so a heredoc hung on
  the wrapper no longer glues its body onto the inner unit. The fork's
  wrapper-floors spec-driven emission and `wrapperFloors` config knob are
  unchanged.
- Peer ranges follow the workspace Pi 1.0.0 baseline (`>=1.0.0 <2`).

### Upstream provenance

- Upstream v35.0.0: [source 284e0a317f7d](https://github.com/gotgenes/pi-packages/tree/284e0a317f7d99f3fa0300c3817f9003c2549fc6/packages/pi-permission-system); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/fa6b7d22109bcf9071ed75c0ac01d7d499d6503c/subtrees/pi-permission-system.json).
- Upstream v37.0.0: [source 7a32def79909](https://github.com/gotgenes/pi-packages/tree/7a32def799093efdf888d17661ee54397b4e42fc/packages/pi-permission-system); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/e9e8aa7f9d19846d1350bfe0059bd2ba11aa3f35/subtrees/pi-permission-system.json).

## [1.4.1] — 2026-09-29

### Fixed

- **A transparent command proxy no longer bypasses `bash` rules.** A proxy that
  rewrites its own argv into the real command (`rtk git push origin main` runs
  `git push origin main`) commonly rewrites the tool call *before* this
  extension's `tool_call` handler reads it — a handler registered earlier in the
  load order sees the command first. The `bash` surface matches `^…$`-anchored
  globs, so the rewritten unit matched only a catch-all `*` and `git add *: ask`
  / `git commit *: ask` / `git push *: ask` / `find /: deny` were silently
  bypassed. `rtk` is now in the fork's indirection-wrapper table, so the
  **proxied** command is enumerated as its own gated unit and the verdict no
  longer depends on which handler ran first. The proxy's own leading options are
  skipped (`rtk --ultra-compact git add x` still gates on `git add x`). Known
  boundary: a proxy *subcommand* that itself names the command to run
  (`rtk err <cmd>`) is not unwrapped further, so it falls back to the catch-all
  rule; `rtk rewrite` emits no such shape.

## [1.4.0] — 2026-09-27

### Changed

- **Synced upstream `v34.0.0` → `v35.0.0`** (breaking). Highlights: an
  operator's custom system prompt no longer receives the appended permission
  tool surface or rules (upstream #980; the tool surface is now entirely
  node-local prose); a redirect written before or between a command's words
  (`>/tmp/o xargs grep foo`) is checked against the command's own rules and
  its trailing words are reattached to the command at the parser boundary
  (upstream #977), with the word-reading helpers refactored into
  `readCommandUnit` / `commandWordNodes` / `hostedRedirects` and
  `parseUnresolvedWithin` moved to the new `parse-health` module.
- The fork keeps its wrapper-floor feature on the new helpers:
  `makeCommandUnit` keeps the spec-driven `classifyWrapperCommand` emission
  (wrapper plus inner units) but adopts upstream's redirect-aware floor scope
  (`isTransparentWrapper(words, redirectedScope(node, scope))`) and the new
  redirect-normalized unit text; `commandUnitText` / `readCommandWords` are
  dropped with the upstream refactor. Named permission profiles, the session
  role layer, forwarded-decision broadcast, and project-scoped profiles
  (dual-layer `resolveProfileScopes`) carry over unchanged — the breaking
  tool-surface removal touches no fork seam.

### Upstream provenance

- Upstream v34.0.0: [source 26caf78f3548](https://github.com/gotgenes/pi-packages/tree/26caf78f35488380740f91bbc68f455c0e96c6fb/packages/pi-permission-system); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/d4de3b1341f592d6373e66a7a8da7e26395bf9e7/subtrees/pi-permission-system.json).
- Upstream v35.0.0: [source 284e0a317f7d](https://github.com/gotgenes/pi-packages/tree/284e0a317f7d99f3fa0300c3817f9003c2549fc6/packages/pi-permission-system); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/fa6b7d22109bcf9071ed75c0ac01d7d499d6503c/subtrees/pi-permission-system.json).

## [1.3.0] — 2026-09-25

### Changed

- **Synced upstream `v32.1.0` → `v34.0.0`** (2 majors, ~342 upstream commits).
  Highlights: a redirect's target is now checked against path rules even when
  the file does not exist yet (upstream breaking fix — creating redirects such
  as `cat x > newfile` were previously unchecked and now reach the path
  surfaces); MCP server rules apply to prefix-named tools such as
  `github_search_code`; MCP rule matching honors true last-match-wins across
  every candidate name instead of stopping at the first match; pi ≥0.86
  section-shaped prompts get the relocated tool-surface treatment while
  keeping a project's own Guidelines section; config-issue reporter warns
  once per report on new issues; additional secret-masking paths for
  indirection wrappers and quote-stitched inline-shell payloads; quoted flag
  and value parsing fixes; permission asks queue FIFO and a second ask no
  longer replaces the first; pending asks are answered at session end.
- The fork keeps its named permission profiles, session role layer, wrapper
  floors, forwarded-decision broadcast, and project-scoped profiles
  (dual-layer `resolveProfileScopes`) on top of the upstream changes.
  `configStore.refresh` moved to a cwd parameter upstream; the fork's
  untrusted-project profiles probe and upstream's new status-bar sync
  (`syncPermissionSystemStatus`) now coexist in `PermissionSession.refreshConfig`.

### Upstream provenance

- Upstream v32.1.0: [source e607d637f0bf](https://github.com/gotgenes/pi-packages/tree/e607d637f0bf8a7b24c54e545982f94a492aa831/packages/pi-permission-system); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/c101d81083f20d54b3e139caa2c0901652569d17/subtrees/pi-permission-system.json).
- Upstream v34.0.0: [source 26caf78f3548](https://github.com/gotgenes/pi-packages/tree/26caf78f35488380740f91bbc68f455c0e96c6fb/packages/pi-permission-system); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/d4de3b1341f592d6373e66a7a8da7e26395bf9e7/subtrees/pi-permission-system.json).

## [1.2.0] — 2026-09-22

### Changed

- **Project configuration may now define permission profiles** (OpenSpec change
  `add-project-scoped-profiles`). Previously a `profiles` key in the project
  config (`<cwd>/.pi/extensions/pi-permission-system/config.json`) rejected the
  whole file with "The 'profiles' key is only supported in the global
  configuration"; now the key is accepted. A trusted project's registry joins
  profile resolution: a same-named global and trusted-project profile merge per
  pattern (origins `profile-global` / `profile-project`), and a project-only
  name resolves when the project is trusted. An untrusted project's registry is
  ignored with an "N permission profile(s) not applied (project is not
  trusted)" warning and never fails the project scope — the global registry
  alone governs selection.

## [1.1.1] — 2026-09-19

### Changed

- **Conflict-surface refactor, no behavior change.** The fork's bash wrapper-classification block moved from `src/access-intent/bash/command-enumeration.ts` to fork-only `src/access-intent/bash/wrapper-floors.ts` (substantive diff ~714+/186− → ~109+/23−); the profile-scope resolution inside `resolvePermissions` moved to fork-only `src/policy/profile-scope.ts`; the duplicated `parseCommandUnits` closure now lives once in fork-only `src/access-intent/bash/wrapper-parse.ts`; five upstream test files are byte-identical to upstream again with fork cases in `*.fork.test.ts` files; the zero-reference `src/denial-messages.ts` (a revived copy of an upstream-dissolved module) was deleted; ~1,500 lines of whitespace churn were reverted to upstream formatting.

## [1.1.0] — 2026-09-17

### Added

- **Synced with upstream pi-permission-system v32.0.5 → v32.1.0** (fork 1.0.0 → 1.1.0). Adopted upstream's region-scoped tool-surface removal for custom system prompts (#919) and configurable permission-dialog hotkeys via `permissionDialogKeys` (#927), while preserving the fork's named permission profiles, session role layer, wrapper floors, and forwarded-decision broadcast.

### Added

- **Synced with upstream pi-permission-system v31.1.4 → v32.0.5** (fork 0.8.0 → 1.0.0). Adopted upstream's parent-session prompting for UI children (#907/#909), deny-preempts-ask (#899), transient filesystem retry for forwarded writes (#914), command-string secret redaction (#920), bash partial-parse salvage (#875), and unregistered chain-link warning (#861), while preserving the fork's named permission profiles, session role layer, wrapper floors, and forwarded-decision broadcast.

### Added

- **Synced with upstream pi-permission-system v31.0.2 → v31.1.4** (fork 0.7.0 → 0.8.0). Adopted upstream's `src/` tree reorganization into `#src/<domain>/` subdirectories, forwarded-permission serving heartbeat fixes (#907), and the tool-surface relocation documentation, while preserving the fork's named permission profiles, session role layer, wrapper floors, and forwarded-decision broadcast.
- **A child session keeps the profile selection it was launched with.** The
  launcher-provided `PI_SUBAGENT_PERMISSION_PROFILE` selection is captured once
  at a subagent child's `session_start` and reused for the rest of that child's
  life, instead of being re-read from the process environment on every decision.
  The value only exists in the environment while the child is being created (the
  host restores its own value afterwards, and concurrent in-process children
  overwrite each other), so re-reading it made a child silently adopt the host
  session's role selection — or another child's — for the rest of its run. A host
  session is unchanged and still reads the variable live, so a mid-session
  profile change applies on the next decision. The launcher announces this with
  `PI_SUBAGENT_PERMISSION_PROFILE_PINNED=1` rather than relying on subagent
  detection: a host session also carries subagent environment hints (the
  pi-subagents adapter sets `PI_SUBAGENT_PARENT_SESSION` in the root session so
  its children inherit it), and treating those as "this is a child" would freeze
  the host's own selection. Fork-specific deviation (OpenSpec change
  `add-agent-role`, requirement 子代理身份隔离).

### Upstream provenance

- Upstream v32.0.5: [source e74af72419c8](https://github.com/gotgenes/pi-packages/tree/e74af72419c80f61e2636bd4d20c4d98b336d9c9/packages/pi-permission-system); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/7ba94220cca228a62d5d8b11134d44e051192f73/subtrees/pi-permission-system.json).
- Upstream v32.1.0: [source e607d637f0bf](https://github.com/gotgenes/pi-packages/tree/e607d637f0bf8a7b24c54e545982f94a492aa831/packages/pi-permission-system); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/c101d81083f20d54b3e139caa2c0901652569d17/subtrees/pi-permission-system.json).
- Upstream v31.1.4: [source 5b7c823f593c](https://github.com/gotgenes/pi-packages/tree/5b7c823f593c73da0734cd1766892efea45db522/packages/pi-permission-system); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/a0d6889bcde043ef3202e58ae3dba9bb75200251/subtrees/pi-permission-system.json).
- Upstream v31.0.2: [source 8ce106cae445](https://github.com/gotgenes/pi-packages/tree/8ce106cae4454c8f1dc37d8da764f8a0d392b1de/packages/pi-permission-system); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/0ccf3b0a5b86e7fe45d9e880c77156b71f4d8072/subtrees/pi-permission-system.json).

## [0.7.0] - 2026-09-11

### Added

- **Named permission profiles.** The global config file gains a `profiles` registry (`profiles: { "<name>": { "permission": ... } }`) whose entries reuse the full `permission` grammar (tool scalars, `bash`/`mcp`/`skill`/`external_directory`/`special` pattern maps, `'*'` fallback). The registry is global-only: a project config that defines `profiles` is schema-rejected, marking the project scope invalid and failing closed.
- **`permission-profile` agent frontmatter + env channel.** A global or project agent file can select a profile with the `permission-profile: <name>` frontmatter key (name grammar `^[A-Za-z0-9][A-Za-z0-9_-]*$`, ≤128 chars, no empty/path/`false` values). `pi-subagents` child launches pass the validated name via the `PI_SUBAGENT_PERMISSION_PROFILE` environment variable; selection precedence is env > project agent file > global agent file. The rules always resolve from the child's own global config — a bare name crosses the boundary, never raw policy.
- **Profile scope in resolution.** The selected profile merges between the project config and the agent frontmatter (`[global, project, profile, agent, project-agent]`) with per-pattern origins tagged `'profile'`; patterns the profile does not mention keep the lower scopes' rules (global denies survive), and the agent's own `permission:` overrides the profile per pattern.
- **Fail-closed selection.** Selecting an unknown profile name or an empty ruleset clamps the agent's `allow` rules to `ask` with a specific `Permission profile '<name>' could not be resolved (unknown name or empty ruleset)` diagnostic — it never silently degrades to the unselected baseline.

## [0.6.0] - 2026-09-05

### Changed

- Synced the fork with upstream pi-permission-system v27.0.1 → v31.0.2 (upstream majors 28–31) while preserving the configurable wrapper-floor (fallback/always) divergence. Adopted upstream: directional path surfaces with a read/write capability axis and wrapper transparency (#806/#807/#803), glob-bearing path token projection (#821), flag/arity parse fixes (#823), command gating in control-flow bodies, function definitions, declarations and assignments (#742), decision attribution with the shared `resolutionFor` decider map and the new `authorizer_allowed` / `authorizer_denied` resolutions (#772), deny-reason forwarding (#844), removal of the process-root service accessors (#796), the unguarded-subagent-child alarm (#792), extractor/formatter exposure with fact-shaping inheritance (#793), named permission surfaces (#808), per-pattern session approval surfaces and direction-proven external path grants (#810), `isToolFullyDenied` cross-extension pre-filtering (#815), both-directions session grants with `sessionGrantWidth` on the wire (#813), statement-operand gating for case subjects and for/select operands (#839), unresolved-redirect handling (#814), and the fail-closed prompt for unresolvable bash parses (#840).
- Fork features kept: the spec-driven wrapper classifier that re-parses opaque payloads (`eval`/`bash -c`/`flock -c`/`env -S`) and slices indirection inner commands into their own gated units, `payloadUnresolved` fail-closed flooring, payload-less (inert) wrapper adjudication, `wrapperFloors` config knob (config default `"fallback"`; a caller that passes no option to the gate gets the upstream blanket floor), the `permissions:forwarded_decision` broadcast with its `user_approved_for_serving_session` resolution, the injectable response writer, and terminal permission notifications. Wrapper transparency (#803) is honored in both wrapper-floor modes. Fixed the `/permission-system` modal silently dropping `wrapperFloors` when persisting config.

### Fixed

- The config modal's save no longer drops `wrapperFloors` from the persisted config (fork knob lost since the config-store refactor).

### Upstream provenance

- Upstream v27.0.1: [source 7affff9f74c8](https://github.com/gotgenes/pi-packages/tree/7affff9f74c8d4eb05efeb0bc12d9a8a4e2f8e30/packages/pi-permission-system); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/b17ccb54cbdd50e94dd8c7128f8619aa0d80f50c/subtrees/pi-permission-system.json).
- Upstream v31.0.2: [source 8ce106cae445](https://github.com/gotgenes/pi-packages/tree/8ce106cae4454c8f1dc37d8da764f8a0d392b1de/packages/pi-permission-system); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/0ccf3b0a5b86e7fe45d9e880c77156b71f4d8072/subtrees/pi-permission-system.json).

## [0.5.0] - 2026-08-24

### Changed

- Synced the fork with upstream pi-permission-system v27.0.1 while preserving the configurable wrapper-floor (fallback/always) divergence. Adopted upstream #726 decision attribution (`decidedBy` carried on forwarded responses), #745 prompt payload contracts (deprecated preview caps are now dropped from config), #746 review-log request facts and `reviewLogFieldMaxWidth`, #787 re-emitted `permissions:ready` at first `before_agent_start`, #794 session-keyed service locator (`getRootPermissionsService` deprecated; root publish/unpublish accessors renamed), #789 subagent detection via parent-session env vars, and the `gen:schema` / `verify:public-types` scripts. Fork additions kept: `permissions:forwarded_decision` broadcast, injectable response writer, and the payload-less wrapper adjudication.

### Upstream provenance

- Upstream v27.0.1: [source 7affff9f74c8](https://github.com/gotgenes/pi-packages/tree/7affff9f74c8d4eb05efeb0bc12d9a8a4e2f8e30/packages/pi-permission-system); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/b17ccb54cbdd50e94dd8c7128f8619aa0d80f50c/subtrees/pi-permission-system.json).

## [0.4.0] - 2026-08-24

### Changed

- Fork: provably payload-less wrapper invocations are now gated as ordinary commands by their own text instead of being floored to `ask` — a bare `eval`, a missing/blank/command-less opaque payload (`bash -c ""`, comments, pure assignments), or an indirection wrapper whose every argument is consumed by its own option/value/positional syntax (`timeout 5`, `env -u HOME`, `sudo -u root`, assignments-only `env`). A non-empty payload that fails to parse still floors to `ask` (fail-closed). Wrappers whose bare or flags-only form executes each stdin line as a shell command (`parallel`, `rust-parallel`, `rush`) stay floored when no command argument is given, and `env -S '…'` is now treated as an inline command string — re-parsed like an opaque payload so its inner commands are gated individually.

## [0.3.0] - 2026-08-16

### Changed

- Synced the fork with upstream pi-permission-system v25.3.0 while preserving the configurable wrapper-floor (fallback/always) divergence; adopted upstream #710 bounded dialog, #744 structured payload, #712 deny-first, #713 executedUnit display, #741 nested-execution module.

### Upstream provenance

- Upstream v25.3.0: [source b1993987d2de](https://github.com/gotgenes/pi-packages/tree/b1993987d2de34ae409561360f0035ee66831460/packages/pi-permission-system); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/47f5df5a369f1dab0301c20b3f185341f598f8f1/subtrees/pi-permission-system.json).

## [0.2.0] - 2026-08-14

### Changed

- Synced the fork with upstream pi-permission-system v25.2.0 while preserving the local wrapper-floor behavior.

### Upstream provenance

- Upstream v25.2.0: [source 87d69d292f44](https://github.com/gotgenes/pi-packages/tree/87d69d292f4415443c9d3df17d14738d6a9c2347/packages/pi-permission-system); [recorded sync metadata](https://github.com/xzzpig/pi-extensions/blob/55628f92cc0c7f60a9ecf1f52ea7f492ac3b2912/subtrees/pi-permission-system.json).

## [0.1.1] - 2026-08-09

### Added

- `permissions:forwarded_decision`, emitted by the serving parent after it
  persists a forwarded permission response. The public payload carries the
  request ID, forwarding context, parent response outcome and resolution, and
  responder session ID without changing `permissions:decision` semantics.
