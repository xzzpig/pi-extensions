import fs from "node:fs";
import path from "node:path";

/** Stage the private workspace dependency inside dist-pkg for pnpm's bundled packer.
 * Hoisted dependencies outside that directory otherwise produce `package/../node_modules`
 * tar entries, which registries reject. Copy the component's compiled public files.
 */
export function stageForkBundledComponents(root, output, sourcePackage) {
	const name = "@xzzpig/pi-components";
	if (!sourcePackage.bundledDependencies?.includes(name)) throw new Error(`Missing bundled dependency ${name}`);
	const source = fs.realpathSync(path.join(root, "node_modules", ...name.split("/")));
	let manifest;
	try {
		manifest = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
	} catch (error) {
		throw new Error(`Cannot read bundled dependency manifest for ${name}`, { cause: error });
	}
	if (manifest.name !== name || manifest.version !== sourcePackage.dependencies?.[name]) {
		throw new Error(`Unexpected bundled dependency identity or version for ${name}`);
	}
	const destination = path.join(output, "node_modules", ...name.split("/"));
	fs.mkdirSync(destination, { recursive: true });
	for (const relative of ["package.json", "dist", "README.md", "CHANGELOG.md", "LICENSE"]) {
		const input = path.join(source, relative);
		if (!fs.existsSync(input)) {
			if (["package.json", "dist"].includes(relative)) throw new Error(`Missing bundled dependency input: ${name}/${relative}`);
			continue;
		}
		fs.cpSync(input, path.join(destination, relative), { recursive: true });
	}
	// Node will not strip TypeScript inside node_modules. Keep the workspace's
	// source export untouched, but expose its already-built JS in the tarball.
	const transcript = manifest.exports?.["./transcript"];
	if (transcript?.default !== "./src/transcript.ts" || transcript.types !== "./dist/src/transcript.d.ts") {
		throw new Error(`Unexpected transcript export shape for ${name}`);
	}
	if (!fs.existsSync(path.join(destination, "dist/src/transcript.js"))) {
		throw new Error(`Missing compiled transcript entry for ${name}`);
	}
	manifest.exports["./transcript"] = { ...transcript, default: "./dist/src/transcript.js" };
	if (Array.isArray(manifest.files)) manifest.files = manifest.files.filter((entry) => entry !== "src");
	fs.writeFileSync(path.join(destination, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}
