import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listSubtreeMetadata } from "./subtree-metadata.mjs";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(process.env.PI_EXTENSIONS_ROOT ?? SCRIPT_ROOT);
const SUBTREES_DIR = join(ROOT, "subtrees");

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    const stderr = error.stderr?.toString().trim();
    const detail = stderr ? `: ${stderr}` : "";
    throw new Error(`git ${args.join(" ")} failed${detail}`);
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function environmentKey(name) {
  return name.toUpperCase().replaceAll("-", "_");
}

function remoteRefKey(remote) {
  return `remote.${remote}.pi-ref`;
}

function ensureRepository() {
  const gitRoot = git(["rev-parse", "--show-toplevel"], {
    allowFailure: true,
  });
  if (!gitRoot || resolve(gitRoot) !== ROOT) {
    throw new Error(
      "upstream metadata exists, but the project root is not a Git repository",
    );
  }
}

function ensureRemotes(records) {
  const existing = new Map();
  const acceptedRefs = new Map();

  // Validate every URL and ref lock before mutating any remote configuration.
  for (const record of records) {
    const url = git(["remote", "get-url", record.remote], {
      allowFailure: true,
    });
    const acceptedRef = git(
      ["config", "--local", "--get", remoteRefKey(record.remote)],
      {
        allowFailure: true,
      },
    );
    if (url && url !== record.source) {
      throw new Error(
        `remote ${record.remote} points to ${url}, expected ${record.source}; refusing to overwrite it`,
      );
    }
    if (acceptedRef && acceptedRef !== record.ref) {
      throw new Error(
        `metadata ref for ${record.name} changed from ${acceptedRef} to ${record.ref}; run the explicit subtree ref workflow before reloading direnv`,
      );
    }
    existing.set(record.remote, url);
    acceptedRefs.set(record.remote, acceptedRef);
  }

  for (const record of records) {
    if (!existing.get(record.remote)) {
      git(["remote", "add", record.remote, record.source]);
    }
    if (!acceptedRefs.get(record.remote)) {
      git(["config", "--local", remoteRefKey(record.remote), record.ref]);
    }
  }
}

function emitEnvironment(records) {
  const lines = [
    `export PI_UPSTREAM_METADATA_DIR=${shellQuote(SUBTREES_DIR)}`,
    `export PI_UPSTREAM_NAMES=${shellQuote(records.map((record) => record.name).join(" "))}`,
  ];

  for (const record of records) {
    const key = environmentKey(record.name);
    const values = {
      SOURCE: record.source,
      REMOTE: record.remote,
      REF: record.ref,
      VERSION: record.version ?? "",
      COMMIT: record.upstreamCommit,
      PREFIX: record.prefix,
      UPSTREAM_PATH: record.upstreamPath ?? "",
    };
    for (const [field, value] of Object.entries(values)) {
      lines.push(`export PI_UPSTREAM_${key}_${field}=${shellQuote(value)}`);
    }
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

try {
  const records = listSubtreeMetadata(ROOT);
  ensureRepository();
  ensureRemotes(records);
  emitEnvironment(records);
} catch (error) {
  process.stderr.write(`upstream initialization failed: ${error.message}\n`);
  process.exitCode = 1;
}
