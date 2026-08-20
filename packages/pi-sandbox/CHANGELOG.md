# Changelog

All notable changes to the `@xzzpig/pi-sandbox` fork are documented here.
This fork tracks [`carderne/pi-sandbox`](https://github.com/carderne/pi-sandbox)
via git subtree; entries below describe only fork-specific deviations from
upstream.

## 0.1.0

### Added

- **Optional pi-tool-display bash rendering integration.** After registering
  the sandboxed `bash` tool, the fork reaches pi-tool-display's decoration API
  through a guarded dynamic import of
  `pi-tool-display/tool-display-api-consumer` and decorates the tool with
  `{ kind: "bash", overrideExistingRenderers: true }` — pi-tool-display takes
  over rendering (spinner + elapsed time, configurable output modes) while the
  fork keeps full control of execution and permission handling. There is no
  hard dependency: when pi-tool-display is absent (import fails) or loads
  later (decoration queued and drained once the API is installed), the bash
  tool safely keeps pi's built-in default rendering and sandbox behavior is
  unchanged. The integration is documented in the README, including the
  coexistence requirement to keep `pi-tool-display`'s
  `registerToolOverrides.bash` set to `false` so pi-tool-display does not
  register its own (non-sandboxed) bash tool.

### Changed

- Initial fork of `carderne/pi-sandbox` v0.6.5, published as
  `@xzzpig/pi-sandbox`.