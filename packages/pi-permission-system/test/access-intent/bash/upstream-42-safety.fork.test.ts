/** Fork regression coverage for the v42 wrapper-security synchronization. */
import { afterEach, describe, expect, it } from "vitest";
import { warmBashParser } from "#src/access-intent/bash/parser";
import { BashProgram } from "#src/access-intent/bash/program";
import { resolveBashCommandCheck } from "#src/handlers/gates/bash-command";
import { posixPathFlavor } from "#src/path/path-flavor";
import { PathNormalizer } from "#src/path/path-normalizer";
import { PermissionResolver } from "#src/policy/permission-resolver";
import { SessionRules } from "#src/session/session-rules";
import type { WrapperFloors } from "#src/types";
import { createManagerWithConfig } from "#test/helpers/manager-harness";

const normalizer = new PathNormalizer(posixPathFlavor, "/projects/my-app");
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

async function decide(command: string, wrapperFloors: WrapperFloors) {
	const { manager, cleanup } = createManagerWithConfig({
		"*": "allow",
		bash: { "*": "allow", "rm *": "deny", "git push *": "deny" },
	});
	cleanups.push(cleanup);
	const program = await BashProgram.parse(command, normalizer);
	return resolveBashCommandCheck(command, program.commands(), undefined,
		new PermissionResolver(manager, new SessionRules()), { wrapperFloors });
}

describe("upstream wrapper security in both fork modes", () => {
	it.each(["fallback", "always"] as const)("does not allow shell-template or computed wrapper arguments in %s", async (mode) => {
		for (const command of [
			"watch cat x \\; rm y",
			"parallel cat x \\; rm y ::: a",
			"sudo -u $U cat x",
			"env FOO=$Y cat x",
			"env -u $U cat x",
			"xargs -n $N cat",
			"doas -u $U cat x",
			"timeout $D cat x",
			"timeout 5 env -u $U cat x",
		]) {
			expect((await decide(command, mode)).state, command).not.toBe("allow");
		}
	});

	it.each(["fallback", "always"] as const)("does not allow ambiguous wrapper option grammars in %s", async (mode) => {
		for (const command of [
			"xargs -J cat rm x", "xargs -i rm cat x", "xargs -l rm cat x",
			"xargs --max-lines rm cat x", "env -P cat rm x", "env --unset rm cat x",
			"env -a cat rm x", "doas -a cat rm x", "doas -C /etc/doas.conf cat x",
		]) {
			expect((await decide(command, mode)).state, command).not.toBe("allow");
		}
	});

	it("continues resolving safe wrapper commands in fallback mode", async () => {
		for (const command of ["sudo --user root git status", "env -u FOO cat x", "xargs -n 1 cat", "timeout 5 git status", "rtk git status"]) {
			expect((await decide(command, "fallback")).state, command).toBe("allow");
		}
		expect((await decide("sudo --user root git push origin main", "fallback")).state).toBe("deny");
	});

	it("keeps async and sync parsing aligned for uncertain wrappers", async () => {
		await warmBashParser();
		for (const command of ["env -u $U cat x", "watch cat x \\; rm y", "xargs -i rm cat x"]) {
			const asynchronous = await BashProgram.parse(command, normalizer);
			expect(BashProgram.parseSync(command, normalizer)?.commands()).toEqual(asynchronous.commands());
		}
	});
});
