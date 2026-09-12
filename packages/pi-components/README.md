# pi-components

Reusable, internal Pi TUI primitives for extension authors. This is a shared
library package, not a Pi extension: consumer packages bundle it into their
release tarballs instead of publishing it independently. Bundled artifacts
expose compiled runtime JavaScript and declarations from `dist/`; the
TypeScript source remains in this repository for development.

## Transcript components

`@xzzpig/pi-components/transcript` provides a bounded `SessionTranscript`
that consumes `AgentSessionEvent` values and a keyboard- and wheel-scrollable
`TranscriptViewport`. User messages, assistant text, thinking, markdown, and
code fences render through Pi's native `UserMessageComponent`,
`AssistantMessageComponent`, and `getMarkdownTheme()`; tool calls render
through Pi's native `ToolExecutionComponent` (raw `args` and structured
results are preserved verbatim so built-in tools keep their rich
main-transcript output), so embedded transcripts match the main session
instead of approximating its styling.

```ts
import {
  SessionTranscript,
  TranscriptViewport,
} from "@xzzpig/pi-components/transcript";

const transcript = new SessionTranscript({
  maxEntries: 500,
  maxChars: 512 * 1024,
  // Optional native tool context: tui, cwd, resolveToolDefinition,
  // showImages, imageWidthCells, expanded.
});
const unsubscribe = session.subscribe((event) => transcript.apply(event));

const viewport = new TranscriptViewport({
  tui,
  theme,
  readEntries: () => transcript.entries,
  assistantLabel: "Auditor",
  thinkingLabel: "Thinking",
  // Live component registry keeps incremental renderer state per tool call;
  // omit it and tool blocks still render via stateless ad-hoc components.
  toolComponents: transcript.toolComponents,
});

const visible = viewport.render(width, height);
```

`TranscriptViewport` owns follow-latest plus keyboard and SGR mouse-wheel
scrolling. Hosts keep ownership of terminal mouse-reporting setup, dialog
chrome, focus behavior, input controls, session lifecycle, and cancellation
policy. `Esc` handling is intentionally delegated to the host overlay.

### History replay

Hosts that rebuild a transcript from persisted records write entries through
the public builder API (`appendEntry`, `ensureTurn`, `finishTurn`,
`removeTranscriptTurn`, `ensureToolCall`, `upsertToolResult`, `appendNotice`).
Text needs two different shapes:

- `upsertText` merges per turn (latest wins) — for one message observed
  repeatedly, e.g. live `message_update` records.
- `appendText` / `appendAssistantMessage` never merge — for replaying several
  finished assistant messages, so every thinking block and answer stays
  visible instead of collapsing into the last one.

```ts
const turnId = ensureTurn(state);
appendAssistantMessage(state, turnId, {
  thinking: "first pass",
  text: "writing the patch",
});
// later messages in the same turn stay separate entries
appendAssistantMessage(state, turnId, { thinking: "verify", text: "done" });
```

`renderTranscriptLines`/`TranscriptViewport` accept `hideThinkingBlock` (with
`thinkingLabel` as the collapsed label) so a host can present replayed thinking
collapsed and offer its own expansion gesture; omitted keeps Pi's default
(expanded).

The transcript normalizes user/assistant events, streaming thinking and text,
tool calls and results, and automatic retry notices. It bounds retained history
(entries and total chars — raw tool data is uncapped by design) and sanitizes
untrusted terminal control sequences in message text before rendering. Pi core
packages are peer dependencies, so installed extensions use the same Pi runtime
and active theme as their host.
