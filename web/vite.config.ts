import { defineConfig } from "vitest/config";
import type { Plugin, Connect } from "vite";
import { createReadStream, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const dataDir = resolve(process.env.WXTREND_DATA_DIR ?? join(repoRoot, "data"));

/**
 * Serve pipeline output at /data/ in dev and preview. Frames are sent as
 * opaque bytes (no Content-Encoding), matching how GitHub Pages serves .gz.
 */
function serveData(): Plugin {
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    const path = (req.url ?? "").split("?")[0];
    if (!path.startsWith("/data/")) return next();
    const file = resolve(dataDir, decodeURIComponent(path.slice("/data/".length)));
    let ok = false;
    try {
      ok = file.startsWith(dataDir + sep) && statSync(file).isFile();
    } catch {
      ok = false;
    }
    if (!ok) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader("Content-Type", file.endsWith(".json") ? "application/json" : "application/octet-stream");
    res.setHeader("Cache-Control", "no-cache");
    createReadStream(file).pipe(res);
  };
  return {
    name: "wxtrend-data",
    configureServer: (server) => void server.middlewares.use(handler),
    configurePreviewServer: (server) => void server.middlewares.use(handler),
  };
}

export default defineConfig({
  base: "./",
  plugins: [serveData()],
  server: { fs: { allow: [repoRoot] } },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
