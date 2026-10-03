// Bundle the browser app (with Mermaid) into dist/client and copy the stylesheet.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dist", "client");
fs.mkdirSync(outDir, { recursive: true });

const watch = process.argv.includes("--watch");
const options = {
  entryPoints: [path.join(root, "client", "main.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  outfile: path.join(outDir, "app.js"),
  logLevel: "info",
  define: { "process.env.NODE_ENV": '"production"' },
};

function copyCss() {
  fs.copyFileSync(path.join(root, "client", "board.css"), path.join(outDir, "board.css"));
  fs.cpSync(path.join(root, "client", "assets"), path.join(outDir, "assets"), { recursive: true });
}

// The Excalidraw whiteboard frame comes prebuilt from lavish-axi (dev dependency):
// Excalidraw + mermaid-to-excalidraw + React + fonts, ~8 MB, served at
// /whiteboard-assets/. Optional: without it the board has no whiteboard button.
function copyWhiteboard() {
  const src = path.join(root, "node_modules", "lavish-axi", "dist", "whiteboard");
  const dest = path.join(root, "dist", "whiteboard");
  if (!fs.existsSync(path.join(src, "whiteboard.js"))) {
    console.log("whiteboard bundle not found (lavish-axi dev dependency missing) - skipping");
    return;
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  const packageDir = path.join(root, "node_modules", "lavish-axi");
  fs.copyFileSync(path.join(packageDir, "LICENSE"), path.join(dest, "LICENSE.lavish-axi"));
  fs.copyFileSync(path.join(packageDir, "THIRD-PARTY-NOTICES.md"), path.join(dest, "THIRD-PARTY-NOTICES.lavish-axi.md"));
  console.log(`copied whiteboard bundle to ${path.relative(root, dest)}`);
}

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  copyCss();
  fs.watch(path.join(root, "client", "board.css"), copyCss);
  console.log("watching client/ …");
} else {
  await esbuild.build(options);
  copyCss();
  copyWhiteboard();
  const size = fs.statSync(options.outfile).size;
  console.log(`built ${path.relative(root, options.outfile)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}
