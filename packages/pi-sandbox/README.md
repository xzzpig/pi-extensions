# pi-sandbox

Sandbox for [pi](https://pi.dev/).

Sandboxes pi like this:
- read/write/edit: direct control using allow/deny lists
- bash: uses [`@xzzpig/sandbox-runtime`](https://www.npmjs.com/package/@xzzpig/sandbox-runtime) to control network and file system access

When a blocked action is attempted, the user is
prompted to allow it temporarily or permanently rather than silently failing.

![demo](./demo/demo.gif)

## Notes
There is an example config at [sandbox.json](./sandbox.json). It was quite a few things added to get this extension to work with [agent-browser](https://agent-browser.dev/) and other common tools.

These open significant security loopholes, so shouldn't be used in a sensitive context or when you don't need browser support.

You may need to trial and error to find additional things you need to allow.

## Quickstart

#### Prerequisites

`pi-sandbox` delegates the OS-level bash sandbox to
[`@xzzpig/sandbox-runtime`](https://www.npmjs.com/package/@xzzpig/sandbox-runtime),
published from the fork at <https://github.com/carderne/sandbox-runtime>,
which is forked from Anthropic's
[`anthropic-experimental/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime).
The sandbox runtime checks for [`ripgrep`](https://github.com/BurntSushi/ripgrep) (the
`rg` binary) on **both macOS and Linux** at sandbox-init time. If `rg`
is not on the `PATH` that pi was launched with, sandbox initialization
fails with:

```
Sandbox initialization failed: Sandbox dependencies not available: ripgrep (rg) not found
```

Install ripgrep before enabling the extension:

| Platform | Install |
|---|---|
| macOS (Homebrew) | `brew install ripgrep` |
| macOS (MacPorts) | `sudo port install ripgrep` |
| Linux (Debian/Ubuntu) | `sudo apt install ripgrep` |
| Linux (Fedora/RHEL) | `sudo dnf install ripgrep` |
| Linux (Arch) | `sudo pacman -S ripgrep` |
| From source / other | <https://github.com/BurntSushi/ripgrep#installation> |

If `which rg` succeeds in your shell but pi still reports `rg not
found`, pi is being launched from a parent process whose `PATH` does
not include the directory containing `rg` (common when GUI launchers
inherit a minimal non-login `PATH`). On macOS, `/opt/homebrew/bin` and
`/usr/local/bin` are the usual culprits — make sure your launcher's
environment includes whichever one your install uses.

#### Install
```bash
pi install npm:@xzzpig/pi-sandbox
```

#### Configure
Add a config like this either to Pi's global agent directory (by default, `~/.pi/agent/sandbox.json`; respects `PI_CODING_AGENT_DIR`) or to `.pi/sandbox.json` (local).
Scalar settings in the local config take precedence over global settings. The
path and domain arrays from both files are combined and deduplicated, so a
project can add permissions without repeating the global configuration. Built-in
defaults are used for an array only when neither file configures it.

Note below that the order of precedence for filesystem read and write are opposite.

```json
{
  "enabled": true,
  "permissionPromptTimeoutSeconds": 600, // Defaults to 10 minutes; 0 waits indefinitely
  "allowBrowserProcess": true,     // If you want to use agent-browser or similar Chrome setup
  "network": {
    "allowLocalBinding": true,     // ditto
    "allowAllUnixSockets": true,   // ditto
    "allowUnauthenticatedSocksProxy": true, // Enables Git-over-SSH on macOS
    "allowedDomains": ["github.com", "*.github.com"],
    "deniedDomains": []
  },
  "filesystem": {
    // For READS:
    // - ANY read is prompted unless the path is in allowRead or allowWrite
    // - Granting a prompt adds to allowRead, which overrides denyRead
    // - denyRead is not a hard-block; it just marks regions as denied by default
    "denyRead": ["/Users", "/home"],
    "allowRead": [".", "~/.config", "~/.local", "Library"],

    // For WRITES:
    // - allowWrite also grants read access to the same paths
    // - empty ALLOW means no write access at all
    // - DENY takes precedence and is never prompted
    "allowWrite": [".", "/tmp"],
    "denyWrite": [".env", ".env.*", "*.pem", "*.key"],

    // Linux/bwrap only. Defaults to false so tools like `git status` and lint
    // glob scans see the real directory while a sandboxed command runs.
    // The runtime default (when this option is absent) is true, which mounts
    // read-only placeholders for not-yet-existing dangerous files (.bashrc,
    // .mcp.json, …) and leaves temporary mount-point files on the host during
    // the command's execution.
    // Set to true to also prevent sandboxed commands from creating those files
    // inside allowed write paths. With the default false, literal denyWrite
    // paths that do not exist yet (built-in defaults or your own entries) are
    // neither created nor protected; existing files are always protected.
    "protectNonexistentFiles": false
  }
}
```

#### Usage

```
pi --no-sandbox                  disable sandboxing for the session
Alt+S                            toggle sandboxing on/off for the session
/sandbox                         show current configuration and session allowances
/sandbox-enable                  enable the sandbox for this session
/sandbox-disable                 disable the sandbox for this session
/sandbox-allow domain <url>      prompt to add a domain to allowedDomains
/sandbox-allow read <path>       prompt to add a path to allowRead
/sandbox-allow write <path>      prompt to add a path to allowWrite
```

## What it does

### Optional rendering with @xzzpig/pi-tool-display

This fork keeps full control of bash execution and permission handling. When
the optional `@xzzpig/pi-tool-display` package is also installed, the
registered bash tool is decorated with pi-tool-display's compact bash
renderer (spinner + elapsed time, configurable output modes) — execution
logic is untouched. The decoration is fully optional:

- **Without pi-tool-display** (package not installed, or import failing):
  bash keeps pi's built-in default rendering and sandbox behavior is
  unchanged.
- **With pi-tool-display**: bash shows the compact display while remaining
  sandboxed. When using a pi-tool-display fork that also overrides the
  built-in `bash` tool, set `registerToolOverrides.bash` to `false` in its
  config so pi-tool-display does not register its own (non-sandboxed) bash
  tool.

There is no hard dependency: the integration uses a guarded dynamic import of
`pi-tool-display/tool-display-api-consumer` at runtime and never fails the
extension load when the package is absent.

**Bash commands** are wrapped with `sandbox-exec` (macOS) or `bubblewrap`
(Linux) to enforce network and filesystem restrictions at the OS level.

**Read, write, and edit tool calls** are intercepted before execution and
checked against the same filesystem policy. The OS-level sandbox cannot cover
these tools because they run directly in the Node.js process rather than in a
subprocess.

When a block is triggered, a prompt appears with four options. Permission prompts
automatically select **Abort (keep blocked)** after 10 minutes by default. Set
`permissionPromptTimeoutSeconds` to a positive number to use a different timeout,
or set it to `0` to wait indefinitely. A timeout never grants permission.

- Abort (keep blocked)
- Allow for this session only
- Allow for this project — written to `.pi/sandbox.json`
- Allow for all projects — written to Pi's global agent directory (by default, `~/.pi/agent/sandbox.json`; respects `PI_CODING_AGENT_DIR`)

**Session allowances** are held in memory only. They are never written to disk
and the agent has no way to read or modify them. They are reset when the
extension reloads or pi restarts.

### What is prompted vs. hard-blocked

| Rule | Behaviour |
|------|-----------|
| Domain not in `allowedDomains` | Prompted (bash and `!cmd`) |
| Path not in `allowRead` or `allowWrite` | Prompted (read tool); granting adds to `allowRead` |
| Path not in `allowWrite` | Prompted (write/edit tools and bash write failures) |
| Path in `denyWrite` | Hard-blocked, no prompt |
| Domain in `deniedDomains` | Hard-blocked at OS level, no prompt |

If a path is added to `allowWrite` via a prompt but is also present in
`denyWrite`, it remains blocked. A warning is shown explaining which config
files to check.

`allowedDomains` supports `*.example.com` wildcards. It also supports `"*"` to
allow all domains; pi-sandbox shows a warning when this is configured because it
removes per-domain prompts and can be easy to add accidentally. `allowWrite` uses prefix
matching, so `.` covers the entire current working directory. Write access also
implies read access; paths do not need to be repeated in `allowRead`.

`allowUnauthenticatedSocksProxy` is enabled by default on macOS so Git-over-SSH
works with the built-in `nc`. Domain filtering still applies, but another local process
that discovers the temporary proxy port can use it while the sandbox is running.

> **⚠️ Read and write have different precedence rules:**
>
> - **Read:** Every read is prompted unless the path is in `allowRead` or `allowWrite`.
>   `denyRead` is not a hard-block — it marks regions as denied by default, but
>   granting a prompt adds the path to `allowRead`, overriding `denyRead`.
> - **Write:** `denyWrite` takes precedence over `allowWrite` and is never
>   prompted. A path in `denyWrite` is always blocked, even if it matches
>   `allowWrite`.

On Linux (bwrap), the sandbox also protects dangerous files (`.bashrc`,
`.gitconfig`, `.mcp.json`, …) that do not exist yet inside allowed write paths.
`filesystem.protectNonexistentFiles` defaults to `false` here so no
placeholder files appear in the working directory while a sandboxed command runs
(placeholder mount points would show up as empty dotfiles to `git status`, lint
glob scans, etc.). Set it to `true` to also prevent sandboxed commands from
creating those files inside allowed write paths.

With the default `false`, any literal `denyWrite` path that does not exist yet —
whether from the built-in defaults (`.env`, `.env.*`, `*.pem`, `*.key`) or from
your own configuration — is neither created nor protected: sandboxed commands
can create and write such files freely, and no placeholder appears. Paths that
already exist on disk (including dangling symlinks) are always protected
regardless of this setting. Glob patterns in `denyWrite` are unaffected by this
option (they are skipped on Linux anyway), and the option has no effect on macOS
or Windows.

If neither file configures an array, its built-in defaults apply (see above for
the defaults). Once an array is configured, only its combined global and local
entries are used, so an explicit empty array disables that default.

The footer shows a lock indicator while the sandbox is active.

## Ackowledgements
Based on code from
[badlogic/pi-mono](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts)
by Mario Zechner, used under the
[MIT License](https://github.com/badlogic/pi-mono/blob/main/LICENSE).
