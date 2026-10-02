/**
 * Fork: spec-driven wrapper classification for the bash command enumerator.
 *
 * Moved verbatim out of `command-enumeration.ts` so the enumerator keeps only
 * the upstream walk plus a minimal seam: for each `command` node the walk
 * calls {@link classifyWrapperCommand}, emits the resolved inner commands it
 * returns, and falls through to the upstream unit build when the node is an
 * ordinary command. The name tables here deliberately duplicate members of
 * `wrapper-analysis.ts` (upstream's word-only classifier) — this module is
 * the fork's classifier, which additionally resolves a wrapper's inner
 * commands.
 *
 * The enumerator's unit text and words for a node are passed into
 * {@link classifyWrapperCommand} by the caller (computed once there), so this
 * module has no runtime dependency on `command-enumeration.ts` — only on its
 * `BashCommand` / `ParseProgram` types.
 */

import type { BashCommand, ParseProgram } from "./command-enumeration";
import type { TSNode } from "./parser";
import { REDIRECT_NODE_TYPES } from "./redirect-analysis";
import {
	type CommandWord,
	executedUnitOf,
	type WrapperKind,
} from "./wrapper-analysis";

/** A `command` node's basename plus its argument texts and offsets. */
interface WrapperArg {
	readonly text: string;
	/** Byte offset of the argument's first character, relative to the `command` node. */
	readonly startIndex: number;
}

/**
 * Classification of a wrapper `command` node: its {@link WrapperKind}, the
 * inner command units that really execute (already resolved via the optional
 * {@link ParseProgram}), and whether that resolution failed.
 */
interface WrapperClassification {
	readonly kind: WrapperKind;
	/**
	 * Inner command units emitted for this wrapper, in execution order. Empty
	 * when the wrapper's inner content could not be located or parsed.
	 */
	readonly inner: readonly BashCommand[];
	/**
	 * True when the wrapper's inner command could not be located or parsed, so
	 * the gate must fail closed (floor to `ask`) rather than let the wrapper
	 * unit ride a permissive rule.
	 */
	readonly unresolved: boolean;
	/**
	 * True when the wrapper invocation carries no executable inner content at
	 * all (a bare `env`, `eval ""`, `bash -c` with no payload argument). Such a
	 * call runs nothing beyond the wrapper binary itself, so the wrapper unit
	 * is gated as an ordinary command by its own text — it is neither marked
	 * unresolved nor floored. Never set alongside {@link unresolved}.
	 *
	 * Wrappers whose bare form executes stdin lines as commands (GNU parallel
	 * and kin, per {@link WrapperSpec.stdinCommands}) are never empty — they
	 * stay fail-closed when no command argument is present.
	 */
	readonly empty?: boolean;
	/**
	 * The command this wrapper actually runs, for display (#713). Absent for
	 * an ordinary command and for a wrapper whose inner command cannot be
	 * established.
	 */
	readonly executedUnit?: string;
}

/**
 * Shell command names whose `-c` flag introduces an opaque inline program.
 */
const SHELL_WRAPPER_NAMES = new Set(["bash", "sh", "dash", "zsh", "ksh"]);

/**
 * Indirection wrappers that always invoke a following command, so the wrapper
 * (not the inner command) is what a bash rule matches (when no inner extraction
 * applies). Extend this set to cover another always-invoking wrapper.
 */
const INDIRECTION_WRAPPER_NAMES = new Set([
	"sudo",
	"env",
	"xargs",
	"time",
	"nohup",
	"timeout",
	"nice",
	// Exec-capable rewrites and prefix wrappers surveyed in #575: parallelizers
	// (parallel/rust-parallel/rush), a sudo rewrite (doas), and prefix wrappers
	// (setsid/stdbuf/watch/flock) that all always invoke a following command.
	"parallel",
	"rust-parallel",
	"rush",
	"doas",
	"setsid",
	"stdbuf",
	"watch",
	"flock",
	// Transparent output proxies: a proxy rewrites its own argv into the real
	// command (`rtk git push origin main` runs `git push origin main`), so the
	// proxied command — not the proxy — is what a bash rule must match. Without
	// this entry the rewritten unit matches only a catch-all `*` rule and a
	// `git push *: ask` / `find /: deny` rule is silently bypassed.
	"rtk",
]);

