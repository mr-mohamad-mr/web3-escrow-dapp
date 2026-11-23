// Browser stub for Node's `path`, used only when bundling
// ../lib/escrow.js for the browser (see vite.config.js). The layer uses
// path.join only inside its Node-only loadDeployment() helper, which
// the frontend never calls — these are minimal POSIX implementations
// so the bundled module stays well-formed.

export function join(...parts) {
  return parts
    .filter((p) => p !== undefined && p !== null && p !== "")
    .join("/")
    .replace(/\/{2,}/g, "/");
}

export function resolve(...parts) {
  return join(...parts);
}

export function dirname(p) {
  const i = String(p).lastIndexOf("/");
  return i <= 0 ? "/" : String(p).slice(0, i);
}

export function basename(p) {
  const s = String(p);
  return s.slice(s.lastIndexOf("/") + 1);
}

export const sep = "/";

export default { join, resolve, dirname, basename, sep };
