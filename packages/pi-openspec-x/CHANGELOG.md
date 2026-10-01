# Changelog

## 0.1.0

Initial release.

- Official-track skills extracted from the installed OpenSpec CLI, cached by
  CLI version under `<agentDir>/cache/pi-openspec-x/skills/<version>/`.
- `/opsx:plan`: planner sandbox mode, append-only per-artifact instruction
  injection, gap analysis, plan review gate, user approval gate.
- `/opsx:implement`: agent (opsx-agent + opsx-worker dispatches) and direct
  main-session modes on a pi-goal-x execution base, with a final completion
  audit pointing at the read-only opsx-reviewer.
- Runtime-registered opsx subagents and structured reporting tools.
- Versioned lifecycle bus events and a literal pi-notify bridge.
