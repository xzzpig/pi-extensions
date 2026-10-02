import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetWarmBashParser,
  warmBashParser,
} from "#src/access-intent/bash/parser";
import { parseBashCommandsSync } from "#src/access-intent/bash/sync-commands";

describe("parseBashCommandsSync", () => {
  beforeEach(() => {
    resetWarmBashParser();
  });
  afterEach(() => {
    resetWarmBashParser();
  });

  it("returns null when the parser is not warm", () => {
    expect(parseBashCommandsSync("echo hi")).toBeNull();
  });

  describe("once warm", () => {
    beforeEach(async () => {
      await warmBashParser();
    });

    it("withholds a wrapped reader's exemption once its argument's HOME is reassigned", () => {
      expect(parseBashCommandsSync('xargs find "$HOME"')).toEqual([
        {
          text: 'xargs find "$HOME"',
          wrapperKind: "indirection",
          executedUnit: 'find "$HOME"',
          floorExemption: "core-reader",
        },
      ]);
      expect(parseBashCommandsSync('HOME=-delete; xargs find "$HOME"')).toEqual(
        [
          { text: "HOME=-delete" },
          {
            text: 'xargs find "$HOME"',
            wrapperKind: "indirection",
            executedUnit: 'find "$HOME"',
          },
        ],
      );
    });

    it("returns a single unit for a lone command", () => {
      expect(parseBashCommandsSync("echo hi")).toEqual([{ text: "echo hi" }]);
    });

    it("decomposes a chained command into its units", () => {
      expect(parseBashCommandsSync("cd /repo && npm install x")).toEqual([
        { text: "cd /repo" },
        { text: "npm install x" },
      ]);
    });

    it("descends into a command substitution, tagging its context", () => {
      expect(parseBashCommandsSync("echo $(rm -rf /)")).toEqual([
        { text: "echo $(rm -rf /)" },
        { text: "rm -rf /", context: "command_substitution" },
      ]);
    });

    it("flags an opaque wrapper", () => {
      expect(parseBashCommandsSync('bash -c "rm -rf /"')).toEqual([
        {
          text: 'bash -c "rm -rf /"',
          wrapperKind: "opaque-payload",
          executedUnit: "rm -rf /",
        },
      ]);
    });

    it("returns an empty array for a comment-only command", () => {
      expect(parseBashCommandsSync("# just a comment")).toEqual([]);
    });

    it("returns an empty array for an empty command", () => {
      expect(parseBashCommandsSync("")).toEqual([]);
    });

    it("enumerates a command a partial parse dropped (#875)", () => {
      // Gate parity (#309): the advisory answer must not be weaker than the
      // gate's, and the gate salvages this command through `BashProgram`.
      expect(
        parseBashCommandsSync(
          "git add -A . && git commit -F - <<'MSG' 2>&1 | rm -rf /tmp/x\nmsg\nMSG",
        ),
      ).toEqual([
        { text: "git add -A .", parseUnresolved: true },
        { text: "git commit -F", parseUnresolved: true },
        { text: "rm -rf /tmp/x", parseUnresolved: true, salvaged: true },
        { text: "git add -A .", parseUnresolved: true, salvaged: true },
        { text: "git commit -F", parseUnresolved: true, salvaged: true },
        { text: "rm -rf /tmp/x", parseUnresolved: true, salvaged: true },
      ]);
    });

    it("enumerates a command after a heredoc the grammar cannot parse", () => {
      expect(
        parseBashCommandsSync("cat <<EOF ; rm -rf /tmp/x\nb\nEOF"),
      ).toEqual([
        { text: "cat", parseUnresolved: true },
        { text: "cat", parseUnresolved: true, salvaged: true },
        { text: "rm -rf /tmp/x", parseUnresolved: true, salvaged: true },
      ]);
    });
  });
});
