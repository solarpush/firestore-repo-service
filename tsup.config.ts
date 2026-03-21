import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "servers/index": "src/servers/index.ts",
    "servers/admin/index": "src/servers/admin/index.ts",
    "servers/crud/index": "src/servers/crud/index.ts",
    "sync/index": "src/sync/index.ts",
    "sync/bigquery": "src/sync/adapters/bigquery.ts",
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
    "@google-cloud/bigquery",
    "@google-cloud/pubsub",
  ],
  minify: true,
  treeshake: true,
  esbuildOptions(opts) {
    opts.jsx = "automatic";
    opts.jsxImportSource = "hono/jsx";
    opts.loader = { ...opts.loader, ".raw.js": "text" };
  },
});
