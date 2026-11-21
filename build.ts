/**
 * Builds everything into dist/: the static pages with their bundled scripts (dist/public, used by
 * both hosts) and the Node server (dist/server.cjs, used by Docker). Run with `node build.ts`.
 */
import { cp, rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });
await cp("public", "dist/public", { recursive: true });

await build({
  entryPoints: ["src/client/display.ts", "src/client/control.ts"],
  outdir: "dist/public",
  bundle: true,
  format: "esm",
  // es2019 so an older school or venue browser can still run the display.
  target: "es2019",
  minify: true,
  logLevel: "warning",
});

await build({
  entryPoints: ["src/node/server.ts"],
  outfile: "dist/server.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  // Optional native speed-ups for ws; it works without them.
  external: ["bufferutil", "utf-8-validate"],
  // Screens reload themselves when this changes, i.e. after every new build is deployed.
  define: { __BUILD_ID__: JSON.stringify(Date.now().toString(36)) },
  logLevel: "warning",
});

console.log("Built dist/");
