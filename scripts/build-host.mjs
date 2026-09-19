import { build } from "esbuild";
await build({
  entryPoints: ["vendor/codex-sdk/src/index.ts"],
  outfile: ".build/codex-sdk.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: true,
});
await build({
  entryPoints: {
    core: "packages/core/entry.ts",
    service: "packages/core/service.ts",
    runtime: "packages/runtime/app-server.ts",
    "provider-runtime": "packages/runtime/codex.ts",
    desktop: "apps/desktop/main.ts",
    preload: "apps/desktop/preload.ts",
  },
  outdir: ".build",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  external: ["electron"],
  sourcemap: true,
});
