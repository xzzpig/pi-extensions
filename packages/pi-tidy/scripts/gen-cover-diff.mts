import { generateDiffString, initTheme } from "@earendil-works/pi-coding-agent";
import { renderSplitDiff } from "../src/tools/split-diff.ts";

initTheme("dark");
const theme = (globalThis as any)[Symbol.for("@earendil-works/pi-coding-agent:theme")];

const before = `export function retry(fn: () => Promise<number>) {
  const retries = 3;
  return fn().catch(() => retries);
}
`;
const after = before.replace("retries = 3", "retries = 5");
const { diff } = generateDiffString(before, after);
const out = renderSplitDiff({ diff, width: 62, theme, filePath: "src/retry.ts" })!;

const ADV = 9.6, BASE_X = 568, TOP = 346, STEP = 26;
const DEFAULT_FG = "#cdd6f4";

type Style = { fg: string; bg: string | null };
function runs(line: string): { text: string; style: Style }[] {
  const res: { text: string; style: Style }[] = [];
  let fg = DEFAULT_FG, bg: string | null = null;
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0, m: RegExpExecArray | null, buf = "";
  const push = () => { if (buf) { res.push({ text: buf, style: { fg, bg } }); buf = ""; } };
  while ((m = re.exec(line))) {
    buf += line.slice(last, m.index); push();
    const p = m[1].split(";").map(Number);
    for (let i = 0; i < p.length; i++) {
      if (p[i] === 0) { fg = DEFAULT_FG; bg = null; }
      else if (p[i] === 39) fg = DEFAULT_FG;
      else if (p[i] === 49) bg = null;
      else if ((p[i] === 38 || p[i] === 48) && p[i + 1] === 2) {
        const hex = "#" + [p[i + 2], p[i + 3], p[i + 4]].map((n) => n.toString(16).padStart(2, "0")).join("");
        if (p[i] === 38) fg = hex; else bg = hex;
        i += 4;
      }
    }
    last = m.index + m[0].length;
  }
  buf += line.slice(last); push();
  return res;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const outLines: string[] = [];
out.lines.forEach((line, row) => {
  const y = TOP + row * STEP;
  let col = 0;
  const rects: string[] = [];
  const spans: string[] = [];
  for (const r of runs(line)) {
    const w = r.text.length * ADV;
    if (r.style.bg) {
      rects.push(`<rect x="${(BASE_X + col * ADV).toFixed(1)}" y="${y - 19}" width="${w.toFixed(1)}" height="25" fill="${r.style.bg}"/>`);
    }
    spans.push(`<tspan fill="${r.style.fg}">${esc(r.text)}</tspan>`);
    col += r.text.length;
  }
  outLines.push(`  ${rects.join("")}`);
  outLines.push(`  <text x="${BASE_X}" y="${y}">${spans.join("")}</text>`);
});
console.log(outLines.join("\n"));
console.error("rows:", out.lines.length, "bottom:", TOP + (out.lines.length - 1) * STEP);
