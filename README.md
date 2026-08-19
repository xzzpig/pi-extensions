# pi-extensions

A monorepo of independently installable [Pi](https://pi.dev/) coding agent
extensions. Every package under `packages/pi-*` can be installed on its own —
install only what you need.

> [!IMPORTANT]
> Pi extensions run with your full user permissions. Review an extension
> before installing it from any third party.

## Available packages

Packages can be installed from npm after a release, or from a local checkout
while developing changes.

| Package                                                           | What it does                                                                                                                                                                                                                  | Install                                       |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| [`@xzzpig/pi-permission-system`](./packages/pi-permission-system) | Permission enforcement for the Pi coding agent; local fork of `@gotgenes/pi-permission-system` with configurable wrapper flooring.                                                                                            | `pi install npm:@xzzpig/pi-permission-system` |
| [`@xzzpig/pi-notify`](./packages/pi-notify)                       | Cross-device notifications for Pi: OSC terminal notifications, ntfy push channels, semantic Pi events, and Herdr blocked-state integration.                                                                                   | `pi install npm:@xzzpig/pi-notify`            |
| [`@xzzpig/pi-components`](./packages/pi-components)               | Internal shared transcript primitives for BTW and goal-x: bounded event capture, Pi-native message rendering, tool results, and a scroll viewport.                                                                            | Bundled with consumers                        |
| [`@xzzpig/pi-tool-display`](./packages/pi-tool-display)           | OpenCode-style compact tool rendering and edit/write diff visualization; local fork of `MasuRii/pi-tool-display` with a tail-style live preview for running bash commands.                                                    | `pi install npm:@xzzpig/pi-tool-display`      |
| [`@xzzpig/pi-goal-x`](./packages/pi-goal-x)                       | Durable goal mode with tasks, auto-continue, and independent completion audit; local fork of `tmonk/pi-goal-x` with a TUI-overlay guard so Esc in other extensions' overlays never pauses the goal.                           | `pi install npm:@xzzpig/pi-goal-x`            |
| [`@xzzpig/pi-btw`](./packages/pi-btw)                             | Parallel side conversations in a focused `/btw` overlay; local fork of `dbachelder/pi-btw` that avoids clobbering pi-tui's mouse-reporting modes in fullscreen TUI (which broke message scrolling after closing the overlay). | `pi install npm:@xzzpig/pi-btw`               |
| [`@xzzpig/pi-starline`](./packages/pi-starline)                   | Starship-inspired statusline and Opencode-style editor chrome; local fork of `Andy8647/pi-starline` that runs git probes with `--no-optional-locks` so the statusline never churns `.git/index.lock`.                         | `pi install npm:@xzzpig/pi-starline`          |

## Install an extension

Install published packages:

```bash
pi install npm:@xzzpig/pi-permission-system
pi install npm:@xzzpig/pi-notify
pi install npm:@xzzpig/pi-tool-display
```

For local development from a checkout:

```bash
# Install a package permanently
pi install ./packages/pi-permission-system

# Or try it for a single session without installing
pi -e ./packages/pi-permission-system/src/index.ts
```

To load the notify extension from a Git checkout during local development, use a resource filter:

```json
{
  "packages": [
    {
      "source": "git:github.com/xzzpig/pi-extensions@main",
      "extensions": ["packages/pi-notify/extensions/index.ts"]
    }
  ]
}
```

See the [Pi packages documentation](https://pi.dev/docs/packages) for all
install options.

## Development

[`AGENTS.md`](AGENTS.md) is the orientation for developers and AI agents
working on this repository; the project skills in
[`.pi/skills/`](./.pi/skills) are the normative workflow documentation.
