import { dts } from "rollup-plugin-dts";

// Pi loads the published TypeScript source; only declarations are bundled.
export default {
  input: "index.ts",
  output: { file: "dist/public.d.ts", format: "es" },
  external: [/^@earendil-works\//, /^@xzzpig\//, /^node:/],
  plugins: [dts({ tsconfig: "./tsconfig.json" })],
};
