import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where things live once Ali Code is installed globally:
 *
 *   package root   <npm prefix>/node_modules/@scope/ali-code   (read-only, ours)
 *   user config    ~/.ali-code                                  (keys, sessions)
 *   project root   process.cwd() at launch                      (the user's repo)
 *
 * Nothing user-specific is ever written into the package root.
 */

/** Root of the installed package (works from dist/ and from src/ under tsx). */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export interface PackageInfo {
  name: string;
  version: string;
}

export function packageInfo(): PackageInfo {
  try {
    const raw = fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8");
    const json = JSON.parse(raw);
    return { name: String(json.name ?? "ali-code"), version: String(json.version ?? "0.0.0") };
  } catch {
    return { name: "ali-code", version: "0.0.0" };
  }
}

/**
 * User-level data directory. `ALI_HOME` overrides it; otherwise ~/.ali-code,
 * falling back to the legacy ~/.mini only when that is the one that exists.
 */
export function configRoot(): string {
  const override = process.env.ALI_HOME?.trim();
  if (override) return path.resolve(override);

  const home = os.homedir();
  const preferred = path.join(home, ".ali-code");
  const legacy = path.join(home, ".mini");
  return fs.existsSync(preferred) || !fs.existsSync(legacy) ? preferred : legacy;
}

/** User-level .env: API keys and preferences shared by every project. */
export function userEnvFile(): string {
  return path.join(configRoot(), ".env");
}
