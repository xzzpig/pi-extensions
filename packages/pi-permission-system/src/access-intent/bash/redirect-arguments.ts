import { parseUnresolvedWithin } from "./parse-health";
import type { TSNode } from "./parser";
import { trailingArgumentIndex } from "./redirect-analysis";

/**
 * `tree-sitter-bash`'s parse with each word it hung on a redirect handed back
 * to the command it belongs to.
 *
 * The grammar (0.25.1) declares a file redirect's destination `repeat1`, so in
 * `git 2>/dev/null push --force` the words `push --force` parse as further
 * destinations of the statement's redirect, where bash passes them to `git`
 * (tree-sitter/tree-sitter-bash#233). Every consumer of the parse (the command
 * enumerator, the path walkers, the effect proofs, the log masker) would
 * otherwise have to learn that quirk on its own, so it is corrected once, here,
 * where the tree enters the package (#977).
 *
 * The corrected shape is the one the grammar already produces for a redirect
 * written before the command: the redirect becomes a child of the `command`,
 * between its words. Every redirect from the body up to the last one carrying
 * words moves into the command, each truncated after its own target and
 * followed by its words; a redirect after the last word stays at the
 * statement, and a statement left with no redirect gives way to its body.
 *
 * Three kinds of statement are left exactly as the grammar produced them:
 *
 * - One whose parse failed. Its units are floored already, and moving a word
 *   out of an unresolvable redirect would hand it the command's effect proof in
 *   place of the redirect's refusal to prove one (#814).
 * - One whose body is not a command (`{ a; } 2>/dev/null b`), which bash
 *   rejects as a syntax error, so nothing runs.
 * - One with no words after any redirect's target, which is almost every one.
 *
 * Returns `root` itself when nothing in the tree needs correcting. A corrected
 * node reads its offsets and text from the source, so `startIndex`/`endIndex`
 * stay positions in the command string every caller already slices.
 */
export function reattachRedirectArguments(root: TSNode): TSNode {
  return correct(root) ?? root;
}

/** The corrected node, or `undefined` when nothing beneath `node` changed. */
function correct(node: TSNode): TSNode | undefined {
  const children: TSNode[] = [];
  let changed = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    const corrected = correct(child);
    if (corrected) changed = true;
    children.push(corrected ?? child);
  }

  if (node.type === "redirected_statement" && !parseUnresolvedWithin(node)) {
    const reattached = reattachStatement(node, children);
    if (reattached) return reattached;
  }
  return changed
    ? adoptingView(node, children, parseUnresolvedWithin(node))
    : undefined;
}

/**
 * Move the words the grammar hung on `statement`'s redirects into the command
 * they belong to, or `undefined` when there are none or no command to take
 * them. `children` are the statement's children, already corrected.
 */
function reattachStatement(
  statement: TSNode,
  children: readonly TSNode[],
): TSNode | undefined {
  const bodyIndex = children.findIndex((child) => child.isNamed);
  const body = children.at(bodyIndex);
  if (!body || !reachesCommand(body)) return undefined;

  const lastCarrier = children.findLastIndex(
    (child) =>
      child.type === "file_redirect" &&
      trailingArgumentIndex(child) !== undefined,
  );
  if (lastCarrier === -1) return undefined;

  const source = sourceOf(statement);
  const moved = children
    .slice(bodyIndex + 1, lastCarrier + 1)
    .flatMap((child) => splitRedirect(child, source));
  const newBody = appendToRightmostCommand(body, moved, source);
  const rest = children.slice(lastCarrier + 1);
  if (!rest.some((child) => child.isNamed)) return newBody;
  return rewrittenNode(
    statement,
    [...children.slice(0, bodyIndex), newBody, ...rest],
    statement.startIndex,
    statement.endIndex,
    source,
  );
}

/**
 * Whether the words after a redirect on `body` belong to a command: `body` is
 * one, or is a `list` or `pipeline` whose last element reaches one. The grammar
 * hangs a redirect on the last command of `cd a && git 2>/dev/null push` or
 * `rg x | xargs ls 2>&1 ~/x` off the whole list or pipeline, while bash gives
 * it, and its words, to that last command.
 */
function reachesCommand(body: TSNode): boolean {
  if (body.type === "command") return true;
  if (!GROUPING_TYPES.has(body.type)) return false;
  const last = lastNamedChild(body);
  return last !== undefined && reachesCommand(last);
}

/** The bodies whose last element a statement-level redirect belongs to. */
const GROUPING_TYPES: ReadonlySet<string> = new Set(["list", "pipeline"]);

