import * as fs from "node:fs";
import * as path from "node:path";

// A simulated remote must supply its own commands in HERDR_REMOTE_PATH.
// In particular NixOS has no /usr/bin/cat; do not weaken the production SSH PATH.
export function remoteShellEnv(home: string): { HOME: string } {
  const cat = (process.env.PATH ?? "").split(path.delimiter)
    .map((directory) => path.join(directory, "cat"))
    .find((candidate) => {
      try { fs.accessSync(candidate, fs.constants.X_OK); return true; }
      catch (error) { if (["ENOENT", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false; throw error; }
    });
  if (!cat) throw new Error("Herdr remote-shell fixture requires cat on the host PATH");
  const bin = path.join(home, ".local", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(cat, path.join(bin, "cat"));
  return { HOME: home };
}
