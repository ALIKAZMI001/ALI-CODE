import { packageInfo } from "./paths.js";

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

/** Wipe the visible screen and the scrollback, then home the cursor. */
export function clearScreen(): void {
  if (process.stdout.isTTY) process.stdout.write("\u001b[2J\u001b[3J\u001b[H");
}

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
  const width = boxWidth();
  const pad = margin();
  const inner = width - 4;
  const edge = style.orange("│");

  const boxed = (text = "", center = false): string => {
    const length = visibleLength(text);
    const left = center ? Math.max(0, Math.floor((inner - length) / 2)) : 0;
    const right = Math.max(0, inner - length - left);
    return edge + " " + " ".repeat(left) + text + " ".repeat(right) + " " + edge;
  };

  const title = ` ${style.bold(style.orange("✻ Ali Code"))} ${style.dim("v" + packageInfo().version)} `;
  const topFill = Math.max(0, width - 4 - visibleLength(title));
  const top = style.orange("╭──") + title + style.orange("─".repeat(topFill) + "╮");
  const bottom = style.orange("╰" + "─".repeat(width - 2) + "╯");

  const lines = [
    top,
    boxed(),
    boxed(style.bold("Welcome to Ali Code!"), true),
    boxed(style.gray("your AI coding agent for the terminal"), true),
    boxed(),
    boxed(style.gray("/help for help · /status for your current setup"), true),
    boxed(style.gray(`cwd: ${clip(info.cwd, inner - 6)}`), true),
  ];

  if (info.resumed) {
    lines.push(boxed(style.gray(`resumed session ${info.resumed}`), true));
  }
  lines.push(boxed(), bottom);

  const modeName =
    info.mode === "yolo"
      ? "bypass permissions"
      : info.mode === "plan"
        ? "plan mode"
        : info.mode === "accept-edits"
          ? "accept edits"
          : "default permissions";

  const tip = (n: number, text: string): string =>
    `${pad}  ${style.orange(String(n) + ".")} ${style.gray(text)}\n`;

  write(
    "\n" +
      lines.map((l) => pad + l).join("\n") +
      "\n\n" +
      pad + "  " + style.bold("Tips for getting started") + "\n" +
      tip(1, "Ask Ali to create a new app or clone a repository") +
      tip(2, "Use Ali for file analysis, editing, bash commands and git") +
      tip(3, "Be as specific as you would with another engineer") +
      tip(4, "Run /init to create an AGENTS.md file with instructions for Ali") +
      "\n" +
      pad + "  " + style.orange("※") + " " +
      style.gray(
        `${info.provider} · ${info.model} · ${
          info.keys === 0 ? "no key needed" : `${info.keys} key${info.keys === 1 ? "" : "s"}`
        } · ${modeName}`
      ) +
      "\n\n"
  );
}

/* ------------------------------------------------------------------ *
 * Boxes: one shape for questions, answers and command output
 * ------------------------------------------------------------------ */

/** Left padding that centres the layout in wide terminals. */
export function margin(): string {
  const cols = process.stdout.columns ?? 80;
  return " ".repeat(Math.max(1, Math.floor((cols - boxWidth()) / 2)));
}

export function boxWidth(): number {
  return Math.max(40, Math.min(terminalWidth() - 2, 100));
}

/** Greedy word wrap that keeps blank lines and leading indentation. */
export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  for (const line of lines) {
    if (line === "") {
      out.push("");
      continue;
    }

    const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
    let remaining = line.slice(indent.length);
    if (!remaining) {
      out.push(indent);
      continue;
    }

    let first = true;
    while (remaining.length > 0) {
      const available = Math.max(1, width - (first ? indent.length : 0));
      if (visibleLength(remaining) <= available) {
        out.push((first ? indent : "") + remaining);
        break;
      }

      let cut = remaining.lastIndexOf(" ", available);
      if (cut <= 0) cut = available;
      out.push((first ? indent : "") + remaining.slice(0, cut));
      remaining = remaining.slice(cut).replace(/^ +/, "");
      first = false;
    }
  }

  return out.length > 0 ? out : [""];
}

