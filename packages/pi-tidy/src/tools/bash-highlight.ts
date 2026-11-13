/**
 * Bash command syntax highlighting (custom tokenizer — highlight.js's bash
 * grammar is too weak: no command names, flags, paths, or pipe operators)
 */

import type { ThemeLike } from "../theme-access.ts";

interface BashCallArgs {
  command?: string;
  timeout?: number;
}

// Shell grammar keywords (flow control) → syntaxKeyword
const SHELL_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done",
  "case", "esac", "in", "function", "select", "time", "coproc", "{", "}", "!",
]);

// NOTE: '#' is deliberately NOT a word break. A '#' only starts a comment at
// word start (handled above), so a mid-word '#' (fill:#242f60, a#b, url#frag)
// must stay inside the word. Treating it as a break used to leave the scanner
// unable to advance — see the progress guard in highlightBashCommand.
const WORD_BREAK = /[\s'"`$|&;<>()]/;

/**
 * Shells whose `-c` takes a script. `-c` on anything else (`grep -c`, `sort -c`)
 * takes none, so the string after it has to stay a string.
 */
const SHELL_NAMES = new Set(["bash", "sh", "zsh", "dash", "ksh", "mksh", "fish"]);

/** `-c`, and the combined forms a login or traced shell uses: `-lc`, `-xc`. */
const SHELL_COMMAND_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/;

/** `bash -c 'bash -c …'` is worth a level or two, not an endless descent. */
const MAX_PAYLOAD_DEPTH = 3;

/**
 * Tokenize and color a shell command string.
 * `color(token, text)` maps a syntax token name to styled text (theme.fg).
 * Anything unrecognized passes through uncolored.
 */
export function highlightBashCommand(
  command: string,
  color: (token: string, text: string) => string
): string {
  return highlightShell(command, color, 0);
}

/**
 * The work behind `highlightBashCommand`, which only seeds the descent depth.
 *
 * `bash -c 'set -e` + newline + `cd src'` is a shell script inside a string.
 * Coloring the payload as one string token is what the shell's grammar says, but
 * a six-line command in one flat colour is unreadable, so the quoted argument of
 * a shell's `-c` is tokenized as the script it is. Everything else — heredocs,
 * double-quoted payloads the outer shell expands first — keeps the plain string
 * treatment.
 */
function highlightShell(
  command: string,
  color: (token: string, text: string) => string,
  depth: number
): string {
  const out: string[] = [];
  const push = (text: string, token: string | null) => {
    out.push(token && text ? color(token, text) : text);
  };

  let i = 0;
  const n = command.length;
  let expectCmd = true; // next word sits in command position
  let shellNamed = false; // the previous word was a shell, so a `-c` may follow
  let scriptNext = false; // the token coming up is a shell's `-c` script

  while (i < n) {
    const c = command[i];

    // whitespace / newlines
    if (c === " " || c === "\t") { push(c, null); i++; continue; }
    if (c === "\n") { push(c, null); expectCmd = true; shellNamed = false; scriptNext = false; i++; continue; }

    // comment (only at word start)
    if (c === "#" && (i === 0 || command[i - 1] === " " || command[i - 1] === "\t" || command[i - 1] === "\n")) {
      const nl = command.indexOf("\n", i);
      const end = nl === -1 ? n : nl;
      push(command.slice(i, end), "syntaxComment");
      i = end;
      continue;
    }

    // Only the token right after `-c` is its script: read the flag here and
    // clear it, so a later quote in the same command is a plain string again.
    // Whitespace and comments above must not consume it.
    const isScriptPayload = scriptNext;
    scriptNext = false;

    // operators (longest first)
    // fd redirects like 2>&1 (4 chars): target is not a command word
    const four = command.slice(i, i + 4);
    if (four === "2>&1" || four === "1>&2") {
      push(four, "syntaxOperator"); i += 4; continue;
    }
    const three = command.slice(i, i + 3);
    if (three === "&>>") {
      push(three, "syntaxOperator"); i += 3; continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      push(two, "syntaxOperator"); i += 2; expectCmd = true; continue;
    }
    // other redirects: the next word is a file target, not a command
    if (two === ">>" || two === "2>" || two === ">&" || two === "<&" || two === "&>" || two === "<<") {
      push(two, "syntaxOperator"); i += 2; continue;
    }
    if (c === "|" || c === ";") {
      push(c, "syntaxOperator"); i++; expectCmd = true; continue;
    }
    if (c === ">" || c === "<") {
      push(c, "syntaxOperator"); i++; continue;
    }
    if (c === "&") { push(c, "syntaxOperator"); i++; expectCmd = true; continue; }
    if (c === "(") { push(c, "syntaxOperator"); i++; expectCmd = true; continue; }
    if (c === ")") { push(c, "syntaxOperator"); i++; expectCmd = false; continue; }

    // single-quoted string
    if (c === "'") {
      const q = command.indexOf("'", i + 1);
      const end = q === -1 ? n : q + 1;
      // A shell's `-c` script: the quotes stay strings, what is between them is
      // the shell code it is. An unclosed quote stays one string, as before.
      if (isScriptPayload && q !== -1 && depth < MAX_PAYLOAD_DEPTH) {
        push("'", "syntaxString");
        // Pushed raw: the inner call colors its own tokens.
        out.push(highlightShell(command.slice(i + 1, q), color, depth + 1));
        push("'", "syntaxString");
        i = end;
        continue;
      }
      push(command.slice(i, end), "syntaxString");
      i = end;
      continue;
    }

    // double-quoted string (escape-aware)
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (command[j] === "\\") { j += 2; continue; }
        if (command[j] === '"') { j++; break; }
        j++;
      }
      push(command.slice(i, j), "syntaxString");
      i = j;
      continue;
    }

    // backtick substitution
    if (c === "`") {
      const q = command.indexOf("`", i + 1);
      const end = q === -1 ? n : q + 1;
      push(command.slice(i, end), "syntaxString");
      i = end;
      continue;
    }

    // variable: $VAR ${VAR} $1 $@ $? $(...)
    if (c === "$") {
      const m = /^\$(\([^)]*\)|\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@#?$!*_-])/.exec(command.slice(i));
      if (m) {
        push(m[0], "syntaxVariable");
        i += m[0].length;
        continue;
      }
      push(c, null); i++; continue;
    }

    // word
    let j = i;
    while (j < n && !WORD_BREAK.test(command[j])) j++;
    // Progress guard: every branch above either advanced `i` or is reached only
    // when `command[i]` is not a word break. If some future/unhandled break
    // character lands here, `j === i` and a bare `continue` would spin forever
    // pushing empty strings (this froze the whole TUI on `echo a#b`). Emit the
    // character plainly and move on — the tokenizer must always terminate.
    if (j === i) {
      push(c, null);
      i++;
      continue;
    }
    const word = command.slice(i, j);
    i = j;

    // Track `… bash -c`: the shell word arms the flag, the flag arms the next
    // string. `/bin/bash` counts, and any other word disarms both.
    if (SHELL_NAMES.has(word.slice(word.lastIndexOf("/") + 1))) {
      shellNamed = true;
    } else if (shellNamed && SHELL_COMMAND_FLAG.test(word)) {
      scriptNext = true;
      shellNamed = false; // one `-c` per shell word
    } else if (!word.startsWith("-")) {
      shellNamed = false;
    }

    // assignment prefix in command position: VAR=value
    if (expectCmd && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      const eq = word.indexOf("=");
      push(word.slice(0, eq), "syntaxVariable");
      push("=", "syntaxOperator");
      push(word.slice(eq + 1), "toolOutput");
      continue; // still expecting the command word
    }

    if (expectCmd) {
      if (SHELL_KEYWORDS.has(word)) push(word, "syntaxKeyword");
      else push(word, "syntaxFunction"); // builtins + external commands
      expectCmd = false;
      continue;
    }

    // flags: -x -abc --long --key=value
    if (/^--?[A-Za-z0-9][\w.-]*(=.*)?$/.test(word) && word !== "-") {
      const eq = word.indexOf("=");
      if (eq !== -1) {
        push(word.slice(0, eq), "syntaxType");
        push("=", "syntaxOperator");
        push(word.slice(eq + 1), "toolOutput");
      } else {
        push(word, "syntaxType");
      }
      continue;
    }

    // numbers
    if (/^\d+(\.\d+)?$/.test(word)) { push(word, "syntaxNumber"); continue; }

    // Words the grammar cannot name: arguments, paths, globs, filenames. The
    // shell has no type for these — `cp foo bar` and `cp foo/bar` are the same
    // shape — so they are not guessed at, they are one quiet colour. Left
    // uncoloured they would be the terminal's default foreground, which turns a
    // path-heavy command into a wall of white. `toolOutput` rather than `muted`:
    // readable at a glance, and not the grey a comment takes.
    push(word, "toolOutput");
  }

  return out.join("");
}

