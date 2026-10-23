import { defineConfig } from "vitest/config";
import type { Plugin, Connect } from "vite";
import { createReadStream, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const dataDir = resolve(process.env.WXTREND_DATA_DIR ?? join(repoRoot, "data"));

/**
 * Serve the local data root at /data/ in dev and preview, standing in for the
 * R2 bucket: the pipeline writes each product to data/<product>/, the same
 * layout as the bucket. Run files are sent as opaque bytes (no
 * Content-Encoding), and a single byte range is answered with 206, as R2 and
 * Cloudflare's cache answer the site's frame requests.
 */
function serveData(): Plugin {
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    const path = (req.url ?? "").split("?")[0];
    if (!path.startsWith("/data/")) return next();
    const file = resolve(dataDir, decodeURIComponent(path.slice("/data/".length)));
    let size = -1;
    try {
      if (file.startsWith(dataDir + sep) && statSync(file).isFile()) size = statSync(file).size;
    } catch {
      size = -1;
    }
    if (size < 0) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader("Content-Type", file.endsWith(".json") ? "application/json" : "application/octet-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Accept-Ranges", "bytes");
    const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1);
      if (start >= size || end < start) {
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${size}`);
        res.end();
        return;
      }
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
      res.setHeader("Content-Length", String(end - start + 1));
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.setHeader("Content-Length", String(size));
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
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    // The viewer, and the daily games under /play/ (build plan Phase G)
    rollupOptions: {
      input: {
        main: resolve(fileURLToPath(new URL(".", import.meta.url)), "index.html"),
        spot: resolve(fileURLToPath(new URL(".", import.meta.url)), "play/spot/index.html"),
        play: resolve(fileURLToPath(new URL(".", import.meta.url)), "play/index.html"),
        measured: resolve(fileURLToPath(new URL(".", import.meta.url)), "play/measured/index.html"),
      },
    },
  },
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
