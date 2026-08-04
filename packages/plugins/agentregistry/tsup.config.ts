import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts", "src/client.tsx", "src/shared.ts"],
  format: ["esm"],
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ["react", "react/jsx-runtime", "effect", "@executor-js/sdk"],
});