function padTo(text: string, width: number): string {
  const length = visibleLength(text);
  return length >= width ? text : text + " ".repeat(width - length);
}

function framedLine(text: string, inner: number): string {
  return margin() + style.gray("│") + " " + padTo(text, inner) + " " + style.gray("│");
}

/** ╭─ Title ─────────────────────────────────────────────╮ */
export function topBorder(title = "", width = boxWidth()): string {
  if (!title) return margin() + style.gray("╭" + "─".repeat(width - 2) + "╮");
  const fill = Math.max(0, width - 5 - visibleLength(title));
  return margin() + style.gray("╭─ ") + title + style.gray(" " + "─".repeat(fill) + "╮");
}

/** ╰──────────────────────────────────────── 1.4s ╯ */
export function bottomBorder(note = "", width = boxWidth()): string {
  if (!note) return margin() + style.gray("╰" + "─".repeat(width - 2) + "╯");
  const fill = Math.max(0, width - 4 - visibleLength(note));
  return margin() + style.gray("╰" + "─".repeat(fill) + " ") + style.dim(note) + style.gray(" ╯");
}

/* ------------------------------------------------------------------ *
 * Assistant text — streamed inside its own box
 * ------------------------------------------------------------------ */

let assistantOpen = false;
let assistantStartedAt = 0;
let assistantBoxWidth = 0;
let assistantLine = "";
let assistantPartial = false;
let assistantWroteBody = false;

function assistantTop(): string {
  const stamp = new Date(assistantStartedAt).toTimeString().slice(0, 8);
  return topBorder(
    `${style.orange("✻")} ${style.bold("Ali")} ${style.dim("· " + stamp)}`,
    assistantBoxWidth
  );
}

function clearAssistantPartial(): void {
  if (!assistantPartial) return;
  write("\r\u001b[2K");
  assistantPartial = false;
}

/** Print the in-progress line, padded so the right border always lines up. */
function drawAssistantPartial(): void {
  clearAssistantPartial();
  write(framedLine(assistantLine, assistantBoxWidth - 4));
  assistantPartial = true;
}

/** Finish one wrapped line and move to the next row inside the box. */
function commitAssistantLine(text: string): void {
  clearAssistantPartial();
  write(framedLine(text, assistantBoxWidth - 4) + "\n");
  assistantWroteBody = true;
}

export function assistantStart(): void {
  if (assistantOpen) return;
  assistantOpen = true;
  assistantStartedAt = Date.now();
  assistantBoxWidth = boxWidth();
  assistantLine = "";
  assistantPartial = false;
  assistantWroteBody = false;
  stopThinking();
  write("\n" + assistantTop() + "\n");
}

export function assistantDelta(text: string): void {
  if (!text) return;
  stopThinking();
  assistantStart();

  const inner = assistantBoxWidth - 4;
  for (const ch of text) {
    if (ch === "\n") {
      const done = assistantLine.replace(/[ \t]+$/, "");
      assistantLine = "";
      commitAssistantLine(done);
      continue;
    }

    assistantLine += ch;
    if (visibleLength(assistantLine) <= inner) continue;

    // Overflowed: break at the last space, or hard-break a long word.
    const chars = [...assistantLine];
    let breakAt = -1;
    for (let i = Math.min(chars.length, inner); i > 0; i--) {
      if (/\s/.test(chars[i - 1])) {
        breakAt = i - 1;
        break;
      }
    }

    if (breakAt > 0) {
      const head = chars.slice(0, breakAt).join("");
      assistantLine = chars.slice(breakAt + 1).join("").replace(/^ +/, "");
      commitAssistantLine(head.replace(/[ \t]+$/, ""));
    } else {
      const head = chars.slice(0, inner).join("");
      assistantLine = chars.slice(inner).join("");
      commitAssistantLine(head);
    }
  }

  drawAssistantPartial();
}

