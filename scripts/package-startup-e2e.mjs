#!/usr/bin/env node
/**
 * Smoke-test the actual package archives with Pi's real extension loader.
 *
 * Each candidate is packed first. We install those exact archives (and their
 * declared peer/runtime dependencies) under a throwaway Pi agent directory,
 * then launch Pi in RPC mode with ONLY that archive's `pi.extensions` entries.
 * A successful get_state response proves the runtime got through extension
 * loading and initialized without making a model request.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const STARTUP_REQUEST_ID = "package-startup-smoke";
const EXTENSION_LOAD_ERROR =
  /Failed to load extension|ERR_MODULE_NOT_FOUND|Cannot find module/u;

export function getPackageLoadPath(manifest, packageDir) {
  const entries = manifest?.pi?.extensions;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(
      `${manifest?.name ?? "package"}: missing pi.extensions entries`,
    );
  }
  for (const entry of entries) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.includes("*")
    ) {
      throw new Error(
        `${manifest.name}: unsupported Pi extension entry ${String(entry)}`,
      );
    }
    const absolute = path.resolve(packageDir, entry);
    const relative = path.relative(packageDir, absolute);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        `${manifest.name}: Pi extension entry escapes package: ${entry}`,
      );
    }
    if (!existsSync(absolute)) {
      throw new Error(
        `${manifest.name}: packed Pi extension entry is missing: ${entry}`,
      );
    }
  }
  // Passing the package root makes Pi read the package manifest and load its
  // declared extension files/directories exactly as it does for an installation.
  return packageDir;
}

export function buildStartupEnvironments(
  baseEnv,
  { tempRoot, agentDir, home, npmrc },
) {
  const passthrough = [
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "TERM",
  ];
  const shared = Object.fromEntries(
    passthrough
      .filter((key) => baseEnv[key] !== undefined)
      .map((key) => [key, baseEnv[key]]),
  );
  const common = {
    ...shared,
    HOME: home,
    XDG_CONFIG_HOME: path.join(tempRoot, "xdg-config"),
    XDG_CACHE_HOME: path.join(tempRoot, "xdg-cache"),
    XDG_DATA_HOME: path.join(tempRoot, "xdg-data"),
    CI: "true",
  };
  const npmEnv = { ...common };
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ]) {
    if (baseEnv[key] !== undefined) npmEnv[key] = baseEnv[key];
  }
  Object.assign(npmEnv, {
    npm_config_userconfig: npmrc,
    npm_config_cache: path.join(tempRoot, "npm-cache"),
    npm_config_registry: "https://registry.npmjs.org",
    npm_config_audit: "false",
    npm_config_fund: "false",
  });
  const piEnv = {
    ...common,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
  };
  return { npmEnv, piEnv };
}

export function buildPiStartupArgs(packagePath) {
  const args = [
    "--mode",
    "rpc",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-mcp",
    "--offline",
  ];
  args.push("--extension", packagePath);
  return args;
}

export function assertPiStartupResult({
  status,
  signal,
  error,
  stdout = "",
  stderr = "",
  name,
}) {
  const label = name ?? "package";
  if (error)
    throw new Error(`${label}: Pi startup process failed: ${error.message}`);
  if (signal || status !== 0) {
    throw new Error(
      `${label}: Pi exited ${signal ? `on ${signal}` : `with status ${status}`}\n${stderr}\n${stdout}`,
    );
  }
  if (EXTENSION_LOAD_ERROR.test(`${stderr}\n${stdout}`)) {
    throw new Error(
      `${label}: Pi reported an extension load error\n${stderr}\n${stdout}`,
    );
  }

  let response;
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (cause) {
      throw new Error(
        `${label}: Pi emitted non-JSON RPC output: ${line.slice(0, 300)}`,
        { cause },
      );
    }
    if (record.id === STARTUP_REQUEST_ID && record.type === "response")
      response = record;
  }
  if (!response?.success || response.command !== "get_state") {
    throw new Error(
      `${label}: Pi did not confirm startup with get_state\n${stderr}\n${stdout}`,
    );
  }
  return response;
}

function readInstalledPackageManifest(packageDir, name) {
  const manifestPath = path.join(packageDir, "package.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `${name}: npm did not install the packed package at ${manifestPath}`,
    );
  }
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

export function buildStartupInstallArgs(artifacts, npmPrefix) {
  // The test harness needs its own supported Pi 1.x CLI, even when every
  // candidate marks the core peer optional. Keep npm's peer checks enabled.
  return [
    "install",
    "--prefix",
    npmPrefix,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-save",
    "--package-lock=false",
    "--progress=false",
    "@earendil-works/pi-coding-agent@1",
    ...artifacts.map((artifact) => artifact.file),
  ];
}

function npmInstallArchives(artifacts, npmPrefix, env) {
  mkdirSync(npmPrefix, { recursive: true });
  const args = buildStartupInstallArgs(artifacts, npmPrefix);
  const result = spawnSync("npm", args, {
    cwd: npmPrefix,
    env,
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Cannot install packed candidates for startup E2E: ${result.error?.message ?? `npm exited ${result.status}`}\n${result.stderr ?? ""}\n${result.stdout ?? ""}`,
    );
  }
}

export function runPackageStartupE2E(artifacts) {
  if (artifacts.length === 0) return [];
  const tempRoot = mkdtempSync(
    path.join(os.tmpdir(), "pi-package-startup-e2e-"),
  );
  const agentDir = path.join(tempRoot, "agent");
  const npmPrefix = path.join(agentDir, "npm");
  const home = path.join(tempRoot, "home");
  const projectDir = path.join(tempRoot, "project");
  const npmrc = path.join(tempRoot, "empty.npmrc");
  for (const dir of [
    agentDir,
    home,
    projectDir,
    path.join(tempRoot, "xdg-config"),
    path.join(tempRoot, "xdg-cache"),
    path.join(tempRoot, "xdg-data"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(npmrc, "", "utf8");

  const { npmEnv, piEnv } = buildStartupEnvironments(process.env, {
    tempRoot,
    agentDir,
    home,
    npmrc,
  });

  try {
    console.log(
      `[package-startup] Installing ${artifacts.length} exact packed candidate(s) in a temporary Pi agent home`,
    );
    npmInstallArchives(artifacts, npmPrefix, npmEnv);
    const piBin = path.join(
      npmPrefix,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "pi.cmd" : "pi",
    );
    if (!existsSync(piBin))
      throw new Error(
        `Pi CLI was not installed from the peer dependency: ${piBin}`,
      );

    const results = [];
    for (const artifact of artifacts) {
      const packageDir = path.join(
        npmPrefix,
        "node_modules",
        ...artifact.name.split("/"),
      );
      const manifest = readInstalledPackageManifest(packageDir, artifact.name);
      if (
        manifest.name !== artifact.name ||
        manifest.version !== artifact.version
      ) {
        throw new Error(
          `${artifact.name}: installed packed identity is ${manifest.name}@${manifest.version}`,
        );
      }
      const packagePath = getPackageLoadPath(manifest, packageDir);
      const args = buildPiStartupArgs(packagePath);
      const input = `${JSON.stringify({ id: STARTUP_REQUEST_ID, type: "get_state" })}\n`;
      const result = spawnSync(piBin, args, {
        cwd: projectDir,
        env: piEnv,
        input,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      assertPiStartupResult({
        ...result,
        name: `${artifact.name}@${artifact.version}`,
      });
      console.log(
        `[package-startup] PASS ${artifact.name}@${artifact.version}`,
      );
      results.push({
        name: artifact.name,
        version: artifact.version,
        extensions: manifest.pi.extensions.length,
      });
    }
    return results;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
