import { dts } from "rollup-plugin-dts";

// Roll the public type surface into a self-contained declaration bundle.
// We ship .ts source, so we want only .d.ts — no JS emit.
// Relative .js specifiers resolve to .ts via the package tsconfig; peer
// dependency types (@earendil-works/*, node builtins) are kept external.

const external = [/^@earendil-works\//, /^node:/];

export default [
  {
    input: "src/index.ts",
    output: { file: "dist/public.d.ts", format: "es" },
    external,
    plugins: [dts({ tsconfig: "./tsconfig.json" })],
  },
];
