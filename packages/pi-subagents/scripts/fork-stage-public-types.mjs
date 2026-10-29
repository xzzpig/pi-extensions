import fs from "node:fs";
import path from "node:path";

/** Preserve the fork's public SDK augmentation, which tsc omits from declaration output. */
export function stageForkPublicTypes(root, output) {
	const relative = "src/types/pi-runtime-compat.d.ts";
	const destination = path.join(output, relative);
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	fs.copyFileSync(path.join(root, relative), destination);
	const entry = path.join(output, "index.d.ts");
	const declaration = fs.readFileSync(entry, "utf8");
	fs.writeFileSync(entry, `import type {} from "./${relative}";\n${declaration}`);
}
