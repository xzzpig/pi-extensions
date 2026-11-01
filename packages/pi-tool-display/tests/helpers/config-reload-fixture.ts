import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 每个用例独占配置路径，不读取或恢复包根配置及用户配置。 */
export function createConfigReloadFixture() {
  const directory = mkdtempSync(
    join(tmpdir(), "pi-tool-display-config-reload-"),
  );
  return {
    configFile: join(directory, "config.json"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
