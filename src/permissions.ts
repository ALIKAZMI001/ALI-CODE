import fs from "node:fs";
import path from "node:path";
import type { PermissionMode } from "./config.js";
import { style, diffPreview, codeBlock, toolLabel } from "./ui.js";

export const READ_ONLY_TOOLS = new Set([
  "read_file",
  "list_files",
  "search",
  "glob",
  "notebook_read",
  "web_fetch",
  "web_search",
  "todo_write",
]);

/** Commands we refuse outright, in every mode including yolo. */
const DANGEROUS_COMMANDS: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+[\/~]/i, why: "recursive delete of root/home" },
  { re: /\b(mkfs|fdisk|diskpart)\b/i, why: "filesystem formatting" },
  { re: /\bdd\s+if=.*of=\/dev\//i, why: "raw device write" },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\};:/, why: "fork bomb" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, why: "machine shutdown" },
  {
    re: /Remove-Item\s+.*(-Recurse|-Force).*\b(C:\\|[A-Z]:\\)/i,
    why: "recursive delete of a drive",
  },
  { re: /format\s+[a-z]:/i, why: "drive format" },
];

export interface PermissionRequest {
  name: string;
  summary: string;
  preview: string;
}

/* ------------------------------------------------------------------ *
 * Tool schemas. Descriptions are prompt text: keep them explicit.
 * ------------------------------------------------------------------ */

export const TOOL_DEFS = [
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description:
        "Read a text file from the workspace. Returns line-numbered content. Always read a file before editing it.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, relative to the workspace root." },
          offset: { type: "number", description: "1-based line to start at. Optional." },
          limit: { type: "number", description: "Max lines to return (default 2000)." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description:
        "Create a new file, or completely replace an existing one. Prefer edit_file for changes to existing files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, relative to the workspace root." },
          content: { type: "string", description: "Full file content." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "edit_file",
      description:
        "Replace an exact string in a file. old_string must match the file byte-for-byte and be unique unless replace_all is true. Read the file first.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string", description: "Exact text to find, including indentation." },
          new_string: { type: "string", description: "Replacement text." },
          replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_files",
      description:
        "List file paths in the workspace. Skips node_modules, .git and build output. Use this to orient yourself.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Subdirectory to list. Defaults to the workspace root." },
          depth: { type: "number", description: "Max directory depth (default 3)." },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search",
      description:
        "Search file contents with a regular expression. Returns path:line: text matches. Faster than reading files one by one.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "JavaScript regular expression." },
          path: { type: "string", description: "Directory or file to search. Defaults to workspace root." },
          glob: { type: "string", description: "Only search files whose path contains this substring." },
          case_sensitive: { type: "boolean", description: "Default false." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "run_command",
      description:
        "Run a shell command in the workspace and return its output. Use for builds, tests, git, package managers. Prefer non-interactive commands.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command line to execute." },
          timeout_seconds: { type: "number", description: "Default 120, max 600." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "glob",
      description:
        "Find files by glob pattern (**/*.ts, src/**/*.tsx, *.json). Faster than walking the tree. Use this to locate files before reading them.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern, relative to the workspace." },
          path: { type: "string", description: "Directory to search. Defaults to the workspace root." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "multi_edit",
      description:
        "Apply several exact-string edits to one file in a single call. Each old_string must be unique unless replace_all is true. Read the file first.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                old_string: { type: "string" },
                new_string: { type: "string" },
                replace_all: { type: "boolean" },
              },
              required: ["old_string", "new_string"],
            },
          },
        },
        required: ["path", "edits"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "notebook_read",
      description:
        "Read a Jupyter notebook (.ipynb): cell indexes, types and sources. Use before notebook_edit.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the .ipynb file." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "notebook_edit",
      description:
        "Edit a Jupyter notebook cell. action=replace changes the source, insert adds a new cell before cell_index, delete removes the cell.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          action: { type: "string", enum: ["replace", "insert", "delete"] },
          cell_index: { type: "number", description: "0-based cell index." },
          cell_type: { type: "string", enum: ["code", "markdown"], description: "For insert." },
          source: { type: "string", description: "New cell source (replace/insert)." },
        },
        required: ["path", "action", "cell_index"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "web_fetch",
      description:
        "Fetch a URL over HTTP(S) and return readable text. Use for documentation, issues and changelogs. HTML is converted to plain text.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL." },
          max_chars: { type: "number", description: "Default 20000, max 60000." },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "web_search",
      description:
        "Search the web and return titles, URLs and snippets. Use when you need current information that is not in the repository.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          max_results: { type: "number", description: "Default 6, max 12." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "task",
      description:
        "Delegate a focused, self-contained investigation to a subagent with its own context. Use for broad searches or multi-file research, then continue with its summary.",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "Short 3-5 word label." },
          prompt: { type: "string", description: "Full, self-contained instructions for the subagent." },
        },
        required: ["description", "prompt"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "todo_write",
      description:
        "Maintain a visible task list for multi-step work. Call it when you start a task and after finishing each step. Keep exactly one item in_progress at a time.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "The full list, in order. Replaces the previous list.",
            items: {
              type: "object",
              properties: {
                content: { type: "string", description: "Short imperative description." },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      },
    },
  },
];

