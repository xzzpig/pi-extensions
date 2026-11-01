import assert from "node:assert/strict";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";
import {
  loadToolDisplayConfig,
  saveToolDisplayConfig,
} from "../src/config-store.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";
import { createConfigReloadFixture } from "./helpers/config-reload-fixture.ts";

test("isolated config reload starts without any configuration file", () => {
  const { configFile, cleanup } = createConfigReloadFixture();
  try {
    assert.equal(existsSync(configFile), false);
    const initial = loadToolDisplayConfig(configFile);
    assert.deepEqual(initial.config, DEFAULT_TOOL_DISPLAY_CONFIG);
    assert.equal(initial.error, undefined);
    assert.equal(existsSync(configFile), false, "读取缺失配置不会创建文件");

    const saved = saveToolDisplayConfig(initial.config, configFile);
    assert.equal(saved.success, true);
    assert.equal(existsSync(configFile), true);
    const reloaded = loadToolDisplayConfig(configFile);
    assert.deepEqual(reloaded.config, initial.config);
    assert.equal(reloaded.error, undefined);
  } finally {
    cleanup();
  }
  assert.equal(existsSync(dirname(configFile)), false, "清理整个临时目录");
});

test("isolated config reload observes an external disk edit without save cache reset", () => {
  const { configFile, cleanup } = createConfigReloadFixture();
  try {
    assert.equal(
      saveToolDisplayConfig(
        { ...DEFAULT_TOOL_DISPLAY_CONFIG, previewLines: 1 },
        configFile,
      ).success,
      true,
    );
    const first = loadToolDisplayConfig(configFile);
    assert.equal(first.config.previewLines, 1);
    assert.equal(loadToolDisplayConfig(configFile).config.previewLines, 1);
    const beforeSize = statSync(configFile).size;

    // 直接修改磁盘而不是调用 save；改变长度，避免依赖文件系统时钟精度或 sleep。
    writeFileSync(
      configFile,
      JSON.stringify({ ...first.config, previewLines: 79 }),
      "utf8",
    );
    assert.notEqual(statSync(configFile).size, beforeSize);
    const reloaded = loadToolDisplayConfig(configFile);
    assert.equal(reloaded.config.previewLines, 79);
    assert.equal(reloaded.error, undefined);
    assert.equal(first.config.previewLines, 1, "之前返回的配置快照不被改变");
    assert.equal(loadToolDisplayConfig(configFile).config.previewLines, 79);
  } finally {
    cleanup();
  }
});