/**
 * Search tools that invoke a command per result only when an exec flag is
 * present; a bare search runs no subcommand. The inner command is the argument
 * that immediately follows the exec flag. Extend by adding a tool with its
 * exec-flag set.
 */
const EXEC_CONDITIONAL_WRAPPERS = new Map<string, ReadonlySet<string>>([
	["find", new Set(["-exec", "-execdir", "-ok", "-okdir"])],
	["fd", new Set(["-x", "--exec", "-X", "--exec-batch"])],
]);

/**
 * Per-wrapper argument syntax used to locate the inner command of an
 * indirection wrapper:
 * - `valueOptions` — short flags that consume the following argument as their
 *   own value (e.g. `sudo -u root …`); the consumed argument is not the
 *   wrapped command.
 * - `skipPositionals` — leading positional arguments that are not the wrapped
 *   command (`timeout 10 …` duration, `flock -n file …` lockfile).
 * - `skipAssignments` — skip positional arguments shaped like environment
 *   assignments (`env X=1 cmd …`); bash's `env` consumes them before the
 *   command.
	 * - `inlinePayloadFlag` — a flag whose value is an inline command string
	 *   (`flock -c "cmd"`) treated as an opaque payload, like `eval`/`bash -c`.
	 * - `stdinCommands` — a bare invocation executes each stdin line as a shell
	 *   command when no command argument is given (GNU parallel semantics). A
	 *   bare call is therefore NOT inert and must stay fail-closed.
	 */
interface WrapperSpec {
	readonly valueOptions?: ReadonlySet<string>;
	readonly skipPositionals?: number;
	readonly skipAssignments?: boolean;
	readonly inlinePayloadFlag?: string;
	readonly stdinCommands?: boolean;
}

const INDIRECTION_WRAPPER_SPECS: Readonly<Record<string, WrapperSpec>> = {
	sudo: {
		valueOptions: new Set([
			"-u",
			"-g",
			"-p",
			"-C",
			"-D",
			"-R",
			"-T",
			"-t",
			"-A",
		]),
	},
	env: {
		valueOptions: new Set(["-u", "-C"]),
		skipAssignments: true,
		// `env -S` takes a split-string command as its value — an inline payload
		// like `flock -c`, re-parsed and gated instead of consumed as a plain
		// option value.
		inlinePayloadFlag: "-S",
	},
	xargs: {
		valueOptions: new Set(["-d", "-E", "-I", "-i", "-L", "-P", "-n", "-s"]),
	},
	timeout: { valueOptions: new Set(["-k", "-s"]), skipPositionals: 1 },
	time: { valueOptions: new Set(["-o", "-f"]) },
	nice: { valueOptions: new Set(["-n"]) },
	nohup: {},
	parallel: {
		valueOptions: new Set([
			"-j",
			"-P",
			"-n",
			"-N",
			"-S",
			"-I",
			"-D",
			"-d",
			"-R",
			"-f",
		]),
		// Bare GNU parallel treats every stdin line as a shell command
		// (`echo rm x | parallel` runs it), so a bare call is not inert.
		stdinCommands: true,
	},
	"rust-parallel": {
		valueOptions: new Set(["-j", "-P", "-n", "-N", "-S", "-I", "-D"]),
		stdinCommands: true,
	},
	rush: {
		valueOptions: new Set(["-j", "-n", "-r", "-k", "-t"]),
		// Same stdin-as-command semantics as GNU parallel.
		stdinCommands: true,
	},
	doas: { valueOptions: new Set(["-C", "-u"]) },
	setsid: { valueOptions: new Set(["-p"]) },
	stdbuf: { valueOptions: new Set(["-i", "-o", "-e"]) },
	watch: { valueOptions: new Set(["-n", "-p"]) },
	flock: {
		valueOptions: new Set(["-E", "-w"]),
		skipPositionals: 1,
		inlinePayloadFlag: "-c",
	},
};

