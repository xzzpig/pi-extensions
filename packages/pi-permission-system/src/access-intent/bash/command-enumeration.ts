import {
	EXECUTION_HOST_TYPES,
	forEachNestedExecution,
} from "#src/access-intent/bash/nested-execution";
import type { TSNode } from "#src/access-intent/bash/parser";
import { type CommandWord, executedUnitOf } from "#src/access-intent/bash/wrapper-analysis";
import type { BashCommandContext } from "#src/types";

// ── Command type ─────────────────────────────────────────────────────────────

/**
 * One command-pattern unit of a parsed bash program.
 *
 * Minimal by design — `text` is the simple-command (or whole compound
 * statement) string matched against the bash rules.
 * The type is the stable extension point: #306 adds an execution `context`,
 * #307 adds per-command path candidates and an effective working directory.
 */
/**
 * Why a command unit's decision is floored to at least `ask`.
 * `"opaque-payload"` — an inline-shell payload (`bash -c`/`eval`) whose inner
 * program is not re-parsed (#481).
 * `"indirection"` — a prefix/exec wrapper (`sudo`/`env`/`xargs`/`find -exec`/…)
 * whose inner command is a visible argument but is not gated on its own (#490).
 * The kind selects the audit sentinel; both floor identically.
 *
 * Fork note: since the local wrapper rework, wrapper units are no longer
 * blanket-floored. Their inner commands are re-parsed / extracted as their own
 * units (see {@link parseProgram}), and the floor falls back only when that
 * extraction fails (`payloadUnresolved`) or the `wrapperFloors: "always"`
 * config is set.
 */
export type WrapperKind = "opaque-payload" | "indirection";

/** A `command` node's basename plus its argument texts and offsets. */
interface WrapperArg {
	readonly text: string;
	/** Byte offset of the argument's first character, relative to the `command` node. */
	readonly startIndex: number;
}

/**
 * Classification of a wrapper `command` node: its {@link WrapperKind}, the
 * inner command units that really execute (already resolved via the optional
 * {@link parseProgram}), and whether that resolution failed.
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
	 * The command this wrapper actually runs, for display (#713). Absent for
	 * an ordinary command and for a wrapper whose inner command cannot be
	 * established.
	 */
	readonly executedUnit?: string;
}

export interface BashCommand {
	readonly text: string;
	/**
	 * True when this unit is the innermost command of an opaque/indirection
	 * wrapper whose inner content could not be resolved, and its decision must
	 * therefore be floored to at least `ask` (fail-closed). Absent for an
	 * ordinary command or a wrapper whose inner commands were resolved.
	 */
	readonly context?: BashCommandContext;
	/**
	 * Set when this unit is a wrapper command (`bash -c`/`eval`, or an
	 * indirection wrapper such as `sudo`). The wrapper's inner commands are
	 * emitted as their own units (with `context` `"wrapper_payload"` or
	 * `"wrapper_indirection"`); the floor applies per {@link payloadUnresolved}.
	 * Absent for an ordinary command.
	 */
	readonly wrapperKind?: WrapperKind;
	/**
	 * Set on a wrapper unit whose inner command could not be located or parsed.
	 * The gate floors such a unit to `ask` (fail-closed), regardless of the
	 * `wrapperFloors` setting. Absent for ordinary commands and for wrappers
	 * whose inner commands were resolved.
	 */
	readonly payloadUnresolved?: boolean;
	/**
	 * The command this wrapper unit actually runs (#713). Display-only — it is
	 * never gated on its own, so the wrapper floor still applies per
	 * {@link payloadUnresolved}. Absent for an ordinary command and for a
	 * wrapper whose inner command cannot be established.
	 */
	readonly executedUnit?: string;
}

/**
 * Re-parse a bash source string into its command units.
 *
 * The enumerator uses this to descend into opaque wrapper payloads
 * (`eval`/`bash -c`), recursively applying the same enumeration (chains,
 * substitutions, nested wrappers). Supply it from the call site that owns a
 * tree-sitter parser; when absent, opaque payloads cannot be resolved and the
 * affected wrapper unit is marked `payloadUnresolved` (fail-closed floor).
 */
export type ParseProgram = (source: string) => BashCommand[];

// ── Command enumeration ──────────────────────────────────────────────────────

/**
 * Container node types descended into when enumerating command units.
 */