export function assistantEnd(): void {
  stopThinking();
  if (!assistantOpen) return;
  assistantOpen = false;

  const tail = assistantLine.replace(/[ \t]+$/, "");
  if (tail.length > 0) {
    assistantLine = "";
    commitAssistantLine(tail);
  } else {
    clearAssistantPartial();
  }

  if (assistantWroteBody) {
    const elapsed = Date.now() - assistantStartedAt;
    const note = elapsed >= 1000 ? `${(elapsed / 1000).toFixed(1)}s` : `${elapsed}ms`;
    write(bottomBorder(note, assistantBoxWidth) + "\n");
  } else {
    // Nothing streamed: remove the title line and the blank line above it.
    write("\r\u001b[2K\u001b[A\r\u001b[2K\u001b[A\r\u001b[2K\n");
  }

  assistantLine = "";
  assistantPartial = false;
  assistantWroteBody = false;
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
      "\r\u001b[2K" + margin() +
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
    case "weather":
      return "Weather";
    case "ask_user":
      return "AskUser";
    case "move_file":
      return "Move";
    case "delete_file":
      return "Delete";
    case "bash_output":
      return "BashOutput";
    case "kill_shell":
      return "KillShell";
    case "task":
      return "Task";
    case "todo_write":
      return "Update Todos";
    default:
      return name;
  }
}

function toolIcon(name: string): string {
  switch (name) {
    case "read_file": case "notebook_read": return "📖";
    case "write_file": return "📝";
    case "edit_file": case "multi_edit": case "notebook_edit": return "✏️ ";
    case "list_files": return "📂";
    case "search": case "glob": return "🔎";
    case "run_command": case "bash_output": case "kill_shell": return "⚡";
    case "web_fetch": case "web_search": return "🌐";
    case "weather": return "🌤️ ";
    case "ask_user": return "❓";
    case "move_file": return "📦";
    case "delete_file": return "🗑️ ";
    case "task": return "🤖";
    case "todo_write": return "✅";
    default: return "🔧";
  }
}

export function toolStart(name: string, summary: string, at?: Date): void {
  stopThinking();
  assistantEnd();

  const label = toolLabel(name);
  const detail =
    name === "todo_write" || !summary ? "" : style.white(`(${summary})`);
  const stamp = at ? style.dim(` · ${at.toTimeString().slice(0, 8)}`) : "";

  write(`\n${margin()}${style.orange("⏺")} ${style.bold(toolIcon(name) + " " + label)}${detail}${stamp}\n`);
}

export function toolEnd(ok: boolean, summary: string | string[]): void {
  const raw = Array.isArray(summary) ? summary : summary.split(/\r?\n/);
  const lines = raw.length > 0 ? raw : [""];
  const tint = ok ? style.gray : style.red;

  write(`${margin()}  ${ok ? style.gray("⎿") : style.red("⎿")}  ${tint(lines[0])}\n`);
  for (const line of lines.slice(1)) {
    write(`${margin()}     ${tint(line)}\n`);
  }
}

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

/** Print a multi-line block inside the centred layout, wrapped to fit. */
export function block(text: string): void {
  assistantEnd();
  write(wrapAnsi(text, boxWidth(), margin()) + "\n");
}

export function info(text: string): void {
  assistantEnd();
  write(margin() + style.gray(text) + "\n");
}

export function warn(text: string): void {
  assistantEnd();
  write(margin() + style.yellow(text) + "\n");
}

export function error(text: string): void {
  assistantEnd();
  write(margin() + style.red(text) + "\n");
}

/* ------------------------------------------------------------------ *
 * Prompt: the input line, and the mode line below it
 * ------------------------------------------------------------------ */

