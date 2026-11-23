// Browser stub for Node's `fs`, used only when bundling
// ../lib/escrow.js for the browser (see vite.config.js). The interaction
// layer touches fs exclusively inside loadDeployment(), which is a
// Node-side helper — the frontend loads the deployment over HTTP
// (/deployment.json) instead, so these must never be called. If one is,
// fail loudly rather than silently misbehaving.

function unavailable(name) {
  return function () {
    throw new Error(
      `lib/escrow.js: fs.${name} is Node-only (loadDeployment) and is not ` +
        "available in the browser build. The frontend fetches " +
        "/deployment.json instead."
    );
  };
}

export const existsSync = unavailable("existsSync");
export const readFileSync = unavailable("readFileSync");

export default { existsSync, readFileSync };