const COMMAND_ENUM_DESCEND = new Set([
	"program",
	"list",
	"pipeline",
	"redirected_statement",
]);

/**
 * Named node types skipped during command enumeration: comments and heredoc
 * terminators — neither is a command nor can host one. A redirect and a
 * heredoc body are deliberately NOT listed here. Neither is a command, but
 * each can host a substitution that really executes, so both are
 * {@link EXECUTION_HOST_TYPES} members instead — conflating the two questions
 * ("is this a command?" and "can this host one?") is the bypass #741 fixed.
 * Anonymous tokens (chain operators `&&`/`;`/`|`, substitution and subshell
 * delimiters `$(`/`)`/`` ` ``/`(`) are filtered by the `isNamed` guard, not
 * listed here.
 */
const COMMAND_ENUM_SKIP = new Set(["comment", "heredoc_end"]);

/**
 * Enumerate the command units of a bash program, in source order.
 *
 * Descends container nodes (`program`, `list`, `pipeline`,
 * `redirected_statement`) and emits each `command` node whole.
 * Additionally descends into the three nested execution contexts — command
 * substitution (`$(…)`, backticks), process substitution (`<(…)`/`>(…)`), and
 * subshells (`( … )`) — emitting each inner command as its own unit *in
 * addition to* the enclosing command, since those inner commands really execute
 * (#306).
 * Control-flow bodies and `{ … }` brace groups are emitted whole without
 * descending (deferred).
 *
 * The enclosing command/subshell is always still emitted whole, so adding the
 * nested units can only ever produce a more-restrictive decision, never weaker.
 *
 * Each emitted command unit has any leading `variable_assignment` prefix
 * stripped (so an env-var prefix cannot defeat a command-pattern rule). A
 * wrapper command (`bash -c`/`eval`, or an indirection wrapper such as `sudo`)
 * is tagged with a {@link WrapperKind} and — when `parseProgram` is supplied —
 * its inner commands, which really execute, are additionally emitted as their
 * own units with a `wrapper_payload` / `wrapper_indirection` context. A wrapper
 * whose inner content cannot be located or parsed is flagged
 * `payloadUnresolved` so the gate can floor it (fail-closed).
 *
 * When `parseProgram` is absent (unit-test or pre-warm callers), a wrapper
 * payload is not parsed; the wrapper unit is flagged `payloadUnresolved` for
 * opaque payloads, while an indirection wrapper still emits its visible inner
 * command (a shallow argument scan needs no parser).
 */
export function collectCommands(
	node: TSNode,
	options?: { parseProgram?: ParseProgram },
): BashCommand[] {
	const out: BashCommand[] = [];
	collectCommandsInto(node, undefined, options?.parseProgram, out);
	return out;
}

function collectCommandsInto(
	node: TSNode,
	context: BashCommandContext | undefined,
	parseProgram: ParseProgram | undefined,
	out: BashCommand[],
): void {
	// Anonymous tokens (operators `&&`/`;`/`|`, delimiters `$(`/`)`/`` ` ``/`(`)
	// carry no command.
	if (!node.isNamed) return;
	if (COMMAND_ENUM_SKIP.has(node.type)) return;

	if (EXECUTION_HOST_TYPES.has(node.type)) {
		// Not a command itself, but its subtree can host one that really runs
		// (`> $(rm x)`, `< <(rm c)`, an interpolating heredoc body). Emit only
		// what it hosts (#741).
		collectHostedCommands(node, out);
		return;
	}

	if (node.type === "command") {
		const classification = classifyWrapperCommand(node, parseProgram);
		out.push(
			makeUnit(
				commandUnitText(node),
				context,
				classification && {
					kind: classification.kind,
					unresolved: classification.unresolved,
					executedUnit: classification.executedUnit,
				},
			),
		);
		// The wrapper's inner commands really execute; gate them as their own
		// units (they are already parse-resolved for opaque payloads, or sliced
		// verbatim for indirection wrappers). A unit that already carries a
		// context or a nested-wrapper tag is kept verbatim, so a payload's own
		// wrappers retain their flooring metadata.
		if (classification !== undefined) {
			const innerContext =
				classification.kind === "opaque-payload"
					? "wrapper_payload"
					: "wrapper_indirection";
			for (const inner of classification.inner) {
				if (inner.context !== undefined || inner.wrapperKind !== undefined) {
					out.push(inner);
				} else {
					out.push({ text: inner.text, context: innerContext });
				}
			}
		}
		// A command's text already contains any substitution; descend its subtree
		// to ALSO emit the inner commands of command/process substitutions and
		// of redirect/heredoc hosts (#741).
		collectHostedCommands(node, out);
		return;
	}

	if (node.type === "subshell") {
		out.push(makeUnit(node.text, context)); // never-weaker whole emit
		descendCommandChildren(node, "subshell", parseProgram, out);
		return;
	}

	if (COMMAND_ENUM_DESCEND.has(node.type)) {
		descendCommandChildren(node, context, parseProgram, out);
		return;
	}

	// Any other named statement (compound_statement `{ … }`, if/while/for/case,
	// function_definition): emit whole, do not descend — deferred (#306).
	out.push(makeUnit(node.text, context));
}

