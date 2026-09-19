import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FilePolicyLoader } from "#src/config/policy-loader";

// Fork-only tests: profile selection and profiles-registry gating across the
// policy-loader scopes (extracted from `policy-loader.test.ts`, whose upstream
// cases are kept byte-identical upstream).

// ---------------------------------------------------------------------------
// Helpers (shared shape with `policy-loader.test.ts`)
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "policy-loader-test-"));
}

function makeLoader(
  baseDir: string,
  options: {
    globalConfig?: Record<string, unknown>;
    mcpServerNames?: readonly string[];
  } = {},
) {
  const agentsDir = join(baseDir, "agents");
  mkdirSync(agentsDir, { recursive: true });

  const globalConfigPath = join(baseDir, "config.json");
  writeFileSync(
    globalConfigPath,
    JSON.stringify(options.globalConfig ?? {}, null, 2),
  );

  return new FilePolicyLoader({
    globalConfigPath,
    agentsDir,
    mcpServerNames: options.mcpServerNames
      ? [...options.mcpServerNames]
      : undefined,
  });
}

// ---------------------------------------------------------------------------
// loadGlobalConfig — profiles registry
// ---------------------------------------------------------------------------

describe("FilePolicyLoader.loadGlobalConfig profiles", () => {
  it("carries the global profiles registry on the global scope", () => {
    const baseDir = makeTempDir();
    try {
      const loader = makeLoader(baseDir, {
        globalConfig: {
          permission: { "*": "ask" },
          profiles: {
            reviewer: { permission: { "*": "ask", read: "allow" } },
          },
        },
      });
      const config = loader.loadGlobalConfig();
      expect(config.profiles).toEqual({
        reviewer: { permission: { "*": "ask", read: "allow" } },
      });
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("leaves profiles undefined when the global config defines none", () => {
    const baseDir = makeTempDir();
    try {
      const loader = makeLoader(baseDir, {
        globalConfig: { permission: { "*": "ask" } },
      });
      const config = loader.loadGlobalConfig();
      expect(config.profiles).toBeUndefined();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// loadProjectConfig — profiles gating
// ---------------------------------------------------------------------------

describe("FilePolicyLoader.loadProjectConfig profiles", () => {
  it("marks the scope invalid when the project config defines profiles", () => {
    const baseDir = makeTempDir();
    try {
      const projectConfigPath = join(baseDir, "project-config.json");
      // `profiles` is global-only: a project file defining one is rejected
      // whole and the project scope fails closed.
      writeFileSync(
        projectConfigPath,
        JSON.stringify({
          permission: { bash: "allow" },
          profiles: { sneaky: { permission: { "*": "allow" } } },
        }),
      );
      const loader = new FilePolicyLoader({
        globalConfigPath: "/nonexistent/config.json",
        agentsDir: "/nonexistent/agents",
        projectGlobalConfigPath: projectConfigPath,
      });
      const config = loader.loadProjectConfig();
      expect(config.invalid).toBe(true);
      expect(config.permission).toBeUndefined();
      expect(
        loader
          .getConfigIssues()
          .some((issue) => issue.includes("global configuration")),
      ).toBe(true);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// loadAgentConfig — permission-profile frontmatter
// ---------------------------------------------------------------------------

describe("FilePolicyLoader.loadAgentConfig profiles", () => {
  it("extracts a valid permission-profile selection from agent frontmatter", () => {
    const baseDir = makeTempDir();
    try {
      const agentsDir = join(baseDir, "agents");
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        join(agentsDir, "reviewer.md"),
        `---\npermission-profile: reviewer-strict\npermission:\n  read: allow\n---\n# Reviewer agent\n`,
      );
      const loader = new FilePolicyLoader({
        globalConfigPath: join(baseDir, "config.json"),
        agentsDir,
      });
      writeFileSync(join(baseDir, "config.json"), "{}");
      const config = loader.loadAgentConfig("reviewer");
      expect(config.profileName).toBe("reviewer-strict");
      expect(config.permission).toEqual({ read: "allow" });
      expect(config.invalid).toBeUndefined();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("leaves profileName unset when frontmatter has no permission-profile", () => {
    const baseDir = makeTempDir();
    try {
      const agentsDir = join(baseDir, "agents");
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        join(agentsDir, "plain.md"),
        `---\npermission:\n  bash: ask\n---\n# Plain agent\n`,
      );
      const loader = new FilePolicyLoader({
        globalConfigPath: join(baseDir, "config.json"),
        agentsDir,
      });
      writeFileSync(join(baseDir, "config.json"), "{}");
      const config = loader.loadAgentConfig("plain");
      expect(config.profileName).toBeUndefined();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("fails the agent scope closed on an invalid permission-profile value", () => {
    const baseDir = makeTempDir();
    try {
      const agentsDir = join(baseDir, "agents");
      mkdirSync(agentsDir, { recursive: true });
      for (const bad of [
        "permission-profile: ../escape",
        "permission-profile: false",
        "permission-profile:",
        "permission-profile: has space",
      ]) {
        writeFileSync(
          join(agentsDir, "broken.md"),
          `---\n${bad}\npermission:\n  read: allow\n---\n# Broken agent\n`,
        );
        const loader = new FilePolicyLoader({
          globalConfigPath: join(baseDir, "config.json"),
          agentsDir,
        });
        writeFileSync(join(baseDir, "config.json"), "{}");
        const config = loader.loadAgentConfig("broken");
        expect(config.invalid).toBe(true);
      }
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// loadProjectAgentConfig — permission-profile frontmatter
// ---------------------------------------------------------------------------

describe("FilePolicyLoader.loadProjectAgentConfig profiles", () => {
  it("extracts permission-profile from project agent frontmatter", () => {
    const baseDir = makeTempDir();
    try {
      const projectAgentsDir = join(baseDir, "project-agents");
      mkdirSync(projectAgentsDir, { recursive: true });
      writeFileSync(
        join(projectAgentsDir, "coder.md"),
        `---\npermission-profile: project-reviewer\n---\n# Project agent\n`,
      );
      const loader = new FilePolicyLoader({
        globalConfigPath: join(baseDir, "config.json"),
        agentsDir: join(baseDir, "agents"),
        projectAgentsDir,
      });
      const config = loader.loadProjectAgentConfig("coder");
      expect(config.profileName).toBe("project-reviewer");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
