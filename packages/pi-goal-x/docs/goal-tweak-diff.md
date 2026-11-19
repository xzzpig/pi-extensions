# Goal tweak diff review

`/goal-tweak` confirms an existing goal through an adjustment-specific dialog
instead of the goal-creation confirmation. The dialog is implemented by the
fork-only module `extensions/goal-tweak-confirmation.ts`; it presents the
effective candidate built by the caller and never recomputes goal semantics
itself.

## What the dialog shows

- **Diff (default):** the line-level change from the authoritative goal to the
  effective candidate. Removed lines use `-`, added lines use `+`, and unchanged
  stretches are omitted by the diff formatter. Symbols carry the meaning; color
  is only a secondary cue. At **120 or more content columns** (after the frame
  and padding), matching old/new semantic values appear side by side; at 119
  columns or fewer they appear one above the other. Tasks are matched by ID,
  not visual row position. Text reflow does not create changes.
- **Full modified goal:** the complete effective content after the tweak. The
  focusable row `View the full modified goal (read-only)` switches to it, and
  `Back to the change diff (read-only)` switches back. Viewing is read-only: it
  does not confirm, save, cancel, or start a new model turn.
- **Auditor state:** `● Auditor enabled` / `○ Auditor disabled` with the
  configured toggle key. Changing it rebuilds both views for the new choice
  before anything is applied.
- **Decision controls:** `Confirm — apply this tweak`,
  `Continue chatting — keep refining`, and `Cancel — discard this tweak`.

The two views keep separate scroll positions, and the selected option,
auditor choice, and any typed feedback draft survive view and auditor changes.

## Controls

| Key                              | Action                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| Enter                            | Activate the selected row: confirm, open the feedback editor, cancel, or toggle the view |
| Up / Down                        | Move between the four focusable rows                                                     |
| PgUp / PgDn, Ctrl+Up / Ctrl+Down | Scroll the proposal body; on very short terminals, scroll the whole dialog               |
| `a` (configurable)               | Toggle the completion auditor and rebuild the views                                      |
| Esc                              | Continue chatting with the draft intact; Esc never cancels or confirms                   |
| Enter in the feedback editor     | Continue chatting with the typed text; empty text is allowed                             |
| Esc in the feedback editor       | Return to the decision rows without losing the draft                                     |

Long content is windowed, never truncated: every diff/full line and every
decision row remains reachable by scrolling. When height permits, the decision
area stays fixed while the body scrolls. On very short terminals the entire
dialog becomes scrollable; the feedback editor keeps its cursor visible even
when only one row is available. The creation confirmation follows the same
height rules and retains blank lines in the proposal. The window is bounded to
the terminal height, honors narrow widths, and preserves a semantic reading
anchor across resize. Proposal text is displayed inertly: terminal control
sequences are stripped rather than interpreted. These keyboard controls also
work when mouse support is unavailable.

## Mouse in the Pi fullscreen TUI

The final `/goal` and `/goal-tweak` confirmations accept native Pi component
mouse events; no separate mouse plugin or global mouse interception is required.
Click a decision row to **select** it, then click `[Confirm selection]` (or press
Enter) to execute the highlighted choice. The initially highlighted choice is
already selected. Clicking the auditor label, or the tweak's read-only view
switch, changes only that pending display state. Narrow frames use compact
`[OK]` and `[A+]` / `[A-]` controls when the full labels do not fit.

Wheel movement inside the frame scrolls by the host's signed line delta and is
consumed at both ends so it does not scroll the chat behind the dialog. Presses
and drags remain available to Pi's text selection and links; double-clicking
does not activate a control. Confirm, auditor, and view clicks wait roughly
520 ms for double-click recognition. Closing, resizing, scrolling, changing the
selection/view, or an observed overlay change invalidates any old gesture. The
feedback editor receives its own visible mouse coordinates and retains the
native keyboard/IME behavior. Regular terminal mode and basic dialogs remain
fully usable by keyboard.

## Decisions and hosts

`showTweakProposalDialog(ctx, options)` resolves to the same decision shape as
`showProposalDialog`:

```ts
{
  decision: "confirm" | "continue" | "cancel",
  auditorEnabled: boolean,
  unavailable: boolean,
  feedback?: string,
}
```

- `confirm` applies the reviewed tweak; `continue` keeps it pending and returns
  trimmed feedback when the user typed any; `cancel` ends this tweak.
- Hosts with `ui.custom` but without a renderable TUI use a basic
  `ui.select` loop over the same two read-only views, auditor toggle, and
  decisions. Feedback uses the existing `ui.input` dialog when available.
- A host without UI, without `select`, or without a usable custom renderer is
  reported as `unavailable: true` with a non-approving `continue` decision. The
  component never approves a host it cannot present.
- Auto-confirm policy is not part of this module. The caller decides whether to
  show the dialog at all (`shouldAutoConfirmProposal`) and treats `unavailable`
  explicitly.

The caller supplies the effective candidate as two read-only strings. The Goal-X
adapter additionally supplies ephemeral `diffEntries` from the **same** semantic
comparison; string-only callers remain supported:

```ts
await showTweakProposalDialog(ctx, {
  presentation: (auditorEnabled) => ({ diffText, fullText, diffEntries }),
  defaultAuditorEnabled,
});
```

`presentation` is called once when the dialog opens and again whenever the
auditor choice changes. It should be a pure projection of the caller's
effective candidate; the dialog does not persist or derive goal fields. The
structured rows are UI-only: existing `diffText`, `fullText`, candidate
revision, outcome, and saved review snapshots retain their original format.

## Reviewing the session record

After confirm, continue, or cancel, the tool result keeps the proposal's original
baseline and both read-only views. Its collapsed row reports the decision and
changed sections; expanding shows the diff, full effective goal, and the outcome
or refinement feedback. Later goal changes do not rewrite that snapshot. A failed
or stale confirmation is not labelled applied. The initial call row is explicitly
pending authoritative validation; the dialog uses the reconciled goal state.
