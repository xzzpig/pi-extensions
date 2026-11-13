# Changelog

What changed in each released version of pi-tidy (published as
`@andy8647/pi-toolbox` up to 0.4.1). Versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.6] - 2026-11-13

### Fixed

**An `edit` another extension registers keeps its file and its diff.** aft's hashline mode (`edit_mode: "hashline"`) takes
`{ patch }` instead of `{ path }` and brings renderers of its own, so the box showed no path chip, no file-type icon and no
panes: it stacked the tool's own `edited … (+a/-d)` row under a border that repeated the path. The file now comes from the
result's `details.files` and the diff from `details.diff` when the call carries neither — the same shape pi's own edit
result uses — and a relative path is resolved against the working directory, so the chip copies all of it. pi's own
`edit` is unchanged: its preview still wins while the edit streams, and a preview error still keeps pi's rendering.

**A `/reload` with new settings reaches every box and message.** The render caches named the options they read, field by
field, so an option no cache listed could leave the old frame on screen — 0.9.4's split diff ignoring a theme switch was
that bug. Each cache now records one revision that every option change bumps, so a setting added later needs nothing
remembered.

## [0.9.5] - 2026-11-09

### Added

**A color in a message gets a swatch.** A reply or your own message that names a color now shows a `●` painted in it:
`#7f849c`, `#f00` and `#7f849c80` for hex, `rgb(127, 132, 156)` / `rgba(…)` and `hsl(240, 10%, 15%)` / `hsla(…)`
for the CSS functions, commas or spaces between the parts. Alpha is ignored because there is nothing to blend against,
and named colors (`red`, `tomato`) are not matched at all: they are ordinary words in prose. Fenced code blocks,
inline code and thinking keep their text, so a shell comment that happens to look like a color stays a comment.
`tidy.hexSwatches: false` leaves the markdown to pi.

**A shell's `-c` script is highlighted as the script it is.** `bash -c 'set -e` plus five more lines used to arrive as
one string token: every row the same green, and no way to read the commands. A quoted argument after `-c` (or a
combined form like `-lc`) is now tokenized as shell code, three levels of nesting deep, with the quotes still read as
strings. Heredocs, double-quoted payloads and `grep -c 'x'` keep the plain string treatment.

**Words the grammar cannot name take a colour of their own.** Arguments, paths, globs, filenames and the value of
`VAR=value` / `--flag=value` were passed through uncoloured, so a path-heavy row was a wall of the terminal's default
foreground. They take `toolOutput`: readable, and clearly not the grey a comment gets.

## [0.9.4] - 2026-11-09

### Added

**A framed user message can stop short of the full width.** `userMessageMaxWidth` takes `"auto"` (the default, the
whole width), a fraction of it (`0.7`) or a column count (`88`). The text wraps earlier and the frame hugs the narrower
column, so a long prompt keeps the chat-bubble shape under `userMessageAlign: "right"` instead of spanning the screen.
The label still gets room to draw itself, so a cap narrower than the icon and time is widened to fit them. The rail and
the rules are full-width by design and ignore it.

### Fixed

**Split diffs now follow the theme's appearance.** Light themes get pale row backgrounds and stronger word highlights;
dark themes and older hosts keep their existing colours. No new setting is needed. Existing edit diffs also refresh
on theme switches and reloads, even when the added-text colour stays the same.

Thanks to @s5unty for the split diff fix, the `appearance` read and the instance-keyed cache included (#73), and to
@cheney12138 for proposing `userMessageMaxWidth` and the three value forms it takes (#58).

## [0.9.3] - 2026-11-08

### Added

**A message an extension draws itself now wears the transcript's frame.** `frameMessages` framed compaction, branch, skill and
pi's own custom boxes, but a custom message whose renderer returns a component was left exactly as the extension drew it —
on a default pi-subagents install, a full-width slab in `customMessageBg` sitting between two framed runs. The rows are still
the extension's, since nothing here can know where a label belongs inside them; the chrome is Tidy's. The frame, the kind's
color, the fill stripped, the blank edges trimmed, and clicks mapped back through the border to the component that drew the
row, so its own click still opens it.

pi-subagents' notices are drawn from the message rather than from its renderer: the border says who it is about and how it
went (`╭─  wiki-verifier failed ──╮`, `╭─  worker needs attention ──╮`) in that status's own color — green for a
completion, red for a failure, yellow for a stall — the message's own text is the body with the title line it repeats taken
out, one row of it shows until a click, and the plugin's `(ctrl+o to expand)` is gone because the row is already a header.
The label is read from `details`: `runs[]` on a completion notice, `event` on a control notice, and the same fields on the
other twelve types wherever they exist, so a notice that names nobody is still drawn, with the glyph alone.  
Session entries (`reply sent to …`) keep their extension's styling: they render through `CustomEntryComponent`, which pi does
not export, and the entry renderer registry answers whichever extension registered first.

### Fixed

**A background job's notifications no longer break the transcript.** `hideJobNotifications` has been on by default since
0.4.1, but it only applied with `collapseTurns: "off"`. 0.8.0 made turn folding the default, so from then on every
`[process] "ticker" matched stdout: READY` came back as a block of its own, between runs, on a default install.

The blocks are still not drawn. The part a job's row cannot hold is the matched log line; the row only carries the
pattern. That line is kept per job and drawn as a row under it, inside the group the job belongs to: `· matched stdout:
tick 5`, at most three, with `· +N earlier` above them, and only while the group is open. A folded turn says how many
arrived (`▸ … · 2 matched`), because the rows carrying them are inside it. The model still receives every message, and a
watcher that ticks every second costs a folded transcript nothing.

`hideJobNotifications: false` keeps the blocks and draws no rows, rather than reporting the same match twice. A
notification whose job has no row to absorb it keeps its own block, so nothing is lost: another session, a row not
rendered again after a `/reload`, a pinned call, `groupTools: false`, pi-processes not loaded.

## [0.9.2] - 2026-11-07

### Added

**A file box's path is one click away.** A `write` or `edit` box's top border carries a copy chip after the path
(`╭─ 󰛦 src/app.ts 󰆒 ────╮`): click it for `~/…/app.ts` on the clipboard, and the chip shows a tick for a moment. Under the
pointer it lights up and the pointer becomes a hand, like the code block chip. `icons: false` draws the word `copy`
instead, and a box too narrow for the chip keeps its plain border.

### Fixed

**Selecting a path on a box's border copied nothing.** A frame's top border was taken for chrome and dropped whole,
so a drag along the `write` or `edit` border produced an empty selection: no hint, and `ctrl+x` silently did nothing
because pi treats an empty selection as no selection. A top border's label now stays when it names a file, with the
corner, the padding rules, the title's icons and the chip taken off; a reply's `model 14:06` label is still chrome.

**The code block chip's hit range was one cell left of it on a framed reply** — the frame's padding was not counted,
which the four-cell word `copy` hid. It is measured on the drawn row now.

**A reply with no frame had a chip nothing answered.** `presentTurn` returns early when a message has no turn header
and no reply frame, and that return came before the layout and the mouse handler were installed: with
`finalReplyStyle: "off"`, and on every reply while it streams, the chip was painted and a click did nothing, hover included.
The early return now only takes the messages that have no hit target, so a reply without chrome keeps its fast path and a
reply with a chip gets the handler it needs. Thanks to @indesperate for the report and for the trace: the early return
was exactly where they said it was, and the three bugs it hid were found in the code they pointed at.

**A block on an open turn's rail had no joint and no chip.** The rules were matched after the rail went on, and a railed
row's `│` never equals a rule's own text, so the block kept a plain border and its chip was dead. The rules are measured
before the rail now: a block on the rail joins it (`├─ fish 󰆒 ────`) and its chip copies like any other.

**One block could stop every later chip in the reply, and a repeated block could copy the wrong one.** A rule was
recognised by the cells it was drawn with, so a block inside a quote or a list item (drawn narrower, with a `│` or a
`1.` in front) never matched, and no later block was matched either. On pi 1.5 a block pi has already drawn is reused
without `renderToken` running, so the blocks tidy knew about and the blocks on the rows drifted apart: with two identical
blocks and a third, the second chip copied the third block's text. The rules are matched by their shape and the blocks
are read from Markdown's tokens now. A rule too narrow for its label draws no chip and no longer gets an invisible hit
target on its last cell.

### Changed

**The copy chips are glyphs**: `󰆒` (md-content_copy) at rest and `󰌌` (fa-check) after a copy, instead of `copy` and
`copied`. They take one cell instead of four, so the rule around them is three cells longer. `icons: false` keeps the
words.

## [0.9.1] - 2026-11-06

### Added

**A reply's fenced code blocks are drawn as a section** (`tidy.codeBlocks`). The two fence rows become rules that
join the reply's frame or rail (`├─ fish copy ────┤`), with the language on the opening one and a chip beside it:
clicking it puts the block's own text on the clipboard, and the chip reads `copied` for a moment. Under the pointer the chip
lights up and the pointer becomes a hand, the same hover the folded rows use. The code rows stay
as pi drew them. A `diff` block goes side by side instead, under the same `splitDiff` switch and `splitDiffMinWidth`
as an edit's diff, and keeps the unified form on a row too narrow for two panes. A language highlight.js has no
grammar for gets the closest one that exists: `fish` is read as a shell, and `.env` and TOML as INI, where pi alone
paints them one flat colour. `tidy.codeBlocks: false` leaves pi's own fences. A pi whose Markdown draws its code
blocks itself (no `renderToken` to hook) is unaffected, and tidy says so once at session start.

**The run summary's counts wear kind glyphs, and its LLM time wears the provider's.** Folded, every `kind×N` and
the `LLM` timing get a Nerd Font glyph in front: the tool kind's own, and for the timing the same provider glyph
the reply's border draws, so both lines name the same vendor. `tidy.icons: false` turns them off. A row too narrow
to hold them drops the glyphs whole and falls back to plain `bash×8 · read×3`: no count is ever truncated to make
room for an icon.

**`codemode` has a kind glyph of its own** (`fa-code`) instead of the generic wrench.

## [0.9.0] - 2026-11-05

### Added

**`tidy.messageTimeFormat` sets how a message's time reads**, in user messages and the final reply's border (#59): `auto`,
or a pattern such as `"M月D日 HH:mm:ss"`.

**`tidy.messageHeaderStyle: "split"` sets a rule between who a message is from and its time** (#59):
`╭── model ── 13:09 ───╮`, in user messages and the final reply's border. The default stays `inline`.

**The final reply and user messages can have rules without side borders** (#56). `tidy.finalReplyStyle` and
`tidy.userMessageStyle` both take `"rules"`: a rule above and below and nothing beside the text, so a terminal's own
selection copies it clean too.

**`tidy.finalReplyStyle` replaces `frameFinalReply`**, which keeps working, and also takes `"rail"`: the rules plus a `│` in
front of the text, like a rail user message.

**`tidy.messageBorderColors.assistant` colors the final reply** (#59): its frame and an opened run's rail and marker, as a
theme color name or `#rrggbb`. The default stays `accent`.

