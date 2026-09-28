import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let cached;
export function version() {
  if (!cached) {
    try {
      cached = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")).version || "0.0.0";
    } catch {
      cached = "0.0.0";
    }
  }
  return cached;
}
