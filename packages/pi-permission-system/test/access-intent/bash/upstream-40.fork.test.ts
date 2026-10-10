/** Fork regression coverage for the upstream v40 synchronization. */
import { afterEach, describe, expect, it } from "vitest";
import { warmBashParser } from "#src/access-intent/bash/parser";
import { BashProgram } from "#src/access-intent/bash/program";
import { resolveBashCommandCheck } from "#src/handlers/gates/bash-command";
import { PathNormalizer } from "#src/path/path-normalizer";
import { posixPathFlavor } from "#src/path/path-flavor";
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
		bash: { "*": "allow", "git push *": "deny", "timeout 9 *": "ask" },
	});
	cleanups.push(cleanup);
	const program = await BashProgram.parse(command, normalizer);
	return resolveBashCommandCheck(command, program.commands(), undefined,
		new PermissionResolver(manager, new SessionRules()), { wrapperFloors });
}

describe("upstream execution-modifier exemption in the fork", () => {
	it.each(["fallback", "always"] as const)("keeps exemptions in %s mode", async (mode) => {
		for (const prefix of ["time", "timeout 5", "nice -n 10", "setsid", "stdbuf -oL"]) {
			expect(await decide(`${prefix} git status`, mode)).toMatchObject({
				state: "allow", floorExemption: "execution-modifier",
			});
			expect(await decide(`${prefix} git push origin main`, mode)).toMatchObject({ state: "deny" });
		}
	});

	it("preserves an explicit wrapper ask before any exemption", async () => {
		expect(await decide("timeout 9 git status", "always")).toMatchObject({
			state: "ask", matchedPattern: "timeout 9 *",
		});
	});

	it("keeps ordinary opaque fallback behavior and the always floor", async () => {
		expect(await decide('eval "git status"', "fallback")).toMatchObject({ state: "allow" });
		expect(await decide('eval "git status"', "always")).toMatchObject({
			state: "ask", floor: "<opaque-bash-wrapper>",
		});
	});

	it("carries an unresolved fallback floor into the forwarded unit list", async () => {
		expect(await decide("parallel", "fallback")).toMatchObject({
			state: "ask", floor: "<indirection-bash-wrapper>",
			askingUnits: [{ command: "parallel", floor: "<indirection-bash-wrapper>" }],
		});
	});

	it("gates a timed subshell once and preserves the inner deny", async () => {
		const command = "time (git status && git push origin main)";
		const program = await BashProgram.parse(command, normalizer);
		expect(program.commands().map((unit) => unit.text)).toEqual([
			command, "git status", "git push origin main",
		]);
		expect(await decide(command, "always")).toMatchObject({ state: "deny" });
	});

	it("keeps asynchronous and synchronous fork payload parsing aligned", async () => {
		const command = 'eval "git status && git push origin main"';
		const asynchronous = await BashProgram.parse(command, normalizer);
		await warmBashParser();
		expect(BashProgram.parseSync(command, normalizer)?.commands()).toEqual(asynchronous.commands());
	});
});


describe("safe sudo parsing in fallback mode", () => {
	it.each([
		"sudo git push origin main",
		"sudo --user root git push origin main",
		"sudo --user=root git push origin main",
		"sudo --us root git push origin main",
		"sudo -nu root git push origin main",
		"sudo -uroot git push origin main",
		"sudo -A git push origin main",
		"sudo FOO=bar git push origin main",
	])("gates the actual inner command in %s", async (command) => {
		expect(await decide(command, "fallback")).toMatchObject({
			state: "deny", matchedPattern: "git push *", command: "git push origin main",
		});
	});

	it.each([
		"sudo -e cat /tmp/x", "sudo --edit cat /tmp/x", "sudo -ne cat /tmp/x",
		"sudo -s git status", "sudo --shell git status", "sudo -i git status",
		"sudo --login git status", "sudo -D /tmp git status",
		"sudo --chdir=/tmp git status", "sudo -R /tmp git status",
		"sudo --chroot /tmp git status", "sudo --unknown git status",
		"sudo --l git status", "sudo $CMD git status",
	])("keeps the unresolved sudo floor for %s", async (command) => {
		expect(await decide(command, "fallback")).toMatchObject({
			state: "ask", floor: "<indirection-bash-wrapper>",
			askingUnits: [{ command, floor: "<indirection-bash-wrapper>" }],
		});
	});

	it.each(["sudo git status", "sudo", "sudo -u root", "sudo --user root", "sudo --help"])(
		"retains ordinary or inert fallback behavior for %s", async (command) => {
			expect(await decide(command, "fallback")).toMatchObject({ state: "allow" });
		},
	);
});


describe("sudo safety through recognized wrapper chains", () => {
	it.each([
		"timeout 5 sudo -e cat", "env FOO=bar sudo --shell git status",
		"env FOO=bar timeout 5 sudo --unknown git status",
		"sudo timeout 5 sudo --chdir=/tmp git status",
		"rtk timeout 5 sudo -i git status",
		"timeout 5 sudo --user root env FOO=bar sudo --chroot /tmp git status",
	])("keeps the sudo ask floor in %s", async (command) => {
		expect(await decide(command, "fallback")).toMatchObject({
			state: "ask", floor: "<indirection-bash-wrapper>",
		});
	});

	it.each([
		"timeout 5 sudo --user root git push origin main",
		"env FOO=bar timeout 5 sudo -nu root git push origin main",
		"rtk sudo --user root git push origin main",
		"sudo timeout 5 sudo --user root git push origin main",
	])("gates the correctly located sudo command in %s", async (command) => {
		expect(await decide(command, "fallback")).toMatchObject({
			state: "deny", command: "git push origin main", matchedPattern: "git push *",
		});
	});

	it.each([
		"timeout 5 sudo --user root git status",
		"env FOO=bar timeout 5 sudo -nu root git status",
		"sudo timeout 5 sudo --user root git status",
		"env echo sudo --unknown",
		"timeout 5 env git status",
	])("retains ordinary fallback behavior for %s", async (command) => {
		expect(await decide(command, "fallback")).toMatchObject({ state: "allow" });
	});
});


describe("literal sudo spellings retain C1", () => {
	it.each([
		"sudo '-e' cat /tmp/x", 'sudo "--edit" cat /tmp/x',
		"'sudo' --edit cat /tmp/x", '"/usr/bin/sudo" -e cat /tmp/x',
		"timeout 5 'sudo' '--shell' git status",
		"'sudo' timeout 5 sudo --edit cat",
		"env FOO=bar timeout 5 sudo '--chdir' /tmp git status",
		"sudo '--user root' git status",
	])("floors %s", async (command) => {
		expect(await decide(command, "fallback")).toMatchObject({
			state: "ask", floor: "<indirection-bash-wrapper>",
		});
	});

	it.each([
		"sudo '--user' root git push origin main",
		"'sudo' '-nu' root git push origin main",
		'"/usr/bin/sudo" "--user=root" git push origin main',
		"timeout 5 'sudo' '--user' root git push origin main",
	])("preserves the real command in %s", async (command) => {
		expect(await decide(command, "fallback")).toMatchObject({
			state: "deny", command: "git push origin main",
		});
	});
});