/* ------------------------------------------------------------------ *
 * Previews shown before a write/bash is approved.
 * ------------------------------------------------------------------ */

export function previewFor(name: string, input: any, cwd: string): string {
  if (name === "edit_file") {
    const abs = path.resolve(cwd, String(input.path ?? ""));
    let before = "";
    try {
      before = fs.readFileSync(abs, "utf8");
    } catch {
      return style.gray("(file is not readable)");
    }

    const oldText = String(input.old_string ?? "");
    const newText = String(input.new_string ?? "");
    let after = before;
    if (input.replace_all) {
      after = before.split(oldText).join(newText);
    } else {
      const at = before.indexOf(oldText);
      if (at !== -1) {
        after = before.slice(0, at) + newText + before.slice(at + oldText.length);
      }
    }
    return diffPreview(before, after);
  }

  if (name === "multi_edit") {
    const abs = path.resolve(cwd, String(input.path ?? ""));
    let before = "";
    try {
      before = fs.readFileSync(abs, "utf8");
    } catch {
      return style.gray("(file is not readable)");
    }

    let after = before;
    for (const edit of Array.isArray(input.edits) ? input.edits : []) {
      const oldText = String(edit.old_string ?? "");
      const newText = String(edit.new_string ?? "");
      after = edit.replace_all
        ? after.split(oldText).join(newText)
        : after.replace(oldText, newText);
    }
    return diffPreview(before, after);
  }

  if (name === "notebook_edit") {
    const action = String(input.action ?? "replace");
    if (action === "delete") {
      return style.gray(`  delete cell ${input.cell_index}`);
    }
    return (
      style.gray(`  ${action} cell ${input.cell_index}`) +
      "\n" +
      codeBlock(String(input.source ?? ""))
    );
  }

  if (name === "task") {
    return style.gray(String(input.prompt ?? "").slice(0, 800));
  }

  if (name === "write_file") {
    return codeBlock(String(input.content ?? ""));
  }

  if (name === "run_command") {
    return "  " + style.bold(String(input.command ?? ""));
  }

  if (name === "web_fetch") {
    return style.gray(String(input.url ?? ""));
  }

  if (name === "web_search") {
    return style.gray(String(input.query ?? ""));
  }

  return style.gray(JSON.stringify(input).slice(0, 300));
}

/** One-line summary for the tool call header: Bash(npm test), Read(src/ui.ts). */
export function summarizeCall(name: string, input: any): string {
  if (name === "run_command") return String(input.command ?? "").slice(0, 90);
  if (name === "search") return String(input.pattern ?? "");
  if (name === "glob") return String(input.pattern ?? "");
  if (name === "list_files") return String(input.path ?? ".");
  if (name === "web_fetch") return String(input.url ?? "").slice(0, 90);
  if (name === "web_search") return String(input.query ?? "").slice(0, 90);
  if (name === "task") return String(input.description ?? input.prompt ?? "").slice(0, 90);
  if (name === "todo_write") return "";
  return String(input.path ?? "");
}

/** Count additions/removals the way Claude Code reports an edit. */
function diffCounts(oldText: string, newText: string): {
  additions: number;
  removals: number;
} {
  const a = oldText.split(/\r?\n/);
  const b = newText.split(/\r?\n/);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }

  return {
    additions: Math.max(0, endB - start + 1),
    removals: Math.max(0, endA - start + 1),
  };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The Claude Code-style ⎿ line shown after a tool finishes. */
