# pi-extensions

A monorepo of independently installable [Pi](https://pi.dev/) coding agent
extensions. Every package under `packages/pi-*` can be installed on its own —
install only what you need.

> [!IMPORTANT]
> Pi extensions run with your full user permissions. Review an extension
> before installing it from any third party.

## Available packages

Packages are not published to the npm registry yet; install them from a local
checkout of this repository.

| Package | What it does | Install |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------- |
| [`pi-permission-system`](./packages/pi-permission-system) | Permission enforcement for the Pi coding agent (upstream `@gotgenes/pi-permission-system`). | `pi install ./packages/pi-permission-system` |

## Install an extension

From a local checkout of the repository:

```bash
# Install a package permanently
pi install ./packages/pi-permission-system

# Or try it for a single session without installing
pi -e ./packages/pi-permission-system/src/index.ts
```

See the [Pi packages documentation](https://pi.dev/docs/packages) for all
install options.

## Development

[`AGENTS.md`](AGENTS.md) is the orientation for developers and AI agents
working on this repository; the project skills in
[`.pi/skills/`](./.pi/skills) are the normative workflow documentation.
