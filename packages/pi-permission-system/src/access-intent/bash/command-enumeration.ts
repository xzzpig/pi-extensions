import {
	EXECUTION_HOST_TYPES,
	forEachExecutionIn,
} from "#src/access-intent/bash/nested-execution";
import {
	parseUnresolvedWithin,
	type TSNode,
} from "#src/access-intent/bash/parser";
import { redirectMayWriteFile } from "#src/access-intent/bash/redirect-analysis";
import {
	type CommandWord,
	executedUnitOf,
	isTransparentWrapper,
	type WrapperKind,
} from "#src/access-intent/bash/wrapper-analysis";
import type { BashCommandContext, FloorExemption } from "#src/types";

export type { WrapperKind } from "#src/access-intent/bash/wrapper-analysis";

// ── Command type ─────────────────────────────────────────────────────────────

/**
 * One command-pattern unit of a parsed bash program.
 *
 * Minimal by design — `text` is the simple-command (or whole compound
 * statement) string matched against the bash rules.
 * The type is the stable extension point: #306 adds an execution `context`,
 * #307 adds per-command path candidates and an effective working directory.
 */
export interface BashCommand {
	readonly text: string;
	/**
	 * Execution context for a nested command (substitution or subshell); absent
	 * for a current-shell (top-level) command.
	 */
	readonly context?: BashCommandContext;
	/**
	 * Set when this unit is a floored indirection wrapper; its decision is floored
	 * to at least `ask` so the wrapped command cannot ride a permissive `allow`.
	 * Absent for an ordinary command.
	 */
	readonly wrapperKind?: WrapperKind;
	/**
	 * The command this wrapper unit actually runs (#713). Absent for an ordinary
	 * command, and for a wrapper whose inner command cannot be established.
	 *
	 * Display-only, and deliberately looks past an `sh -c` layer the gate must
	 * not look past — {@link floorExemption} is the gateable answer, established
	 * by its own walk rather than read off this string (#803).
	 */
	readonly executedUnit?: string;
	/**
	 * Set when this wrapper unit's floor has no reason left to hold, naming the
	 * reason (#803). Only ever present alongside `wrapperKind: "indirection"`
	 * and an established {@link executedUnit}.
	 */
	readonly floorExemption?: FloorExemption;
	/**
	 * Set when this unit was emitted from, or beneath, a statement holding a
	 * region tree-sitter could not resolve. Its decision is floored to at least
	 * `ask`, because the recovered structure is not evidence of what runs — ADR
	 * 0013 §10's fail-closed base case (#840).
	 */
	readonly parseUnresolved?: true;
	/**
	 * Fork: set on a wrapper unit whose inner command could not be located or
	 * parsed. The gate floors such a unit to `ask` (fail-closed) even in the
	 * configurable `wrapperFloors: "fallback"` mode, where resolved wrappers are
	 * gated by their own text and their inner commands are gated as units of
	 * their own. Absent for ordinary commands and for wrappers whose inner
	 * commands were resolved.
	 */
	readonly payloadUnresolved?: boolean;
}

/**
 * Fork: re-parse a bash source string into its command units.
 *
 * The enumerator uses this to descend into opaque wrapper payloads
 * (`eval`/`bash -c`), recursively applying the same enumeration (chains,
 * substitutions, nested wrappers). Supply it from the call site that owns a
 * tree-sitter parser. Returns `null` when the source cannot be parsed
 * (including a parse tree containing ERROR nodes) so the affected wrapper
 * unit can be marked `payloadUnresolved` (fail-closed floor); an empty array
 * means a clean parse of a payload that contains no commands (comments,
 * pure assignments) — provably inert. When absent, opaque payloads cannot be
 * resolved and the affected wrapper unit is marked `payloadUnresolved`
 * (fail-closed floor).
 */
export type ParseProgram = (source: string) => BashCommand[] | null;

/**
 * What the statement enclosing a command unit establishes about it.
 *
 * Both facts flow down the walk together because both are the *statement's*,
 * not the command's: a subshell's commands run in a subshell however they are
 * spelled, and a redirected statement writes a file however read-only the
 * command in front of the operator is.
 */
