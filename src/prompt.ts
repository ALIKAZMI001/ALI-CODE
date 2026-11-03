import fs from "node:fs";
import path from "node:path";

const MAX_PROMPT_FILE_CHARS = 12_000;

function readIfExists(file: string): string | null {
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    if (!text) return null;
    return text.length > MAX_PROMPT_FILE_CHARS
      ? text.slice(0, MAX_PROMPT_FILE_CHARS) + "\n… (truncated)"
      : text;
  } catch {
    return null;
  }
}

/**
 * Build the system prompt. Keep this stable across turns so provider-side
 * prompt caching can hit.
 */
export function buildSystemPrompt(cwd: string): string {
  const projectRules =
    readIfExists(path.join(cwd, "AGENTS.md")) ??
    readIfExists(path.join(cwd, "CLAUDE.md")) ??
    readIfExists(path.join(cwd, ".ali-code", "instructions.md")) ??
    readIfExists(path.join(cwd, ".mini", "instructions.md"));

  const pkg = readIfExists(path.join(cwd, "package.json"));
  let stack = "unknown";
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg);
      const deps = Object.keys({
        ...(parsed.dependencies ?? {}),
        ...(parsed.devDependencies ?? {}),
      });
      if (deps.length) stack = deps.slice(0, 40).join(", ");
    } catch {
      /* ignore */
    }
  }

  const parts = [
    `You are Ali Code, an interactive CLI coding agent working inside a terminal on the user's machine — in the spirit of Claude Code.`,
    ``,
    `# Environment`,
    `- working directory: ${cwd}`,
    `- platform: ${process.platform}`,
    `- date: ${new Date().toISOString().slice(0, 10)}`,
    `- detected dependencies: ${stack}`,
    ``,
    `# How to work`,
    `- Investigate before answering. Use read_file, list_files, glob, search and notebook_read instead of guessing.`,
    `- You MUST read a file with read_file before you edit it.`,
    `- Use edit_file for small, surgical changes. Use multi_edit for several edits to one file. Use write_file for new files or full rewrites.`,
    `- Use glob to locate files by pattern and search for content. Prefer those over listing the whole tree.`,
    `- Use web_fetch and web_search when you need documentation or current information that is not in the repo.`,
    `- For broad, self-contained research, delegate with task and keep your own context small.`,
    `- Match the existing code style, naming and formatting. Do not reformat unrelated code.`,
    `- Make the smallest change that solves the problem. Do not add features nobody asked for.`,
    `- After changing code, run the project's tests or build if one exists (check package.json first).`,
    `- Never invent file paths or APIs. Verify them.`,
    `- Do not create README/docs/example files unless the user asks.`,
    `- Prefer non-interactive shell commands. Long running servers should be avoided.`,
    `- For any task with 3 or more steps, call todo_write first and keep it updated as you go.`,
    `- In plan mode, only read-only tools are available: investigate, then propose a plan.`,
    `- If a command fails, read the error and fix the cause instead of retrying blindly.`,
    ``,
    `# Style`,
    `- Be concise. No preamble, no "certainly", no repeating the user back to them.`,
    `- Never use emojis unless the user asks for them.`,
    `- Explain briefly what you changed and why, then stop.`,
    `- Use markdown only when it helps. The output is rendered in a terminal.`,
  ];

  if (projectRules) {
    parts.push(``, `# Project instructions (from AGENTS.md / CLAUDE.md)`, projectRules);
  }

  return parts.join("\n");
}