function makeUnit(
	text: string,
	context: BashCommandContext | undefined,
	wrapper?: {
		kind: WrapperKind;
		unresolved?: boolean;
		executedUnit?: string;
	},
): BashCommand {
	return {
		text,
		...(context === undefined ? null : { context }),
		...(wrapper
			? {
					wrapperKind: wrapper.kind,
					...(wrapper.unresolved ? { payloadUnresolved: true } : null),
					...(wrapper.executedUnit === undefined
						? null
						: { executedUnit: wrapper.executedUnit }),
				}
			: null),
	};
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
 */
interface WrapperSpec {
	readonly valueOptions?: ReadonlySet<string>;
	readonly skipPositionals?: number;
	readonly skipAssignments?: boolean;
	readonly inlinePayloadFlag?: string;
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
	env: { valueOptions: new Set(["-u", "-C", "-S"]), skipAssignments: true },
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
	},
	"rust-parallel": {
		valueOptions: new Set(["-j", "-P", "-n", "-N", "-S", "-I", "-D"]),
	},
	rush: { valueOptions: new Set(["-j", "-n", "-r", "-k", "-t"]) },
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
 * exposed as `inner` with `wrapper_payload` context. A missing payload or an
 * unparseable one marks the wrapper `unresolved` (fail-closed floor).
 *
 * `"indirection"`: an always-invoking prefix/exec wrapper
 * (`INDIRECTION_WRAPPER_NAMES`), or a search tool (`EXEC_CONDITIONAL_WRAPPERS`)
 * carrying a per-result exec flag — the inner command is located by scanning
 * the leading option/value/positional arguments per {@link WrapperSpec} and
 * slicing the command text verbatim from the first inner-command argument
 * (with `wrapper_indirection` context). A bare `find`/`fd` search runs no
 * subcommand and is not flagged. An inner command that cannot be located marks
 * the wrapper `unresolved`.
 */
function classifyWrapperCommand(
	node: TSNode,
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
			classification = classifyIndirection(node, args, spec);
		} else {
			const flagIndex = args.findIndex((arg) => arg.text === spec.inlinePayloadFlag);
			if (flagIndex === -1) {
				classification = classifyIndirection(node, args, spec);
			} else {
				classification = classifyOpaquePayload(args.slice(flagIndex + 1, flagIndex + 2), parseProgram);
			}
		}
	} else if (EXEC_CONDITIONAL_WRAPPERS.has(commandName)) {
		const execFlags = EXEC_CONDITIONAL_WRAPPERS.get(commandName);
		if (execFlags === undefined) return undefined;
		const flagIndex = args.findIndex((arg) => execFlags.has(arg.text));
		if (flagIndex === -1) return undefined; // bare search runs no subcommand
		classification = classifyIndirection(node, args.slice(flagIndex + 1), { skipPositionals: 0 });
	} else {
		return undefined;
	}

	// #713: display-only field naming the command this wrapper actually runs.
	// It is never gated on its own — the wrapper floor still applies per
	// `payloadUnresolved` / `wrapperFloors`.
	const executedUnit = executedUnitOf(commandUnitText(node), readCommandWords(node));
	return executedUnit === null ? classification : { ...classification, executedUnit };
}

/**
 * Classify an opaque-payload wrapper (`eval`, `bash -c`, `flock -c`).
 *
 * The payload is the remaining argument list (joined, mirroring bash's arg
 * concatenation), unquoted one layer, then re-parsed as a bash program. A
 * parseable non-empty program contributes its command units as `inner`
 * (recursively resolved, so a payload's own wrappers keep gating); a missing
 * or unparseable payload marks the wrapper `unresolved` (fail-closed).
 */
