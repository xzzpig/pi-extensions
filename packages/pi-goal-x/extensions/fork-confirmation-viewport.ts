/** Final body viewport for the two proposal dialogs; it never discards source rows. */
export interface ConfirmationBodyViewport {
  lines: string[];
  scrollTop: number;
  pageSize: number;
  /** Start and end (exclusive) of content rows within `lines`. */
  contentStart: number;
  contentEnd: number;
}

export function fitConfirmationBody(
  body: readonly string[],
  height: number,
  requestedTop: number,
  indicator: (label: string) => string,
): ConfirmationBodyViewport {
  const slots = Math.max(1, Math.floor(height));
  const capacity = Math.max(1, slots - (slots >= 3 ? 2 : slots === 2 ? 1 : 0));
  const top = Math.min(
    Math.max(0, Math.floor(requestedTop)),
    Math.max(0, body.length - capacity),
  );
  const visible = body.slice(top, top + capacity);
  const below = Math.max(0, body.length - top - visible.length);
  const lines: string[] = [];
  if (slots >= 3) lines.push(indicator(top > 0 ? `▲ ${top} more` : ""));
  const contentStart = lines.length;
  for (const row of visible) lines.push(row);
  const contentEnd = lines.length;
  while (lines.length < slots - (slots >= 2 ? 1 : 0)) lines.push(indicator(""));
  if (slots >= 2) {
    const labels: string[] = [];
    if (slots === 2 && top > 0) labels.push(`▲ ${top} more`);
    if (below > 0) labels.push(`▼ ${below} more`);
    lines.push(indicator(labels.join(" · ")));
  }
  return {
    lines,
    scrollTop: top,
    pageSize: capacity,
    contentStart,
    contentEnd,
  };
}