export function promptFor(mode: string): string {
  const arrow = mode === "plan" ? style.blue("> ") : style.bold("> ");
  return margin() + style.gray("│") + " " + arrow;
}

export function promptTop(): void {
  write("\n");
}

export function promptBottom(_mode: string): void {
  // The mode line now lives under the input box while typing.
}

/** Top-edge label of the input box: the model that will answer. */
export function inputTitle(model: string, provider: string): string {
  const room = Math.max(10, boxWidth() - provider.length - 14);
  return (
    style.orange("✻") +
    " " +
    style.bold(clip(model, room)) +
    style.dim(" · " + provider)
  );
}

/** Hint row drawn under the input box. */
export function hintLine(mode: string): string {
  return margin() + "  " + modeStatus(mode);
}

/**
 * The submitted question, framed in a box with the time it was entered:
 *
 *   ╭─ You · 14:32:05 ─────────────────────╮
 *   │ > how does the search work?          │
 *   ╰──────────────────────────────────────╯
 */
export function submittedMessage(text: string, at = new Date()): string {
  const width = boxWidth();
  const inner = width - 4;
  const stamp = at.toTimeString().slice(0, 8);
  const title = `${style.bold("You")} ${style.dim("· " + stamp)}`;
  const body = text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "");

  const rows = wrapText(body, inner - 2).map((line, index) =>
    framedLine((index === 0 ? style.bold("> ") : "  ") + line, inner)
  );

  return [topBorder(title, width), ...rows, bottomBorder("", width)].join("\n");
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
  write("\r\u001b[2K\n" + margin() + "  " + modeStatus(mode) + "\n");
}

/**
 * One-line command palette shown under the input while typing a slash command.
 * Shows as many matches as fit, plus a count of the rest.
 */
export function suggestionLine(names: string[], hint = "tab to complete"): string {
  const max = boxWidth() - 8;
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
    margin() + style.dim("  ↳ ") +
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

/**
 * Wrap each line of (possibly coloured) text to `width` visible columns,
 * indenting continuation rows and re-applying the active colour on each.
 * `prefix` is added to every row (e.g. the centring margin).
 */
export function wrapAnsi(text: string, width: number, prefix = ""): string {
  const SGR = /^\u001b\[[0-9;]*m/;
  const rows: string[] = [];

  for (const line of text.split("\n")) {
    if (line === "") {
      rows.push("");
      continue;
    }
    let row = "";
    let visible = 0;
    let active = "";
    let first = true;
    let spaceAt = -1;
    const hang = "  ";

    for (let i = 0; i < line.length; ) {
      const m = SGR.exec(line.slice(i));
      if (m) {
        row += m[0];
        active = m[0] === `${ESC}0m` ? "" : m[0];
        i += m[0].length;
        continue;
      }
      const ch = String.fromCodePoint(line.codePointAt(i)!);
      const limit = first ? width : width - hang.length;
      if (visible >= limit) {
        let head = row;
        let carry = "";
        const cut = spaceAt > (first ? 0 : hang.length) ? spaceAt : -1;
        if (cut > 0) {
          head = row.slice(0, cut);
          carry = row.slice(cut + 1);
        }
        rows.push(prefix + head + (active ? `${ESC}0m` : ""));
        row = hang + active + carry;
        visible = [...carry.replace(ANSI, "")].length;
        spaceAt = -1;
        first = false;
      }
      if (ch === " ") spaceAt = row.length;
      row += ch;
      visible++;
      i += ch.length;
    }
    rows.push(prefix + row);
  }
  return rows.join("\n");
}

export function previewWidth(): number {
  return boxWidth();
}

export function codeBlock(text: string, maxLines = 24): string {
  const lines = text.split(/\r?\n/);
  const shown = lines.slice(0, maxLines).map((l) => style.green(`+ ${l}`));
  if (lines.length > maxLines) {
    shown.push(style.gray(`  … ${lines.length - maxLines} more lines`));
  }
  return shown.join("\n");
}
