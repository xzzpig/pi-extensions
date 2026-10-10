import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  countProjectConfigProfiles,
  untrustedProjectProfilesWarning,
} from "#src/config/project-profile-probe";
import { getProjectConfigPath } from "#src/config/config-paths";
import { makeCtx } from "#test/helpers/handler-fixtures";
import { makeRealSession } from "#test/helpers/session-fixtures";

/**
 * Fork-only tests (project-permission-profiles): the «N project profiles not
 * applied (project is not trusted)» warning surfaces through two channels —
 * `getPolicyIssues` (permission-profiles-scope.test.ts) and the session-level
 * UI notify fired by `PermissionSession.refreshConfig` when the project is
 * untrusted. This file covers the UI-notify channel and the fork-only probe
 * helper behind it.
 */

const tempDirs: string[] = [];

function writeProjectConfig(dir: string, content: string): void {
  const configPath = getProjectConfigPath(dir);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, content, "utf-8");
}

function makeProjectDir(profiles: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "pps-probe-"));
  tempDirs.push(dir);
  writeProjectConfig(dir, `${JSON.stringify({ profiles }, null, 2)}\n`);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("countProjectConfigProfiles (fork-only probe)", () => {
  it("counts the profiles entries in a project config file", () => {
    const dir = makeProjectDir({
      dev: { permission: { read: "ask" } },
      prod: { permission: { read: "deny" } },
    });
    expect(countProjectConfigProfiles(dir)).toBe(2);
  });

  it("returns 0 when the project config has no profiles key", () => {
    const dir = makeProjectDir({});
    expect(countProjectConfigProfiles(dir)).toBe(0);
  });

  it("returns 0 for a missing project config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pps-probe-"));
    tempDirs.push(dir);
    expect(countProjectConfigProfiles(dir)).toBe(0);
  });

  it("returns 0 for malformed JSON without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "pps-probe-"));
    tempDirs.push(dir);
    writeProjectConfig(dir, "{ not valid json");
    expect(countProjectConfigProfiles(dir)).toBe(0);
  });
});

describe("untrustedProjectProfilesWarning", () => {
  it("uses singular/plural wording consistently", () => {
    expect(untrustedProjectProfilesWarning(1)).toBe(
      "Project defines 1 permission profile that was not applied (project is not trusted).",
    );
    expect(untrustedProjectProfilesWarning(2)).toBe(
      "Project defines 2 permission profiles that were not applied (project is not trusted).",
    );
  });
});

describe("PermissionSession.refreshConfig untrusted-project UI notify", () => {
  it("notifies with the profile count when the project is untrusted", () => {
    const dir = makeProjectDir({
      dev: { permission: { read: "ask" } },
    });
    const { session } = makeRealSession();
    const ctx = makeCtx({ cwd: dir });

    session.refreshConfig(ctx, false);

    const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
    expect(notify).toHaveBeenCalledWith(
      untrustedProjectProfilesWarning(1),
      "warning",
    );
  });

  it("does not notify a trusted project even with a profiles registry", () => {
    const dir = makeProjectDir({
      dev: { permission: { read: "ask" } },
    });
    const { session } = makeRealSession();
    const ctx = makeCtx({ cwd: dir });

    session.refreshConfig(ctx, true);

    const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not notify an untrusted project without a profiles registry", () => {
    const dir = makeProjectDir({});
    const { session } = makeRealSession();
    const ctx = makeCtx({ cwd: dir });

    session.refreshConfig(ctx, false);

    const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
    expect(notify).not.toHaveBeenCalled();
  });

  it("dedups repeated refreshes in the same untrusted project", () => {
    const dir = makeProjectDir({
      dev: { permission: { read: "ask" } },
    });
    const { session } = makeRealSession();
    const ctx = makeCtx({ cwd: dir });

    session.refreshConfig(ctx, false);
    session.refreshConfig(ctx, false);
    session.refreshConfig(ctx, false);

    const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("re-notifies after the project becomes trusted and untrusted again", () => {
    const dir = makeProjectDir({
      dev: { permission: { read: "ask" } },
    });
    const { session } = makeRealSession();
    const ctx = makeCtx({ cwd: dir });

    session.refreshConfig(ctx, false);
    session.refreshConfig(ctx, true); // clears the dedup marker
    session.refreshConfig(ctx, false);

    const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