/**
 * Classify a `command` node as a wrapper, resolving its inner commands when
 * possible. Returns `undefined` for an ordinary command.
 *
 * Reads only the node's own named children (a shallow walk), skipping any
 * leading `variable_assignment` prefix, and matches the command name on its
 * basename (so `/bin/bash -c …` counts).
 *
 * `"opaque-payload"`: `eval`, or a shell (`bash`/`sh`/`dash`/`zsh`/`ksh`) with a
 * `-c` short-flag cluster (`-c`, `-ec`, `-xc`) — the inner program is the
 * argument string following the flag (for `eval`, all its arguments joined).
 * The payload is unquoted and re-parsed via `parseProgram`; its commands are
 * exposed as `inner` with `wrapper_payload` context. A missing or blank
 * payload marks the wrapper inert (`empty`) — it runs nothing beyond the
 * shell itself and is gated as an ordinary command; an unparseable
 * non-empty payload marks the wrapper `unresolved` (fail-closed floor).
 *
 * `"indirection"`: an always-invoking prefix/exec wrapper
 * (`INDIRECTION_WRAPPER_NAMES`), or a search tool (`EXEC_CONDITIONAL_WRAPPERS`)
 * carrying a per-result exec flag — the inner command is located by scanning
 * the leading option/value/positional arguments per {@link WrapperSpec} and
 * slicing the command text verbatim from the first inner-command argument
 * (with `wrapper_indirection` context). A bare `find`/`fd` search runs no
 * subcommand and is not flagged. An invocation whose every argument was
 * consumed by the wrapper's own syntax (`timeout 5`, `env -u HOME`, bare
 * `sudo`) is marked inert (`empty`). An inner command that cannot be located
 * otherwise marks the wrapper `unresolved`.
 */
export function classifyWrapperCommand(
	node: TSNode,
	/** The unit text `commandUnitText` produces for `node`, computed by the caller. */
	text: string,
	/** The unit words `readCommandWords` produces for `node`, computed by the caller. */
	words: CommandWord[],
	parseProgram: ParseProgram | undefined,
): WrapperClassification | undefined {
	const { commandName, args } = readWrapperCommand(node);
	if (commandName === undefined) return undefined;

	let classification: WrapperClassification | undefined;
	if (commandName === "eval") {
		classification = classifyOpaquePayload(args, parseProgram);
	} else if (SHELL_WRAPPER_NAMES.has(commandName)) {
		const cArgIndex = findShortFlagC(args);
		if (cArgIndex === undefined) {
			// A bare shell invocation (`sh foo.sh`) runs a script file as its
			// command name; it is an ordinary command, not a wrapper.
			return undefined;
		}
		classification = classifyOpaquePayload(args.slice(cArgIndex + 1), parseProgram);
	} else if (INDIRECTION_WRAPPER_NAMES.has(commandName)) {
		const spec = INDIRECTION_WRAPPER_SPECS[commandName] ?? {};
		if (spec.inlinePayloadFlag === undefined) {
			classification = classifyIndirection(node, text, args, spec);
		} else {
			const flagIndex = args.findIndex((arg) => arg.text === spec.inlinePayloadFlag);
			if (flagIndex === -1) {
				classification = classifyIndirection(node, text, args, spec);
			} else {
				classification = classifyOpaquePayload(args.slice(flagIndex + 1), parseProgram);
			}
		}
	} else if (EXEC_CONDITIONAL_WRAPPERS.has(commandName)) {
		const execFlags = EXEC_CONDITIONAL_WRAPPERS.get(commandName);
		if (execFlags === undefined) return undefined;
		const flagIndex = args.findIndex((arg) => execFlags.has(arg.text));
		if (flagIndex === -1) return undefined; // bare search runs no subcommand
		classification = classifyIndirection(node, text, args.slice(flagIndex + 1), { skipPositionals: 0 });
	} else {
		return undefined;
	}

	// #713: display-only field naming the command this wrapper actually runs.
	// It is never gated on its own — the wrapper floor still applies per
	// `payloadUnresolved` / `wrapperFloors`. Absent when no inner command can
	// be established (unresolved payload) or when nothing executes (inert).
	const executedUnit =
		classification.unresolved || classification.empty
			? null
			: executedUnitOf(text, words);
	return executedUnit === null ? classification : { ...classification, executedUnit };
}

