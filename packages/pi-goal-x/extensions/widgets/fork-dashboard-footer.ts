import { visibleWidth } from "@earendil-works/pi-tui";

export interface FooterAction<Action extends string> {
  action: Action;
  start: number;
  end: number;
}

export interface FooterControls<Action extends string> {
  line: number;
  actions: FooterAction<Action>[];
}

export type FooterEntry<Action extends string> = {
  text: string;
  shortText?: string;
} & (
  | { action: Action; after?: never; right?: never }
  | { action?: never; after: Action; right?: never }
  | { action?: never; after?: never; right?: boolean }
);

/** Accept entries in fit priority order; reserve no width for an omitted entry. */
export function layoutDashboardFooter<Action extends string>(
  width: number,
  frame: (text: string) => string,
  entries: readonly FooterEntry<Action>[],
): { text: string; actions: FooterAction<Action>[] } {
  if (width < 2) return { text: width === 1 ? frame("╰") : "", actions: [] };
  const prefix = "╰─ ";
  const separator = " · ";
  const left: {
    text: string;
    width: number;
    action?: Action;
    attached: boolean;
  }[] = [];
  const right: string[] = [];
  let leftWidth = 0;
  let rightWidth = 0;

  for (const entry of entries) {
    const previous =
      entry.after === undefined
        ? -1
        : left.findIndex((item) => item.action === entry.after);
    if (entry.after !== undefined && previous < 0) continue;
    const attached = previous >= 0;
    // Keep a dash before the right-hand suffix (or before the corner if absent).
    let overhead = prefix.length - 1;
    if (entry.right) overhead = right.length ? separator.length : 3;
    else if (attached) overhead = 1;
    else if (left.length) overhead = separator.length;
    for (const text of [entry.text, entry.shortText]) {
      if (!text) continue;
      const columns = visibleWidth(text);
      if (
        columns === 0 ||
        leftWidth + rightWidth + overhead + columns + 3 > width
      )
        continue;
      if (entry.right) {
        right.push(text);
        rightWidth += overhead + columns;
      } else {
        const item = { text, width: columns, action: entry.action, attached };
        if (attached) left.splice(previous + 1, 0, item);
        else left.push(item);
        leftWidth += overhead + columns;
      }
      break;
    }
  }

  const actions: FooterAction<Action>[] = [];
  let text = frame(left.length ? prefix : "╰");
  let column = left.length ? prefix.length : 1;
  for (const [i, item] of left.entries()) {
    if (i > 0) {
      const gap = item.attached ? " " : separator;
      text += frame(gap);
      column += gap.length;
    }
    if (item.action !== undefined)
      actions.push({
        action: item.action,
        start: column,
        end: column + item.width,
      });
    text += item.text;
    column += item.width;
  }
  const suffix = right.length
    ? ` ${right.join(frame(separator))} ${frame("─")}`
    : "";
  const dashes = width - column - visibleWidth(suffix) - 1;
  return {
    text: text + frame("─".repeat(dashes)) + suffix + frame("╯"),
    actions,
  };
}
