/** Display-only formatting: preserve blank logical lines in a proposed goal. */
export function formatConfirmationLines(content: string): string[] {
  return content.split("\n").map((rawLine) => {
    if (!rawLine.trim()) return "│";
    return rawLine.trim().startsWith("│") ? rawLine : `│   ${rawLine}`;
  });
}