### Fixed

**`bashResultLines` no longer depends on `highlightBash`.** With highlighting off, the setting was ignored and collapsed
bash boxes showed pi's 5 lines. They now follow the setting, whose default is 1. If you had highlighting off and want the
5 lines back, set `tidy.bashResultLines: 5`.

**`thinkingColor` accepts `#rrggbb`, as documented.** A hex value made every thinking row disappear.

### Changed

**The configuration reference is grouped by what each key affects**, and every key now says when it applies. It also
records two limits that were not written down: `diffLines` only works while an edit's diff is drawn as two panes, and
`hideJobNotifications` only works with `collapseTurns: "off"`.

## [0.8.1] - 2026-11-05

### Added

**Copies leave the frames behind.** Text selected in pi's fullscreen mode now reaches the clipboard without tidy's
frames, corners and rail glyphs, on select and with the copy key, with or without pi-starline (#56). A terminal's own
selection (shift or option and drag) never reaches tidy, so it still brings them along. If you relied on the old copies,
`tidy.cleanCopy: false` turns this off. Until pi-starline's next release, its copy key still handles the selections it
recognises, and its hint counts characters its own way.

**A rail message carries its icon and time in the top rule.** With `userMessageStyle: "rail"`, the user icon moves out of
the text into the top rule, next to the time the frame style already showed. `userMessageAlign: "right"` moves that label to
the right end of the rule; the rail and the text stay left. The text also sits one cell closer to the rail: a cell of pi's
padding that was meant to come off never did.

**`tidy.userMessageTime: false` hides a user message's time**, in both styles. The final reply's border keeps its own.

### Fixed

**An opened run draws fast again.** 0.8.0 slowed down an opened run by 40-90%: settled thinking rows were rebuilt on
every frame. They are reused now, which takes 20-46% off a frame in that state at 1,500 components. The render benchmark
now measures opened runs, which is how this got through.

**A short message's frame has room around its label.** The box was exactly as wide as the icon and time in its top
border, leaving a stub of border on each side (#49). It is now four cells wider.

### Changed

**The startup list may name `pi-tidy/src`.** The sources moved under `src/`. Nothing else changes for you.

## [0.8.0] - 2026-11-04

**A run now folds by default.** When a run ends, its process folds to one `▸ took …` line above a framed final reply.
This changes what you see on update unless your settings already name these keys. To go back:

```json
{ "tidy": { "collapseTurns": "off", "frameFinalReply": false } }
```

### Changed

**An opened run hangs on a rail.** The summary's marker moves to the first column, and a rail runs down from it into the
final reply's left border, in the reply's colour. Groups sit one cell in, boxes two. A box from `alwaysShowTools` joins
the rail of a group that is open right above or below it. The summary drops its call counts while opened, because the
group headers carry them.

**A group's rows are easier to scan.** The `✓` or `✗` follows the tool's name, so tool icons and the thinking brain share
a column. Thinking text is dim and runs up to the metrics column. bash commands are highlighted (`highlightBash`), and a
leading `cd` shows only its last directory (`cd …/pi-tidy && rg x`); the opened box keeps the full command.

**Rows say what happened.** A bash call that printed nothing says `no output`, and reading an image says `image`, where it
said `1 line`.

### Added

**`toolRowLines`.** Set it to `2` and a call that does not fit its row goes on to a second one: the rest of a long command,
or the next line of a multi-line one with `(+N lines)`. Calls that fit keep one row. The default stays `1`.

### Fixed

**Opening an always-shown box no longer throws thinking out of its group.** Opening a `write` or `edit` box moved its
step's thinking out of the group and took one off the `N thoughts` count.

**A failed run keeps its failure in view when it folds.** A run that ended in an error with no text folded the error away,
and only the summary's `error` was left.

**The hover band reaches the end of a clipped row.** It used to stop at the `…`.

**The metrics columns follow a result that lands late.** They were only measured again when a call joined the group.

**An opened row keeps its columns.** Opening a call moved its row one cell right, and opening a thought moved it two.

## [0.7.3] - 2026-11-03

### Fixed

**One reply, one group.** The first reply after pi started could show two `▾` headers, with some of its calls
under the second. Folding then kept both headers, in reverse order. A reply is one group again, whichever extensions
restyle your messages.

**Thinking stays under its group's header.** With `groupOpen: true`, a step's `thinking` row could sit above the
group's summary line instead of inside the group.

**An empty step no longer starts a new group** (#50, by dreanzy).

**Failed requests are framed, once.** A request that fails for good now shows its `Error: …` in the same
`╭─ error ─╮` box as other errors (#45). When pi retries, the attempts share one box that counts them
(`error ×3`), and pi's "Retry failed after N attempts" takes its place when it gives up. An error after part of
the reply, and an abort with Esc, stay as pi drew them. `tidy.dedupeErrors: false` turns all of this off.

### Changed

**pi can show you this changelog.** tidy now ships its changelog, so pi 1.5 can list what changed after an update.
pi starts showing it from the next update on.

## [0.7.2] - 2026-11-02

### Added

**A failed request is one framed row, not one row per retry.** pi reports its own errors — a failed request, an
extension that threw — by appending a plain row per attempt: `Error: 429: {"message":…}` three times for one
failure, provider body included, with no frame. tidy now keeps the first row of a repeated error, puts `×N` in its
border (`╭─ error ×3 ─────╮`) and hides the repeats, so one failure reads as one line. The surviving row is the only
record that a turn failed, so it stays; warnings and notes are not touched. `tidy.dedupeErrors: false` restores pi's
behaviour.

### Changed

**A summary box's label sits in the border, not on its own row.** Compaction, branch and expanded skill boxes
draw the `[compaction]` / `[branch]` / `[skill]` label on a row of its own; a custom message draws `[type]` the
same way. That row is a title, so it now goes into the top border next to the kind icon — `╭─ 󰊢 [branch] ───╮`
— and the blank row that separated it from the body goes with it. A collapsed skill box keeps its label inline:
there it shares the row with the skill's name. User messages are never touched: their first row is the user's
own text, which may well be a bare `[word]`.

## [0.7.1] - 2026-11-01

A rendering release: nothing changes on screen, the frame costs a fraction of what it did.

### Changed

**A row is measured before it is truncated.** pi-tui's `truncateToWidth` segments the whole string whether or not
anything is cut — 17 µs for a styled 100-cell row against 90 ns for `visibleWidth` — and every drawn row went through
it. Rows that already fit now skip it entirely; at 500 components with every tool output open that was 78% of the
frame. Measured on the benchmark fixture with every tool output open: 5.5 ms → 0.8 ms at 500 components, 21.2 ms →
2.6 ms at 1500.

**A settled tool's rows are drawn once.** An opened call rebuilt its body rows every frame — concatenation, trim and a
format per row — from a box that had not changed. They are now cached and rebuilt when the group, the pointer, the
tool's own result or the box under it moves. An active run, a partial call, a background job or a scheduled reveal all
still draw fresh, so streaming is unchanged.

**A turn summary is built once per turn, not once per frame.** Folding a run is now the cheapest state to render
instead of the most expensive: 3.8 ms → 0.53 ms per frame at 1500 components, where the summary used to iterate the
turn's messages and tools four times per turn per frame. It is rebuilt when the turn moves or a second passes.

### Added

**The render benchmark folds runs, and reports on the pull request.** `pnpm bench` now measures three states — tool
outputs closed, runs folded, tool outputs open — because turn folding is a different path, not a smaller version of
the other two. CI rewrites a single comment on the PR with the table, found by a marker in its body so every run
patches it rather than stacking a new one. Pull requests from forks skip that step, and a base older than 0.7.0
reports the PR's own numbers for the state it cannot render.

## [0.7.0] - 2026-11-01

### Experimental (opt-in)

Turn folding and final-reply framing are experimental and disabled by default. Updating does not enable
them. To try both, merge these keys into the `tidy` object in `~/.pi/agent/settings.json`:

```json
{
  "tidy": {
    "collapseTurns": "afterRun",
    "frameFinalReply": true
  }
}
```

The two keys work independently. Use `collapseTurns: "live"` to fold while the run is still active.
To disable them, restore `collapseTurns: "off"` and `frameFinalReply: false`. Restart Pi after upgrading
to load the new rendering patches.

**A run can fold to one summary.** `tidy.collapseTurns` takes `off` (default), `afterRun` or `live`. One run
follows steering, retries and automatic continuations until pi settles. Its summary sits at the top of the turn
and reads wall time, the main model's request time, the union of top-level tool time, per-tool call counts and
failure counts; failures stay named inline. Click it, or use `/tidy turn [N|last]`, to open the process; the row
stays in place and folds it again, with the pointer band and hand. `ctrl+o` still controls tool outputs and their
turn. Metadata is saved outside model context and restored on the active branch; older turns show `—` for the
timings they never recorded.

**Frame the final reply.** `tidy.frameFinalReply: true` frames only the settled final text, full width,
with that message's model and a dim italic `HH:MM` (`MM-DD` for older messages). It can be enabled without
turn folding.

### Added

**User frames carry a clock and can align right.** The clock appears next to the user icon. Set
`tidy.userMessageAlign: "right"` for right alignment; it defaults to `"left"` and requires
`tidy.userMessageStyle: "frame"` with `tidy.frameMessages: true` (both defaults).

**File tools put their title in the border.** read/edit/write boxes carry the kind icon and path in the top
border; the body starts with the result or diff. `write` no longer leaves a gap under its title.

### Fixed

- A framed `codemode` box puts its summary row in the top border, where read/edit/write put their path
  (`╭─ ✓ codemode bash×1 read×4  0.1s ─╮`), and the body starts with the script's fold row. It was the one box
  whose title stayed inside the frame.
- The final reply's border names the model that answered, not the provider (`╭─ 🐳 deepseek-v4-pro 14:03 ─╮`). The
  provider keeps the glyph. A model id too long for the border is clipped with `…` instead of dropping the whole
  label.
- Folded turns preserve tool group boundaries, so thinking counts and rows stay with their own groups after
  restoring or expanding a turn, including groups split by `alwaysShowTools`.
- Hovering a turn summary no longer highlights the first tool group header too, or vice versa.
- OSC 133 zone markers stay outside the final frame. A zone that started after the left border made Ghostty
  cache the row and paint the first answer line blank; selection then exposed stale copies of it.
- The final frame contains only the answer; the final message's thinking is not drawn inside it.
- A group's `N thoughts` no longer over-counts when a streaming step turns into a boundary: the run
  counted as a carrier is given back when its text arrives. Thanks to @ncuiigai for reporting the mismatch
  and tracing its cause ([#39](https://github.com/Andy8647/pi-tidy/issues/39)).
- A pinned, expanded edit no longer leaves pi's bare `Thinking...` above its box.
- Deepseek uses the whale emoji; Nerd Fonts has no brand glyph for it.

## [0.6.3] - 2026-10-31

### Added

**Tool groups can start open.** Set `tidy.groupOpen: true` to start each new group with its `▾` header
and one row per call, without opening the calls' full outputs. The default is `false`, so existing
setups stay unchanged. Clicking the header or using `ctrl+o`'s collapse-all keeps the group folded;
the setting only decides its initial state. Changes apply to new groups after `/reload`, and fold
state is not persisted across session restores. Thanks to @dreanzy for the proposal and implementation
([#37](https://github.com/Andy8647/pi-tidy/pull/37)).

## [0.6.2] - 2026-10-30

### Fixed

**A script's call whose arguments wrap reads as its summary, not as raw JSON.** Inside an open `codemode` box pi
writes each call's arguments as compact JSON, and wraps a row longer than the box onto the rows below it. tidy glued
those rows back together to find the arguments and put the summary in their place, but pi's box pads each row out to
its width, indents the next one and drops the space it broke at, so the glued text never matched the arguments and
the row kept pi's JSON, clipped with `…`. Below about 200 columns that was every `write` and `edit` and any long
`bash` command. The rows are now glued back with the one space pi dropped, and matched with spaces let through, so
the row shows the path or the command like the others, and its duration lines up with theirs again. A row that does
get clipped keeps its duration's colour: the clip used to take the colour with the arguments and leave the duration
white.

## [0.6.1] - 2026-10-30

### Changed

**A row you can click shows a hand.** The band that lights a clickable row under the pointer now comes with the
pointer shape to match: tidy asks the terminal for a hand (OSC 22) while a row is lit and for the arrow again when
none is, and puts the arrow back before pi leaves the alt screen. Ghostty, kitty, foot and WezTerm draw it; other
terminals ignore the sequence.

**A `codemode` box reads as its call list with grouping off, too**
([#27](https://github.com/Andy8647/pi-tidy/issues/27)). 0.6.0 built the call list into the group: with
`groupTools: false` the box was still pi's own — ten lines of script, the last eight calls, the head of the output
and a `Took` row. Now it is the same list in a frame of its own: the row a group would show for the call
(`✓ codemode bash×3 read×1  1 failed · 0.1s`) as its title, every call the script made, and the script and the
output folded to one row each that open on click and light up under the pointer. `ctrl+o`, or a click anywhere
else in the box, opens both. The list is drawn from a second, expanded rendering of pi's own renderer, so nothing
is cut short and pi's box is left as it was. The same goes for a grouped session with `codemode` in
`alwaysShowTools`. Each box keeps its list until something in it changes: 0.6.0 re-decorated every framed
`codemode` box on every frame, which on a session of 300 scripts cost about 38 ms a frame; it is under 2 ms now.
Thanks to @indesperate for asking for the call list in the first place and for noticing it was missing with
grouping off.

**Thinking is tidy's row with grouping off, too.** The thinking row was wired into grouping, so with
`groupTools: false` every step left pi's bare `Thinking...` floating over its box. The row has nothing to do with
folding calls: with grouping off each step's thinking is now the same `thinking` row a message that writes text
gets inside a group — the brain, one line of what it thought, a click to open it in its box — and the step loses
pi's padding rows the way it does with grouping on.

**An open thinking box carries its label in the border.** Opening a message's thinking used to keep the
`󰧑 thinking  Now demo…` row above the box, repeating the box's first words. The row now folds into the box's
top border, `╭─ 󰧑 thinking ───╮`, so the open box is one row shorter and still says what it holds; a click
anywhere on it, the border included, folds it back into the row.

### Fixed

**bash's `Command exited with code N` trailer comes off a failed call inside a script.** 0.6.0 said so, but
it only matched the row without pi's box around it: drawn for real, the row is one cell further in, and the
trailer stayed, two blank rows above it.

**Long sessions scroll smoothly again.** pi's fullscreen mode draws the whole transcript on every frame — every
wheel tick, every streamed token, every hover change — and three things tidy draws were rebuilt from scratch each
time. Edit boxes were the worst: the side-by-side diff had a cache with room for one diff, so with more than one
edit in the transcript each box pushed out the one before it, and every frame re-parsed and re-highlighted every
diff in the history. The lag grew with the number of edits, which is why only long sessions felt it. On a
1,500-message session with 121 edits a scroll frame took about 50 ms (pi on its own: under 1 ms); it takes about
1.4 ms now. The diff is kept per box, and so are each group's summary line and each message's thinking rows, each
rebuilt only when what it shows changes. Nothing looks different.

**…and with every box open, too.** With `ctrl+o`'s expand-all on, each opened call's rows went through a
trailing-whitespace regex that is quadratic on a padded row (the padding is followed by a colour reset, so it
never sits at the end), and the same session took about 250 ms a frame. It is about 24 ms now, with nothing
looking different.

## [0.6.0] - 2026-10-30

### Changed

**A `codemode` row says what its script ran.** Nested tool calls never become tool rows of their own, so the
folded row used to show only the script's first line. It counts them now: `codemode bash×3 read×1  0.1s`, growing
while the script runs, with a red `1 failed` when a call inside the script failed and the script caught it and
still succeeded.

**Inside the box, the nested calls read like tidy's rows.** pi draws them with the arguments as compact JSON;
they now carry the same kind icon as the outer rows, and the arguments become the same one-line summary
(`pwd`, `src/app.ts`, `(+12 lines)` for a multi-line one), read back from `result.details.calls`: JSON when the
200-character clip survived it, the surviving key when it did not, pi's own text when neither works. bash's
`Command exited with code N` trailer is dropped from a nested failure, where the error above it already says
what happened.

**The body opens as a call list.** Inside a group, a `codemode` box no longer dumps the script and the output:
the script folds to `▸ script · 13 lines` and the output to `▸ output · 4 items`, each opening in place on
click (and lighting up under the pointer, like every other row), with a dim rule between the sections and a
rail of its own down the body. The call rows take a name column and a duration column, and a nested
`process start` hangs inside the body with them. A script that called nothing folds the same way, using the
output's first marker (`==> text N/M <==`, `<console_output>`, `Script error:`) as the boundary. Nothing wraps
onto a second row: an argument that does not fit is clipped, and the duration is the part that never gives way.
pi's `Took` row is gone, since the row above the body carries the time. The output stays one block: a script
builds its `text()` items from whatever it computed, so an item can be a filtered, merged summary of several
calls and nothing ties it back to the call that fed it.

**`bash` takes the md-console glyph.** `fa-terminal` is missing from some monospace Nerd Fonts and drew as a
blank; `\u{f018d}` renders wherever the rest of the set does. The file-type map's `bash` entry was still on
codicons' terminal glyph, so shell files and the `bash` tool now agree.

**Group rows share a name column.** A call's arguments used to start wherever its name ended, so a list of
`bash` and `read` and `process` rows had a ragged left edge. The name is padded to the widest one in the group
(capped at 14 cells, so one long MCP name cannot push everything out of reach), and a thinking row's label
pads the same way so its text starts in that column too.

### Fixed

**No blank row above a framed message box.** pi inserts a `Spacer(1)` before a user message and before the
compaction, branch and skill boxes, and the frame added an empty row of its own on top of it: the box floated
one row below the transcript, and for the summary boxes that turned pi's filled padding row into a second blank
one. The top border is the first row now, for all four (the user message's `OSC 133` zone marker moved with it).
Custom messages keep the spacer, because pi puts no spacer in front of those and it is the only separation they
have.

**A click on message text lands where it is drawn** ([#30](https://github.com/Andy8647/pi-tidy/pull/30), by
@s5unty). Trimming the message edges and restyling a thinking run changed the layout, but the mouse regions
kept using the untrimmed one: an interactive Markdown element such as pi-code-render's `[COPY]` had a click
target a few rows off, and a click outside a thinking run was swallowed instead of reaching the Markdown, which
left raw code unfoldeable. Rendering and hit testing now go through the same component tree, with one
coordinate transform for the trimmed rows.

## [0.5.0] - 2026-10-30

### Changed

**User messages are tidy's now, in a frame that hugs them.** pi-starline used to restyle user messages, tied to its
editor switch: turning Starline's input box off sent the transcript's prompts back to pi's filled block. They are
tidy's to draw now, independently of Starline, and by default (`userMessageStyle: "frame"`) in tidy's rounded frame,
as wide as the text plus its inset — a one-word prompt gets a small box, a long one stops at the screen's width —
with the user icon set into the top border (`╭─  ───╮`), so the text starts clean and copies without it. The
border is `messageBorderColors.user`.

`"rail"` keeps the look pi-starline drew: a full-width rule above and below, an accent `│` and (with `icons`) the
user icon in front of the text, later rows hanging under it; `userMessagePaddingY` and `userMessageColors` (`rail`,
`rule`; theme names or `#rrggbb`) tune it. `"off"` leaves pi's look. Both styles render pi's own Markdown child, so
markdown transformers keep working. `frameUserMessages` is no longer read: `true` asked for what is now the default.
pi-starline 0.9 drops its own version; with an older pi-starline, Starline's still draws on top.

**Your own `!` commands get a frame, marked as yours.** pi drew `!` / `!!` runs between two full-width `bashMode`
rules, which read like the agent's bash box without its frame. Under `frameMessages` they now get tidy's rounded frame
with the user icon, the `!` or `!!` that was typed in place of `$`, and the user messages' color — the agent's bash
box changes color with its state, this one does not, and pi's own `Running...` / `(exit N)` / `(cancelled)` rows report
the outcome. `!!` stays dim. The 20-row preview and `ctrl+o` are pi's, unchanged.

## [0.4.14] - 2026-10-28

### Fixed

**Background jobs started through codemode are tracked too.** Nested `process start` calls now keep
independent status rows under their calling tool, including multiple processes started by one script.
Completion and log-match notifications fold into those rows instead of appearing separately. A script
failure does not discard jobs it already started, and saved associations survive session restoration.
Direct starts and processes without a corresponding row keep their existing behaviour.

**Each nested process has its own hover and expand target.** Clicking a process no longer expands
codemode. It opens that process's command, working directory and the last 20 output lines; expanded
logs update as output arrives. Closing one process leaves its siblings and the script unchanged.
The group header and collapse-all close child details too. Unavailable logs are reported explicitly,
and process output is stripped of terminal control sequences before display.

## [0.4.13] - 2026-10-27

### Fixed

**The group header keeps its click when a thinking run above it is expanded.** `installCarrierMouse` answered an
expanded run before it looked at which row was hit, and the summary line is drawn by the same component, so
clicking `▾ 3 calls` folded the run instead of shutting the group: the header stayed `▾` and the reasoning
disappeared. The fold now only answers on the run's own rows.

## [0.4.11] - 2026-10-24

### Fixed

**A user message keeps its own padding while tools are folded.** Grouping trims the blank rows pi pads every
message with, so a folded group sits against the line above it. A user message is not one of those: it is a
filled box whose first and last rows are padding *with a background fill*, not empty rows, and the trim
stripped them as well — the highlighted bubble hugged its text on both sides and the `▸ 2 calls` header
pressed against it. The boundary wrapper gained an `untrimmed` branch, and the messages that are pi's own
padded boxes (user, plus custom in the same shape) take it. Assistant steps keep their edges compacted
around a group, which is what the compacting was for.

No setting was added: keeping the padding is now the only behaviour, because the tight version was a
mistake for messages rather than a preference.

Reported by @bumaociyuan (#17) and @frostime (#19); the fix is @bumaociyuan's `untrimmed` change from #18.

**Settings are read from the native home directory.** Before `PI_CODING_AGENT_DIR`, the fallback was
`${HOME}/.pi/agent` with `/tmp` behind it, so a Windows session without `HOME` looked in `/tmp/.pi/agent` and
silently ran on defaults. It asks `os.homedir()` now, which is right on Windows too.

## [0.4.10] - 2026-10-23

### Fixed

**A multi-line argument no longer paints the rows below it off by a line.** A row is one string in the lines
array the renderer hands back, and the summary took a call's `command` apart at its first newline but passed
every other argument through whole. So a tool whose first string argument is a script
(`chrome-devtools_evaluate_script`'s `function`, most MCP tools) returned a "row" with real newlines in it:
the terminal drew four physical rows where pi's frame counted one, and every row below painted off by the
difference. What you saw was the last few lines of a script sitting in the middle of the transcript, with
`Working` wedged between them and the durations stranded on their own rows.

Every argument now goes through the same rule: first line, then `(+N lines)` for the rest, trimmed. That is
also what the collapsed row has always claimed, so a script now reads as `evaluate_script () => { (+3 lines)`.

## [0.4.9] - 2026-10-23

### Fixed

**A thinking row no longer takes the whole message with it.** An assistant step streams as a carrier and
becomes the group boundary when its text arrives, and the click handler installed while it was a carrier
stayed on the component: it answered "this is my row" for every `y`, and consumed the click. So on any
message that had streamed its thinking, clicking the text (a fenced code block included) opened the
reasoning instead of reaching what was under the pointer. The handler now records the rows it actually
drew each frame and hands everything else back to the handler it replaced.

**One row under a thinking row no longer toggles it.** pi places its own regions on the untrimmed
layout, and the padding rows this extension trims away move every row by one, so a click on the first
line below a run landed on pi's hidden label. The runs are ours once restyled — the click table covers
every one of them, open or shut — so a click that misses them all now falls through instead.

## [0.4.8] - 2026-10-23

### Added

**Thinking is a row inside the group, and it stays live while it arrives.** A model step that only
thinks and calls a tool used to vanish when you opened a group: its `Thinking...` label was hidden, so
the transcript showed the call but nothing about the reasoning behind it. Now that step is a `thinking`
line under the `│` gutter — a brain, the word, then one line of what the model actually thought, above
the call it belongs to and in transcript order, at one consistent height whether the group is folded or
open. The summary line counts the runs (`▾ 5 calls · bash×3 · 🧠 4 thoughts · 1 failed · 1.3s`),
which while folded is the only sign the reply did any thinking at all.

- While a run is still arriving, the group keeps one line beneath the summary: a sliding window over the
  *tail* of that thinking, so the newest words are what you see and the row takes the full width. It
  moves on a 300ms tick rather than per frame — pi repaints ~30x/s, and a window recomputed on every
  paint slides a cell per token, which read as flicker — and the cut lands on a word break. The summary
  says `◐ thinking` while it runs and goes back to `N thoughts` once it stops; the row itself does not
  animate. A message's thinking **outside** a group (the label above its text, or a turn that has not
  called a tool yet) is live on the same terms, except that it has no summary above it, so the row wears
  the spinner itself.
- Live means three things at once: an agent run is open (`agent_start` … `agent_end`/`agent_settled`,
  tracked in a live slot so `/reload` reaches the patches), the message is still streaming, and its text
  grew inside the last 1.5 seconds. Growth is the signal that cannot lie — a run that stops sending
  tokens goes quiet on its own — and a repaint is scheduled for the moment the window lapses, because by
  then pi may have nothing left to paint. A restored session never looks live: a component that arrives
  with its text already finished did not grow in front of us.
- A click on the row opens that step's thinking: pi renders its own text, untruncated, inside the same
  rounded box a tool result gets — the border uses the new `thinkingColor` (default `warning`). Another
  click folds it back. pi's `thinkingVisibilityOverrides` is the switch behind it, so pi's own click and
  ours cannot disagree about what is open. A message that is nothing but thinking toggles on any click,
  and the hit map is shifted with the rows when padding is trimmed — pi's own region measures the
  untrimmed layout.
- A message with both thinking **and** text is the group boundary, and its `Thinking...` label used to
  float above the text as bare italic. It now wears the same row — same colour, same format, same
  preview — right where pi draws it, above the text. Its run is **not** added to the group's count: the
  group lists only the runs it folded, and counting one that renders above the text would promise a row
  that opening the group cannot show.
- The summary line of an open group is carried by the leading thinking row when there is one — a carrier
  renders *before* its own call, so the header would otherwise land under it. Folded, the first call
  still carries the line, which keeps the group's first frame from being blank.
- pi's `hideThinkingBlock` setting is deliberately ignored: the row is the same whether the setting is
  on or off, and a click is the one way to read the text. One behaviour, not two.
- The brain is `nf-md-brain`, **U+F09D1** — not the emoji 🧠, which is in no monospace Nerd Font and
  falls back to a two-cell colour glyph that breaks the row it sits in. The preview is capped at **56
  cells**: filling the row turned a glance into a paragraph wedged between the calls.

### Changed

**An opened call keeps its row.** It used to *become* a box: the row vanished and a framed block took
its place, which made a group hard to follow — the thing you clicked disappeared. Inside the group the
rail already says what belongs to what, so a box there was a frame inside a frame. Now the row stays
where it is (the anchor never moves), takes a tick off the rail (`├─`) and its output hangs underneath —
without repeating the command, which the row already spells out. Boxes are kept where they earn their
keep: an `edit`/`write` call (never folded into a group), and a message's own thinking outside one —
where the expanded run now keeps its `thinking` title above the box.

**The metrics sit in columns.** `1 line` / `12 lines` and `2.0s` / `0.1s` used to start wherever the
arguments happened to end, so a group read as a ragged block of numbers. The note and the duration are
now padded to the group's widest of each and the whole tail is right-aligned, so every row ends on the
same cell.

**No padding rows left anywhere in the transcript.** The gaps were not the box's spacer but pi's own
message padding: a user message draws a blank row above and below its text, and an assistant text
message starts with a `Spacer`. Every message block is now trimmed at both edges — a reply sits directly
under the prompt, and a group line directly under the text that introduced it. The OSC 133 zone markers
that ride on those dropped rows move onto the rows that survive, so shell integration (prompt placement,
`Ctrl+Shift+Up`) is unaffected.

### Fixed

**A tool row now spends the terminal's width on the command.** The argument column was a fixed 60 cells
and the row was cut at the right edge afterwards, which meant on a narrow terminal the
`51 lines · 1.6s` went first and a chopped command stayed behind — and on a wide one the command was
still cut at cell 60 with 80 cells of row left empty. The row now measures what it has: the arguments
fill the space left after the tail, the `(+12 lines)` marker is dropped before the command is shortened,
and the tail only gives way when there is no room for both.

**A grouped box no longer opens with a blank row.** pi puts a blank line between a call and its output;
under the gutter that read as a hole between the row and the box. Inside a group the blank is dropped
and the click geometry follows it. The split-diff body lost its own blank row under the `↳ diff +N -M`
summary too: a 20-row diff box was spending three of them on air.

## [0.4.7] - 2026-10-21

### Changed

**The copy no longer says "Claude Code-style".** The comparison set the wrong expectations and invited
the wrong argument: the parts that carry this extension — split diffs with word-level emphasis,
failures pinned at level 1 while the rest of the group is folded, live background-job rows, the
per-tool never-fold list — do not exist there. The README, the npm description and the cover now say
what the extension does instead of what it resembles. `claude-code` stays a search keyword, because
that is what people type when they want this interaction.

The cover also shows the split edit diff (`old │ new`) rather than the old stacked one, at 16:9.

## [0.4.6] - 2026-10-20

### Fixed

**Tidy no longer registers any tools, so sandbox extensions can load alongside it.** Registering a
tool under a built-in name is a hard failure in pi (`Tool "write" conflicts with
…/pi-tidy/index.ts`), and Tidy did it for `bash` (to highlight the command row) and, since 0.4.4, for
`write` (to make the preview height a setting). Any extension that legitimately owns those tools — a
sandbox such as pi-playpen, which must wrap execution or lose its enforcement — could therefore not
be installed at the same time. Both now travel as a `pi.registerToolRenderer()` resolver: the
installed tool keeps execution, schema, shell and result renderer, and `next()` hands Tidy the
downstream renderers so the call row can be replaced and the collapsed preview budget lowered on top
of whatever it returned.

- `bash`: the command row is still syntax highlighted and still folds to one line while collapsed,
  and `bashResultLines` still caps the output preview. The `startedAt`/`endedAt` state pi's own
  result renderer reads for its `Took 1.2s` footer is still maintained (we own the call renderer, so
  nobody else would). `highlightBash: false` leaves bash completely untouched.
- `write`: unchanged behaviour, now on top of whichever result renderer is downstream instead of
  pi's built-in one.
- `pi ≥ 1.3` is required for those two features. On an older pi they are skipped and a single warning
  names what is unavailable, and only when the setting was actually changed away from pi's own
  default — someone who never touched `writeLines` is not lectured.

Thanks to @s5unty for the diagnosis, the constraint that made the alternative (asking a sandbox
extension to stand down) unacceptable, and the write half in #8.

## [0.4.5] - 2026-10-20

### Added

**`diffLines`: the edit box's height is a setting.** pi's edit renderer draws the entire diff, collapsed
or not — a large edit owns the screen no matter what `alwaysShowTools` says. The collapsed box now
draws at most `diffLines` rows (default 20), windowed at the *first changed line* with a third of the
budget of context above it, and closes with `… (N more lines, M total, ctrl+o to expand)`. Cutting at
the top of the diff would hide the change itself on a large file, which is why the window follows the
first change instead. `ctrl+o` draws all of it; `0` keeps just the `↳ diff +N -M` summary.

**Hover on folded rows.** Pointing at a group summary line turns `▸` into `▶` and tints the row;
pointing at a call row in an open group lights that row and shows a `›` at its end. The whole row is
the click target, so the whole row lights up. Nothing is consumed — pi still receives the packet and
drag-selection across rows behaves exactly as before — and the band is dropped the moment the pointer
leaves, via a wrapper over the alt screen's mouse handler. Only available with 1003 all-motion
tracking, which pi enables outside tmux/screen; inside a multiplexer the rows simply never light up.

### Changed

**Failures stopped shouting, and stopped taking up room.** A folded group used to hang one red row
per failed call under its summary. In a 50-call reply with two failures that is a three-line "folded"
group — the fold accomplishes nothing — and three reds (`1 failed`, `✗`, `exit 1`) described one probe.
Now level 0 is one line again: the summary carries `2 failed` in red — the colour is the signal, no
cross beside it — and the failed rows wait in level 1 with the rest. Open the group and each failed row shows its own `✗` (the count goes `muted`,
so red appears once at either level), its note in `muted` (`exit 1` is data, not an alarm), and — for a
failure that printed nothing at all (`sed` on a directory, a `test`, anything that only exits
non-zero) — a whole row dropped to `dim` while keeping the red glyph. A timeout or an abort counts as
something to read and keeps full contrast. The expanded box's red border is unchanged.

## [0.4.4] - 2026-10-20

### Added

**Side-by-side edit diffs.** An edit's diff is now two panes, `old │ new`, with line numbers on both
sides, a coloured bar and a tinted row for every changed line, and the changed words emphasised
inside the line. pi hands its edit renderer a unified diff string, so the panes are re-derived from
that string (the rendered lines are not reversible) and the row tint is mixed from the theme's diff
colours — it follows whatever theme is active. Removed and added blocks pair row by row, so a
replaced block reads as before/after instead of two stacked runs. Below `splitDiffMinWidth` (72 by
default) the box keeps pi's unified diff; `splitDiff: false` turns it off entirely.

The frame keeps the tinted rows' background fill and strips every other one, so the box stays
transparent everywhere else.

**`writeLines`: the write preview's height is a setting.** pi's write box hard-codes ten lines of the
written file while collapsed. The tool is re-registered (the same way bash already was) with a
configurable budget: `"writeLines": 10` is pi's number, `0` keeps just the header until `ctrl+o`.
`alwaysShowTools` remains the switch for whether edits and writes show their own box or fold into
the group — `[]` folds both.

## [0.4.3] - 2026-10-19

### Changed

**A cover image, a demo video and screenshots.** The README opens with a cover
and links a 40-second demo; `pi.image` and `pi.video` give the
[pi package gallery](https://pi.dev/packages) a preview instead of a line of
text. The media live in `assets/` on GitHub and stay out of the npm tarball.

## [0.4.2] - 2026-10-19

### Changed

**Renamed to pi-tidy.** `@andy8647/pi-toolbox` said nothing about what the
package does and sat under a personal scope; it is now the unscoped `pi-tidy`,
and the repository is `Andy8647/pi-tidy` (GitHub redirects the old URLs). Swap
the package with `pi remove npm:@andy8647/pi-toolbox && pi install npm:pi-tidy`.
Settings move to a `"tidy"` key; the `"toolbox"` key is still read, so existing
configs keep working. The old package is deprecated with a pointer here.

**Peer dependencies are `*` again**, as pi asks of extensions. 0.4.0 set them to
`>=1.1.0`, but npm treats a peer conflict as an error for the whole install, so
one mismatched range can block every package in pi's directory — an older pi
now gets a warning at session start instead.

## [0.4.1] - 2026-10-19

### Added

**Background jobs on the row that started them.** A `process start` call
(pi-processes) finishes in milliseconds while the process it started runs on, so
the row used to say `✓ … 0.0s` and the process's life showed up as separate
`[process] …` messages further down. The row now tracks the process:
`◐ process ticker  running 12s · READY matched`, changing in place to
`✓ … exited 0 · 20s`, `✗ … exit 1 · 3s` or `⊘ … killed SIGTERM · 3s`. A running or
failed job keeps its row under a folded summary, which spins and counts them
(`▸ 5 calls · … · ◐ 1 running`); failed jobs count toward `N failed`.

The job's notification messages are no longer drawn once its row shows them —
pi-processes still delivers them to the model, toolbox only skips drawing them;
a job without a row (one started from `/ps`) keeps its messages. A reloaded
session is rebuilt from those persisted messages, and a job pi-processes no
longer knows (a session from an earlier pi) reads `not running` instead of
spinning forever. The spinner turns once a second for a job's first five
minutes, then stands still and the clock ticks once a minute, so a dev server
left running for hours doesn't repaint the transcript every second.

This is an adapter: pi has no notion of background jobs, so `background-jobs.ts`
has a small provider interface and pi-processes (its `processes:*` event
protocol and `ad-process:notification` messages) is the first provider. If that
protocol changes, rows simply go back to plain tool rows. New options
`backgroundJobs` and `hideJobNotifications` (both default `true`).

### Fixed

**A quick call flashed a row under the summary.** A folded group shows the row
of a call that is still running — so a call that ran for 40 ms popped out under
`▸ 4 calls` and folded back a frame later, and a `process start` stopped within
a second did the same. A running call (or job) now gets its row, and its
`running …` mention in the summary, after one second; long commands still
surface, quick ones never move. Likewise a step still streaming its thinking in
the middle of a group no longer flashes `Thinking...` under the summary before
its tool call arrives; at the start of a turn, with nothing folded yet, the label
still shows.

The README's "No mouse handling" section described a design removed long ago
and contradicted the click support; it's rewritten, along with the broken
screenshot placeholder and a duplicate border-color bullet.

## [0.4.0] - 2026-10-19

### Added

**Grouped tool calls: one line per assistant segment, three levels deep.** A reply
that ran six tools used to cost six boxes; it now costs one line —
`▸ 6 calls ·  bash×4  read×2 · 1.2s` — with the per-tool icons toolbox already
uses for call rows. Clicking the line turns it into a `▾` header with exactly one
row per call under a `│` gutter
(`│ ✓ bash  cd ~ && python3 - <<'PY' (+26 lines)  0.1s`); clicking a row opens that
call's full box (still on the gutter, so it's clear which group it belongs to),
clicking the box folds it back into its row, and clicking the `▾` header folds the
whole group — boxes included — back to its summary line.

Edits and writes never fold. Their diff is the thing you want to see, so they keep
pi's own box and end the group before them; the calls after an edit start a new
group, which keeps the transcript in order. New `alwaysShowTools` option (default
`["edit", "write"]`, `[]` folds everything).

A group is everything between two boundaries: a user message, or an assistant
message with visible text. The text always renders, so a reply that drifts is
still visible, and each segment keeps its own summary. pi gives every model step
its own assistant message, and a step that only calls a tool has no text — those
steps don't split the group, and their `Thinking...` label folds away with it,
reappearing next to that call's box when you open it. The running tool keeps its
own row under the summary so a long command doesn't look frozen.

Running and failed calls keep their own row under a folded summary — a failure
should never hide inside `▸ 6 calls` — and the summary counts them
(`▸ 6 calls · … · 1 failed · 1.2s`). Clicking any row opens that call's box,
including those two under a folded summary. Every row also says what the call
produced, Claude Code style: `12 lines`, `3 matches`, `no files`, `exit 1` for the
built-in tools (truncated output reports the original total); other tools get no
note rather than a guessed one.

`ctrl+o` expands every box (thinking included, like pi's native transcript), and
pressing it again folds every group back to its summary line; pi's own click on a
full box folds just that box. Membership is derived at render time from transcript
order, so groups survive a session reload without persisting anything. New
`groupTools` option (default `true`).

### Changed

**Requires pi ≥ 1.1.0** (peer dependencies were `*`). Component mouse events
arrived in 0.86 and tool durations in 1.1.0; on anything older the groups can't
be opened and the summary has no times. The dev dependencies moved from 0.82 to
1.3, so the tests now run pi's real click dispatch instead of a stand-in — the
stand-in is how a `button: "left"` vs `0` mismatch went unnoticed.

**Settings apply on `/reload`.** The prototype patches are installed once per
process, and used to keep the options of the first load; a reload's new settings
(including `enabled: false` and `frameMessages: false`) were silently dropped.
The patches now read their options from a global slot each load updates.

**Bash call rows collapse to one line by default.** The call row rendered the
command verbatim, so a heredoc (`python3 - <<'PY'` plus forty lines of body) or a
long `&&` chain filled the box before the command had even run, pushing every
previous tool call off screen. The collapsed row now shows the first line only,
cut at 100 characters (pi's own `COLLAPSED_ARGS_CHARS`, so bash folds like every
other tool), followed by `(+N more lines, ctrl+o to expand)`. `ctrl+o` still
gives the whole command back.

**Collapsed result previews shrank to one line too.** pi's bash renderer caps the
collapsed output at a hard-coded `BASH_PREVIEW_LINES = 5` with no setting, so even
a one-line command cost five output rows. The collapsed view now keeps a single
row and `ctrl+o` still brings back all of it. New `bashResultLines` option (default
`1`, `0` hides output until expanded) — applied by lowering the budget on the
`VisualLinePreview` pi built, so timers, truncation warnings and image fallbacks
stay pi's own.

`frame.ts` is split by job (`frame-draw.ts`, `tool-frame.ts`, `tool-group-view.ts`,
`message-frame.ts`); it keeps re-exporting the same API.

### Fixed

**Clicking a framed box toggled the wrong row — or nothing at all.** pi maps a
click on a box through its own unframed layout, and for `renderShell: "self"`
tools (edit, and MCP tools via pi-mcp-adapter) through a height that only pi's
own render records; toolbox replaces that render, so those clicks were always
dropped. Clicks are now translated through the frame's geometry into the source
component's coordinates and reach pi's own toggle.

`formatBashCallHighlighted(args, theme, options?)` takes the new third argument
(`{ expanded, maxChars, hint }`); omitting it renders the full command, so
existing callers are unaffected. `collapseBashCommand` is exported for tests.

## [0.3.3] - 2026-10-05

### Fixed

**A running tool box no longer freezes on a stale frame.** The frame cache
keyed on `(line count, first line, last line)`; tool boxes are bordered by
constant frame and padding rows, so any change confined to the middle left the
key untouched. A `sleep 580` bash call kept showing `Elapsed 0.0s` until
something else — a click expanding the box — invalidated the cache. The same
hole hid streaming output that stayed on the same number of lines. The cache
now compares the lines it framed, which costs a pointer comparison per row
while `Box`/`Text` hand back their cached arrays. The message and container box
caches, which shared the fingerprint helper, were made sound the same way.

Also: framing no longer writes into the line array `Text` returns from its
cache (`content[0] = row` on an untrimmed array duplicated the kind icon on the
next render).

## [0.3.2] - 2026-09-22

### Removed

**The `collapseAnchor` option and its `(ctrl+o to collapse)` row are gone.**
The row existed because, before Pi 0.86.0, the only way to close one expanded
box was `ctrl+o` collapsing every box at once. Pi now toggles a single tool
box (and compaction/branch/skill message boxes) on a click anywhere in its
content, so the anchor row is redundant. A `toolbox.collapseAnchor` key in
`settings.json` is ignored.

## [0.3.1] - 2026-09-20

### Fixed

**File icon placement for home-relative paths.** pi's `renderToolPath`
shortens `$HOME` to `~` in the display text, so an edit on
`~/.pi/agent/settings.json` never contained the raw args path — the icon
fell back into the prefix (`✏️{} edit ~/.pi/...`) instead of sitting in
front of the path. The matcher now tries both the raw and the `~`-shortened
form.

### Added

**File icons render in their brand colors, with full-set coverage.** The
icon map now contains the complete nvim-web-devicons set — 736 extensions
and 1172 special filenames — each with its brand color applied as a
truecolor escape (TypeScript blue, Rust orange, Go cyan, ...), like lazyvim
and yazi. Unknown extensions fall back to an uncolored generic file icon.
Tool-kind icons (FA glyphs) intentionally stay uncolored; they follow the
call row.

### Changed

**The call row drops the tool-name word for file tools.** With the kind
icon in front, ` 󰛦 edit ~/x.ts` reads choppier than
` 󰛦 ~/x.ts` — the word is redundant, so read/edit/write rows are
just `kind icon + file icon + path`. Rows that don't start with the tool
name are left untouched.

## [0.3.0] - 2026-09-19

### Added

**Message boxes get the same rounded transparent frame as tool boxes, each
kind in its own border color.** User messages, compaction and branch
summaries, skill invocations, and extension custom messages previously kept
pi's default filled-background bars, since they never go through
`ToolExecutionComponent`. Their components are now patched the same way.
User messages keep their OSC 133 zone markers, and custom messages rendered
by an extension-provided renderer are left untouched — the renderer owns its
styling.

**Tool boxes can take per-tool border colors and Nerd Font icons.** A
successful box uses its tool's configured color instead of green (pending
stays grey, errors stay red, unlisted tools take the theme accent), and every
box's call row leads with a kind icon — file tools put the target file's
nvim-web-devicons glyph right in front of the path (`write /tmp/x.ts`
renders `  write 󰛦 /tmp/x.ts`).

New settings under `toolbox`: `frameMessages` (default `true`) toggles the
message frames; `frameUserMessages` (default `false`) opts user messages in
— they are skipped by default because pi-starline patches the same
prototype, and two render patches on one prototype fight over the output;
`icons` (default `true`, requires a Nerd Font) toggles the icons;
`toolColors` maps tool names to success border colors (replaces defaults
when set); `messageBorderColors` picks a border color per message
kind — `user` (`toolTitle`), `compaction` (`customMessageLabel`), `branch`
(`mdCode`), `skill` (`accent`), `custom` (`warning`). Values are theme fg
color names, so they follow the active theme; tool boxes keep their
status-driven grey/green/red.

## [0.2.3] - 2026-09-18

### Fixed

**Bash syntax highlighting can no longer freeze the whole interface.** A `#`
that was neither at the start of a word nor inside quotes — `fill:#242f60`,
`a#b`, `url#frag` — was treated as a word break that no branch handled. The
scanner stopped advancing and pushed empty strings until the process ran out of
memory. Because the call row is re-rendered on every tool-argument delta, a
streaming command containing one of these deadlocked the TUI: 100% CPU, no
repaint, `ctrl+c` unresponsive, and the session file stopped updating. The
process could not recover on its own and survived closing the terminal tab.

Bare `\r` and other non-space whitespace (`\u00a0`, `\v`, `\f`) reached the same
dead end, because they are word breaks too.

The tokenizer now keeps a mid-word `#` inside the word, and the scanner can
never loop without consuming a character — an unhandled break character is
emitted as plain text instead of spinning. `test/bash-highlight.test.ts` covers
the reported shapes, a heredoc with a hex colour, and 400 randomized inputs
containing `#`, `\r` and non-ASCII spaces; every case asserts termination (a hang
is detected by a worker deadline) and that no character is dropped.

## [0.2.2] - 2026-08-10

### Added

**A collapse anchor row inside expanded tool boxes.** When a tool box is
expanded, the frame now ends with a `(ctrl+o to collapse)` row. With
[pi-starline](https://github.com/Andy8647/pi-starline) installed the row is
clickable (click it to collapse the box again); without Starline it reads as
an ordinary keyboard hint — `ctrl+o` really does collapse the box in Pi.
Set `toolbox.collapseAnchor: false` to opt out of the row entirely.

The anchor row is painted by Starline's `expandHintAction` matching it, so
neither extension needs to know about the other.

## [0.2.1] - 2026-07-26

### Changed

- Tool boxes stand down when another extension owns the mouse; clicking to
  expand a box is now opt-in rather than the default.

## [0.2.0] - 2026-07-26

### Added

- Rounded, status-aware tool box frames with bash highlighting.
- Click a tool box's border to expand just that box.

### Removed

- The fixed-editor-era click-to-expand that required Starline's compositor.
