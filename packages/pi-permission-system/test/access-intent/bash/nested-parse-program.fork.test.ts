/**
 * Fork: `collectCommands` must save/restore `activeParseProgram` across a
 * recursive walk.
 *
 * Why this file exists: an opaque payload (`bash -c`/`eval`/`flock -c`/
 * `env -S`) is re-parsed by `wrapper-parse.ts` through a second
 * `collectCommands` call carrying its own `parseProgram`. When that nested
 * walk cleared the module-level parser in `finally`, the *outer* walk lost it
 * and every later wrapper in the same command was flagged
 * `payloadUnresolved`, so `wrapperFloors: "fallback"` degraded a resolvable
 * `bash -c 'rm -rf /tmp/b'` into `ask`. The regression is invisible with one
 * wrapper per command, which is why these cases assert on a *second* wrapper.
 */

import { describe, expect, it } from "vitest";

import { BashProgram } from "#src/access-intent/bash/program";
import { PathNormalizer } from "#src/path/path-normalizer";
import { pathFlavorForPlatform } from "#src/path/path-flavor";

const normalizer = new PathNormalizer(
  pathFlavorForPlatform(process.platform),
  "/projects/my-app",
);

interface UnitShape {
  text: string;
  wrapperKind: string | null;
  context: string | null;
  payloadUnresolved: boolean | undefined;
}

async function units(command: string): Promise<UnitShape[]> {
  const program = await BashProgram.parse(command, normalizer);
  return program.commands().map((unit) => ({
    text: unit.text,
    wrapperKind: unit.wrapperKind ?? null,
    context: unit.context ?? null,
    payloadUnresolved: unit.payloadUnresolved,
  }));
}

function payloadUnits(shape: UnitShape[]): UnitShape[] {
  return shape.filter((unit) => unit.context === "wrapper_payload");
}

describe("collectCommands re-entrancy keeps the outer parseProgram", () => {
  it("resolves a single opaque wrapper payload", async () => {
    const shape = await units("bash -c 'rm -rf /tmp/b'");
    expect(payloadUnits(shape)).toEqual([
      expect.objectContaining({
        text: "rm -rf /tmp/b",
        payloadUnresolved: undefined,
      }),
    ]);
  });

  it("resolves the second sibling opaque wrapper too", async () => {
    const shape = await units("bash -c 'rm -rf /tmp/a'; bash -c 'rm -rf /tmp/b'");
    const payloads = payloadUnits(shape);
    expect(payloads.map((unit) => unit.text)).toEqual([
      "rm -rf /tmp/a",
      "rm -rf /tmp/b",
    ]);
    expect(payloads.map((unit) => unit.payloadUnresolved)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("resolves a third wrapper after an indirection wrapper", async () => {
    // `sudo` slices its arguments instead of re-parsing, so it never restores
    // a parser; the following `eval` still needs the outer walk's parser.
    const shape = await units(
      "bash -c 'rm -rf /tmp/a'; sudo rm -rf /tmp/b; eval 'rm -rf /tmp/c'",
    );
    const payloads = payloadUnits(shape);
    expect(payloads.map((unit) => unit.text)).toEqual([
      "rm -rf /tmp/a",
      "rm -rf /tmp/c",
    ]);
    expect(payloads.every((unit) => unit.payloadUnresolved === undefined)).toBe(
      true,
    );
  });
});
