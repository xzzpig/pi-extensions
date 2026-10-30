# Starline

<p align="center">
  <img src="https://raw.githubusercontent.com/Andy8647/pi-starline/main/assets/cover.png" alt="pi-starline: a statusline you can click" width="840">
</p>

A Starship-inspired statusline, Opencode-style editor chrome, and fullscreen mouse control for [Pi](https://pi.dev).

Starline makes Pi's fullscreen mode feel like a finished terminal app:

- **See the state:** a pill footer with directory, git, runtime, model, context and cost; click one for the numbers behind it.
- **Act on it:** click a pill to switch model or thinking level, see what is queued, or list running subagents.
- **Type comfortably:** a compact bordered input box, paste collapse, and a `ctrl+g` hint for your `$EDITOR`.
- **Drive with the mouse:** select and copy anywhere, click to move the caret, wheel to scroll the draft.

## Features

**Footer**

- Starship-style segments: directory, git, runtime (57 runtimes), model, context, cost, plus optional session name, `user@host`, time, OS, session duration and project version.
- A colour palette with `$name` references; the bar is built from `pill.segments`, in your order.
- One `git` pill: branch, dirty markers and any operation in progress together. Click it for the changed files, ahead/behind and stashes. The list is read-only, because an agent may be running in the same tree.
- One `context` pill: the percentage, and nothing else. Click it for the window size, tokens used, session in/out totals and the cache rate.
- Other extensions' statuses from `ctx.ui.setStatus()` as pills, on either side or in the middle.
- The model pill's icon spins while the agent works, and the pill counts the run's elapsed time; when the run ends the number stays as the total it reached.
- No git pill on the bar means no `git status`: the refresh only reads the repository when something on the bar shows it.

**Clickable pills**

- **Model:** pick from your scoped models (the ones ctrl+p cycles).
- **Thinking:** pick a level from the ones the model supports.
- **Queue:** an inbox icon and a count while messages wait; click to read them.
- **Subagents:** with [pi-subagents](https://github.com/nicobailon/pi-subagents), a count of running subagents; click for agent, model, time and tokens, live.
- **Your extension's pill:** a small published API lets any extension open the same bubble with its own content. See [Clickable pills for other extensions](https://github.com/Andy8647/pi-starline/blob/main/docs/pill-api.md).
- Clicking anywhere else on screen closes the bubble, and the click still does what it would have done: the caret moves, the line gets selected.
- Every action also runs from the keyboard as `/starline <name>`, and the pointer turns into a hand over anything clickable.

**Editor**

- Bordered input box with an accent rail, as tall as its text; paste, selection and `ctrl+g` hints ride its top rule. `editorMinRows` keeps it a fixed minimum height.
- This fork retains Starline's full-width user-message rails and their existing colour and padding settings. If pi-tidy also styles messages, the visible renderer can depend on load order; set `tidy.userMessageStyle` to `"off"` in Pi's `settings.json` to leave user messages to Starline.
- Copy-friendly mode drops the rail glyphs so terminal selection copies less chrome.

**Mouse** (Pi's `tuiMode: "fullscreen"`)

The fork's mouse enhancements use [`@xzzpig/pi-mouse-events`](https://www.npmjs.com/package/@xzzpig/pi-mouse-events) rather than installing a competing mouse patch. Install it alongside Starline; without it, these enhancements and pill click-away are disabled. Pi's own component clicks remain available. Version 0.3.0 or newer also shares pointer shapes, uses Pi's native clipboard when available, and routes editor scrolling with Pi's calculated wheel delta; older v2 installations fall back to the previous copy and wheel paths.

- Drag to select in the transcript or the draft; double-click keeps paths and kebab-case whole; triple-click takes a line.
- Clean copies: Starline's rails and rule rows and pi-toolbox frames are dropped before the clipboard.
- A selection hint says how many characters the copy key will copy.
- Click a tool, bash box, skill or summary to toggle that component; drag selection and links remain available.
- Click to move the caret; backspace/delete remove a selected range; the wheel scrolls the draft.

## Screenshots

<p align="center">
  <img src="https://raw.githubusercontent.com/Andy8647/pi-starline/main/assets/starline.png" alt="Starline in a pi session: transcript, editor frame and pill bar" width="840">
</p>

A session as a whole: the transcript above, the editor frame in the middle, the bar along the bottom.

## Install

Needs **Pi 1.x** and a [Nerd Font](https://www.nerdfonts.com/) (or set `icons.mode` to `"ascii"`).

```bash
# From npm (local fork @xzzpig/pi-starline)
pi install npm:@xzzpig/pi-starline

# For fork mouse enhancements and shared pill interaction
pi install npm:@xzzpig/pi-mouse-events

# Or install the separate upstream package from git
pi install git:github.com/Andy8647/pi-starline
```

What changed in each version: **[Changelog](https://github.com/Andy8647/pi-starline/blob/main/CHANGELOG.md)**.

## Configure

`/starline` opens a menu for the everyday settings: colour sources, feature toggles, the order of the bar (`Pills`), and where other extensions' statuses go. The `Pills` tab is the bar itself: one row per segment, its value is the position it holds, and every status an extension published this session gets a row of its own, so one of them can be placed without editing JSON.

Everything else lives in `~/.pi/agent/starline.json`. The file is optional; missing keys fall back to defaults.

```json
{
	"pill": { "segments": ["model", "cwd", "git", "context", "cost"] },
	"colors": { "gitBranch": "bold purple" },
	"mouse": { "clickToToggleExpandable": false }
}
```

## Docs

- [Configuration](https://github.com/Andy8647/pi-starline/blob/main/docs/configuration.md): every option and its default.
- [What the footer shows](https://github.com/Andy8647/pi-starline/blob/main/docs/segments.md): git status indicators and the detected runtimes.
- [Clickable pills for other extensions](https://github.com/Andy8647/pi-starline/blob/main/docs/pill-api.md): put your extension's content in a pill.
- [Clickable pills: design](https://github.com/Andy8647/pi-starline/blob/main/docs/clickable-pills.md): how the pills, bubbles and bridges work.

## Development

```bash
npm install
npm run verify       # lint, typecheck, tests
npm run pi:dev       # run Pi with this checkout and no other extensions
```

`pi:dev` uses the globally installed Pi; set `PI_BIN=/path/to/pi` to use another.

## Credits

Started as a fork of [pi-zentui](https://github.com/lmilojevicc/pi-zentui) by Luka. Inspired by [Starship](https://starship.rs/) and [Opencode](https://github.com/opencode-ai/opencode).

## License

MIT

## Compatibility: explicit expand targets (fork-only)

This fork's click-to-expand resolution (`mouse/tool-box.ts`) checks an
optional, versioned **explicit expand-target protocol** before its own
`setExpanded`/hint logic:

- Providers publish a resolver on a component instance under
  `Symbol.for("@xzzpig/transcript-expand-target.v1")` with
  `{ version: 1, resolveLocalTarget(localRow, width) }`. The consumer is
  `mouse/explicit-expand-target.ts` (fork-only file).
- Today the only provider is
  [`@xzzpig/pi-group-collapse`](../pi-group-collapse): its group summaries
  resolve to the independent group object, so clicking a summary toggles
  the group instead of the tool that carries it.
- Without a provider nothing changes: no published protocol, a wrong
  version, a non-callable resolver, a thrown resolution, or an invalid
  resolved shape all fall through to the existing resolution. Installing
  the provider is never required, and load order in either direction
  works (the resolver is read per click, not cached).
- Drag selection, double-click word selection, hyperlinks, wheel, and
  overlay behavior are unaffected; the explicit target only answers for
  the specific local rows it owns.