export function resultSummary(
  name: string,
  input: any,
  result: string
): string[] {
  const text = result ?? "";

  if (name === "read_file") {
    const lines = text.length === 0 ? 0 : text.split(/\r?\n/).length;
    return [`Read ${plural(lines, "line")}`];
  }

  if (name === "write_file") {
    const lines = String(input.content ?? "").split(/\r?\n/).length;
    return [`Wrote ${plural(lines, "line")} to ${input.path}`];
  }

  if (name === "edit_file") {
    const { additions, removals } = diffCounts(
      String(input.old_string ?? ""),
      String(input.new_string ?? "")
    );
    return [
      `Updated ${input.path} with ${plural(additions, "addition")} and ${plural(
        removals,
        "removal"
      )}`,
    ];
  }

  if (name === "list_files") {
    const files = text.split(/\r?\n/).filter((line) => line.trim()).length;
    return [`Listed ${plural(files, "file")}`];
  }

  if (name === "search") {
    const matches = text.split(/\r?\n/).filter((line) => line.trim()).length;
    return matches > 0 ? [`Found ${plural(matches, "match")}`] : ["No matches found"];
  }

  if (name === "glob") {
    const files = text.split(/\r?\n/).filter((line) => line.trim()).length;
    return [`Found ${plural(files, "file")}`];
  }

  if (name === "multi_edit") {
    let additions = 0;
    let removals = 0;
    for (const edit of Array.isArray(input.edits) ? input.edits : []) {
      const counts = diffCounts(
        String(edit.old_string ?? ""),
        String(edit.new_string ?? "")
      );
      additions += counts.additions * (edit.replace_all ? 2 : 1);
      removals += counts.removals * (edit.replace_all ? 2 : 1);
    }
    return [
      `Updated ${input.path} with ${plural(additions, "addition")} and ${plural(
        removals,
        "removal"
      )}`,
    ];
  }

  if (name === "notebook_read") {
    const cells = (text.match(/^## \[/gm) ?? []).length;
    return [`Read ${plural(cells, "cell")}`];
  }

  if (name === "notebook_edit") {
    return [text.split(/\r?\n/).find((line) => line.trim()) ?? "Notebook updated"];
  }

  if (name === "web_fetch") {
    return [`Fetched ${text.length.toLocaleString()} characters`];
  }

  if (name === "web_search") {
    const results = (text.match(/^\d+\. /gm) ?? []).length;
    return results > 0 ? [`Found ${plural(results, "result")}`] : ["No results found"];
  }

  if (name === "task") {
    const first = text.split(/\r?\n/).find((line) => line.trim()) ?? "Subagent finished";
    return [first];
  }

  if (name === "run_command") {
    if (text.trim() === "") return ["(no output)"];
    const lines = text.replace(/^\s*\r?\n/, "").replace(/\s+$/, "").split(/\r?\n/);
    const shown = lines.slice(0, 4);
    if (lines.length > shown.length) {
      shown.push(`… +${lines.length - shown.length} lines`);
    }
    return shown;
  }

  const first = text.split(/\r?\n/).find((line) => line.trim()) ?? "";
  return [first];
}

/* ------------------------------------------------------------------ */

export class Permissions {
  private always = new Set<string>();

  constructor(
    private ask: (question: string) => Promise<string | null>,
    public mode: PermissionMode
  ) {}

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  reset(): void {
    this.always.clear();
  }

  autoAllowed(): string[] {
    const list = [...READ_ONLY_TOOLS];
    if (this.mode === "accept-edits") list.push("edit_file", "write_file");
    if (this.mode === "yolo") list.push("edit_file", "write_file", "run_command");
    return list.map((name) => `${name}`);
  }

  async confirm(req: PermissionRequest): Promise<boolean> {
    // The hard deny-list applies even in yolo mode. Only shell commands are
    // checked, so writing a file that merely mentions "shutdown" is not blocked.
    const danger =
      req.name === "run_command"
        ? DANGEROUS_COMMANDS.find((entry) => entry.re.test(req.preview))
        : undefined;
    if (danger) {
      process.stdout.write(
        "\n" +
          style.orange("⏺") +
          " " +
          style.bold(`${toolLabel(req.name)}(${req.summary})`) +
          "\n  " +
          style.red("⎿") +
          "  " +
          style.red(`Blocked: ${danger.why}`) +
          "\n     " +
          style.gray("This command is on the hard deny-list, even in bypass mode.") +
          "\n"
      );
      return false;
    }

    if (this.mode === "yolo") return true;
    if (READ_ONLY_TOOLS.has(req.name)) return true;

    if (this.mode === "plan") {
      process.stdout.write(
        "\n" +
          style.orange("⏺") +
          " " +
          style.bold(`${toolLabel(req.name)}(${req.summary})`) +
          "\n  " +
          style.yellow("⎿") +
          "  " +
          style.yellow("Blocked: plan mode is read-only") +
          "\n     " +
          style.gray("Shift+tab to leave plan mode, or run /permissions default.") +
          "\n"
      );
      return false;
    }

    if (
      this.mode === "accept-edits" &&
      (req.name === "write_file" || req.name === "edit_file")
    ) {
      return true;
    }

    if (this.always.has(req.name)) return true;

    const label = toolLabel(req.name);
    const again = req.summary
      ? `for \`${req.summary.length > 40 ? req.summary.slice(0, 39) + "…" : req.summary}\` commands`
      : `for ${label}`;

    process.stdout.write(
      "\n" +
        style.bold(`${label}(${req.summary})`) +
        "\n\n" +
        (req.preview.trim() ? req.preview + "\n\n" : "") +
        style.bold("Do you want to proceed?") +
        "\n" +
        style.orange("❯ 1. Yes") +
        "\n" +
        `  2. Yes, and don't ask again ${again}\n` +
        "  3. No, and tell Ali what to do differently\n\n"
    );

    for (;;) {
      const raw = await this.ask(
        style.gray("  Enter to confirm · 1 / 2 / 3 · esc to cancel ") + style.bold("› ")
      );
      if (raw === null) return false;
      const answer = raw.trim().toLowerCase();

      if (answer === "" || answer === "1" || answer === "y" || answer === "yes") {
        return true;
      }
      if (answer === "2" || answer === "a" || answer === "always") {
        this.always.add(req.name);
        return true;
      }
      if (answer === "3" || answer === "n" || answer === "no") return false;
      if (answer === "q" || answer === "quit" || answer === "exit") {
        process.stdout.write("\n");
        process.exit(0);
      }
    }
  }
}
