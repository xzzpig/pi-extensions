import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getGrammarParser,
  getParser,
  getWarmBashParser,
  resetWarmBashParser,
  warmBashParser,
} from "#src/access-intent/bash/parser";

describe("getParser", () => {
  it("parses a simple bash command and returns a non-null root node", async () => {
    const parser = await getParser();
    const tree = parser.parse("echo hi");
    expect(tree).not.toBeNull();
    expect(tree?.rootNode).toBeDefined();
    expect(tree?.rootNode.type).toBe("program");
    tree?.delete();
  });

  it("returns the same memoized parser instance on repeated calls", async () => {
    const first = await getParser();
    const second = await getParser();
    expect(first).toBe(second);
  });
});

describe("getGrammarParser", () => {
  it("returns the same memoized parser instance on repeated calls", async () => {
    const first = await getGrammarParser();
    const second = await getGrammarParser();
    expect(first).toBe(second);
  });
});

describe("the words after a redirect's target", () => {
  /** The named child types under the first statement of `command`'s parse. */
  async function firstStatement(
    parser: Awaited<ReturnType<typeof getParser>>,
    command: string,
  ): Promise<string[]> {
    const tree = parser.parse(command);
    if (!tree) throw new Error("parser.parse returned null");
    try {
      const statement = tree.rootNode.child(0);
      const types = [statement?.type ?? ""];
      for (let i = 0; i < (statement?.childCount ?? 0); i++) {
        const child = statement?.child(i);
        if (child?.isNamed) types.push(child.type);
      }
      return types;
    } finally {
      tree.delete();
    }
  }

  it("are the command's own words through getParser", async () => {
    await expect(
      firstStatement(await getParser(), "git 2>/dev/null push --force"),
    ).resolves.toEqual([
      "command",
      "command_name",
      "file_redirect",
      "word",
      "word",
    ]);
  });

  it("stay on the redirect through getGrammarParser", async () => {
    await expect(
      firstStatement(await getGrammarParser(), "git 2>/dev/null push --force"),
    ).resolves.toEqual(["redirected_statement", "command", "file_redirect"]);
  });
});

describe("warm parser", () => {
  beforeEach(() => {
    resetWarmBashParser();
  });
  afterEach(() => {
    resetWarmBashParser();
  });

  it("returns null before the parser is warmed", () => {
    expect(getWarmBashParser()).toBeNull();
  });

  it("exposes the parser synchronously after warm-up", async () => {
    await warmBashParser();
    const parser = getWarmBashParser();
    expect(parser).not.toBeNull();
    const tree = parser?.parse("echo hi");
    expect(tree?.rootNode.type).toBe("program");
    tree?.delete();
  });

  it("hands out the same memoized parser as getParser", async () => {
    await warmBashParser();
    expect(getWarmBashParser()).toBe(await getParser());
  });

  it("resetWarmBashParser clears the cached parser", async () => {
    await warmBashParser();
    expect(getWarmBashParser()).not.toBeNull();
    resetWarmBashParser();
    expect(getWarmBashParser()).toBeNull();
  });
});
