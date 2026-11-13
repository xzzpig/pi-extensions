/**
 * pi's own clipboard write, when this pi has one.
 *
 * Imported as a namespace on purpose: a named import of an export an older pi
 * lacks is a link error, and the whole extension would refuse to load over a
 * copy chip. `copyToClipboard` itself falls back native → platform command →
 * OSC 52, so nothing here touches escape sequences.
 */

import * as pi from "@earendil-works/pi-coding-agent";

type Copy = (text: string) => Promise<void>;

const piCopy = (pi as { copyToClipboard?: Copy }).copyToClipboard;
let writer = piCopy;

/** Whether a chip that copies anything would do anything on this pi. */
export function canCopyText(): boolean {
  return typeof writer === "function";
}

export async function copyText(text: string): Promise<void> {
  await writer?.(text);
}

/** Tests swap the writer: a click must not touch the real clipboard. */
export function setClipboardWriter(next: Copy | undefined): void {
  writer = next ?? piCopy;
}