interface UnitScope {
	/**
	 * Execution context for a nested command (substitution or subshell); absent
	 * for a current-shell (top-level) command.
	 */
	readonly context?: BashCommandContext;
	/**
	 * True when the enclosing statement redirects output into a real file, which
	 * withholds the floor exemption from any wrapper unit beneath it.
	 */
	readonly writesViaRedirect: boolean;
	/**
	 * True when the enclosing statement holds a region tree-sitter could not
	 * resolve, so every unit beneath it is floored rather than trusted (#840).
	 */
	readonly parseUnresolved: boolean;
}

/** A top-level command in the current shell, writing no file, fully parsed. */
const TOP_LEVEL_SCOPE: UnitScope = {
	writesViaRedirect: false,
	parseUnresolved: false,
};

// ── Node-type vocabulary ─────────────────────────────────────────────────────

/**
 * Container node types descended into with the enclosing scope unchanged.
 *
 * `redirected_statement` is descended too, but has its own branch: it is the
 * node that can establish a write, so it descends with a scope of its own.
 */
const COMMAND_ENUM_DESCEND = new Set(["program", "list", "pipeline"]);

/**
 * Compound statements: emitted whole, then descended for their statements.
 *
 * The whole emit is what keeps the #306 never-weaker invariant — the commands
 * found inside are additional units, never a replacement.
 *
 * `select` parses as `for_statement` and `until` as `while_statement`, so each
 * pair is one entry.
 */
const COMPOUND_STATEMENT_TYPES = new Set([
	"if_statement",
	"while_statement",
	"for_statement",
	"c_style_for_statement",
	"case_statement",
	"function_definition",
	"compound_statement",
	"negated_command",
]);

/**
 * Syntactic groupings inside a compound statement: descended, never emitted.
 *
 * None of these is something anybody runs — a `do_group` is the loop body's
 * punctuation — so emitting one would produce a `do rm $f; done` unit.
 */
const STATEMENT_GROUP_TYPES = new Set([
	"do_group",
	"case_item",
	"elif_clause",
	"else_clause",
]);

/**
 * Named node types abandoned during command enumeration: they are neither
 * commands nor able to host one, so nothing in their subtree ever runs.
 *
 * A redirect and a heredoc body are deliberately NOT listed here. Neither is a
 * command, but each can host a substitution that really executes, so both are
 * {@link EXECUTION_HOST_TYPES} members instead — conflating the two questions
 * ("is this a command?" and "can this host one?") is the bypass #741 fixed.
 *
 * Anonymous tokens (chain operators `&&`/`;`/`|`, substitution and subshell
 * delimiters `$(`/`)`/`` ` ``/`(`) are filtered by the `isNamed` guard, not
 * listed here.
 */
const COMMAND_ENUM_SKIP = new Set(["comment", "heredoc_end"]);

/**
 * Every node type the enumerator recognizes as a statement.
 *
 * This is the enumerator's third question, beside "is this a command?" and
 * "can this host one?": "is this a *statement*, so that descending an enclosing
 * compound reaches it?" A compound statement's named children are a mix —
 * `for_statement` carries its loop variable and word list, `case_statement` its
 * subject, `function_definition` its name — and descending all of them emits
 * operand words as bash command units, naming `a` as the offending *command* in
 * a prompt. Membership is what {@link descendStatementChildren} filters on.
 */
const STATEMENT_TYPES = new Set([
	"command",
	"redirected_statement",
	"subshell",
	"declaration_command",
	"variable_assignment",
	"test_command",
	"unset_command",
	"ERROR",
	...COMMAND_ENUM_DESCEND,
	...COMPOUND_STATEMENT_TYPES,
	...STATEMENT_GROUP_TYPES,
]);