/**
 * Classify an opaque-payload wrapper (`eval`, `bash -c`, `flock -c`).
 *
 * The payload is the remaining argument list (joined, mirroring bash's arg
 * concatenation), unquoted one layer, then re-parsed as a bash program. A
 * parseable non-empty program contributes its command units as `inner`
 * (recursively resolved, so a payload's own wrappers keep gating); a missing,
 * blank, or fully command-less payload marks the wrapper inert (`empty`); a
 * non-empty unparseable payload marks the wrapper `unresolved` (fail-closed).
 */
function classifyOpaquePayload(
	payloadArgs: readonly WrapperArg[],
	parseProgram: ParseProgram | undefined,
): WrapperClassification {
	if (payloadArgs.length === 0) {
		// No payload argument at all (`eval`, `bash -c`): the shell prints a
		// usage error and runs nothing. Inert — gate as an ordinary command.
		return { kind: "opaque-payload", inner: [], unresolved: false, empty: true };
	}
	const payload = unquotePayload(payloadArgs.map((arg) => arg.text).join(" "));
	if (payload.trim() === "" || payload === "-") {
		// An empty/blank payload executes nothing; `-` names no runnable command.
		return { kind: "opaque-payload", inner: [], unresolved: false, empty: true };
	}
	if (parseProgram === undefined) {
		return { kind: "opaque-payload", inner: [], unresolved: true };
	}
	const inner = parseProgram(payload);
	if (inner === null) {
		// The payload exists but cannot be parsed — fail closed.
		return { kind: "opaque-payload", inner: [], unresolved: true };
	}
	if (inner.length === 0) {
		// A clean parse found no commands in the payload (comments, pure
		// assignments) — nothing executes.
		return { kind: "opaque-payload", inner: [], unresolved: false, empty: true };
	}
	return {
		kind: "opaque-payload",
		inner,
		unresolved: false,
	};
}

/**
 * Classify an indirection wrapper by scanning its arguments for the inner
 * command's first token. The inner unit is the command text sliced verbatim
 * from that token (options and their values before it are consumed per the
 * wrapper's spec; `--` ends option processing). When every argument was
 * consumed by that syntax (`timeout 5`, `env -u HOME`, bare `sudo`), the
 * invocation is payload-less: it is marked inert (`empty`) — gated as an
 * ordinary command — unless the wrapper executes stdin lines as commands
 * ({@link WrapperSpec.stdinCommands}), in which case it stays fail-closed.
 */
function classifyIndirection(
	node: TSNode,
	text: string,
	args: readonly WrapperArg[],
	spec: WrapperSpec,
): WrapperClassification {
	const start = findInnerCommandStart(args, spec);
	if (start !== undefined) {
		return {
			kind: "indirection",
			inner: [{ text: innerCommandText(node, text, args, start) }],
			unresolved: false,
		};
	}
	// Every argument was consumed by the wrapper's own option/value/positional
	// syntax — the invocation carries no inner command at all.
	if (spec.stdinCommands) {
		// …but these wrappers execute each stdin line as a shell command when
		// no command argument is given, so payload-less is not provably
		// inert — fail closed.
		return { kind: "indirection", inner: [], unresolved: true };
	}
	return { kind: "indirection", inner: [], unresolved: false, empty: true };
}

/**
 * The inner command's text, sliced from the unit's word-joined `text` rather
 * than the raw node text. The unit text is upstream's WordReader
 * reconstruction, which excludes a hosted heredoc's body; `node.text` spans
 * it, so slicing the raw text would glue the heredoc lines onto the inner
 * unit and no rule could match it. The inner token's node offset is mapped to
 * its position in `text` by scanning the wrapper's own arguments in order.
 */
