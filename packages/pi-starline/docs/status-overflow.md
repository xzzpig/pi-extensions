# Status overflow and the status panel (fork-only)

Starline keeps the pill bar on a single row. When the configured segments do
not fit, the bar used to cut the row at the terminal edge, which deleted later
pills without saying so. This fork governs that row instead:

- a pill's content is capped by display columns, with `…` (`...` in ascii mode);
- pills that cannot fit are replaced by one `+N` pill;
- `/starline statuses` opens every status, untruncated, in a bounded, scrollable
  panel.

Configuration lives in `pill.overflow`; see the fork sections of
[configuration](./configuration.md).

## What "full text" means

The panel shows **the text an extension published through `ctx.ui.setStatus()`**,
after Starline's existing safety cleaning, and nothing more.

Starline never invents data. If a publisher sends `3 agents`, the panel shows
`3 agents`, not the three agents' names; the publisher's own action (the pill's
click, or Enter in the panel) is how you reach its detail view. Likewise the
`formats: value` setting only changes what the bar draws: the panel keeps the
published words.

The snapshot is built in memory for the current session only. It is not written
to disk, not logged, and not sent to the model.

## Reading behaviour of the panel

The entry you are on is filled across the whole row — the theme's accent colour
with dark or light text picked for contrast, or reverse video when the theme has
no background to give — so the block reads as one selected unit rather than as a
marked line. The pointer moves that highlight too: whatever entry it is over
becomes the selected one, without scrolling the list under a resting pointer.

The panel keeps the _reading position_, not a row number: it anchors on the
entry that is under the eye plus the offset inside it. A status that grows or
shrinks above the viewport, or a re-wrap after resizing the terminal, leaves the
same text where it was; and when the entry you are on disappears, the selection
moves to the entry that took its place rather than jumping to the top.

Keys: ↑/↓ scroll one visual line and keep the selected entry's identity,
Shift+↑/↓ step the selection, PgUp/PgDn page, Home/End jump to the first or last
entry, the wheel scrolls, `Tab` expands the other-statuses group, `Enter` runs the
selected entry's action, and `Esc` closes.

The box also degrades instead of overflowing: below ten columns it drops its
side padding, below five it drops the borders, and it never draws more rows than
the terminal has — the hint row shortens to fit rather than being cut mid-glyph.

Every entrance hands over the same way: the `+N` pill, a shortened pill with no
action, `/starline statuses` and the settings row all close Starline's own pill
bubble first, then check whether another dialog is already on screen (through
`@xzzpig/pi-mouse-events`' published API when it is installed). If one is, the
entrance stays quiet — no panel, no notice — because the panel cannot be shown
over it; closing our own bubble first is what keeps that check honest, since the
bubble is an overlay too.

The same entrance toggles: pressing `+N` again, or running `/starline statuses`
while the panel is open, puts the panel away. Asking for a _different_ entry
replaces the open panel with one focused there. A click anywhere outside the
panel's rows — its frame, the space around it, the bar underneath — dismisses it,
and that click is claimed so it cannot fall through and reopen what it closed.

Clicking an entry runs it when it has an action, exactly like `Enter`: the
pointer already selected it, so a click that did nothing would look broken. It
runs the way a pill click does, so `model` and `thinking` open their pickers
instead of stepping to the next value (the bare `/starline model` command still
steps). Entries with no action only take the selection.

## Publication order and identity

A status's configuration key is `extensionStatus:<key>`, while the pill's action
still resolves through the status key itself, so nothing about the published
action protocol changes. Explicitly placing `extensionStatus:<key>` and also
listing the `extensionStatus` wildcard draws the status once, at the explicit
position.

## Configuration

```json
{
	"pill": {
		"overflow": {
			"enabled": true,
			"maxContentWidth": 32,
			"extensionMaxContentWidth": 28,
			"maxWidths": { "cwd": 24, "git": 24, "extensionStatus:mcp": 20 },
			"priorities": { "queue": 100, "model": 80, "context": 80 },
			"pinned": ["model", "context"]
		}
	}
}
```

| Key                        | Default | What it does                                                                               |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `enabled`                  | `true`  | Govern the row. `false` restores the old single truncation (the panel still works).        |
| `maxContentWidth`          | `32`    | Content cap for built-in pills, icon included.                                             |
| `extensionMaxContentWidth` | `28`    | Content cap for third-party statuses, icon included.                                       |
| `maxWidths`                | —       | Per-key cap. Ships with `cwd: 24` and `git: 24`, so overriding one keeps the other.        |
| `priorities`               | —       | Per-key retention priority. Ships with `queue: 100`, `model`/`context`: `80`; others `50`. |
| `pinned`                   | `[]`    | Keys kept ahead of unpinned keys of the same priority.                                     |

Keys are segment names (`cwd`, `git`, `model`, …) or `extensionStatus:<key>`.
A key that is not published yet keeps its entry and starts applying once that
status appears. Each field falls back on its own: one invalid width does not
discard a valid priority list.

Retention is a **strict prefix** of that order. The bar keeps the highest
entries that fit, then draws them back in their original positions, so a pill
never changes column just because a status got shorter. The price is that a
low-priority short pill is not squeezed into space a high-priority long one
could not use: the row may end with a few free columns.

`fits` is decided with the real renderer, so arrows, caps and same-background
dividers are counted. When even one pill plus `+N` does not fit, the bar draws
`+N` alone, then `+`, then nothing; the panel remains reachable through
`/starline statuses`.

## `/starline` settings

The settings screen exposes the switch, the third-party cap, and per-status
priority and pinning for the statuses the session has published. Per-key widths
stay in JSON, where the key table is easier to read.
