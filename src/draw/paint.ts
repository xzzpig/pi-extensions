/**
 * Paint text in a configured color: a pi theme color name or a `#rrggbb` hex.
 *
 * `theme.fg` only knows its own tokens and throws on anything else, so a hex
 * goes straight to an SGR sequence — truecolor, or the nearest xterm-256 entry
 * when the theme runs in 256-color mode. An unknown name leaves the text
 * unpainted rather than breaking the render.
 */

import type { ThemeLike } from "../theme-access.ts";

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isHexColor(value: string): boolean {
  return HEX_RE.test(value);
}

function hexToRgb(hex: string): [number, number, number] {
  let body = hex.slice(1);
  if (body.length === 3) body = [...body].map((ch) => ch + ch).join("");
  return [0, 2, 4].map((i) => Number.parseInt(body.slice(i, i + 2), 16)) as [number, number, number];
}

/** The xterm-256 cube steps; grey ramp entries are 8, 18, …, 238. */
const CUBE = [0, 95, 135, 175, 215, 255];

function nearestCubeIndex(value: number): number {
  let best = 0;
  for (let i = 1; i < CUBE.length; i++) {
    if (Math.abs(CUBE[i] - value) < Math.abs(CUBE[best] - value)) best = i;
  }
  return best;
}

function rgbTo256([r, g, b]: [number, number, number]): number {
  const [ri, gi, bi] = [r, g, b].map(nearestCubeIndex);
  const cube = 16 + 36 * ri + 6 * gi + bi;
  const cubeDistance = (CUBE[ri] - r) ** 2 + (CUBE[gi] - g) ** 2 + (CUBE[bi] - b) ** 2;
  const grey = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const level = 8 + grey * 10;
  const greyDistance = (level - r) ** 2 + (level - g) ** 2 + (level - b) ** 2;
  return greyDistance < cubeDistance ? 232 + grey : cube;
}

function hexSgr(hex: string, theme: ThemeLike): string {
  const rgb = hexToRgb(hex);
  return theme.getColorMode?.() === "256color" ? `\x1b[38;5;${rgbTo256(rgb)}m` : `\x1b[38;2;${rgb.join(";")}m`;
}

export function paint(theme: ThemeLike, color: string, text: string): string {
  if (isHexColor(color)) return `${hexSgr(color, theme)}${text}\x1b[39m`;
  try {
    return theme.fg(color, text);
  } catch {
    return text;
  }
}
