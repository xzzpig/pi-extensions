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
`AssistantMessageComponent`, and `getMarkdownTheme()` so embedded transcripts
match the main session instead of approximating its styling.

```ts
import {
  SessionTranscript,
  TranscriptViewport,
} from "@xzzpig/pi-components/transcript";

const transcript = new SessionTranscript({
  maxEntries: 500,
  maxChars: 512 * 1024,
  maxToolResultChars: 16 * 1024,
});
const unsubscribe = session.subscribe((event) => transcript.apply(event));

const viewport = new TranscriptViewport({
  tui,
  theme,
  readEntries: () => transcript.entries,
  assistantLabel: "Auditor",
  toolLabel: "Tool",
  thinkingLabel: "Thinking",
});

const visible = viewport.render(width, height);
```

`TranscriptViewport` owns follow-latest plus keyboard and SGR mouse-wheel
scrolling. Hosts keep ownership of terminal mouse-reporting setup, dialog
chrome, focus behavior, input controls, session lifecycle, and cancellation
policy. `Esc` handling is intentionally delegated to the host overlay.

The transcript normalizes user/assistant events, streaming thinking and text,
tool calls and results, and automatic retry notices. It bounds retained history
and sanitizes untrusted terminal control sequences before rendering. Pi core
packages are peer dependencies, so installed extensions use the same Pi runtime
and active theme as their host.
