/** Fork regression: wrapper extraction must retain upstream command aliases. */
import { homedir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { BashProgram } from "#src/access-intent/bash/program";
import { warmBashParser } from "#src/access-intent/bash/parser";
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

async function decide(command: string, mode: WrapperFloors, rules: Record<string, "allow" | "ask" | "deny">,
	options?: { workdir?: string; outerOnly?: boolean }) {
	const { manager, cleanup } = createManagerWithConfig({ "*": "allow", bash: { "*": "allow", ...rules } });
	cleanups.push(cleanup);
	const program = await BashProgram.parse(command, normalizer, options);
	const units = options?.outerOnly ? program.commands().slice(0, 1) : program.commands();
	return resolveBashCommandCheck(command, units, undefined,
		new PermissionResolver(manager, new SessionRules()), { wrapperFloors: mode });
}

describe("wrapper command spellings", () => {
	it.each([
		"rm ./secret", "sudo rm ./secret", "sudo --user root rm ./secret",
		"'sudo' '--user' root rm ./secret", "env FOO=bar sudo rm ./secret",
		"rtk sudo --user root rm ./secret", "timeout 5 rm ./secret",
		"timeout 5 nice -n 10 rm ./secret", "sudo rm > /dev/null ./secret",
		"rtk rm ./secret", "xargs rm ./secret",
		"sudo rm ./secret <<'EOF'\nignored ./other\nEOF",
	])("keeps an absolute deny on %s", async (command) => {
		expect(await decide(command, "fallback", { "rm /projects/my-app/secret": "deny" })).toMatchObject({ state: "deny" });
	});

	it.each(["fallback", "always"] as const)("carries aliases into the exempt outer gate in %s", async (mode) => {
		expect(await decide("timeout 5 rm ./secret", mode,
			{ "rm /projects/my-app/secret": "deny" }, { outerOnly: true })).toMatchObject({ state: "deny" });
		expect(await decide("sudo cat ./secret", mode,
			{ "cat /projects/my-app/secret": "deny" }, { outerOnly: true })).toMatchObject({ state: "deny" });
	});

	it.each(["sudo", "timeout 5"])("preserves home spellings behind %s", async (prefix) => {
		expect(await decide(`${prefix} ~/bin/task`, "fallback", { [`${homedir()}/bin/task`]: "deny" })).toMatchObject({ state: "deny" });
		expect(await decide(`${prefix} rm ~/secret`, "fallback", { [`rm ${homedir()}/secret`]: "deny" })).toMatchObject({ state: "deny" });
	});

	it("preserves the existing exec-conditional unit text while adding aliases", async () => {
		const command = "find . -exec rm ./secret \\;";
		const program = await BashProgram.parse(command, normalizer);
		expect(program.commands()[1]).toMatchObject({
			text: "rm ./secret \\;", spellings: ["rm /projects/my-app/secret \\;"],
		});
		expect(await decide(command, "fallback", { "rm /projects/my-app/secret *": "deny" })).toMatchObject({ state: "deny" });
	});

	it("keeps a quoted literal path as one original word", async () => {
		expect(await decide('sudo rm "./my secret"', "fallback", { "rm /projects/my-app/my secret": "deny" })).toMatchObject({ state: "deny" });
	});

	it("uses upstream effective directories for source-aligned arguments", async () => {
		expect(await decide("cd /elsewhere && sudo rm ./secret", "fallback", { "rm /elsewhere/secret": "deny" })).toMatchObject({ state: "deny" });
		expect(await decide("timeout 5 rm ./secret", "always", { "rm /workdir/secret": "deny" }, { workdir: "/workdir" })).toMatchObject({ state: "deny" });
	});

	it("retains explicit wrapper precedence and non-exempt floors", async () => {
		expect(await decide("timeout 5 rm ./secret", "always", { "timeout 5 *": "ask" }, { outerOnly: true })).toMatchObject({ state: "ask", matchedPattern: "timeout 5 *" });
		expect(await decide("sudo rm ./secret", "always", {})).toMatchObject({ state: "ask", floor: "<indirection-bash-wrapper>" });
	});

	it.each(["sudo rm $TARGET", "cd $TARGET && sudo rm ./secret", 'eval "cd /elsewhere && rm ./secret"'])(
		"does not fabricate an absolute inner alias for %s", async (command) => {
			const program = await BashProgram.parse(command, normalizer);
			for (const unit of program.commands().filter((unit) => unit.text.startsWith("rm "))) {
				expect(unit.spellings).toBeUndefined();
			}
		},
	);

	it("keeps async and sync parsing identical", async () => {
		const command = "cd /elsewhere && timeout 5 sudo --user root rm ./secret";
		const program = await BashProgram.parse(command, normalizer);
		await warmBashParser();
		expect(BashProgram.parseSync(command, normalizer)?.commands()).toEqual(program.commands());
	});
});