/**
 * Format the bash call row: bold `$` prompt + syntax-highlighted command.
 * Falls back to the built-in flat style when there is no command yet.
 */
export interface BashCallFormatOptions {
  /**
   * `false` renders the collapsed view pi shows by default: only the first
   * line of the command plus a `+N more lines` hint. `true` (default) renders
   * the whole command, which is what `ctrl+o` switches to.
   */
  expanded?: boolean;
  /** Collapsed view: how many characters of the first line to keep. */
  maxChars?: number;
  /** Collapsed view: styled hint appended after the `+N more lines` count. */
  hint?: string;
}

/** Matches pi's own `COLLAPSED_ARGS_CHARS` so bash collapses like every other tool. */
export const COLLAPSED_COMMAND_CHARS = 100;

interface CollapsedCommand {
  head: string;
  hiddenLines: number;
  truncatedChars: boolean;
}

/**
 * Reduce a possibly multi-line command to the single line shown in the
 * collapsed view. Heredocs are the reason this exists: `python3 - <<'PY'` plus
 * 40 lines of body used to fill the whole box before the command even ran.
 */
export function collapseBashCommand(command: string, maxChars: number = COLLAPSED_COMMAND_CHARS): CollapsedCommand {
  const lines = command.split("\n");
  let head = (lines[0] ?? "").trimEnd();
  const hiddenLines = lines.length - 1;
  let truncatedChars = false;
  if (head.length > maxChars) {
    head = `${head.slice(0, Math.max(0, maxChars - 1))}…`;
    truncatedChars = true;
  }
  return { head, hiddenLines, truncatedChars };
}

