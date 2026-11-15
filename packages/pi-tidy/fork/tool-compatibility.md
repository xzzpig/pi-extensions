# Tool renderer coexistence

The fork defaults leave write rendering to Pi or the owning extension, such as
pi-tool-display. This avoids showing both tidy's call-body preview and Tool
Display's result diff for the same write.

To restore tidy's write call preview, merge this into the agent `settings.json`
and run `/reload`:

```json
{ "tidy": { "writePreview": true, "writeLines": 10 } }
```

`writePreview` defaults to `false`; only a boolean `true` enables it. The legacy
`toolbox` object also accepts the key when `tidy` is absent. `writeLines` alone
never enables the preview, and setting it to `0` is not equivalent to disabling
it (expanded previews would still display the body). To turn the preview off,
set `writePreview: false` and reload. This switch does not control tool frames:
leave `frameTools: false` when another extension should own those too.

## Audit of other tools

- **write:** disabled by default. No write resolver is installed; the owner's
  call, result, shell and execution remain intact. Explicit opt-in replaces only
  the call preview and can intentionally duplicate a result diff.
- **bash:** `highlightBash: false` preserves the owner's call renderer (including
  sandbox/Tool Display command presentation). Tidy still wraps the result to
  lower nested `maxVisualLines` budgets to `bashResultLines` (default 1). The
  downstream renderer runs exactly once; expanded output and errors are not
  shrunk. Tool Display's renderer does not expose this native preview structure,
  so the walk normally has nothing to change there. With other renderers using
  that structure, a smaller collapsed preview is expected. Enabling highlighting
  replaces the owner's command display, so its spinner/command-specific styling
  may be lost; keep it disabled for Tool Display ownership.
- **edit, read, grep, find, ls and extension tools:** no dedicated Tidy resolver;
  their renderer sets pass through unchanged. `frameTools`, `groupTools` and
  `collapseTurns` are separate opt-ins which can restyle or hide tool components.
- **diffs:** `splitDiff: false` avoids Tidy's side-by-side diff conversion. With
  tool frames off, Tool Display keeps its own diff layout.

Regression tests cover both extension load orders with actual Tool Display
registrations, real Pi tool-component rendering, one result body when collapsed
and expanded, successful filesystem writes and error display. These are automated
component/integration tests, not a recorded interactive-terminal acceptance run.
