# @xzzpig/pi-context-cap

> **Fork notice**: this package is a local fork (二开) of
> [@lukeramsden/pi-context-cap](https://github.com/lukeramsden/pi-context-cap)
> (MIT). It adds a model whitelist config file (`context-cap.json`) and a
> session tri-state toggle (`/context-cap on|off`) on top of the upstream
> behavior. Upstream maintenance is tracked via `git subtree` in the
> `pi-extensions` monorepo.

A [pi](https://github.com/earendil-works/pi) extension that enforces a context token budget by forcing compaction — including mid-turn during long tool loops — instead of riding a long-context model up to its full window. Without an explicit budget the cap **is the model's configured context window** (compacting at `window - reserve`, like pi's native threshold but enforced mid-loop); the 200k default only applies when the model does not expose a window.

## Why

Pi compacts when context passes `contextWindow - reserveTokens`. On a 1M-window model that means ~984k tokens: slow requests, degraded attention, and a large bill before the first compaction.

Two obvious workarounds don't work:

1. **Lowering `contextWindow`** (via `modelOverrides` or an extension) poisons output. Pi clamps every request's `max_tokens` to `contextWindow − estimatedInput − 4096`, floor 1 token. As usage nears a lowered cap, the output budget shrinks to nothing and turns die with _"Model stopped because it reached the maximum output token limit"_ — right before compaction would have fired. This extension leaves `model.contextWindow` untouched.
2. **Relying on pi's auto-compaction** misses long tool loops. Pi (as of 0.83.0) checks compaction only after a full agent run and before a new user prompt — never between LLM calls inside a tool loop. One long turn can grow unbounded until the provider rejects it (pi issues [#2871](https://github.com/earendil-works/pi/issues/2871), [#5512](https://github.com/earendil-works/pi/issues/5512), [#6879](https://github.com/earendil-works/pi/issues/6879)).

## How it works

The budget lives only in the extension. It triggers compaction from three hooks:

1. **`turn_end` with tool results** — mid-loop backpressure. `turn_end` fires after every LLM response inside a tool loop, and `getContextUsage()` includes estimated tokens for trailing tool results (the exact blind spot in pi's own check). Because `ctx.compact()` aborts the running agent, the extension sends a follow-up prompt after compaction so the task resumes (`resume off` to disable).
2. **`agent_settled`** — the run is done and pi will not continue on its own; compact quietly so the next prompt starts under budget.
3. **`session_start`** — a resumed session that is already over budget gets compacted immediately.

Compaction fires when estimated tokens exceed `budget − reserve`. Without an explicit budget, `budget` is the model's configured context window (e.g. a 365k-window model with the default reserve compacts at ~349k); the 200,000 default applies only when the model does not expose a window (200,000 − 16,384 ≈ 184k). A footer status line shows usage against the budget (`cap 132k/200k (66%)`), since pi's own percentage is relative to the model's real window.

Guards: no overlapping compactions, a 20k token growth requirement between retries after a failure, and the watcher disables itself for the session after two consecutive compaction failures. A failure that lands after pi's own auto-compaction already shrank the context (with a window-derived budget the two thresholds coincide, so pi's run-end check can compact first) is treated as benign: an info notice instead of an error, no failure counted.

## Known limit

The request that _crosses_ the threshold still goes out before its `turn_end` fires. Overshoot is bounded to roughly one request past the threshold — an extension cannot stop the loop before the next LLM call. Removing that needs a compaction check inside the agent loop itself; the enabling `shouldStopAfterTurn` hook is tracked in [#7299](https://github.com/earendil-works/pi/issues/7299) / [PR #7367](https://github.com/earendil-works/pi/pull/7367).

## Install

```bash
pi install npm:@xzzpig/pi-context-cap
```

Or try it for a single run without installing:

```bash
pi -e npm:@xzzpig/pi-context-cap
```

## Configure

CLI flags (set the session defaults):

```bash
pi --context-cap 150000 --context-cap-reserve 24000
```

### Configuration file

Persistent settings live in a `context-cap.json` file at two levels; project
values override global values **per key** (missing keys fall back to the lower
level, then to the defaults):

| Location                         | Scope   |
| -------------------------------- | ------- |
| `~/.pi/agent/context-cap.json`   | Global  |
| `<project>/.pi/context-cap.json` | Project |

Supported keys (all optional):

```json
{
  "models": ["openai-codex/*", "claude-*"],
  "budget": 150000,
  "reserve": 24000
}
```

- `models` — **model whitelist** (minimatch). Patterns match against
  `provider/modelId` (e.g. `openai-codex/*`) or a bare `modelId` (e.g.
  `claude-*`), following pi's `scopedModels`/`enabledModels` convention:
  matching is **case-insensitive**, and `*` does not cross `/` — use `**` for
  hierarchical ids from proxy providers (e.g. `new-api/**` or
  `new-api/ZhipuAI/*`). The guard is active only for models matching at least
  one pattern. Omit or leave empty to apply to **all** models. Invalid
  patterns are reported as a warning and treated as non-matching.
- `budget` — token budget enforced by forced compaction. When omitted (or set
  to `null`), the budget is the active model's configured context window —
  compaction then fires at `contextWindow - reserve`, mirroring pi's native
  threshold but enforced mid-loop (e.g. a 365k-window model with the default
  reserve compacts at ~349k). The 200000 default only applies when the model
  does not expose a window. Values must be positive integers; suffix strings
  like `"200k"` are rejected with a warning rather than silently truncated.
- `reserve` — headroom below the budget before compaction fires (default
  `16384`); must be smaller than `budget`. A `reserve >= budget` config error
  disables the guard for the session with a notification.

A key set to JSON `null` is treated as unset (handy for generated configs,
e.g. home-manager).

The compaction point is always clamped to `contextWindow - 4096` (4096 is
pi-ai's `CONTEXT_SAFETY_TOKENS`), so an explicit budget can never make the
guard fire outside the model's real window. A model whose window is too small
to leave that safety margin (or too small to host the configured reserve)
disables the guard for that model — `status` shows the reason. The model
window is read, never modified, and budget derivation picks up model switches
immediately.

The project file is only read when the project is trusted. Invalid JSON or
wrong types are skipped with a warning; the session keeps the remaining
configuration sources.

### Session switch

`/context-cap` supports a **tri-state session override** that can force the
guard on or off regardless of the whitelist, resetting when the session ends:

| Command                                 | Effect                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `/context-cap` or `/context-cap status` | Show budget, threshold, usage, and the effective state with its reason |
| `/context-cap <tokens>`                 | Set the budget (e.g. `/context-cap 150000`, session only)              |
| `/context-cap off`                      | Force the guard off for this session (ignores usage and whitelist)     |
| `/context-cap on`                       | Force the guard on for this session (ignores the whitelist)            |
| `/context-cap default`                  | Back to default: follow the model whitelist                            |
| `/context-cap resume on\|off`           | Toggle the auto-resume prompt after mid-task compaction                |

`/context-cap <tokens>` and the session switch last only for the current
session; they are never written to a config file.

## Verify

```bash
npm run verify
```

Type-checks the extension and runs a headless functional test with a mocked pi API — no pi binary, models, or API keys required.

## License

MIT