function classifyOpaquePayload(
	payloadArgs: readonly WrapperArg[],
	parseProgram: ParseProgram | undefined,
): WrapperClassification {
	if (payloadArgs.length === 0) {
		return { kind: "opaque-payload", inner: [], unresolved: true };
	}
	const payload = unquotePayload(payloadArgs.map((arg) => arg.text).join(" "));
	if (payload === "" || payload === "-") {
		return { kind: "opaque-payload", inner: [], unresolved: true };
	}
	if (parseProgram === undefined) {
		return { kind: "opaque-payload", inner: [], unresolved: true };
	}
	const inner = parseProgram(payload);
	return {
		kind: "opaque-payload",
		inner,
		unresolved: inner.length === 0,
	};
}

/**
 * Classify an indirection wrapper by scanning its arguments for the inner
 * command's first token. The inner unit is the command text sliced verbatim
 * from that token (options and their values before it are consumed per the
 * wrapper's spec; `--` ends option processing). An inner command that cannot
 * be located marks the wrapper `unresolved`.
 */
function classifyIndirection(
	node: TSNode,
	args: readonly WrapperArg[],
	spec: WrapperSpec,
): WrapperClassification {
	const start = findInnerCommandStart(args, spec);
	if (start === undefined) {
		return { kind: "indirection", inner: [], unresolved: true };
	}
	return {
		kind: "indirection",
		inner: [{ text: node.text.slice(start) }],
		unresolved: false,
	};
}

/**
 * Locate the byte offset of the inner command's first token (relative to the
 * enclosing `command` node), or `undefined` when no inner command exists.
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
 * skipping any leading `variable_assignment` prefix (matching
 * `commandUnitText`). `commandName` is `undefined` for a pure assignment with
 * no `command_name`.
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

/**
 * The command-pattern text of a `command` node, with any leading
 * `variable_assignment` prefix stripped.
 *
 * An env-var prefix (`AWS_PROFILE=prod aws …`, `PGPASSWORD=…`) is part of the
 * `command` node's text but must not defeat a rule that gates the underlying
 * command, so matching targets the text from the first non-assignment child
 * (the `command_name`) onward, sliced verbatim to preserve spacing. A pure
 * assignment (`FOO=bar`, no `command_name`) runs no command and is returned
 * unchanged.
 */
function commandUnitText(node: TSNode): string {
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (child?.isNamed && child.type !== "variable_assignment") {
			return node.text.slice(child.startIndex - node.startIndex);
		}
	}
	return node.text;
}

function descendCommandChildren(
	node: TSNode,
	context: BashCommandContext | undefined,
	parseProgram: ParseProgram | undefined,
	out: BashCommand[],
): void {
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (child) collectCommandsInto(child, context, parseProgram, out);
	}
}

/**
 * Search a command's subtree for command/process substitutions and enumerate
 * the commands inside them, tagged with the substitution's execution context.
 * A substitution can nest under `command_name` (when the whole command is
 * `$(…)`) or under an argument, so the entire subtree is searched.
 */
/**
 * Enumerate the commands of every nested execution context in a subtree, each
 * tagged with the context it was found in. The traversal itself lives in
 * `nested-execution.ts` so the bash path surface shares one definition of what
 * counts as a nested execution (#741); this function supplies the
 * command-surface interpretation of each one found.
 */
function collectHostedCommands(node: TSNode, out: BashCommand[]): void {
	forEachNestedExecution(node, (contextNode, context) => {
		descendCommandChildren(contextNode, context, undefined, out);
	});
}

/**
 * A `command` node's words — its `command_name` followed by its arguments —
 * each carrying its offset into the unit text {@link commandUnitText} produces
 * (relative to the first non-`variable_assignment` child). Used to answer the
 * upstream #713 display question via {@link executedUnitOf}.
 */
function readCommandWords(node: TSNode): CommandWord[] {
	const words: CommandWord[] = [];
	let unitStart: number | undefined;
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (!child?.isNamed) continue;
		if (child.type === "variable_assignment") continue;
		unitStart ??= child.startIndex;
		words.push({ text: child.text, offset: child.startIndex - unitStart });
	}
	return words;
}
