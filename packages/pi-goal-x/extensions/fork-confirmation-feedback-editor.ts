import {
  Editor,
  visibleWidth,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Pi's wrapper must be able to fit every real grapheme with its cursor reserve.
 * Some clusters (including Indic conjuncts) occupy more than two cells. */
export class ConfirmationFeedbackEditor extends Editor {
  private measuredText?: string;
  private minimum = 3;
  private renderedWidth?: number;

  constructor(tui: TUI, theme: EditorTheme) {
    super(tui, theme);
    this.onChange = () => {
      // Pi may handle a key appended to a bracketed paste immediately, before
      // the host can draw again. Refresh native navigation's wrapping width.
      if (
        this.renderedWidth !== undefined &&
        this.renderedWidth < this.minimumWidth()
      ) {
        this.render(this.minimum);
      }
    };
  }

  minimumWidth(): number {
    const text = this.getText();
    if (this.measuredText !== text) {
      this.measuredText = text;
      this.minimum = 3;
      for (const { segment } of graphemes.segment(text)) {
        this.minimum = Math.max(this.minimum, visibleWidth(segment) + 1);
      }
    }
    return this.minimum;
  }

  override render(width: number): string[] {
    this.renderedWidth = Math.max(width, this.minimumWidth());
    return super.render(this.renderedWidth);
  }
}