// ── Command enumeration ──────────────────────────────────────────────

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
 * A compound statement (control flow, a function definition, a `{ … }` brace
 * group) is emitted whole and then descended for the statements it contains,
 * while its operand words — a loop variable, a word list, a `case` subject, a
 * function's own name — are not commands and are left unemitted. An `ERROR`
 * node is the one exception: its recovered structure is invented rather than
 * observed, so the unparsed blob is emitted whole and never descended (#742).
 *
 * The enclosing command/statement is always still emitted whole, so adding the
 * nested units can only ever produce a more-restrictive decision, never weaker.
 *
 * A unit emitted from, or beneath, a statement holding a region tree-sitter
 * could not resolve is marked {@link BashCommand.parseUnresolved}, so the
 * verdict fold can floor it rather than match its recovered text against the
 * bash rules (#840).
 *
 * Each emitted command unit has any leading `variable_assignment` prefix
 * stripped (so an env-var prefix cannot defeat a command-pattern rule), and a
 * wrapper unit (`bash -c`/`eval`, or an indirection wrapper such as `sudo`) is
 * tagged with a {@link WrapperKind} so its decision is later floored to `ask`.
 *
 * Fork: a wrapper's inner commands — re-parsed from an opaque payload
 * (`eval`/`bash -c`/`flock -c`/`env -S`) or sliced from an indirection
 * wrapper's arguments — are additionally emitted as their own units with a
 * `wrapper_payload` / `wrapper_indirection` context, so they are gated by
 * their own rules. A wrapper whose inner content cannot be located or parsed
 * is flagged `payloadUnresolved` so the gate can floor it (fail-closed); a
 * provably payload-less invocation (`timeout 5`, bare `env`) is gated by its
 * own text.
 */
export function collectCommands(
	node: TSNode,
	options?: { parseProgram?: ParseProgram },
): BashCommand[] {
	const out: BashCommand[] = [];
	collectCommandsInto(node, TOP_LEVEL_SCOPE, options?.parseProgram, out);
	return out;
}

function collectCommandsInto(
	node: TSNode,
	inherited: UnitScope,
	parseProgram: ParseProgram | undefined,
	out: BashCommand[],
): void {
	// Anonymous tokens (operators `&&`/`;`/`|`, delimiters `$(`/`)`/`` ` ``/`(`)
	// carry no command.
	if (!node.isNamed) return;
	if (COMMAND_ENUM_SKIP.has(node.type)) return;

	const scope = unresolvedScope(node, inherited);

	if (node.type === "command") {
		makeCommandUnit(node, scope, parseProgram, out);
		// A command's text already contains any substitution; descend its subtree
		// to ALSO emit the inner commands of command/process substitutions.
		collectHostedCommands(node, out);
		return;
	}

	if (node.type === "redirected_statement") {
		descendCommandChildren(node, redirectedScope(node, scope), parseProgram, out);
		return;
	}

	if (EXECUTION_HOST_TYPES.has(node.type)) {
		// Not a command itself, but its subtree can host one that really runs
		// (`> $(rm x)`, `< <(rm c)`). Emit only what it hosts (#741).
		collectHostedCommands(node, out);
		return;
	}

	if (node.type === "subshell") {
		out.push(makeUnit(node.text, scope)); // never-weaker whole emit
		descendCommandChildren(node, { ...scope, context: "subshell" }, parseProgram, out);
		return;
	}

	if (COMMAND_ENUM_DESCEND.has(node.type)) {
		descendCommandChildren(node, scope, parseProgram, out);
		return;
	}

	if (COMPOUND_STATEMENT_TYPES.has(node.type)) {
		out.push(makeUnit(node.text, scope)); // never-weaker whole emit
		descendStatementChildren(node, scope, parseProgram, out);
		return;
	}

	if (STATEMENT_GROUP_TYPES.has(node.type)) {
		descendStatementChildren(node, scope, parseProgram, out);
		return;
	}

	if (node.type === "ERROR") {
		// Tree-sitter's error recovery *invents* structure, so the node types
		// inside an ERROR subtree are not evidence that anything runs: descending
		// one turns backtick-quoted prose in an unterminated heredoc into command
		// units. Emit the unparsed blob whole and stop (#742).
		out.push(makeUnit(node.text, scope));
		return;
	}

	// Any other named statement (compound_statement `{ … }`, if/while/for/case,
	// function_definition): emit whole, do not descend — deferred (#306).
	// A declaration, assignment, test, or `unset` still hosts executions that
	// really run (`local x=$(rm y)`, `[[ $(rm x) ]]`), so those are enumerated
	// in addition to the statement (#742).
	out.push(makeUnit(node.text, scope));
	collectHostedCommands(node, out);
}

/**
 * The scope `node`'s own subtree establishes, marking it unresolved when
 * tree-sitter could not parse a region within it (#840).
 *
 * The three pure containers are deliberately excluded. `program`, `list`, and
 * `pipeline` report an error whenever *anything* anywhere beneath them failed,
 * so asking there would mark every unit of the command and make the answer
 * per-program rather than per-statement. Excluded, `rm -rf /tmp/y` in
 * `echo hi > out.txt <> rw.txt; rm -rf /tmp/y` keeps its own rule, while every
 * unit under the failed statement is floored.
 *
 * Over-marking is the fail-closed direction — the flag can only floor an
 * `allow` up to `ask`, never weaken a decision — which is what makes marking a
 * whole statement for a failure buried in one of its redirects acceptable.
 */
function unresolvedScope(node: TSNode, scope: UnitScope): UnitScope {
	if (scope.parseUnresolved) return scope;
	if (COMMAND_ENUM_DESCEND.has(node.type)) return scope;
	return parseUnresolvedWithin(node)
		? { ...scope, parseUnresolved: true }
		: scope;
}

/** The wrapper facts a `command` node's words establish about its unit. */
interface WrapperFacts {
	readonly wrapperKind?: WrapperKind;
	readonly executedUnit?: string;
	readonly floorExemption?: FloorExemption;
	readonly payloadUnresolved?: boolean;
}

function makeUnit(
	text: string,
	scope: UnitScope,
	wrapper: WrapperFacts = {},
): BashCommand {
	const { wrapperKind, executedUnit, floorExemption, payloadUnresolved } =
		wrapper;
	const scoped: BashCommand = scope.context
		? { text, context: scope.context }
		: { text };
	const flagged = wrapperKind ? { ...scoped, wrapperKind } : scoped;
	const named =
		executedUnit === undefined ? flagged : { ...flagged, executedUnit };
	const exempted =
		floorExemption === undefined ? named : { ...named, floorExemption };
	const payloadMarked =
		payloadUnresolved === undefined
			? exempted
			: { ...exempted, payloadUnresolved };
	return scope.parseUnresolved
		? { ...payloadMarked, parseUnresolved: true }
		: payloadMarked;
}

/**
 * Build the unit for a `command` node and emit it into `out`, reading its
 * words once to answer all the wrapper questions: whether the unit is floored,
 * what it actually runs, and whether the floor still has a reason to hold.
 *
 * Fork: the wrapper classification is the fork's own spec-driven
 * {@link classifyWrapperCommand}, which resolves a wrapper's inner commands.
 * Resolved inner commands really execute, so they are emitted as their own
 * units right after the wrapper — tagged `wrapper_payload` /
 * `wrapper_indirection` unless they carry their own metadata — and an
 * unresolvable inner marks the wrapper `payloadUnresolved` (fail-closed).
 */
function makeCommandUnit(
	node: TSNode,
	scope: UnitScope,
	parseProgram: ParseProgram | undefined,
	out: BashCommand[],
): void {
	const text = commandUnitText(node);
	const words = readCommandWords(node);
	const classification = classifyWrapperCommand(node, parseProgram);
	if (classification === undefined) {
		out.push(
			makeUnit(text, scope, {
				executedUnit: executedUnitOf(text, words) ?? undefined,
			}),
		);
		return;
	}
	out.push(
		makeUnit(text, scope, {
			wrapperKind: classification.kind,
			executedUnit: classification.executedUnit,
			floorExemption: isTransparentWrapper(words, scope)
				? "core-reader"
				: undefined,
			payloadUnresolved: classification.unresolved || undefined,
		}),
	);
	const innerContext =
		classification.kind === "opaque-payload"
			? "wrapper_payload"
			: "wrapper_indirection";
	for (const inner of classification.inner) {
		if (
			inner.context !== undefined ||
			inner.wrapperKind !== undefined ||
			inner.payloadUnresolved !== undefined ||
			inner.parseUnresolved !== undefined ||
			inner.floorExemption !== undefined
		) {
			// A unit with its own context or flooring metadata is kept verbatim, so
			// a payload's own wrappers retain their flooring facts.
			out.push(inner);
		} else {
			out.push({ text: inner.text, context: innerContext });
		}
	}
}

/**
 * The scope a `redirected_statement`'s children run under: the enclosing one,
 * plus a write unless every one of its redirects provably only reads.
 *
 * The redirect belongs to the last element of a pipeline, but it hangs off the
 * whole statement in the parse tree, so every command beneath it is marked.
 * Over-attributing is the fail-closed direction — the flag can only withhold an
 * exemption, never grant one — which is also why the question asked of each
 * redirect is a refusal rather than a proof.
 */
function redirectedScope(node: TSNode, scope: UnitScope): UnitScope {
	if (scope.writesViaRedirect) return scope;
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (child?.type !== "file_redirect") continue;
		if (redirectMayWriteFile(child)) {
			return { ...scope, writesViaRedirect: true };
		}
	}
	return scope;
}


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
	 * is gated as an ordinary command by its own text  it is neither marked
	 * unresolved nor floored. Never set alongside {@link unresolved}.
	 *
	 * Wrappers whose bare form executes stdin lines as commands (GNU parallel
	 * and kin, per {@link WrapperSpec.stdinCommands}) are never empty  they
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
				classification = classifyOpaquePayload(args.slice(flagIndex + 1), parseProgram);
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
	// `payloadUnresolved` / `wrapperFloors`. Absent when no inner command can
	// be established (unresolved payload) or when nothing executes (inert).
	const executedUnit =
		classification.unresolved || classification.empty
			? null
			: executedUnitOf(commandUnitText(node), readCommandWords(node));
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
	args: readonly WrapperArg[],
	spec: WrapperSpec,
): WrapperClassification {
	const start = findInnerCommandStart(args, spec);
	if (start !== undefined) {
		return {
			kind: "indirection",
			inner: [{ text: node.text.slice(start) }],
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
 * A `command` node's words — its `command_name` followed by its arguments — each
 * carrying its offset into the unit text `commandUnitText` produces.
 *
 * A leading `variable_assignment` prefix is skipped (matching
 * `commandUnitText`), so offsets are relative to the `command_name`. An empty
 * list means a pure assignment with no `command_name`.
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
	scope: UnitScope,
	parseProgram: ParseProgram | undefined,
	out: BashCommand[],
): void {
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (child) collectCommandsInto(child, scope, parseProgram, out);
	}
}

/**
 * Descend a compound statement's children, enumerating only the ones that are
 * themselves statements.
 *
 * The filter is the whole difference from {@link descendCommandChildren}, whose
 * container types (`program` / `list` / `pipeline` / `redirected_statement` /
 * `subshell`) have nothing but statement children. Here the children are a mix,
 * and a non-statement one is an operand word rather than something that runs.
 *
 * A non-statement child is not abandoned, though: `for f in $(rm x)` hosts a
 * real execution in its word list, which is what the second branch reaches.
 *
 * The scope is relayed unchanged — a compound statement's body runs in the
 * current shell, so a write established by an enclosing `redirected_statement`
 * covers every unit beneath it (#803).
 */
function descendStatementChildren(
	node: TSNode,
	scope: UnitScope,
	parseProgram: ParseProgram | undefined,
	out: BashCommand[],
): void {
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (!child?.isNamed) continue;
		if (STATEMENT_TYPES.has(child.type))
			collectCommandsInto(child, scope, parseProgram, out);
		else collectHostedCommands(child, out);
	}
}

/**
 * Enumerate the commands of every nested execution context in a subtree, each
 * tagged with the context it was found in.
 *
 * The traversal itself lives in `nested-execution.ts` so the bash path surface
 * shares one definition of what counts as a nested execution (#741); this
 * function supplies the command-surface interpretation of each one found.
 *
 * `node` may be a context outright or merely host one, so the traversal is the
 * root-inclusive `forEachExecutionIn`.
 */
function collectHostedCommands(node: TSNode, out: BashCommand[]): void {
	forEachExecutionIn(node, (contextNode, context) => {
		// A nested execution starts fresh: an enclosing statement's redirect is
		// that statement's, not the substitution's, exactly as #807 attributes a
		// nested command's path tokens to its own command. The parse question
		// starts fresh for the same reason and costs nothing either way — each
		// statement inside re-asks it of itself, and the enclosing statement's own
		// units carry the mark regardless, so the verdict is unchanged (#840).
		descendCommandChildren(
			contextNode,
			{ context, writesViaRedirect: false, parseUnresolved: false },
			undefined,
			out,
		);
	});
}
