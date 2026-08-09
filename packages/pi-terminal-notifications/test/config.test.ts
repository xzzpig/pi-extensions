import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createDefaultTerminalNotificationConfig,
  DEFAULT_TERM_PROGRAM_PROTOCOLS,
  getTerminalNotificationConfigPath,
  loadTerminalNotificationConfig,
  parseTerminalNotificationConfig,
  resolveNotificationProtocol,
} from "../extensions/config.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("terminal notification configuration", () => {
  it("ships documented defaults for common TERM_PROGRAM values", () => {
    const config = createDefaultTerminalNotificationConfig();

    expect(DEFAULT_TERM_PROGRAM_PROTOCOLS).toMatchObject({
      WarpTerminal: "osc777",
      WezTerm: "osc9",
      ghostty: "osc9",
      "iTerm.app": "osc9",
      kitty: "osc99",
      vscode: "osc99",
    });
    expect(resolveNotificationProtocol(config, "WezTerm")).toBe("osc9");
    expect(resolveNotificationProtocol(config, "kitty")).toBe("osc99");
    expect(resolveNotificationProtocol(config, "unknown")).toBe("osc99");
    expect(resolveNotificationProtocol(config, undefined)).toBe("osc99");
  });

  it("merges valid user mappings over built-in defaults", () => {
    const config = parseTerminalNotificationConfig({
      fallback: "osc777",
      termPrograms: {
        MyTerminal: "osc9",
        WezTerm: "osc777",
        ignored: "unsupported",
      },
    });

    expect(resolveNotificationProtocol(config, "WezTerm")).toBe("osc777");
    expect(resolveNotificationProtocol(config, "myterminal")).toBe("osc9");
    expect(resolveNotificationProtocol(config, "unknown")).toBe("osc777");
    expect(resolveNotificationProtocol(config, "kitty")).toBe("osc99");
  });

  it("falls back safely when the JSON configuration cannot be read", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-terminal-notifications-"));
    tempDirectories.push(agentDir);
    const configPath = getTerminalNotificationConfigPath(agentDir);
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, "{ invalid json", "utf8");

    const config = loadTerminalNotificationConfig(agentDir);
    expect(resolveNotificationProtocol(config, "unknown")).toBe("osc99");
  });

  it("loads valid JSON mappings from the agent extension directory", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-terminal-notifications-"));
    tempDirectories.push(agentDir);
    const configPath = getTerminalNotificationConfigPath(agentDir);
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ fallback: "osc9", termPrograms: { Custom: "osc777" } }),
      "utf8",
    );

    const config = loadTerminalNotificationConfig(agentDir);
    expect(resolveNotificationProtocol(config, "Custom")).toBe("osc777");
    expect(resolveNotificationProtocol(config, "Unknown")).toBe("osc9");
  });
});
