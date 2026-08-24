# Model-context accounting (PR D)

Measures the COMPLETE model-facing request — extension-injected system block,
post-hook message list, and ACTIVE tool schemas — not isolated prompt strings.

    npm run context:measure   # re-capture all fixtures -> baseline-main.json
    npm run context:gate      # deterministic equality + invariants (CI-safe)

## Layout

- `fixtures.mjs` — 22 deterministic scenarios (fixed ids/timestamps).
- `capture-context.mjs` — drives the real extension handlers over a fixture;
  returns { baseSystem, extensionSystem, messages, tools }. Pure function
  calls; no network, no child agent, no live model.
- `measure-context.mjs` — ContextSizeBreakdown + serializeRequest.
- `semantic-invariants.mjs` — SemanticOccurrenceCounts (objective, contracts,
  current task, lifecycle policy markers, checkpoint/unfocused/stale markers).
- `run-measure.mjs` / `run-gate.mjs` — the two npm scripts.
- `baseline-main.json` — committed artifact; update ONLY with a spec rationale
  in specs/2026-08-23-model-context-accounting/CONTEXT-BASELINE.md.

## Notes

- estimatedTokens = chars/4 heuristic (documented estimate, not live usage).
- Tool schemas are ~7.3K chars on every request — the component B4 never saw.
- Post-issue-#30 invariant enforced by the gate: historical checkpoint payload
  visible to the provider must be 0 chars on every fixture.
