import fs from "node:fs";
import path from "node:path";

export class ToolError extends Error {}

export const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".svelte-kit",
  "vendor", "__pycache__", ".venv", "venv", ".idea", ".vscode", ".cache",
  "coverage", ".turbo", ".pytest_cache", "target", "bin", "obj",
]);

const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff",
  ".pdf", ".zip", ".gz", ".tar", ".7z", ".rar", ".exe", ".dll", ".so",
  ".dylib", ".bin", ".woff", ".woff2", ".ttf", ".eot", ".mp3", ".mp4",
  ".mov", ".avi", ".mkv", ".sqlite", ".db", ".class", ".jar", ".pyc",
  ".lock",
]);

export function isBinaryExt(file: string): boolean {
  return BINARY_EXT.has(path.extname(file).toLowerCase());
}

/** Walk a directory tree, skipping noise. Yields absolute file paths. */
export function* walk(dir: string, depth = 0, maxDepth = 12): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (depth >= maxDepth) continue;
      yield* walk(full, depth + 1, maxDepth);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/** Resolve a user/model supplied path and refuse anything outside the workspace. */
export function resolveInside(cwd: string, input: string): string {
  const abs = path.resolve(cwd, input.trim() || ".");
  const rel = path.relative(cwd, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ToolError(
      `Path "${input}" is outside the workspace (${cwd}). Refusing to access it.`
    );
  }
  return abs;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = Math.floor(max * 0.4);
  const omitted = text.length - head - tail;
  return (
    text.slice(0, head) +
    `\n\n... [${omitted} characters omitted] ...\n\n` +
    text.slice(text.length - tail)
  );
}

export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    count++;
    i += needle.length;
  }
  return count;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function oneLine(text: string, max = 70): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
