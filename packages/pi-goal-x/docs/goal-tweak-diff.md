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
  is only a secondary cue.
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

| Key | Action |
| --- | --- |
| Enter | Activate the selected row: confirm, open the feedback editor, cancel, or toggle the view |
| Up / Down | Move between the four focusable rows |
| PgUp / PgDn, Ctrl+Up / Ctrl+Down | Scroll the complete dialog |
| `a` (configurable) | Toggle the completion auditor and rebuild the views |
| Esc | Continue chatting with the draft intact; Esc never cancels or confirms |
| Enter in the feedback editor | Continue chatting with the typed text; empty text is allowed |
| Esc in the feedback editor | Return to the decision rows without losing the draft |

Long content is windowed, never truncated: every diff/full line and every
decision row remains reachable by scrolling. The window is bounded to the
terminal height, honors narrow widths, and re-renders on resize. Proposal text
is displayed inertly: terminal control sequences are stripped rather than
interpreted.

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

The caller supplies the effective candidate as two read-only strings:

```ts
await showTweakProposalDialog(ctx, {
  presentation: (auditorEnabled) => ({ diffText, fullText }),
  defaultAuditorEnabled,
});
```

`presentation` is called once when the dialog opens and again whenever the
auditor choice changes. It should be a pure projection of the caller's
effective candidate; the dialog does not persist or derive goal fields.

## Reviewing the session record

After confirm, continue, or cancel, the tool result keeps the proposal's original
baseline and both read-only views. Its collapsed row reports the decision and
changed sections; expanding shows the diff, full effective goal, and the outcome
or refinement feedback. Later goal changes do not rewrite that snapshot. A failed
or stale confirmation is not labelled applied. The initial call row is explicitly
pending authoritative validation; the dialog uses the reconciled goal state.
