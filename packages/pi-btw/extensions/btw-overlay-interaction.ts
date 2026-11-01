import type { TuiMouseEvent } from "@earendil-works/pi-tui";

/**
 * Overlay-local rows above the transcript viewport: top border, mode line,
 * summary line, and the rule that separates chrome from transcript content.
 * Kept next to the renderer so mouse mapping and drawing cannot drift apart.
 */
export const BTW_OVERLAY_TRANSCRIPT_TOP = 4;

/**
 * Layout of the visible transcript inside the BTW overlay. Presenter output is
 * already laid out to `contentWidth`; the overlay uses those lines verbatim so
 * native tool diffs, borders, and tables keep their geometry. `lineCount` is
 * the number of presenter lines available for hit testing.
 */
export interface BtwOverlayTranscriptLayout {
  /** Overlay-local y of the first transcript row. */
  transcriptTop: number;
  /** Number of transcript rows currently visible. */
  transcriptHeight: number;
  /** First presenter line currently shown. */
  scrollOffset: number;
  /** Overlay-local x of the first content column (after the left border). */
  contentLeft: number;
  /** Width the presenter rendered at. */
  contentWidth: number;
  /** Total presenter lines available in the current frame. */
  lineCount: number;
}

/**
 * Converts an overlay-local mouse event to presenter transcript space.
 * Returns `undefined` for chrome, the footer/input area, the border columns,
 * and any row that is scrolled or clipped out of the visible viewport. The
 * caller must never hand raw overlay coordinates to a child component.
 */
export function mapBtwOverlayTranscriptMouse(
  event: TuiMouseEvent,
  layout: BtwOverlayTranscriptLayout,
): TuiMouseEvent | undefined {
  const visibleRow = event.y - layout.transcriptTop;
  if (visibleRow < 0 || visibleRow >= layout.transcriptHeight) return undefined;

  const presenterLine = layout.scrollOffset + visibleRow;
  if (presenterLine < 0 || presenterLine >= layout.lineCount) return undefined;

  const contentX = event.x - layout.contentLeft;
  if (contentX < 0 || contentX >= layout.contentWidth) return undefined;

  return {
    ...event,
    x: contentX,
    y: presenterLine,
    width: layout.contentWidth,
  };
}

const SGR_MOUSE_SEQUENCE = /^\x1b\[<\d+;\d+;\d+[Mm]$/;

/** Whether raw input is an SGR mouse report (wheel handled separately). */
export function isBtwSgrMouseSequence(data: string): boolean {
  return SGR_MOUSE_SEQUENCE.test(data);
}