export function formatBashCallHighlighted(
  args: BashCallArgs,
  theme: ThemeLike,
  options: BashCallFormatOptions | boolean = {},
): string {
  const opts = typeof options === "boolean" ? { expanded: options } : options;
  const expanded = opts.expanded ?? true;
  const command = typeof args?.command === "string" ? args.command : "";
  const timeout = typeof args?.timeout === "number" ? args.timeout : undefined;
  const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
  const prompt = theme.fg("toolTitle", theme.bold("$ "));

  if (!command) {
    return prompt + theme.fg("toolOutput", "...") + timeoutSuffix;
  }

  let body = command;
  let collapsedSuffix = "";
  if (!expanded) {
    const { head, hiddenLines, truncatedChars } = collapseBashCommand(command, opts.maxChars);
    if (hiddenLines > 0 || truncatedChars) {
      body = head;
      const parts: string[] = [];
      if (hiddenLines > 0) parts.push(`+${hiddenLines} more lines`);
      if (truncatedChars) parts.push("truncated");
      collapsedSuffix =
        theme.fg("muted", ` (${parts.join(", ")}, `) +
        (opts.hint ?? "expand") +
        theme.fg("muted", ")");
    }
  }

  let highlighted: string;
  try {
    highlighted = highlightBashCommand(body, (token, text) => theme.fg(token, text));
  } catch {
    highlighted = body; // never break the tool row on a tokenizer bug
  }
  return prompt + highlighted + collapsedSuffix + timeoutSuffix;
}
