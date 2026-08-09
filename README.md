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

| Package                                                                     | What it does                                                                                                                       | Install                                            |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| [`@xzzpig/pi-permission-system`](./packages/pi-permission-system)           | Permission enforcement for the Pi coding agent; local fork of `@gotgenes/pi-permission-system` with configurable wrapper flooring. | `pi install npm:@xzzpig/pi-permission-system`      |
| [`@xzzpig/pi-terminal-notifications`](./packages/pi-terminal-notifications) | Desktop notifications and Herdr blocked-state integration for Pi ask and permission prompts.                                       | `pi install npm:@xzzpig/pi-terminal-notifications` |

## Install an extension

Install published packages:

```bash
pi install npm:@xzzpig/pi-permission-system
pi install npm:@xzzpig/pi-terminal-notifications
```

For local development from a checkout:

```bash
# Install a package permanently
pi install ./packages/pi-permission-system

# Or try it for a single session without installing
pi -e ./packages/pi-permission-system/src/index.ts
```

To load the terminal-notifications extension from a Git checkout during local development, use a resource filter:

```json
{
  "packages": [
    {
      "source": "git:github.com/xzzpig/pi-extensions@main",
      "extensions": ["packages/pi-terminal-notifications/extensions/index.ts"]
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
