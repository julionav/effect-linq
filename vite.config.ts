import { defineConfig } from "vite-plus";
import { linq } from "./src/vite.ts";

export default defineConfig({
  plugins: [linq()],
  pack: {
    entry: {
      index: "src/index.ts",
      vite: "src/vite.ts",
      compiler: "src/compiler.ts",
      register: "src/register.ts",
      bun: "src/bun.ts",
      "bun/register": "src/bun-register.ts",
    },
    dts: true,
    exports: true,
  },
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    testTimeout: 30_000,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
