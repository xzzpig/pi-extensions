import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));

describe("package identity", () => {
	it("publishes as @xzzpig/pi-starline under a plain semver version", () => {
		expect(pkg.name).toBe("@xzzpig/pi-starline");
		// The publish workflow checks the tag against this field, so pinning an
		// exact version here would only mean editing two places per release.
		expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("identifies the publishing fork while retaining upstream reference urls", () => {
		expect(pkg.repository.url).toBe("git+https://github.com/xzzpig/pi-extensions.git");
		const urls = [pkg.homepage, pkg.bugs.url, pkg.pi.image];
		for (const url of urls) {
			expect(url).toContain("Andy8647/pi-starline");
			expect(url).not.toContain("lmilojevicc");
		}
	});

	it("ships extension sources, declarations and both release histories", () => {
		// `types/` is what other extensions `import type` the pill API from.
		// The upstream log stays byte-identical and the fork log carries the
		// independently versioned @xzzpig releases; both must reach the tarball.
		expect(pkg.files).toEqual(["CHANGELOG.md", "extensions", "dist", "types", "FORK-CHANGELOG.md"]);
	});

	it("keeps both copyright lines in the licence", () => {
		const licence = readFileSync(join(process.cwd(), "LICENSE"), "utf8");

		expect(licence).toContain("Copyright (c) 2025-2026 Luka");
		expect(licence).toContain("Copyright (c) 2026 Andy");
	});
});
