/**
 * Fork: `rtk` is a transparent output proxy, so the bash gate must gate the
 * command it proxies rather than the proxy itself.
 *
 * Why this file exists: the RTK extension's `tool_call` handler runs before the
 * permission gate's — `~/.pi/agent/extensions/*` (precedence rank 3) is loaded
 * ahead of every package (rank 4) — and rewrites `git add x` into
 * `rtk git add x` in place. The bash surface matches `^…$`-anchored globs, so
 * `git add *` stopped matching the rewritten unit and only a catch-all `*`
 * decided it: `git add *: ask`, `git commit *: ask`, `git push *: ask` and
 * `find /: deny` were silently bypassed. `INDIRECTION_WRAPPER_NAMES` carries
 * `"rtk"` so the enumerator peels the proxy and emits the proxied command as
 * its own gated unit — which also makes the outcome independent of which
 * handler ran first.
 *
 * The gate is exercised through the real `BashProgram` parse and a real
 * filesystem-backed `PermissionResolver`, so the assertions cover the
 * composition (parse → unit enumeration → `bash` surface match) rather than a
 * hand-built unit list.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BashProgram } from "#src/access-intent/bash/program";
import type { BashCommand } from "#src/access-intent/bash/command-enumeration";
import { resolveBashCommandCheck } from "#src/handlers/gates/bash-command";
import { PathNormalizer } from "#src/path/path-normalizer";
import { pathFlavorForPlatform } from "#src/path/path-flavor";
import { PermissionResolver } from "#src/policy/permission-resolver";
import { SessionRules } from "#src/session/session-rules";
import { createManagerWithConfig } from "#test/helpers/manager-harness";

const CWD = "/projects/my-app";

/**
 * The rule set the proxy rewrite defeated: a permissive catch-all plus the
 * git/find rules an anchored match can no longer reach once `rtk ` is
 * prefixed.
 */
const PERMISSION: Record<string, unknown> = {
  "*": "allow",
  bash: {
    "*": "allow",
    "git add *": "ask",
    "git commit *": "ask",
    "git push *": "ask",
    "find /": "deny",
    "find / *": "deny",
  },
};

let cleanups: (() => void)[] = [];

beforeEach(() => {
  cleanups = [];
});

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
});

function realResolver(): PermissionResolver {
  const { manager, cleanup } = createManagerWithConfig(PERMISSION);
  cleanups.push(cleanup);
  return new PermissionResolver(manager, new SessionRules());
}

const normalizer = new PathNormalizer(
  pathFlavorForPlatform(process.platform),
  CWD,
);

async function parse(command: string) {
  return BashProgram.parse(command, normalizer, { workdir: CWD });
}

/** The gate's verdict for a real command, through the real parse. */
async function decide(command: string) {
  const program = await parse(command);
  return resolveBashCommandCheck(
    program.commandText(),
    program.commands(),
    undefined,
    realResolver(),
    { wrapperFloors: "fallback" },
  );
}

/** The gate's verdict for a hand-built unit list (flooring pins only). */
function decideUnits(command: string, commands: BashCommand[]) {
  return resolveBashCommandCheck(
    command,
    commands,
    undefined,
    realResolver(),
    { wrapperFloors: "fallback" },
  );
}

/** A unit's text plus the wrapper facts the gate reads off it. */
function shape(commands: readonly BashCommand[]) {
  return commands.map((cmd) => ({
    text: cmd.text,
    wrapperKind: cmd.wrapperKind ?? null,
    context: cmd.context ?? null,
  }));
}

