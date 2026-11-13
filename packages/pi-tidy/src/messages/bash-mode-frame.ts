/**
 * `!` / `!!` bash runs — the commands the user types, not the agent's — in a
 * rounded frame of their own.
 *
 * pi draws them between two full-width rules in `bashMode`, which reads like
 * the agent's bash box with its frame missing. The frame here is tidy's, but
 * marked as the user's: the user icon instead of the terminal one, the command
 * behind the `!` or `!!` that was typed instead of `$`, and the user
 * messages' color for the border. The agent's bash boxes change color with their
 * state; this one keeps its color, and pi's own rows say how the run went
 * (the spinner, `(exit 1)`, `(cancelled)`). `!!` — output kept out of the
 * model's context — stays dim, as pi draws it.
 *
 * Everything under the command row is pi's own: the 20-row preview, `ctrl+o`,
 * the truncation notice.
 */

import { BashExecutionComponent } from "@earendil-works/pi-coding-agent";
import { highlightBashCommand } from "../tools/bash-highlight.ts";
import { drawFrame, sameLines, stripBackgroundFills, trimBlankEdges } from "../draw/frame-draw.ts";
import { MESSAGE_ICONS } from "../draw/icons.ts";
import { liveSlot, tidyEnabled } from "../live.ts";
import { paint } from "../draw/paint.ts";
import { getTheme, type ThemeLike } from "../theme-access.ts";

export interface BashModeOptions {
  enabled: boolean;
  icons: boolean;
  /** The user messages' color (frame border or rail): a theme color name or `#rrggbb`. */
  color: string;
}

interface BashExecutionInternals {
  command: string;
  /** `"dim"` for `!!`, `"bashMode"` for `!`. */
  colorKey?: string;
  contentContainer?: { children: Array<{ render(width: number): string[] }> };
  render(width: number): string[];
  __tidyBashModeCache?: { width: number; sample: string; raw: string[]; out: string[] };
}

const bashModeOptions = liveSlot<BashModeOptions | undefined>("bash-mode-options", undefined);

/**
 * `theme` with `fg` taking `#rrggbb` too, for `drawFrame`. Forwarded, not
 * spread: pi's theme keeps its methods on the class prototype.
 */
function withHexColors(theme: ThemeLike): ThemeLike {
  return { fg: (color, text) => paint(theme, color, text), bold: (text) => theme.bold(text) };
}

function commandRow(component: BashExecutionInternals, theme: ThemeLike, color: string, icons: boolean): string {
  const excluded = component.colorKey === "dim";
  const prompt = paint(theme, color, theme.bold(excluded ? "!! " : "! "));
  let command: string;
  try {
    command = highlightBashCommand(component.command, (token, text) => theme.fg(token, text));
  } catch {
    command = component.command;
  }
  const icon = icons ? `${paint(theme, color, MESSAGE_ICONS.user)} ` : "";
  return ` ${icon}${prompt}${command}`;
}

function renderBashMode(
  component: BashExecutionInternals,
  width: number,
  theme: ThemeLike,
  options: BashModeOptions,
): string[] | undefined {
  const container = component.contentContainer;
  if (!container || typeof component.command !== "string") return undefined;
  const color = component.colorKey === "dim" ? "dim" : options.color;

  // Child 0 is pi's `$ command` header; the rows under it are kept as drawn.
  const raw: string[] = [];
  for (const child of container.children.slice(1)) raw.push(...child.render(width - 2));

  const sample = paint(theme, color, "·");
  const cache = component.__tidyBashModeCache;
  if (cache && cache.width === width && cache.sample === sample && sameLines(cache.raw, raw)) return cache.out;

  const body = trimBlankEdges(raw.map(stripBackgroundFills));
  const content = [commandRow(component, theme, color, options.icons), ...(body.length > 0 ? ["", ...body] : [])];
  const out = ["", ...drawFrame(content, width, withHexColors(theme), color)];
  component.__tidyBashModeCache = { width, sample, raw, out };
  return out;
}

/**
 * Install the patch once; later calls (a `/reload`) only update the options it
 * reads. `enabled: false`, `tidy.enabled: false`, a missing theme or a render
 * error leaves pi's own drawing.
 */
export function patchBashExecutions(options: BashModeOptions): void {
  bashModeOptions.set(options);
  const proto = BashExecutionComponent.prototype as unknown as BashExecutionInternals & { __tidyBashMode?: boolean };
  if (proto.__tidyBashMode) return;
  proto.__tidyBashMode = true;

  const originalRender = proto.render;
  proto.render = function (this: BashExecutionInternals, width: number): string[] {
    const live = bashModeOptions.get();
    const theme = getTheme();
    if (!theme || !live?.enabled || !tidyEnabled.get() || width < 6) return originalRender.call(this, width);
    try {
      return renderBashMode(this, width, theme, live) ?? originalRender.call(this, width);
    } catch {
      return originalRender.call(this, width);
    }
  };
}
