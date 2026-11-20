import type { KeyId } from "@earendil-works/pi-tui";
import { formatGoalKeybinding } from "../goal-settings.ts";
import {
  layoutDashboardFooter,
  type FooterControls,
  type FooterEntry,
} from "./fork-dashboard-footer.ts";

export type TaskFooterAction = "toggle" | "follow";
export type TaskFooterControls = FooterControls<TaskFooterAction> & {
  preserveThrough: number;
};

export function appendTaskDashboardFooter(
  lines: string[],
  width: number,
  frame: (text: string) => string,
  controls: (geometry: TaskFooterControls) => void,
  options: {
    expanded: boolean;
    hasCurrent: boolean;
    preserveThrough: number;
    keys: readonly KeyId[];
    scrollHint?: string;
    auditor?: { dot: string; note: string };
  },
): void {
  const entries: FooterEntry<TaskFooterAction>[] = [
    { text: frame(options.expanded ? "[收起]" : "[展开]"), action: "toggle" },
  ];
  if (options.hasCurrent)
    entries.push({ text: frame("[回到当前]"), action: "follow" });
  if (options.auditor) {
    entries.push({
      text: options.auditor.note,
      shortText: options.auditor.dot,
      right: true,
    });
  }
  if (options.keys.length) {
    entries.push({
      text: frame(
        [...new Set(options.keys)].map(formatGoalKeybinding).join("/"),
      ),
      after: "toggle",
    });
  }
  if (options.scrollHint) entries.push({ text: frame(options.scrollHint) });
  const footer = layoutDashboardFooter(width, frame, entries);
  controls({
    line: lines.length,
    actions: footer.actions,
    preserveThrough: options.preserveThrough,
  });
  lines.push(footer.text);
}

export function taskFooterScrollHint(
  up: readonly KeyId[],
  down: readonly KeyId[],
): string {
  if (
    up.length === 1 &&
    up[0] === "ctrl+shift+up" &&
    down.length === 1 &&
    down[0] === "ctrl+shift+down"
  )
    return "Ctrl+Shift+↑↓: scroll";
  const keys = [...up, ...down];
  return keys.length
    ? `${keys.map(formatGoalKeybinding).join("/")}: scroll`
    : "";
}

export function taskFooterAuditorNote(
  frame: (text: string) => string,
  dot: string,
  keys: readonly KeyId[],
): string {
  return keys.length
    ? `${frame(`${keys.map(formatGoalKeybinding).join("/")}: toggle auditor`)} ${dot}`
    : dot;
}
