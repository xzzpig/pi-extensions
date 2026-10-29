import * as fs from "node:fs";
import * as path from "node:path";

/** Equip an isolated fake remote home with real POSIX tools without changing the production remote PATH. */
export function installFakeRemoteTools(home: string): string {
	const bin = path.join(home, ".local", "bin");
	fs.mkdirSync(bin, { recursive: true });
	for (const name of ["cat", "cp", "mktemp", "rm", "sed", "tail"]) {
		const executable = (process.env.PATH ?? "").split(path.delimiter)
			.filter(path.isAbsolute)
			.map((directory) => path.join(directory, name))
			.find((candidate) => {
				try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); } catch { return false; }
			});
		if (!executable) throw new Error(`Test fixture requires the POSIX tool ${name} on PATH.`);
		fs.symlinkSync(executable, path.join(bin, name));
	}
	return bin;
}
