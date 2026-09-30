/**
 * Name the browser bundle `client.js`.
 *
 * DSH web client loader serves `${package}/client.js` and requires the `.js` extension.
 * `vp pack` with `format: ["cjs"]` emits `.cjs` for type:module packages, so this script
 * normalizes the artifact to `lib/client.js`.
 */

import { existsSync, renameSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const built = path.join(ROOT, "lib/client.cjs");
const served = path.join(ROOT, "lib/client.js");

if (existsSync(built)) {
  if (existsSync(served)) {
    renameSync(served, path.join(ROOT, "lib/.client.js.stale"));
  }
  renameSync(built, served);
}