/**
 * `redirect` as it belongs in the command: truncated after its own target and
 * followed by the words the grammar appended to it. A redirect carrying no
 * words, or a node that is not a file redirect, moves as it is.
 */
function splitRedirect(redirect: TSNode, source: Source): TSNode[] {
  const trailing =
    redirect.type === "file_redirect"
      ? trailingArgumentIndex(redirect)
      : undefined;
  if (trailing === undefined) return [redirect];

  const kept: TSNode[] = [];
  const words: TSNode[] = [];
  for (let i = 0; i < redirect.childCount; i++) {
    const child = redirect.child(i);
    if (child) (i < trailing ? kept : words).push(child);
  }
  const end = kept.at(-1)?.endIndex ?? redirect.startIndex;
  return [
    rewrittenNode(redirect, kept, redirect.startIndex, end, source),
    ...words,
  ];
}

/**
 * `body` with `moved` appended to its rightmost command: the command itself,
 * or the last element of a `list` or `pipeline`, recursively. Each node on the way grows to
 * the end of the last moved node.
 */
function appendToRightmostCommand(
  body: TSNode,
  moved: readonly TSNode[],
  source: Source,
): TSNode {
  const children = childrenOf(body);
  const end = moved.at(-1)?.endIndex ?? body.endIndex;
  if (body.type === "command") {
    return rewrittenNode(
      body,
      [...children, ...moved],
      body.startIndex,
      end,
      source,
    );
  }
  const lastIndex = children.findLastIndex((child) => child.isNamed);
  const last = children[lastIndex];
  const replaced = children.with(
    lastIndex,
    appendToRightmostCommand(last, moved, source),
  );
  return rewrittenNode(body, replaced, body.startIndex, end, source);
}

/** A node the correction built, reading its text from the statement's source. */
function rewrittenNode(
  original: TSNode,
  children: readonly TSNode[],
  startIndex: number,
  endIndex: number,
  source: Source,
): TSNode {
  return adoptingView(
    {
      type: original.type,
      isNamed: original.isNamed,
      startIndex,
      endIndex,
      text: source(startIndex, endIndex),
    },
    children,
    false,
  );
}

/**
 * A view whose children are views too, so each one's `previousSibling` is its
 * neighbor in the corrected tree rather than the one the grammar gave it.
 */
function adoptingView(
  fields: NodeFields,
  children: readonly TSNode[],
  hasError: boolean,
): TSNode {
  return new NodeView(fields, children.map(asView), hasError);
}

/** A slice of the command by absolute offsets. */
type Source = (startIndex: number, endIndex: number) => string;

/** The source slicer for every node within `statement`. */
function sourceOf(statement: TSNode): Source {
  return (startIndex, endIndex) =>
    statement.text.slice(
      startIndex - statement.startIndex,
      endIndex - statement.startIndex,
    );
}

function childrenOf(node: TSNode): TSNode[] {
  const children: TSNode[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) children.push(child);
  }
  return children;
}

function lastNamedChild(node: TSNode): TSNode | undefined {
  return childrenOf(node).findLast((child) => child.isNamed);
}

/**
 * `node` as a view, so a new parent can give it a new previous sibling.
 *
 * Its own children stay the grammar's nodes: nothing beneath it moved, so their
 * siblings are still the grammar's too.
 */
function asView(node: TSNode): TSNode {
  return node instanceof NodeView
    ? node
    : new NodeView(node, childrenOf(node), parseUnresolvedWithin(node));
}

/** The fields a {@link NodeView} copies from the node it stands for. */
interface NodeFields {
  readonly type: string;
  readonly isNamed: boolean;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly text: string;
}

/**
 * A parse-tree node the correction presents in place of the grammar's.
 *
 * Adopting its children sets each view child's `previousSibling` to the child
 * before it, which is what lets a redirect moved into a command ask
 * `parseUnresolvedAt` about its new neighbor.
 */
class NodeView implements TSNode {
  readonly type: string;
  readonly isNamed: boolean;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly text: string;
  readonly childCount: number;
  previousSibling: TSNode | null = null;

  constructor(
    fields: NodeFields,
    private readonly children: readonly TSNode[],
    readonly hasError: boolean,
  ) {
    this.type = fields.type;
    this.isNamed = fields.isNamed;
    this.startIndex = fields.startIndex;
    this.endIndex = fields.endIndex;
    this.text = fields.text;
    this.childCount = children.length;
    children.forEach((child, i) => {
      if (child instanceof NodeView)
        child.previousSibling = children[i - 1] ?? null;
    });
  }

  child(index: number): TSNode | null {
    return this.children[index] ?? null;
  }
}
