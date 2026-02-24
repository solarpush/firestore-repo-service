import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "index.ts",
    "servers/index": "servers/index.ts",
    "servers/pagination/index": "servers/pagination/index.ts",
    "servers/admin/index": "servers/admin/index.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  external: [
    "firebase-admin",
    "firebase-functions",
    "zod",
    "hono",
    "@hono/node-server",
  ],
  minify: true,
  treeshake: true,
  esbuildOptions(opts) {
    opts.jsx = "automatic";
    opts.jsxImportSource = "hono/jsx";
    opts.loader = { ...opts.loader, ".raw.js": "text" };
  },
});
