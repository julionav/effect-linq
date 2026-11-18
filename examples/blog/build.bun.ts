import { linq } from "@blitz/effect-linq/bun";

// The repository is type-checked without Bun's types; an app would install @types/bun.
declare const Bun: {
  build(options: object): Promise<{ success: boolean; logs: ReadonlyArray<unknown> }>;
};

const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  outdir: "dist-bun",
  target: "bun",
  minify: true,
  plugins: [linq({ strict: true })],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
