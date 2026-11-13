# Contributing

Issues and pull requests are welcome. tidy redraws pi's transcript, so most bugs depend on your setup as much as
on the code: two people on the same version can see different screens. Please include the following, or the
report may need a round of questions before anyone can reproduce it.

## What to include

1. **pi version**: `pi --version`.
2. **tidy version**: the one actually loaded, not the latest on npm.
   `cat ~/.pi/agent/npm/node_modules/pi-tidy/package.json | grep '"version"'`, or the path `pi list` shows for
   pi-tidy if you installed it from a local checkout.
3. **Terminal and TUI mode**: the terminal app and its version (Ghostty, iTerm2, WezTerm, Windows Terminal, …),
   and whether pi runs full screen or inline. Mention tmux/zellij if you use one.
4. **Your `tidy` settings**: the whole `"tidy": { … }` block from `~/.pi/agent/settings.json` (and from the
   project's `.pi/settings.json`, if it has one). Say so if there is none: then you are on the defaults, and the
   defaults change between versions.
5. **Other extensions that draw the chat**: anything that restyles messages, tool output, the footer or the
   editor (themes, status lines, message renderers). `pi list` shows what is installed. Several tidy bugs only
   appeared next to another extension, or depended on the order extensions loaded.
6. **What you saw and what you expected**, with a screenshot if it is a rendering problem. If it depends on
   timing (it shows while a reply streams, or only on the first reply after pi starts), say so.

Redact API keys and anything private from screenshots and settings.

## Pull requests

- `npm test` and `npm run typecheck` must pass.
- A fix comes with a test that fails without it. Render through pi's real components (see
  `test/renderer-harness.ts` and `test/boundary-order.test.ts`), not hand-written rows: hand-written rows have hidden
  real bugs before.
- tidy patches pi at render time. Never render a component outside the frame's top-to-bottom pass (in `addChild`,
  in `updateContent`, to measure it): the tool grouping reads that order, and an early render splits groups.
- User-facing changes get an entry in `CHANGELOG.md`, written for someone who never read the code: what they see,
  and how to get the old behaviour back if there is a setting for it.
