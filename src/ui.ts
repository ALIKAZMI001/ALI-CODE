const ESC = "\u001b[";
const colorEnabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function paint(code: string) {
  return (text: string): string =>
    colorEnabled ? `${ESC}${code}m${text}${ESC}0m` : text;
}

/**
 * Claude Code's palette: orange accent for the ✻ and ⏺ markers, soft greys for
 * chrome, and the classic red/green for diffs.
 */
export const style = {
  dim: paint("2"),
  gray: paint("38;5;245"),
  bold: paint("1"),
  red: paint("38;5;203"),
  green: paint("38;5;114"),
  yellow: paint("38;5;179"),
  blue: paint("38;5;111"),
  magenta: paint("38;5;141"),
  cyan: paint("38;5;81"),
  orange: paint("38;5;208"),
  white: paint("97"),
};

const ANSI = /\u001b\[[0-9;]*m/g;

export function write(text: string): void {
  process.stdout.write(text);
}

function terminalWidth(): number {
  return Math.max(40, Math.min(process.stdout.columns ?? 80, 140));
}

function visibleLength(text: string): number {
  return [...text.replace(ANSI, "")].length;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + "…";
}

/* ------------------------------------------------------------------ *
 * Welcome screen — the rounded box and numbered tips from Claude Code
 * ------------------------------------------------------------------ */

export function banner(info: {
  model: string;
  provider: string;
  cwd: string;
  mode: string;
  keys: number;
  resumed?: string;
}): void {
  const width = Math.max(56, Math.min(terminalWidth() - 2, 96));
  const inner = width - 4;

  const boxed = (text = "", center = false): string => {
    const length = visibleLength(text);
    const left = center ? Math.max(0, Math.floor((inner - length) / 2)) : 0;
    const right = Math.max(0, inner - length - left);
    return (
      style.gray("│") +
      " " +
      " ".repeat(left) +
      text +
      " ".repeat(right) +
      " " +
      style.gray("│")
    );
  };

  const top = style.gray("╭" + "─".repeat(width - 2) + "╮");
  const bottom = style.gray("╰" + "─".repeat(width - 2) + "╯");
  const empty = boxed();

  const lines = [
    " " + top,
    boxed(),
    boxed(style.bold(style.orange("✻ Welcome to Ali Code!")), true),
    boxed(),
    boxed(style.gray("/help for help, /status for your current setup"), true),
    boxed(),
    boxed(style.gray(`cwd: ${clip(info.cwd, inner - 8)}`), true),
    boxed(),
  ];

  if (info.resumed) {
    lines.push(boxed(style.gray(`resumed session ${info.resumed}`), true));
    lines.push(boxed());
  }

  lines.push(" " + bottom);

  const modeName =
    info.mode === "yolo"
      ? "bypass permissions"
      : info.mode === "plan"
        ? "plan mode"
        : info.mode === "accept-edits"
          ? "accept edits"
          : "default permissions";

  write(
    "\n" +
      lines.join("\n") +
      "\n\n" +
      "  Tips for getting started:\n" +
      `  1. Ask Ali to create a new app or clone a repository\n` +
      `  2. Use Ali to help with file analysis, editing, bash commands and git\n` +
      `  3. Be as specific as you would with another engineer for the best results\n` +
      `  4. Run /init to create an AGENTS.md file with instructions for Ali\n` +
      "\n" +
      style.gray(
        `  ※ ${info.provider} · ${info.model} · ${info.keys} key${
          info.keys === 1 ? "" : "s"
        } · ${modeName}`
      ) +
      "\n\n"
  );
}

/* ------------------------------------------------------------------ *
 * Assistant text
 * ------------------------------------------------------------------ */

let assistantOpen = false;

export function assistantStart(): void {
  if (assistantOpen) return;
  assistantOpen = true;
  stopThinking();
  write("\n" + rule() + "\n");
}

export function assistantDelta(text: string): void {
  stopThinking();
  assistantStart();
  write(text);
}

export function assistantEnd(): void {
  stopThinking();
  if (!assistantOpen) return;
  assistantOpen = false;
  write("\n" + rule() + "\n");
}

/* ------------------------------------------------------------------ *
 * Thinking spinner — ✻ Thinking… (4s · esc to interrupt)
 * ------------------------------------------------------------------ */

const SPINNER_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽"];
let spinner: ReturnType<typeof setInterval> | null = null;
let spinnerStarted = 0;
let spinnerFrame = 0;

export function startThinking(label = "Thinking"): void {
  if (!process.stdout.isTTY || spinner) return;
  spinnerStarted = Date.now();
  spinnerFrame = 0;

  const draw = (): void => {
    const seconds = Math.floor((Date.now() - spinnerStarted) / 1000);
    const elapsed = seconds > 0 ? ` (${seconds}s · esc to interrupt)` : " (esc to interrupt)";
    const frame = SPINNER_FRAMES[spinnerFrame++ % SPINNER_FRAMES.length];
    write(
      "\r\u001b[2K" +
        style.orange(frame) +
        " " +
        style.bold(label + "…") +
        style.dim(elapsed)
    );
  };

  draw();
  spinner = setInterval(draw, 120);
}

export function stopThinking(): void {
  if (!spinner) return;
  clearInterval(spinner);
  spinner = null;
  write("\r\u001b[2K");
}

/* ------------------------------------------------------------------ *
 * Tool calls — ⏺ Read(path) / ⎿  Read 156 lines
 * ------------------------------------------------------------------ */

/** Claude Code's tool names, so transcripts read the same. */
export function toolLabel(name: string): string {
  switch (name) {
    case "read_file":
      return "Read";
    case "write_file":
      return "Write";
    case "edit_file":
      return "Update";
    case "list_files":
      return "List";
    case "search":
      return "Grep";
    case "run_command":
      return "Bash";
    case "glob":
      return "Glob";
    case "multi_edit":
      return "MultiEdit";
    case "notebook_read":
      return "NotebookRead";
    case "notebook_edit":
      return "NotebookEdit";
    case "web_fetch":
      return "WebFetch";
    case "web_search":
      return "WebSearch";
    case "task":
      return "Task";
    case "todo_write":
      return "Update Todos";
    default:
      return name;
  }
}

export function toolStart(name: string, summary: string, at?: Date): void {
  stopThinking();
  assistantEnd();

  const label = toolLabel(name);
  const detail =
    name === "todo_write" || !summary ? "" : style.white(`(${summary})`);
  const stamp = at ? style.dim(` · ${at.toTimeString().slice(0, 8)}`) : "";

  write(`\n${style.orange("⏺")} ${style.bold(label)}${detail}${stamp}\n`);
}

export function toolEnd(ok: boolean, summary: string | string[]): void {
  const raw = Array.isArray(summary) ? summary : summary.split(/\r?\n/);
  const lines = raw.length > 0 ? raw : [""];
  const tint = ok ? style.gray : style.red;

  write(`  ${ok ? style.gray("⎿") : style.red("⎿")}  ${tint(lines[0])}\n`);
  for (const line of lines.slice(1)) {
    write(`     ${tint(line)}\n`);
  }
}

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

export function info(text: string): void {
  assistantEnd();
  write(style.gray(text) + "\n");
}

export function warn(text: string): void {
  assistantEnd();
  write(style.yellow(text) + "\n");
}

export function error(text: string): void {
  assistantEnd();
  write(style.red(text) + "\n");
}

/* ------------------------------------------------------------------ *
 * Prompt: a rule above the input, and the mode line below it
 * ------------------------------------------------------------------ */

function rule(): string {
  return style.gray("─".repeat(terminalWidth() - 1));
}

export function promptFor(mode: string): string {
  if (mode === "plan") return style.blue("> ");
  return style.bold("> ");
}

export function promptTop(): void {
  write("\n");
}

export function promptBottom(mode: string): void {
  write("  " + modeStatus(mode) + "\n");
}

/**
 * The submitted question, framed in a box with the time it was entered:
 *
 *   ╭──────────────────────────────────────╮
 *   │ 14:32:05  > explain this repo        │
 *   ╰──────────────────────────────────────╯
 */
export function submittedMessage(text: string, at = new Date()): string {
  const width = Math.max(40, Math.min(terminalWidth() - 1, 120));
  const inner = width - 4;
  const stamp = at.toTimeString().slice(0, 8);
  const prefix = `${stamp}  > `;
  const available = Math.max(1, inner - prefix.length);
  const shown = clip(text.replace(/\r?\n/g, " "), available);
  const visible = prefix + shown;
  const body = style.dim(stamp) + "  " + style.bold("> ") + shown;
  const padding = " ".repeat(Math.max(1, inner - visible.length));

  const top = style.gray("╭" + "─".repeat(width - 2) + "╮");
  const bottom = style.gray("╰" + "─".repeat(width - 2) + "╯");
  const middle = style.gray("│") + " " + body + padding + " " + style.gray("│");

  return top + "\n" + middle + "\n" + bottom;
}

export function modeStatus(mode: string): string {
  if (mode === "accept-edits") {
    return style.green("⏵⏵ accept edits on") + style.dim(" (shift+tab to cycle)");
  }
  if (mode === "plan") {
    return style.blue("⏸ plan mode on") + style.dim(" (shift+tab to cycle)");
  }
  if (mode === "yolo") {
    return style.red("⏵⏵ bypass permissions on") + style.dim(" (shift+tab to cycle)");
  }
  return style.dim("? for shortcuts");
}

/** Print the new mode after shift+tab, above a freshly drawn prompt. */
export function modeFlash(mode: string): void {
  write("\r\u001b[2K\n  " + modeStatus(mode) + "\n");
}

/**
 * One-line command palette shown under the input while typing a slash command.
 * Shows as many matches as fit, plus a count of the rest.
 */
export function suggestionLine(names: string[], hint = "tab to complete"): string {
  const max = terminalWidth() - 8;
  const shown: string[] = [];
  let used = 0;

  for (const name of names) {
    if (shown.length > 0 && used + name.length + 2 > max) break;
    shown.push(name);
    used += name.length + 2;
  }

  const rest = names.length - shown.length;
  const more = rest > 0 ? `  +${rest}` : "";
  return (
    style.dim("  ↳ ") +
    style.gray(shown.join("  ")) +
    style.dim(more) +
    style.dim(shown.length > 0 ? `   ${hint}` : "")
  );
}

/* ------------------------------------------------------------------ *
 * Diffs and code previews
 * ------------------------------------------------------------------ */

/** Cheap line diff: trim common prefix/suffix, then show -/+ around the change. */
export function diffPreview(
  oldText: string,
  newText: string,
  maxLines = 24
): string {
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

  const context = 2;
  const from = Math.max(0, start - context);
  const out: string[] = [];
  for (let i = from; i < start; i++) {
    out.push(style.gray(`  ${String(i + 1).padStart(4)} ${a[i]}`));
  }

  const removed = a.slice(start, endA + 1);
  const added = b.slice(start, endB + 1);

  for (const line of removed.slice(0, maxLines)) {
    out.push(style.red(`- ${line}`));
  }
  if (removed.length > maxLines) {
    out.push(style.gray(`  … ${removed.length - maxLines} more removed lines`));
  }
  for (const line of added.slice(0, maxLines)) {
    out.push(style.green(`+ ${line}`));
  }
  if (added.length > maxLines) {
    out.push(style.gray(`  … ${added.length - maxLines} more added lines`));
  }

  if (out.length === 0) out.push(style.gray("  (no visible change)"));
  return out.join("\n");
}

export function codeBlock(text: string, maxLines = 24): string {
  const lines = text.split(/\r?\n/);
  const shown = lines.slice(0, maxLines).map((l) => style.green(`+ ${l}`));
  if (lines.length > maxLines) {
    shown.push(style.gray(`  … ${lines.length - maxLines} more lines`));
  }
  return shown.join("\n");
}
