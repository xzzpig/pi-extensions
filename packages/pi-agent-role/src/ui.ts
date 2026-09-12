import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

/** One selectable row of a role picker. */
export interface PickerOption<T> {
  value: T;
  label: string;
  hint?: string;
  /** The option that is currently effective, rendered with a marker. */
  current?: boolean;
  /** Small badges rendered dim after the label (e.g. declared profiles). */
  badges?: string[];
  /** Rendered with the error colour, for clearing options. */
  danger?: boolean;
}

/**
 * Show a navigable single-choice picker and resolve with the selected value,
 * or undefined when the user cancels (Esc/Ctrl+C).
 *
 * Navigation: ↑/↓ and j/k move, Enter confirms, Esc/Ctrl+C cancels. The
 * component renders with the session theme and never touches the transcript.
 */
export function pickOption<T extends string>(
  ctx: ExtensionContext,
  title: string,
  options: readonly PickerOption<T>[],
  status?: string,
): Promise<T | undefined> {
  if (!ctx.hasUI) return Promise.resolve(undefined);
  return ctx.ui.custom<T | undefined>((tui, theme, _kb, done) => {
    let selectedIndex = 0;
    let resolved = false;

    const finish = (value: T | undefined): void => {
      if (resolved) return;
      resolved = true;
      done(value);
    };

    const badgeText = (badges: readonly string[]): string =>
      badges.map((badge) => ` ${theme.fg("dim", `[${badge}]`)}`).join("");

    return {
      render(width: number): string[] {
        const lines = [truncateToWidth(theme.fg("accent", title), width)];
        if (status) lines.push(truncateToWidth(theme.fg("dim", status), width));
        lines.push("");
        for (let index = 0; index < options.length; index++) {
          const option = options[index]!;
          const isSelected = index === selectedIndex;
          const prefix = isSelected ? " → " : "   ";
          let label = option.current
            ? `${theme.fg("accent", "●")} ${option.label}`
            : option.label;
          if (option.badges && option.badges.length > 0)
            label += badgeText(option.badges);
          if (option.hint) label += `  ${theme.fg("dim", option.hint)}`;
          const colored =
            option.danger && !isSelected ? theme.fg("error", label) : label;
          lines.push(truncateToWidth(`${prefix}${colored}`, width));
        }
        lines.push("");
        lines.push(
          truncateToWidth(
            theme.fg("dim", "↑↓ / jk navigate · enter confirm · esc cancel"),
            width,
          ),
        );
        return lines;
      },
      invalidate(): void {
        // No cached layout: every render recomputes from the current selection.
      },
      handleInput(data: string): void {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
          finish(undefined);
          return;
        }
        if (matchesKey(data, Key.enter)) {
          finish(options[selectedIndex]?.value);
          return;
        }
        if (matchesKey(data, Key.up) || data === "k") {
          selectedIndex = Math.max(0, selectedIndex - 1);
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.down) || data === "j") {
          selectedIndex = Math.min(options.length - 1, selectedIndex + 1);
          tui.requestRender();
          return;
        }
      },
    };
  });
}
