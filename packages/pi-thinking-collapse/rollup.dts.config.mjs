import { dts } from "rollup-plugin-dts";

// Roll the public type surface into a self-contained declaration bundle.
// The package ships .ts source (Pi loads it through jiti), so we want only
// .d.ts — no JS emit. `index.ts` is the extension entry Pi loads; its
// default export and the exported types are the entire public contract.
// Relative .js specifiers resolve to .ts via the package tsconfig; peer
// dependency types (@earendil-works/*, node builtins) are kept external.

const external = [/^@earendil-works\//, /^node:/];

export default [
  {
    input: "index.ts",
    output: { file: "dist/public.d.ts", format: "es" },
    external,
    plugins: [dts({ tsconfig: "./tsconfig.json" })],
  },
];
