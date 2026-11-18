import { linq } from "effect-linq/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/main.ts"],
    minify: true,
    dts: false,
    plugins: [linq({ strict: true })],
  },
});
