/**
 * Shared test fixtures: a fake `openspec` executable plus temp-dir helpers.
 *
 * The fake CLI is a real executable shell script driven through the real
 * spawnSync, so PATH resolution and child-process plumbing stay under test;
 * only scenario outputs are parameterized.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const FAKE_CLI_VERSION = "9.9.9-test";

export const FAKE_SCHEMAS = [
  {
    name: "spec-driven",
    description:
      "Default OpenSpec workflow - proposal → specs → design → tasks",
    artifacts: ["proposal", "specs", "design", "tasks"],
    source: "package",
  },
  {
    name: "lite",
    description: "Lite workflow - proposal → tasks",
    artifacts: ["proposal", "tasks"],
    source: "package",
  },
];

export const FAKE_TEMPLATES: Record<string, { path: string; source: string }> =
  Object.fromEntries(
    ["proposal", "specs", "design", "tasks"].map((artifact) => [
      artifact,
      { path: `/tmp/fake-templates/${artifact}.md`, source: "package" },
    ]),
  );

export interface FakeCliOptions {
  version?: string;
  schemasStdout?: string;
  templatesStdout?: string;
  schemasExitCode?: number;
}

/** Create a directory containing a fake `openspec` executable. */
export function makeFakeCliDir(options: FakeCliOptions = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-openspec-x-fake-cli-"));
  const {
    version = FAKE_CLI_VERSION,
    schemasStdout = JSON.stringify(FAKE_SCHEMAS),
    templatesStdout = JSON.stringify(FAKE_TEMPLATES),
    schemasExitCode = 0,
  } = options;
  const shQuote = (value: string): string =>
    `'${value.replaceAll("'", "'\\''")}'`;
  const script = [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then',
    `  echo ${shQuote(version)}`,
    "  exit 0",
    "fi",
    'if [ "$1" = "schemas" ]; then',
    ...(schemasExitCode === 0
      ? [`  echo ${shQuote(schemasStdout)}`, "  exit 0"]
      : ['  echo "boom" >&2', `  exit ${schemasExitCode}`]),
    "fi",
    'if [ "$1" = "templates" ]; then',
    `  echo ${shQuote(templatesStdout)}`,
    "  exit 0",
    "fi",
    'echo "unexpected args: $*" >&2',
    "exit 64",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "openspec"), script, {
    encoding: "utf-8",
    mode: 0o755,
  });
  return dir;
}

/** Environment whose PATH finds only the given fake CLI dir. */
export function fakeCliEnv(
  cliDir: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return { ...extra, PATH: cliDir };
}

export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
