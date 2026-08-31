# @lukeramsden/pi-context-cap

A [pi](https://github.com/earendil-works/pi) extension that enforces a context token budget (default **200k**) by forcing compaction — including mid-turn during long tool loops — instead of riding a long-context model up to 1M tokens.

## Why

Pi compacts when context passes `contextWindow - reserveTokens`. On a 1M-window model that means ~984k tokens: slow requests, degraded attention, and a large bill before the first compaction.

Two obvious workarounds don't work:

1. **Lowering `contextWindow`** (via `modelOverrides` or an extension) poisons output. Pi clamps every request's `max_tokens` to `contextWindow − estimatedInput − 4096`, floor 1 token. As usage nears a lowered cap, the output budget shrinks to nothing and turns die with *"Model stopped because it reached the maximum output token limit"* — right before compaction would have fired. This extension leaves `model.contextWindow` untouched.
2. **Relying on pi's auto-compaction** misses long tool loops. Pi (as of 0.83.0) checks compaction only after a full agent run and before a new user prompt — never between LLM calls inside a tool loop. One long turn can grow unbounded until the provider rejects it (pi issues [#2871](https://github.com/earendil-works/pi/issues/2871), [#5512](https://github.com/earendil-works/pi/issues/5512), [#6879](https://github.com/earendil-works/pi/issues/6879)).

## How it works

The budget lives only in the extension. It triggers compaction from three hooks:

1. **`turn_end` with tool results** — mid-loop backpressure. `turn_end` fires after every LLM response inside a tool loop, and `getContextUsage()` includes estimated tokens for trailing tool results (the exact blind spot in pi's own check). Because `ctx.compact()` aborts the running agent, the extension sends a follow-up prompt after compaction so the task resumes (`resume off` to disable).
2. **`agent_settled`** — the run is done and pi will not continue on its own; compact quietly so the next prompt starts under budget.
3. **`session_start`** — a resumed session that is already over budget gets compacted immediately.

Compaction fires when estimated tokens exceed `budget − reserve` (defaults: 200,000 − 16,384 ≈ 184k). A footer status line shows usage against the budget (`cap 132k/200k (66%)`), since pi's own percentage is relative to the model's real window.

Guards: no overlapping compactions, a 20k token growth requirement between retries after a failure, and the watcher disables itself for the session after two consecutive compaction failures.

## Known limit

The request that *crosses* the threshold still goes out before its `turn_end` fires. Overshoot is bounded to roughly one request past the threshold — an extension cannot stop the loop before the next LLM call. Removing that needs a compaction check inside the agent loop itself; the enabling `shouldStopAfterTurn` hook is tracked in [#7299](https://github.com/earendil-works/pi/issues/7299) / [PR #7367](https://github.com/earendil-works/pi/pull/7367).

## Install

```bash
pi install npm:@lukeramsden/pi-context-cap
```

Or try it for a single run without installing:

```bash
pi -e npm:@lukeramsden/pi-context-cap
```

## Configure

CLI flags (set the session defaults):

```bash
pi --context-cap 150000 --context-cap-reserve 24000
```

`/context-cap` command (changes last for the current session):

| Command | Effect |
|---|---|
| `/context-cap` or `/context-cap status` | Show budget, threshold, usage, and state |
| `/context-cap <tokens>` | Set the budget (e.g. `/context-cap 150000`) |
| `/context-cap off` / `on` | Disable / re-enable enforcement |
| `/context-cap resume on\|off` | Toggle the auto-resume prompt after mid-task compaction |

## Verify

```bash
npm run verify
```

Type-checks the extension and runs a headless functional test with a mocked pi API — no pi binary, models, or API keys required.

## License

MIT
