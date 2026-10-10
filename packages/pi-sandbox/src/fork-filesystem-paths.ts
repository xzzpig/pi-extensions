import { homedir } from "node:os";
import { resolve } from "node:path";

import { canonicalizePath } from "./policy.ts";

export const isFilesystemGlob = (path: string): boolean => /[*?[\]]/.test(path);

/** Anchor patterns without treating their wildcard suffix as a literal filename. */
export function canonicalizeFilesystemPatternForCwd(path: string, baseCwd = process.cwd()): string {
  return isFilesystemGlob(path)
    ? resolve(baseCwd, path.replace(/^~(?=$|\/)/, homedir()))
    : canonicalizePath(path, baseCwd);
}
