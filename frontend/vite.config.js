// Vite config for the escrow frontend.
//
// Two project-specific plugins:
//
// 1. bundleEscrowLib — the app imports the interaction layer
//    (../lib/escrow.js) directly, so there is exactly one implementation
//    of every contract call. That file is CommonJS written for Node: it
//    require()s the Hardhat artifact JSONs and uses fs/path inside its
//    Node-only loadDeployment() helper. esbuild bundles it to ESM for
//    the browser here (artifacts inlined, fs/path aliased to stubs that
//    throw if loadDeployment is ever called in the browser — the
//    frontend fetches the deployment over HTTP instead, see 2). Two
//    esbuild quirks are patched in the output: its CJS wrapper leaves
//    `require("ethers")` as a dynamic require (rewritten to a real ESM
//    import, so app and layer share one ethers instance), and it only
//    emits a default export (the layer's public names are re-exported
//    explicitly from it).
//
// 2. serveDeployment — serves ../deployments/localhost.json at
//    /deployment.json (dev + preview), always fresh from disk, so a
//    re-seed is picked up on page reload without a rebuild.

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { build as esbuildBuild } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const libPath = path.join(rootDir, "..", "lib", "escrow.js");
const deploymentFile = path.join(rootDir, "..", "deployments", "localhost.json");
const fsStub = path.join(rootDir, "stubs", "fs.js");
const pathStub = path.join(rootDir, "stubs", "path.js");

// The interaction layer's public API surface, read from the real module
// (this config runs in Node, where the CJS layer loads natively). The
// browser bundle below re-exports these names explicitly: esbuild's
// CJS→ESM conversion of the layer only produces a default export (it
// wraps the module in a lazy require), which would leave every named
// import undefined in the app.
const libExportNames = Object.keys(createRequire(import.meta.url)(libPath));

function bundleEscrowLib() {
  return {
    name: "bundle-escrow-lib",
    enforce: "pre",
    resolveId(source) {
      if (source.endsWith("lib/escrow.js")) return libPath;
      return null;
    },
    async load(id) {
      if (id !== libPath) return null;
      const result = await esbuildBuild({
        entryPoints: [libPath],
        bundle: true,
        format: "esm",
        platform: "browser",
        write: false,
        logLevel: "silent",
        external: ["ethers"],
        alias: {
          fs: fsStub,
          path: pathStub,
          "node:fs": fsStub,
          "node:path": pathStub,
        },
      });
      let code = result.outputFiles[0].text;
      // The layer's CJS wrapper keeps its (only) external require —
      // `require("ethers")` — as a dynamic __require() call, which
      // throws in a browser. Rewrite it to a real ESM import of the
      // app's ethers, so layer and app share one ethers instance.
      if (!code.includes('__require("ethers")')) {
        throw new Error(
          "bundle-escrow-lib: expected a dynamic require of \"ethers\" in the bundled layer — esbuild output changed, review vite.config.js."
        );
      }
      code = code.split('__require("ethers")').join("__ethersExternal");
      code = `import * as __ethersExternal from "ethers";\n${code}`;
      // esbuild's CJS→ESM conversion only produces a default export
      // (the module is wrapped in a lazy require), so re-export the
      // layer's public names explicitly from that default.
      return code.replace(/export default ([\s\S]+?);\s*$/, (_match, expr) => {
        const reExports = libExportNames
          .map((name) => `export const ${name} = __escrowDefault.${name};`)
          .join("\n");
        return `const __escrowDefault = ${expr};\nexport default __escrowDefault;\n${reExports}\n`;
      });
    },
  };
}

function serveDeployment() {
  const handler = (req, res, next) => {
    if (!req.url || !req.url.startsWith("/deployment.json")) return next();
    fs.readFile(deploymentFile, "utf8", (err, data) => {
      res.setHeader("Content-Type", "application/json");
      if (err) {
        res.statusCode = 404;
        res.end(
          JSON.stringify({
            error:
              "deployments/localhost.json not found — start a local node and run `npm run seed:local` first.",
          })
        );
        return;
      }
      res.end(data);
    });
  };
  return {
    name: "serve-deployment",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

// Bind to IPv4 loopback by default (the app and tooling use 127.0.0.1).
// The Docker image sets VITE_HOST=0.0.0.0 so the published port works.
const host = process.env.VITE_HOST || "127.0.0.1";

export default defineConfig({
  plugins: [bundleEscrowLib(), react(), serveDeployment()],
  server: {
    host,
    port: 5173,
    fs: { allow: [path.join(rootDir, "..")] },
  },
  preview: { host, port: 4173, strictPort: true },
  build: {
    // The app chunk still carries the inlined contract artifacts and the
    // parts of ethers the layer pulls in through its namespace import
    // (~550 kB raw / ~175 kB gzip). Fine for a local demo.
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      // ethers is most of the bundle; split it (and React) into their
      // own long-cacheable vendor chunks.
      output: {
        manualChunks: { ethers: ["ethers"], react: ["react", "react-dom"] },
      },
    },
  },
});
