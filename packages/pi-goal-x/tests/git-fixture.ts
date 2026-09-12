/**
 * Shared git fixtures for the workspace-change-manifest tests.
 *
 * Not a test file on purpose: the unit runner discovers `tests/*.test.ts` only
 * and `tests/.test-manifest.json` pins exactly those entries.
 *
 * Every fixture isolates git from the developer's global/system config
 * (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`) so assertions do not depend on
 * machine state, and sets `protocol.file.allow=always` so `git submodule add`
 * from a local path works in tests.
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** True when a `git` binary is available; tests skip cleanly when it is not. */
export const gitAvailable: boolean = (() => {
	try {
		return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
	} catch {
		return false;
	}
})();

export interface GitFixture {
	/** Absolute, symlink-resolved fixture root (a repository after `gitInit`). */
	readonly dir: string;
	/** Run git inside the fixture (or `cwd`), inheriting the isolated config. */
	git(args: readonly string[], cwd?: string): string;
	/** Run git and return its exit status instead of throwing. */
	gitStatus(args: readonly string[], cwd?: string): number;
	write(relativePath: string, content: string): void;
	read(relativePath: string): string;
	mkdir(relativePath: string): string;
	remove(): void;
}

function isolatedEnv(dir: string): NodeJS.ProcessEnv {
	const emptyGlobal = path.join(dir, ".gitconfig-isolated");
	if (!fs.existsSync(emptyGlobal)) fs.writeFileSync(emptyGlobal, "", "utf8");
	return {
		...process.env,
		GIT_CONFIG_GLOBAL: emptyGlobal,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
	};
}

/** Create a temp directory (optionally initialized as a repository). */
export function makeGitFixture(options: { init?: boolean } = {}): GitFixture {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "goal-manifest-")));
	const env = isolatedEnv(dir);

	const git = (args: readonly string[], cwd: string = dir): string =>
		execFileSync("git", [...args], { cwd, env, encoding: "utf8" }).toString();

	const gitStatus = (args: readonly string[], cwd: string = dir): number => {
		try {
			return spawnSync("git", [...args], { cwd, env, stdio: "ignore" }).status ?? 1;
		} catch {
			return 1;
		}
	};

	const write = (relativePath: string, content: string): void => {
		const target = path.join(dir, relativePath);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content, "utf8");
	};

	const fixture: GitFixture = {
		dir,
		git,
		gitStatus,
		write,
		read: (relativePath: string) => fs.readFileSync(path.join(dir, relativePath), "utf8"),
		mkdir: (relativePath: string) => {
			const target = path.join(dir, relativePath);
			fs.mkdirSync(target, { recursive: true });
			return target;
		},
		remove: () => fs.rmSync(dir, { recursive: true, force: true }),
	};

	if (options.init !== false) initRepo(fixture);
	return fixture;
}

/**
 * Give a repository (including a submodule's working tree) the fixture's local
 * identity and safety config. Submodule clones do not inherit the
 * superproject's local config, so commits inside them fail without this.
 */
export function configureRepo(fixture: GitFixture, dir: string = fixture.dir): void {
	fixture.git(["config", "user.email", "fixture@example.com"], dir);
	fixture.git(["config", "user.name", "Fixture"], dir);
	fixture.git(["config", "commit.gpgsign", "false"], dir);
	fixture.git(["config", "core.autocrlf", "false"], dir);
	// Local-path submodule add is blocked by default since git 2.38.
	fixture.git(["config", "protocol.file.allow", "always"], dir);
}

/** Initialize a repository at `dir` (or the fixture root) with one commit. */
export function initRepo(fixture: GitFixture, dir: string = fixture.dir, options: { commit?: boolean } = {}): void {
	// `-c` must precede the subcommand; `git init -c ...` is not accepted.
	fixture.git(["-c", "init.defaultBranch=main", "init", "-q"], dir);
	configureRepo(fixture, dir);
	if (options.commit === false) return;
	// The seed file must land in `dir`, which may be a nested repository.
	fs.writeFileSync(path.join(dir, ".gitkeep"), "");
	fixture.git(["add", "-A"], dir);
	fixture.git(["commit", "-q", "-m", "initial"], dir);
}