describe("rtk as an indirection wrapper (fork)", () => {
  describe("unit enumeration peels the proxy", () => {
    it("emits the proxied command as its own unit next to the wrapper unit", async () => {
      const program = await parse("rtk git add .pi/pi-goal-x-settings.json");
      expect(shape(program.commands())).toEqual([
        {
          text: "rtk git add .pi/pi-goal-x-settings.json",
          wrapperKind: "indirection",
          context: null,
        },
        {
          text: "git add .pi/pi-goal-x-settings.json",
          wrapperKind: null,
          context: "wrapper_indirection",
        },
      ]);
    });

    it("peels every proxy in a chain", async () => {
      const program = await parse(
        'rtk git add a.json && rtk git commit -m "x" && rtk git log --stat -1',
      );
      expect(program.commands().map((cmd) => cmd.text)).toEqual([
        "rtk git add a.json",
        "git add a.json",
        'rtk git commit -m "x"',
        'git commit -m "x"',
        "rtk git log --stat -1",
        "git log --stat -1",
      ]);
    });

    it("leaves a non-proxy command untouched", async () => {
      const program = await parse("git add -A");
      expect(shape(program.commands())).toEqual([
        { text: "git add -A", wrapperKind: null, context: null },
      ]);
    });
  });

  describe("the proxied command decides the gate", () => {
    it.each([
      ["rtk git add .pi/pi-goal-x-settings.json", "ask", "git add *"],
      ['rtk git commit -m "chore: x"', "ask", "git commit *"],
      ["rtk git push origin main", "ask", "git push *"],
      ["rtk find / -name y", "deny", "find / *"],
      ["rtk ls -al", "allow", "*"],
      ["rtk read package.json", "allow", "*"],
    ])("%s → %s (%s)", async (command, state, matchedPattern) => {
      const result = await decide(command);
      expect({ state: result.state, matchedPattern: result.matchedPattern }).toEqual(
        { state, matchedPattern },
      );
    });

    it("gates the incident command on its first proxied unit", async () => {
      const result = await decide(
        `cd ${CWD}; rtk git add .pi/pi-goal-x-settings.json && rtk git commit -m "x" && rtk log --stat -1`,
      );
      expect({
        state: result.state,
        matchedPattern: result.matchedPattern,
        command: result.command,
      }).toEqual({
        state: "ask",
        matchedPattern: "git add *",
        command: "git add .pi/pi-goal-x-settings.json",
      });
    });

    it("reaches the deny a catch-all used to shadow", async () => {
      // The deny is the severe half of the defect: an unpeeled `rtk find /`
      // matched `*: allow` and ran.
      expect(await decide("rtk find /")).toMatchObject({ state: "deny" });
    });
  });

  describe("boundaries", () => {
    it("skips a proxy's own leading options before the inner command", async () => {
      // `findInnerCommandStart` consumes `-`-prefixed words as the wrapper's
      // own syntax, so a leading global flag does not become the inner
      // command's head. Pinned because it is the flag shape RTK may add.
      const result = await decide("rtk --ultra-compact git add a.json");
      expect({
        state: result.state,
        matchedPattern: result.matchedPattern,
      }).toEqual({ state: "ask", matchedPattern: "git add *" });
    });

    it("gates a bare proxy by its own text (inert invocation)", async () => {
      const program = await parse("rtk");
      expect(shape(program.commands())).toEqual([
        { text: "rtk", wrapperKind: "indirection", context: null },
      ]);
      expect(await decide("rtk")).toMatchObject({ state: "allow" });
    });

    it("does not see through a proxy subcommand that wraps a command (pre-existing gap)", async () => {
      // `rtk err <cmd>` / `rtk test <cmd>` / `rtk summary <cmd>` name their
      // payload after an rtk subcommand word, so the inner unit's head is
      // `err`, not `<cmd>`, and only `*` decides it. This is unchanged by the
      // fix — an unpeeled `rtk err …` also matched `*` before — and
      // `rtk rewrite` emits no such form (it only ever emits `rtk <tool> …`
      // where `<tool>` is the original command name or a read-only alias), so
      // it is out of scope here and recorded as a follow-up.
      const result = await decide("rtk err git push origin main");
      expect({
        state: result.state,
        matchedPattern: result.matchedPattern,
      }).toEqual({ state: "allow", matchedPattern: "*" });
    });

    it("floors an unresolved indirection payload to ask in fallback mode", () => {
      // Not reachable through a real `rtk` parse (its spec declares no
      // `stdinCommands`), but the generic floor must keep holding for the
      // wrapper kind this fork now assigns to `rtk`.
      const result = decideUnits("rtk git add a.json", [
        {
          text: "rtk git add a.json",
          wrapperKind: "indirection",
          payloadUnresolved: true,
        },
      ]);
      expect({
        state: result.state,
        matchedPattern: result.matchedPattern,
      }).toEqual({
        state: "ask",
        matchedPattern: "<indirection-bash-wrapper>",
      });
    });
  });
});
