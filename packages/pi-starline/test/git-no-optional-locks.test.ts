import { beforeEach, describe, expect, it, vi } from "vitest";
import { readGitStatus } from "../extensions/starline/git";

/**
 * Regression test for the `.git/index.lock` churn: every git probe spawned by
 * the statusline refresh must pass `--no-optional-locks` (the global option
 * that stops git from taking the index lock for optional stat refresh).
 * Without it, the frequent event-driven `git status` / `git diff` probes write
 * the index and collide with concurrent git processes, so `.git/index.lock`
 * keeps appearing and disappearing — and occasionally "Unable to create
 * index.lock: File exists" errors surface.
 */
const gitCalls = vi.hoisted(() => [] as string[][]);

vi.mock("node:child_process", () => ({
	execFile: (
		_file: string,
		args: string[],
		_options: Record<string, unknown>,
		callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
	) => {
		gitCalls.push(args);
		const result = { stdout: "", stderr: "" };
		if (typeof callback === "function") callback(null, result);
		else return Promise.resolve(result);
	},
}));

describe("git probes", () => {
	beforeEach(() => {
		gitCalls.length = 0;
	});

	it("passes --no-optional-locks to the status, stash, tag, and metrics probes", async () => {
		const result = await readGitStatus(process.cwd(), {
			readExactTag: true,
			readMetrics: true,
		});

		expect(result.kind).toBe("ok");
		expect(gitCalls.length).toBeGreaterThan(0);
		for (const args of gitCalls) {
			expect(args[0]).toBe("--no-optional-locks");
		}
	});

	it("passes --no-optional-locks to the git-path and work-tree probes", async () => {
		const result = await readGitStatus(process.cwd());

		expect(result.kind).toBe("ok");
		const revParseCalls = gitCalls.filter((args) => args[1] === "rev-parse");
		expect(revParseCalls.length).toBeGreaterThan(0);
		for (const args of revParseCalls) {
			expect(args[0]).toBe("--no-optional-locks");
		}
	});
});
