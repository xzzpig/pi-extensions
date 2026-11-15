import { InteractiveMode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { patchToolBoxFrames, type ToolFrameOptions } from "../src/frame.ts";
import { installHoverTracking } from "../src/hover.ts";
import { setGroupingActive, setIconsEnabled, setNativeThinking, setThinkingColor } from "../src/tools/tool-group-view.ts";
import type { ForkTidyConfig } from "./defaults.ts";
import { installForkThinkingRows } from "./thinking-row.ts";

export interface ForkToolFrameInstallers {
  patchToolBoxFrames(options: ToolFrameOptions): void;
  installHoverTracking(): void;
  setGroupingActive?(active: () => boolean): void;
  setIconsEnabled?(icons: () => boolean): void;
  setThinkingColor?(color: () => string): void;
}

const upstreamInstallers: ForkToolFrameInstallers = {
  patchToolBoxFrames,
  installHoverTracking,
  setGroupingActive,
  setIconsEnabled,
  setThinkingColor,
};
let errorHookWarningSent = false;

function warnIfErrorHookIsUnavailable(pi: ExtensionAPI, config: ForkTidyConfig): void {
  if (!config.dedupeErrors) return;
  const init = (InteractiveMode.prototype as { init?: unknown }).init;
  if (typeof init === "function") return;

  pi.on("session_start", (_event, ctx) => {
    if (errorHookWarningSent) return;
    errorHookWarningSent = true;
    ctx.ui.notify("pi-tidy: this pi has no InteractiveMode.init hook; chat-row retry errors keep the host's original rendering.", "warning");
  });
}

function toolFrameOptions(config: ForkTidyConfig): ToolFrameOptions {
  return {
    icons: config.icons,
    toolColors: config.toolColors,
    groupTools: config.groupTools,
    groupOpen: config.groupOpen,
    alwaysShowTools: config.alwaysShowTools,
    backgroundJobs: config.backgroundJobs,
    hideJobNotifications: config.hideJobNotifications,
    splitDiff: config.splitDiff,
    splitDiffMinWidth: config.splitDiffMinWidth,
    diffLines: config.diffLines,
    thinkingColor: config.thinkingColor,
    highlightBash: config.highlightBash,
    toolRowLines: config.toolRowLines,
  };
}

/** Install tool frames only when opted in, but keep the shared hover hook for code-block chips. */
export function installForkToolFrames(
  config: ForkTidyConfig,
  pi: ExtensionAPI,
  installers: ForkToolFrameInstallers = upstreamInstallers,
): void {
  warnIfErrorHookIsUnavailable(pi, config);
  // This fork leaves thinking rendering to Pi and pi-thinking-collapse.
  setNativeThinking(() => config.nativeThinking);
  if (config.enabled && config.finalReplyStyle !== "off") {
    // index.ts registers pi-tidy's own boundary installer first, so this runs after it.
    pi.on("before_agent_start", () => installForkThinkingRows());
  }
  if (config.frameTools) installers.patchToolBoxFrames(toolFrameOptions(config));
  else {
    // patchToolBoxFrames normally publishes the runtime switches the boundary
    // renderer reads. With framing off it never runs, and the `groupingActive`
    // default (true) would make a thinking+tool-use assistant render as a group
    // carrier with no group — the thinking row silently disappeared when a tool
    // call arrived. Publish the real values here so renderers follow the config.
    installers.setGroupingActive?.(() => config.groupTools);
    installers.setIconsEnabled?.(() => config.icons);
    installers.setThinkingColor?.(() => config.thinkingColor);
    installers.installHoverTracking();
  }
}
