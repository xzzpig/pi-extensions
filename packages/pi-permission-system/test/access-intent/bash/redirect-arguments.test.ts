import { describe, expect, it } from "vitest";
import { getGrammarParser, type TSNode } from "#src/access-intent/bash/parser";
import { reattachRedirectArguments } from "#src/access-intent/bash/redirect-arguments";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse `command` with the grammar's own parser and hand the corrected root,
 * alongside the grammar's, to `read`.
 *
 * The grammar's parser, not `getParser()`: the subject is what the correction
 * does to `tree-sitter-bash`'s real output, so the input must be that output.
 */
async function withCorrected<T>(
  command: string,
  read: (corrected: TSNode, grammar: TSNode) => T,
): Promise<T> {
  const parser = await getGrammarParser();
  const tree = parser.parse(command);
  if (!tree) throw new Error("parser.parse returned null");
  try {
    // Read once: web-tree-sitter builds a new wrapper on every access.
    const root = tree.rootNode;
    return read(reattachRedirectArguments(root), root);
  } finally {
    tree.delete();
  }
}

/**
 * A node's named structure as an S-expression: an inner node renders as
 * `(type child…)`, and a node with no named children as its text in quotes.
 */
function shape(node: TSNode): string {
  const named: TSNode[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.isNamed) named.push(child);
  }
  if (named.length === 0) return JSON.stringify(node.text);
  return `(${node.type} ${named.map(shape).join(" ")})`;
}

function correctedShape(command: string): Promise<string> {
  return withCorrected(command, (corrected) => shape(corrected));
}

/** Every node of a tree, depth-first. */
function allNodes(node: TSNode, out: TSNode[] = []): TSNode[] {
  out.push(node);
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) allNodes(child, out);
  }
  return out;
}

/** A node's range and type, which identify it across a real node and a view. */
function spanOf(node: TSNode | null): string | null {
  return node ? `${node.type}@${node.startIndex}-${node.endIndex}` : null;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("reattachRedirectArguments", () => {
  describe("a redirect the grammar hung the command's words on", () => {
    it("hands the words back to a command body", async () => {
      // Nothing is left at the statement, so the corrected command takes its
      // place, exactly as the grammar parses `2>/dev/null git push --force`.
      await expect(
        correctedShape("git 2>/dev/null push --force"),
      ).resolves.toBe(
        '(program (command (command_name "git") (file_redirect "2" "/dev/null") "push" "--force"))',
      );
    });

    it("keeps a redirect after the last word at the statement", async () => {
      await expect(correctedShape("cmd a > out b 2>&1")).resolves.toBe(
        '(program (redirected_statement (command (command_name "cmd") "a" (file_redirect "out") "b") (file_redirect "2" "1")))',
      );
    });

    it("moves every redirect up to the last word, in source order", async () => {
      // `<in` carries no words of its own, but it sits before `arg1`, so it
      // moves with the rest and the command's children stay in source order.
      await expect(
        correctedShape("cmd <in 2>err arg1 >out arg2"),
      ).resolves.toBe(
        '(program (command (command_name "cmd") (file_redirect "in") (file_redirect "2" "err") "arg1" (file_redirect "out") "arg2"))',
      );
    });

    it("hands the words to a close operator's command, since it has no target", async () => {
      await expect(correctedShape("cmd >&- arg")).resolves.toBe(
        '(program (command (command_name "cmd") ">&-" "arg"))',
      );
    });

    it("hands the words to the last command of a list the grammar grouped", async () => {
      // The grammar hangs the redirect off the whole `&&` list; bash gives it
      // and its words to `git`.
      await expect(
        correctedShape("cd a && b && git 2>/dev/null push"),
      ).resolves.toBe(
        '(program (list (list (command (command_name "cd") "a") (command (command_name "b"))) (command (command_name "git") (file_redirect "2" "/dev/null") "push")))',
      );
    });

    it("hands the words to the last stage of a pipeline the grammar grouped", async () => {
      // A redirect on the last stage hangs off the whole pipeline in the
      // grammar; bash gives it and its words to that stage.
      await expect(correctedShape("rg -l x | xargs ls 2>&1 ~/x")).resolves.toBe(
        '(program (pipeline (command (command_name "rg") "-l" "x") (command (command_name "xargs") "ls" (file_redirect "2" "1") "~/x")))',
      );
    });
  });

  describe("a statement nested in another node", () => {
    it.each([
      [
        "a pipeline",
        "git 2>/dev/null push --force | tail",
        '(program (pipeline (command (command_name "git") (file_redirect "2" "/dev/null") "push" "--force") (command (command_name "tail"))))',
      ],
      [
        "a command substitution",
        "x=$(git 2>/dev/null push --force)",
        '(program (variable_assignment "x" (command_substitution (command (command_name "git") (file_redirect "2" "/dev/null") "push" "--force"))))',
      ],
      [
        "a word moved out of another redirect",
        "echo 2>/dev/null $(git 2>/dev/null push)",
        '(program (command (command_name "echo") (file_redirect "2" "/dev/null") (command_substitution (command (command_name "git") (file_redirect "2" "/dev/null") "push"))))',
      ],
    ])("is corrected inside %s", async (_label, command, expected) => {
      await expect(correctedShape(command)).resolves.toBe(expected);
    });
  });

  describe("a tree with nothing to correct", () => {
    it.each([
      ["no redirect", "git push --force"],
      ["a redirect after the last word", "git push --force 2>/dev/null"],
      ["a redirect before the command", "2>/dev/null git push --force"],
      ["a statement whose parse failed", "cat <> rw.txt extra"],
      ["a compound body bash rejects", "{ a; } 2>/dev/null b"],
    ])("returns the grammar's own root for %s", async (_label, command) => {
      await withCorrected(command, (corrected, grammar) => {
        expect(corrected).toBe(grammar);
      });
    });
  });

  describe("the corrected tree", () => {
    const rewritten = [
      "git 2>/dev/null push --force",
      "cmd a > out b 2>&1",
      "cmd <in 2>err arg1 >out arg2",
      "cmd >&- arg",
      "cd a && b && git 2>/dev/null push",
      "echo é 2>/dev/null $(git 2>/dev/null push) | tail",
    ];

    it.each(rewritten)(
      "keeps every node's text its source slice in %s",
      async (command) => {
        await withCorrected(command, (corrected) => {
          for (const node of allNodes(corrected)) {
            expect(node.text).toBe(
              command.slice(node.startIndex, node.endIndex),
            );
          }
        });
      },
    );

    it.each(rewritten)(
      "keeps every node's children in source order in %s",
      async (command) => {
        await withCorrected(command, (corrected) => {
          for (const node of allNodes(corrected)) {
            for (let i = 1; i < node.childCount; i++) {
              const before = node.child(i - 1);
              const after = node.child(i);
              expect(after?.startIndex).toBeGreaterThanOrEqual(
                before?.endIndex ?? Number.POSITIVE_INFINITY,
              );
            }
          }
        });
      },
    );

    it.each(rewritten)(
      "gives every child its corrected previous sibling in %s",
      async (command) => {
        await withCorrected(command, (corrected) => {
          for (const node of allNodes(corrected)) {
            for (let i = 0; i < node.childCount; i++) {
              expect(spanOf(node.child(i)?.previousSibling ?? null)).toBe(
                spanOf(i === 0 ? null : node.child(i - 1)),
              );
            }
          }
        });
      },
    );

    it.each(rewritten)("reports no parse error in %s", async (command) => {
      await withCorrected(command, (corrected) => {
        expect(allNodes(corrected).some((node) => node.hasError)).toBe(false);
      });
    });
  });
});
