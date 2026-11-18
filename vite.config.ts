import { defineConfig } from "vite-plus";
import { linq } from "./src/vite.ts";

export default defineConfig({
  plugins: [linq()],
  pack: {
    entry: ["src/index.ts", "src/vite.ts", "src/compiler.ts", "src/register.ts"],
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
