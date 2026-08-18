import {
  TranscriptViewport,
  type SessionTranscript,
} from "@xzzpig/pi-components/transcript";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type KeybindingsManager,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";
import { borderedLine, dialogInnerWidth, horizontalRule } from "./dialog-scaffold.ts";

export interface AuditorTranscriptOverlay {
  refresh(): void;
  close(): void;
}

interface OverlayRuntime {
  closed: boolean;
  done?: () => void;
  handle?: OverlayHandle;
  component?: AuditorTranscriptOverlayComponent;
}

let activeOverlay: AuditorTranscriptOverlay | null = null;

class AuditorTranscriptOverlayComponent implements Component {
  private readonly tui: TUI;
  private readonly viewport: TranscriptViewport;
  private readonly theme: Theme;
  private readonly getStatus: () => string;
  private readonly onClose: () => void;
  private readonly ownsMouseReporting: boolean;
  private mouseReportingReleased = false;

  constructor(
    tui: TUI,
    theme: Theme,
    _keybindings: KeybindingsManager,
    transcript: SessionTranscript,
    getStatus: () => string,
    onClose: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.getStatus = getStatus;
    this.onClose = onClose;
    this.viewport = new TranscriptViewport({
      tui,
      theme,
      readEntries: () => transcript.entries,
      assistantLabel: "Auditor",
      toolLabel: "Tool",
      thinkingLabel: "Thinking",
      emptyText: "Waiting for the auditor session...",
    });
    // Fullscreen Pi owns mouse reporting. Regular mode needs this overlay to
    // opt in so wheel and touchpad events reach TranscriptViewport.
    const tuiMode = (tui as { mode?: "regular" | "fullscreen" }).mode;
    this.ownsMouseReporting = tuiMode !== "fullscreen";
    if (this.ownsMouseReporting) {
      tui.terminal?.write?.("\x1b[?1000h\x1b[?1006h");
    }
  }

  refresh(): void {
    this.viewport.refresh();
  }

  invalidate(): void {
    this.refresh();
  }

  dispose(): void {
    if (!this.ownsMouseReporting || this.mouseReportingReleased) return;
    this.mouseReportingReleased = true;
    this.tui.terminal?.write?.("\x1b[?1000l\x1b[?1006l");
  }

  private frame(content: string, innerWidth: number): string {
    const clipped = visibleWidth(content) > innerWidth ? truncateToWidth(content, innerWidth, "") : content;
    return borderedLine((value) => this.theme.fg("border", value), innerWidth, clipped);
  }

  private dialogHeight(): number {
    const rows = process.stdout.rows ?? 30;
    return Math.max(16, Math.min(34, Math.floor(rows * 0.78)));
  }

  render(width: number): string[] {
    const dialogWidth = Math.max(56, Math.min(width, 118));
    const innerWidth = dialogInnerWidth(dialogWidth, 116);
    const accent = (value: string) => this.theme.fg("accent", value);
    const height = this.dialogHeight();
    // Top border, title, status, rule, content, rule, footer, bottom border.
    const contentHeight = Math.max(6, height - 7);
    const viewport = this.viewport.render(Math.max(1, innerWidth - 2), contentHeight);
    const status = this.getStatus().trim() || "Auditing...";
    const scroll = viewport.hiddenAbove || viewport.hiddenBelow
      ? `  ${status}  |  up ${viewport.hiddenAbove} down ${viewport.hiddenBelow}`
      : `  ${status}`;
    const lines = [
      accent(`+${horizontalRule(innerWidth)}+`),
      this.frame(`  ${this.theme.bold("Completion audit transcript")}`, innerWidth),
      this.frame(this.theme.fg("dim", scroll), innerWidth),
      accent(`+${horizontalRule(innerWidth)}+`),
    ];

    for (const line of viewport.lines) {
      lines.push(this.frame(` ${line}`, innerWidth));
    }
    for (let index = viewport.lines.length; index < contentHeight; index++) {
      lines.push(this.frame("", innerWidth));
    }

    lines.push(accent(`+${horizontalRule(innerWidth)}+`));
    lines.push(this.frame(this.theme.fg("dim", "  Wheel, Up/Down, PgUp/PgDn scroll | End latest | Esc close"), innerWidth));
    lines.push(accent(`+${horizontalRule(innerWidth)}+`));
    return lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "") : line));
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.onClose();
      return;
    }
    this.viewport.handleInput(data);
  }
}

/**
 * Opens one non-blocking, read-only transcript overlay. Starting a subsequent
 * audit closes the old overlay, so an inactive transcript never steals focus.
 */
export function openAuditorTranscriptOverlay(
  ctx: ExtensionContext,
  options: {
    transcript: SessionTranscript;
    getStatus: () => string;
    onClose?: () => void;
  },
): AuditorTranscriptOverlay | null {
  if (!ctx.hasUI || typeof ctx.ui.custom !== "function") return null;

  activeOverlay?.close();
  const runtime: OverlayRuntime = { closed: false };
  const close = (): void => {
    if (runtime.closed) return;
    runtime.closed = true;
    runtime.handle?.hide();
    runtime.done?.();
    if (activeOverlay === overlay) activeOverlay = null;
    try {
      options.onClose?.();
    } catch (error) {
      // Presentation-only observers cannot block overlay teardown.
      void error;
    }
  };
  const overlay: AuditorTranscriptOverlay = {
    refresh: () => runtime.component?.refresh(),
    close,
  };
  activeOverlay = overlay;

  void ctx.ui.custom<void>(
    (tui, theme, keybindings, done): Component => {
      runtime.done = done;
      runtime.component = new AuditorTranscriptOverlayComponent(
        tui,
        theme,
        keybindings,
        options.transcript,
        options.getStatus,
        close,
      );
      if (runtime.closed) done();
      return runtime.component;
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "top-center",
        width: "82%",
        minWidth: 56,
        maxHeight: "82%",
        margin: { top: 1, left: 2, right: 2 },
        nonCapturing: true,
      },
      onHandle: (handle) => {
        runtime.handle = handle;
        if (runtime.closed) {
          handle.hide();
          runtime.done?.();
          return;
        }
        handle.focus();
      },
    },
  ).catch((error) => {
    if (activeOverlay === overlay) activeOverlay = null;
    if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  });

  return overlay;
}