function innerCommandText(
	node: TSNode,
	text: string,
	args: readonly WrapperArg[],
	start: number,
): string {
	let from = 0;
	for (const arg of args) {
		const at = text.indexOf(arg.text, from);
		if (at === -1) continue;
		from = at + arg.text.length;
		if (arg.startIndex === start) return text.slice(at);
	}
	return node.text.slice(start);
}

/**
 * Locate the byte offset of the inner command's first token (relative to the
 * enclosing `command` node), scanning past the wrapper's own syntax. Returns
 * `undefined` when every argument was consumed by that syntax (`timeout 5`,
 * `env -u HOME`, bare `sudo`) — a payload-less invocation whose only possible
 * effect is the wrapper binary's own usage error or environment output.
 */
function findInnerCommandStart(
	args: readonly WrapperArg[],
	spec: WrapperSpec,
): number | undefined {
	const valueOptions = spec.valueOptions ?? new Set<string>();
	let positionalsSkipped = 0;
	let endOfOptions = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!endOfOptions && arg.text === "--") {
			endOfOptions = true;
			continue;
		}
		if (!endOfOptions && arg.text.startsWith("-") && arg.text.length > 1) {
			if (valueOptions.has(arg.text)) i++; // skip the option's value
			continue;
		}
		if (!endOfOptions && spec.skipAssignments === true) {
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg.text)) continue;
		}
		if ((spec.skipPositionals ?? 0) > positionalsSkipped) {
			positionalsSkipped++;
			continue;
		}
		return arg.startIndex;
	}
	return undefined;
}

/**
 * A `command` node's name basename and its argument texts with offsets,
 * skipping any leading `variable_assignment` prefix and any hosted redirect
 * (matching `commandWordNodes`, so a redirect written before or between the
 * words never masquerades as the command name or as an argument).
 * `commandName` is `undefined` for a pure assignment with no `command_name`.
 */
function readWrapperCommand(node: TSNode): {
	commandName: string | undefined;
	args: WrapperArg[];
} {
	let commandName: string | undefined;
	const args: WrapperArg[] = [];
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (!child?.isNamed) continue;
		if (child.type === "variable_assignment") continue;
		if (REDIRECT_NODE_TYPES.has(child.type)) continue;
		if (commandName === undefined) {
			commandName = basename(child.text);
			continue;
		}
		args.push({
			text: child.text,
			startIndex: child.startIndex - node.startIndex,
		});
	}
	return { commandName, args };
}

/**
 * True when an argument list has a short-flag cluster containing `c` before any
 * `--` end-of-options marker (`-c`, `-ec`, `-xc`) — the inline-shell payload
 * flag for `bash`/`sh`/`dash`/`zsh`/`ksh`.
 */
function findShortFlagC(args: readonly WrapperArg[]): number | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.text === "--") return undefined;
		if (
			arg.text.startsWith("-") &&
			!arg.text.startsWith("--") &&
			arg.text.includes("c")
		) {
			return i;
		}
	}
	return undefined;
}

/** The final path segment of a command name (`/bin/bash` → `bash`). */
function basename(name: string): string {
	const slash = name.lastIndexOf("/");
	return slash === -1 ? name : name.slice(slash + 1);
}

/**
 * Strip one layer of shell quoting from a payload string, best-effort.
 *
 * `eval`/`bash -c` take the payload as the shell would see it after one
 * expansion pass; the raw argument text includes its quotes, which would
 * otherwise turn `eval 'rm -rf /'` into a single word when re-parsed. Strip a
 * matching `'…'` or `"…"` pair; embedded escapes are left as-is (the re-parse
 * applies the shell's own rules where it can).
 */
function unquotePayload(payload: string): string {
	if (payload.length >= 2) {
		const first = payload.at(0);
		const last = payload.at(-1);
		if (first !== undefined && last !== undefined) {
			if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
				return payload.slice(1, -1);
			}
		}
	}
	return payload;
}
