import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  ToolError,
  walk,
  resolveInside,
  truncate,
  countOccurrences,
  isBinaryExt,
  formatBytes,
  oneLine,
} from "./util.js";
import type { History } from "./session.js";
import type { TodoList } from "./todos.js";

export interface ToolContext {
  cwd: string;
  /** Files the model has read this session; edit_file refuses otherwise. */
  readFiles: Set<string>;
  history: History;
  todos: TodoList;
  /** Supplied by the Agent so the `task` tool can spawn a subagent. */
  runSubagent?: (prompt: string) => Promise<string>;
  /** Supplied by the CLI so the `ask_user` tool can reach the terminal. */
  askUser?: (question: string, options?: string[]) => Promise<string | null>;
  /** Set for the duration of a run() so a tool can bail out when the user interrupts. */
  signal?: AbortSignal;
}

export const MAX_TOOL_OUTPUT = 30_000;
const MAX_READ_LINES = 2000;
const MAX_SEARCH_MATCHES = 150;

export async function executeTool(
  name: string,
  input: any,
  ctx: ToolContext
): Promise<string> {
  switch (name) {
    case "read_file":
      return readFile(input, ctx);
    case "write_file":
      return writeFile(input, ctx);
    case "edit_file":
      return editFile(input, ctx);
    case "list_files":
      return listFiles(input, ctx);
    case "search":
      return search(input, ctx);
    case "run_command":
      return runCommand(input, ctx);
    case "glob":
      return globFiles(input, ctx);
    case "multi_edit":
      return multiEdit(input, ctx);
    case "notebook_read":
      return notebookRead(input, ctx);
    case "notebook_edit":
      return notebookEdit(input, ctx);
    case "web_fetch":
      return webFetch(input);
    case "web_search":
      return webSearch(input);
    case "weather":
      return weather(input);
    case "ask_user": {
      const question = String(input?.question ?? "").trim();
      if (!question) throw new ToolError("question is required");
      if (!ctx.askUser) throw new ToolError("No interactive user is available.");
      const options = Array.isArray(input?.options)
        ? input.options.map((option: any) => String(option))
        : [];
      const answer = await ctx.askUser(question, options);
      if (answer === null) throw new ToolError("The user cancelled the question.");
      return `The user answered: ${answer.trim() || "(no answer)"}`;
    }
    case "move_file":
      return moveFile(input, ctx);
    case "delete_file":
      return deleteFile(input, ctx);
    case "bash_output":
      return bashOutput(input);
    case "kill_shell":
      return killShell(input);
    case "task": {
      const prompt = String(input?.prompt ?? "").trim();
      if (!prompt) throw new ToolError("prompt is required");
      if (!ctx.runSubagent) throw new ToolError("Subagents are not available in this context.");
      return ctx.runSubagent(prompt);
    }
    case "todo_write":
      return todoWrite(input, ctx);
    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}

function readFile(input: any, ctx: ToolContext): string {
  const rel = String(input.path ?? "");
  if (!rel) throw new ToolError("path is required");
  const abs = resolveInside(ctx.cwd, rel);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new ToolError(`File not found: ${rel}`);
  }
  if (stat.isDirectory()) {
    throw new ToolError(`${rel} is a directory. Use list_files instead.`);
  }
  if (stat.size > 2 * 1024 * 1024) {
    throw new ToolError(`File is too large (${formatBytes(stat.size)}). Read a smaller file or search it.`);
  }

  const text = fs.readFileSync(abs, "utf8");
  const lines = text.split(/\r?\n/);
  const offset = Math.max(1, Math.floor(Number(input.offset) || 1));
  const limit = Math.min(
    Math.max(1, Math.floor(Number(input.limit) || MAX_READ_LINES)),
    MAX_READ_LINES
  );
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const width = String(offset + slice.length - 1).length;
  const body = slice
    .map((line, i) => `${String(offset + i).padStart(width, " ")}  ${line}`)
    .join("\n");

  ctx.readFiles.add(abs);

  const header =
    offset > 1 || slice.length < lines.length
      ? `# ${rel} (lines ${offset}-${offset + slice.length - 1} of ${lines.length})\n`
      : `# ${rel}\n`;
  return truncate(header + body, MAX_TOOL_OUTPUT);
}

function writeFile(input: any, ctx: ToolContext): string {
  const rel = String(input.path ?? "");
  if (!rel) throw new ToolError("path is required");
  const abs = resolveInside(ctx.cwd, rel);
  const content = String(input.content ?? "");

  ctx.history.snapshot(abs);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const existed = fs.existsSync(abs);
  fs.writeFileSync(abs, content, "utf8");
  ctx.readFiles.add(abs);

  const lines = content.split(/\r?\n/).length;
  return `${existed ? "Overwrote" : "Created"} ${rel} (${lines} lines, ${formatBytes(
    Buffer.byteLength(content)
  )}).`;
}

function editFile(input: any, ctx: ToolContext): string {
  const rel = String(input.path ?? "");
  if (!rel) throw new ToolError("path is required");
  const abs = resolveInside(ctx.cwd, rel);

  if (!fs.existsSync(abs)) throw new ToolError(`File not found: ${rel}`);
  if (!ctx.readFiles.has(abs)) {
    throw new ToolError(
      `You must read_file("${rel}") before editing it, so the edit matches the real content.`
    );
  }

  const before = fs.readFileSync(abs, "utf8");
  const oldString = String(input.old_string ?? "");
  const newString = String(input.new_string ?? "");
  if (!oldString) throw new ToolError("old_string must not be empty. Use write_file to replace the whole file.");

  const occurrences = countOccurrences(before, oldString);
  if (occurrences === 0) {
    throw new ToolError(
      `old_string was not found in ${rel}. Re-read the file and copy the exact text, including indentation.`
    );
  }
  if (occurrences > 1 && !input.replace_all) {
    const lines = before
      .split(/\r?\n/)
      .map((line, i) => (line.includes(oldString.split(/\r?\n/)[0]) ? i + 1 : 0))
      .filter((n) => n > 0)
      .slice(0, 5)
      .join(", ");
    throw new ToolError(
      `old_string appears ${occurrences} times in ${rel} (near lines ${lines}). Add more surrounding context to make it unique, or set replace_all: true.`
    );
  }

  let after: string;
  if (input.replace_all) {
    after = before.split(oldString).join(newString);
  } else {
    const at = before.indexOf(oldString);
    after = before.slice(0, at) + newString + before.slice(at + oldString.length);
  }

  ctx.history.snapshot(abs);
  fs.writeFileSync(abs, after, "utf8");
  const replaced = input.replace_all ? occurrences : 1;
  return `Edited ${rel}: replaced ${replaced} occurrence${replaced === 1 ? "" : "s"}.`;
}

function listFiles(input: any, ctx: ToolContext): string {
  const rel = String(input.path ?? ".");
  const abs = resolveInside(ctx.cwd, rel);
  if (!fs.existsSync(abs)) throw new ToolError(`Directory not found: ${rel}`);
  if (!fs.statSync(abs).isDirectory()) throw new ToolError(`${rel} is a file. Use read_file.`);

  const maxDepth = Math.min(Math.max(1, Math.floor(Number(input.depth) || 3)), 8);
  const maxEntries = 400;
  const results: string[] = [];

  for (const file of walk(abs, 0, maxDepth)) {
    const relative = path.relative(ctx.cwd, file).split(path.sep).join("/");
    results.push(relative);
    if (results.length >= maxEntries) break;
  }

  if (results.length === 0) return `No files found under ${rel}.`;
  const suffix = results.length >= maxEntries ? `\n… capped at ${maxEntries} files` : "";
  return `# ${results.length} files under ${rel}\n${results.join("\n")}${suffix}`;
}

function search(input: any, ctx: ToolContext): string {
  const pattern = String(input.pattern ?? "");
  if (!pattern) throw new ToolError("pattern is required");

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, input.case_sensitive ? "" : "i");
  } catch {
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), input.case_sensitive ? "" : "i");
  }

  const rel = String(input.path ?? ".");
  const abs = resolveInside(ctx.cwd, rel);
  if (!fs.existsSync(abs)) throw new ToolError(`Path not found: ${rel}`);

  const glob = input.glob ? String(input.glob) : null;
  const files: string[] = fs.statSync(abs).isDirectory() ? [...walk(abs, 0, 10)] : [abs];

  const out: string[] = [];
  let matches = 0;
  let scanned = 0;

  for (const file of files) {
    const relative = path.relative(ctx.cwd, file).split(path.sep).join("/");
    if (glob && !relative.includes(glob)) continue;
    if (isBinaryExt(file)) continue;

    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue;
    }
    if (size > 1024 * 1024) continue;

    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    scanned++;

    const lines = text.split(/\r?\n/);
    let perFile = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!regex.test(lines[i])) continue;
      out.push(`${relative}:${i + 1}: ${oneLine(lines[i], 200)}`);
      matches++;
      perFile++;
      if (matches >= MAX_SEARCH_MATCHES || perFile >= 20) break;
    }
    if (matches >= MAX_SEARCH_MATCHES) break;
  }

  if (out.length === 0) {
    return `No matches for /${pattern}/ in ${scanned} file${scanned === 1 ? "" : "s"}.`;
  }
  const suffix = matches >= MAX_SEARCH_MATCHES ? `\n… capped at ${MAX_SEARCH_MATCHES} matches` : "";
  return truncate(
    `# ${matches} match${matches === 1 ? "" : "es"} in ${scanned} file${scanned === 1 ? "" : "s"}\n${out.join("\n")}${suffix}`,
    MAX_TOOL_OUTPUT
  );
}

function todoWrite(input: any, ctx: ToolContext): string {
  const raw = input?.todos;
  if (!Array.isArray(raw)) throw new ToolError("todos must be an array");

  ctx.todos.set(raw);
  const total = ctx.todos.items.length;
  const done = ctx.todos.done;
  if (total === 0) return "Todo list cleared.";

  const inProgress = ctx.todos.items.filter((item) => item.status === "in_progress");
  return [
    `Todo list updated: ${done}/${total} done.`,
    ctx.todos.items
      .map((item) => `- [${item.status === "completed" ? "x" : " "}] ${item.content}`)
      .join("\n"),
    inProgress.length === 0
      ? "Mark the next item in_progress before starting it."
      : `Now working on: ${inProgress.map((item) => item.content).join(", ")}`,
  ].join("\n");
}

function runCommand(input: any, ctx: ToolContext): Promise<string> {
  const command = String(input.command ?? "").trim();
  if (!command) throw new ToolError("command is required");

  const timeoutMs =
    Math.min(Math.max(Number(input.timeout_seconds) || 120, 1), 600) * 1000;

  if (input.background) return Promise.resolve(startBackground(command, ctx));

  const isWindows = process.platform === "win32";
  const file = isWindows ? "powershell.exe" : "bash";
  const args = isWindows
    ? ["-NoProfile", "-NonInteractive", "-Command", command]
    : ["-lc", command];

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(file, args, {
      cwd: ctx.cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const kill = (): void => {
      try {
        if (isWindows && child.pid) {
          spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
            windowsHide: true,
          });
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        /* ignore */
      }
    };

    const finish = (note: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
      const body = [
        note,
        stdout.trim() ? `stdout:\n${stdout.trim()}` : "",
        stderr.trim() ? `stderr:\n${stderr.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      resolve(truncate(body || `${note}\n(no output)`, MAX_TOOL_OUTPUT));
    };

    const timer = setTimeout(() => {
      kill();
      finish(`timed out after ${timeoutMs / 1000}s and was killed`);
    }, timeoutMs);

    const onAbort = (): void => {
      kill();
      finish("interrupted by user and was killed");
    };
    if (ctx.signal?.aborted) onAbort();
    else ctx.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_TOOL_OUTPUT * 2) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_TOOL_OUTPUT * 2) stderr += chunk.toString();
    });
    child.on("error", (err) => finish(`failed to start: ${err.message}`));
    child.on("close", (code) => finish(`exit code: ${code ?? "null"}`));
  });
}

/* ------------------------------------------------------------------ *
 * Background shells
 * ------------------------------------------------------------------ */

interface BackgroundShell {
  id: string;
  command: string;
  child: ReturnType<typeof spawn>;
  stdout: string;
  stderr: string;
  startedAt: number;
  done: boolean;
  code: number | null;
}

const backgroundShells = new Map<string, BackgroundShell>();
let shellCounter = 0;

function shellInvocation(command: string): { file: string; args: string[] } {
  return process.platform === "win32"
    ? { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command] }
    : { file: "bash", args: ["-lc", command] };
}

function startBackground(command: string, ctx: ToolContext): string {
  const { file, args } = shellInvocation(command);
  const id = `shell-${++shellCounter}`;
  const child = spawn(file, args, {
    cwd: ctx.cwd,
    env: process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const entry: BackgroundShell = {
    id,
    command,
    child,
    stdout: "",
    stderr: "",
    startedAt: Date.now(),
    done: false,
    code: null,
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    if (entry.stdout.length < MAX_TOOL_OUTPUT * 2) entry.stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (entry.stderr.length < MAX_TOOL_OUTPUT * 2) entry.stderr += chunk.toString();
  });
  child.on("error", (err) => {
    entry.stderr += `failed to start: ${err.message}\n`;
    entry.done = true;
  });
  child.on("close", (code) => {
    entry.done = true;
    entry.code = code;
  });

  backgroundShells.set(id, entry);
  return [
    `Started ${id} in the background: ${command}`,
    `Use bash_output("${id}") to read output and kill_shell("${id}") to stop it.`,
  ].join("\n");
}

function lookupShell(input: any): BackgroundShell {
  const id = String(input?.shell_id ?? "").trim();
  if (!id) throw new ToolError("shell_id is required");
  const entry = backgroundShells.get(id);
  if (!entry) {
    const known = [...backgroundShells.keys()].join(", ") || "(none)";
    throw new ToolError(`Unknown shell "${id}". Known shells: ${known}.`);
  }
  return entry;
}

function bashOutput(input: any): string {
  const entry = lookupShell(input);
  const elapsed = Math.round((Date.now() - entry.startedAt) / 1000);
  const status = entry.done
    ? `exited with code ${entry.code ?? "null"}`
    : `still running (${elapsed}s)`;
  const out = entry.stdout.trim();
  const err = entry.stderr.trim();

  return truncate(
    [
      `# ${entry.id}: ${entry.command}`,
      status,
      out ? `stdout:\n${out}` : "",
      err ? `stderr:\n${err}` : "",
    ]
      .filter(Boolean)
      .join("\n") || status,
    MAX_TOOL_OUTPUT
  );
}

function killShell(input: any): string {
  const entry = lookupShell(input);
  if (entry.done) return `${entry.id} already exited with code ${entry.code ?? "null"}.`;

  try {
    if (process.platform === "win32" && entry.child.pid) {
      spawn("taskkill", ["/pid", String(entry.child.pid), "/t", "/f"], { windowsHide: true });
    } else {
      entry.child.kill("SIGTERM");
    }
  } catch (err: any) {
    throw new ToolError(`Could not stop ${entry.id}: ${err?.message ?? String(err)}`);
  }

  return `Stopped ${entry.id}.`;
}

/* ------------------------------------------------------------------ *
 * File moves and deletes
 * ------------------------------------------------------------------ */

function moveFile(input: any, ctx: ToolContext): string {
  const from = String(input?.from ?? "").trim();
  const to = String(input?.to ?? "").trim();
  if (!from || !to) throw new ToolError("from and to are required");

  const source = resolveInside(ctx.cwd, from);
  const target = resolveInside(ctx.cwd, to);

  if (!fs.existsSync(source)) throw new ToolError(`File not found: ${from}`);
  if (fs.statSync(source).isDirectory()) {
    throw new ToolError("move_file only moves files. Use run_command for directories.");
  }
  if (source === target) return `${from} is already at ${to}.`;

  if (fs.existsSync(target)) {
    if (!input?.overwrite) {
      throw new ToolError(`${to} already exists. Set overwrite: true to replace it.`);
    }
    if (fs.statSync(target).isDirectory()) throw new ToolError(`${to} is a directory.`);
    ctx.history.snapshot(target);
    fs.rmSync(target, { force: true });
  }

  ctx.history.snapshot(source);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(source, target);
  ctx.readFiles.delete(source);
  return `Moved ${from} → ${to}.`;
}

function deleteFile(input: any, ctx: ToolContext): string {
  const rel = String(input?.path ?? "").trim();
  if (!rel) throw new ToolError("path is required");

  const abs = resolveInside(ctx.cwd, rel);
  if (!fs.existsSync(abs)) throw new ToolError(`File not found: ${rel}`);

  if (fs.statSync(abs).isDirectory()) {
    if (!input?.recursive) {
      throw new ToolError(`${rel} is a directory. Set recursive: true to delete it.`);
    }
    fs.rmSync(abs, { recursive: true, force: true });
    return `Deleted directory ${rel}.`;
  }

  ctx.history.snapshot(abs);
  fs.unlinkSync(abs);
  ctx.readFiles.delete(abs);
  return `Deleted ${rel}.`;
}

/* ------------------------------------------------------------------ *
 * Weather (Open-Meteo, no API key)
 * ------------------------------------------------------------------ */

const WEATHER_CODES: Record<number, string> = {
  0: "clear",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "freezing fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  56: "freezing drizzle",
  57: "heavy freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "freezing rain",
  67: "heavy freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light rain showers",
  81: "rain showers",
  82: "violent rain showers",
  85: "snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with hail",
  99: "thunderstorm with heavy hail",
};

function describeWeather(code: number): string {
  return WEATHER_CODES[code] ?? "unknown conditions";
}

async function weather(input: any): Promise<string> {
  const location = String(input?.location ?? "").trim();
  if (!location) throw new ToolError("location is required");

  const days = Math.min(Math.max(Math.floor(Number(input?.days) || 3), 1), 7);
  const imperial = String(input?.units ?? "metric").toLowerCase() === "imperial";

  let place: any;
  try {
    const response = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
        location
      )}&count=1&language=en&format=json`,
      { signal: AbortSignal.timeout(20_000) }
    );
    if (!response.ok) throw new Error(`geocoding HTTP ${response.status}`);
    const data: any = await response.json();
    place = data?.results?.[0];
  } catch (err: any) {
    throw new ToolError(`Could not look up ${location}: ${err?.message ?? String(err)}`);
  }

  if (!place) {
    throw new ToolError(`No place found for "${location}". Try "City, Country".`);
  }

  const params = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current:
      "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m",
    daily:
      "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max",
    timezone: "auto",
    forecast_days: String(days),
  });
  if (imperial) {
    params.set("temperature_unit", "fahrenheit");
    params.set("wind_speed_unit", "mph");
    params.set("precipitation_unit", "inch");
  }

  let data: any;
  try {
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`forecast HTTP ${response.status}`);
    data = await response.json();
  } catch (err: any) {
    throw new ToolError(`Could not fetch weather for ${location}: ${err?.message ?? String(err)}`);
  }

  const unit = imperial ? "°F" : "°C";
  const speed = imperial ? "mph" : "km/h";
  const rain = imperial ? "in" : "mm";
  const round = (value: any): string => {
    const number = Number(value);
    return Number.isFinite(number) ? String(Math.round(number)) : "?";
  };

  const current = data?.current ?? {};
  const daily = data?.daily ?? {};
  const placeName = [place.name, place.admin1, place.country].filter(Boolean).join(", ");
  const days_out = Array.isArray(daily.time) ? daily.time : [];

  return [
    `# Weather for ${placeName}`,
    `Now: ${round(current.temperature_2m)}${unit} (feels ${round(
      current.apparent_temperature
    )}${unit}), ${describeWeather(Number(current.weather_code))} · humidity ${round(
      current.relative_humidity_2m
    )}% · wind ${round(current.wind_speed_10m)} ${speed} · rain ${round(
      current.precipitation
    )} ${rain}`,
    `Local time: ${current.time ?? "now"}`,
    "",
    "Forecast:",
    ...days_out.map(
      (day: string, index: number) =>
        `- ${day}: ${round(daily.temperature_2m_min?.[index])}–${round(
          daily.temperature_2m_max?.[index]
        )}${unit}, ${describeWeather(Number(daily.weather_code?.[index]))}, ${round(
          daily.precipitation_probability_max?.[index]
        )}% rain, wind ${round(daily.wind_speed_10m_max?.[index])} ${speed}`
    ),
  ].join("\n");
}

/* ------------------------------------------------------------------ *
 * Extra tools: glob, multi_edit, notebooks, web, subagents
 * ------------------------------------------------------------------ */

function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("\\^$+.()|{}[]".includes(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return new RegExp(out + "$", "i");
}

function globFiles(input: any, ctx: ToolContext): string {
  const pattern = String(input?.pattern ?? "").trim();
  if (!pattern) throw new ToolError("pattern is required");

  const rel = String(input?.path ?? ".");
  const base = resolveInside(ctx.cwd, rel);
  if (!fs.existsSync(base)) throw new ToolError(`Path not found: ${rel}`);

  const matcher = globToRegExp(pattern);
  const wantPath = pattern.includes("/");
  const results: string[] = [];

  const files = fs.statSync(base).isDirectory() ? [...walk(base, 0, 12)] : [base];
  for (const file of files) {
    const relative = path.relative(ctx.cwd, file).split(path.sep).join("/");
    const candidate = wantPath ? relative : path.basename(file);
    if (!matcher.test(candidate)) continue;
    results.push(relative);
    if (results.length >= 500) break;
  }

  if (results.length === 0) return `No files matched ${pattern} under ${rel}.`;
  const suffix = results.length >= 500 ? "\n… capped at 500 files" : "";
  return `${results.length} file${results.length === 1 ? "" : "s"} matched ${pattern}:\n${results.join(
    "\n"
  )}${suffix}`;
}

function requireRead(rel: string, abs: string, ctx: ToolContext): void {
  if (!ctx.readFiles.has(abs)) {
    throw new ToolError(
      `You must read_file("${rel}") before editing it, so the edit matches the real content.`
    );
  }
}

function multiEdit(input: any, ctx: ToolContext): string {
  const rel = String(input?.path ?? "");
  if (!rel) throw new ToolError("path is required");
  const abs = resolveInside(ctx.cwd, rel);
  if (!fs.existsSync(abs)) throw new ToolError(`File not found: ${rel}`);
  requireRead(rel, abs, ctx);

  const edits = input?.edits;
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new ToolError("edits must be a non-empty array");
  }

  let text = fs.readFileSync(abs, "utf8");
  let replacements = 0;

  edits.forEach((edit: any, index: number) => {
    const oldString = String(edit?.old_string ?? "");
    const newString = String(edit?.new_string ?? "");
    if (!oldString) {
      throw new ToolError(`Edit ${index + 1}: old_string must not be empty.`);
    }

    const occurrences = countOccurrences(text, oldString);
    if (occurrences === 0) {
      throw new ToolError(
        `Edit ${index + 1}: old_string was not found in ${rel}. Re-read the file and copy it exactly.`
      );
    }
    if (occurrences > 1 && !edit.replace_all) {
      throw new ToolError(
        `Edit ${index + 1}: old_string appears ${occurrences} times in ${rel}. Add context or set replace_all.`
      );
    }

    if (edit.replace_all) {
      text = text.split(oldString).join(newString);
      replacements += occurrences;
    } else {
      const at = text.indexOf(oldString);
      text = text.slice(0, at) + newString + text.slice(at + oldString.length);
      replacements += 1;
    }
  });

  ctx.history.snapshot(abs);
  fs.writeFileSync(abs, text, "utf8");
  return `Applied ${edits.length} edit${edits.length === 1 ? "" : "s"} to ${rel} (${replacements} replacement${
    replacements === 1 ? "" : "s"
  }).`;
}

function notebookRead(input: any, ctx: ToolContext): string {
  const rel = String(input?.path ?? "");
  if (!rel) throw new ToolError("path is required");
  const abs = resolveInside(ctx.cwd, rel);
  if (!fs.existsSync(abs)) throw new ToolError(`File not found: ${rel}`);

  let notebook: any;
  try {
    notebook = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch {
    throw new ToolError(`${rel} is not valid notebook JSON.`);
  }
  if (!Array.isArray(notebook.cells)) throw new ToolError(`${rel} has no cells array.`);

  ctx.readFiles.add(abs);
  const parts = notebook.cells.map((cell: any, index: number) => {
    const source = Array.isArray(cell.source) ? cell.source.join("") : String(cell.source ?? "");
    return `## [${index}] ${cell.cell_type ?? "code"}\n${truncate(source, 2000)}`;
  });
  return truncate(
    `# ${rel} (${notebook.cells.length} cells)\n\n${parts.join("\n\n")}`,
    MAX_TOOL_OUTPUT
  );
}

function notebookEdit(input: any, ctx: ToolContext): string {
  const rel = String(input?.path ?? "");
  if (!rel) throw new ToolError("path is required");
  const abs = resolveInside(ctx.cwd, rel);
  if (!fs.existsSync(abs)) throw new ToolError(`File not found: ${rel}`);
  requireRead(rel, abs, ctx);

  let notebook: any;
  try {
    notebook = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch {
    throw new ToolError(`${rel} is not valid notebook JSON.`);
  }
  if (!Array.isArray(notebook.cells)) throw new ToolError(`${rel} has no cells array.`);

  const index = Math.floor(Number(input?.cell_index));
  if (!Number.isFinite(index) || index < 0) {
    throw new ToolError("cell_index must be a zero-based integer");
  }
  const action = String(input?.action ?? "replace");
  const source = String(input?.source ?? "");
  const type = input?.cell_type === "markdown" ? "markdown" : "code";

  if (action === "replace") {
    if (!notebook.cells[index]) throw new ToolError(`No cell at index ${index}.`);
    notebook.cells[index].source = source;
  } else if (action === "insert") {
    if (index > notebook.cells.length) throw new ToolError(`Cannot insert at ${index}.`);
    const cell: any = {
      cell_type: type,
      metadata: {},
      source,
    };
    if (type === "code") {
      cell.execution_count = null;
      cell.outputs = [];
    }
    notebook.cells.splice(index, 0, cell);
  } else if (action === "delete") {
    if (!notebook.cells[index]) throw new ToolError(`No cell at index ${index}.`);
    notebook.cells.splice(index, 1);
  } else {
    throw new ToolError(`Unknown action "${action}". Use replace, insert or delete.`);
  }

  ctx.history.snapshot(abs);
  fs.writeFileSync(abs, JSON.stringify(notebook, null, 1) + "\n", "utf8");
  return `Notebook ${rel}: ${action} cell ${index}.`;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|pre|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function webFetch(input: any): Promise<string> {
  const url = String(input?.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) throw new ToolError("url must start with http:// or https://");
  const maxChars = Math.min(
    Math.max(Number(input?.max_chars) || 20_000, 1_000),
    60_000
  );

  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; AliCode/1.0; +https://github.com/local/ali-code)",
        Accept: "text/html,application/xhtml+xml,text/plain,application/json",
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err: any) {
    throw new ToolError(`Could not fetch ${url}: ${err?.message ?? String(err)}`);
  }

  const raw = await response.text();
  const type = response.headers.get("content-type") ?? "";
  const text =
    type.includes("html") || raw.trimStart().startsWith("<") ? stripHtml(raw) : raw;
  return truncate(`# ${url} (HTTP ${response.status})\n\n${text || "(empty response)"}`, maxChars);
}

function decodeDuckUrl(href: string): string {
  const match = /[?&]uddg=([^&]+)/.exec(href);
  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return href;
    }
  }
  return href.startsWith("//") ? "https:" + href : href;
}

async function webSearch(input: any): Promise<string> {
  const query = String(input?.query ?? "").trim();
  if (!query) throw new ToolError("query is required");
  const max = Math.min(Math.max(Number(input?.max_results) || 6, 1), 12);

  let html: string;
  try {
    const response = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
        },
        signal: AbortSignal.timeout(30_000),
      }
    );
    if (!response.ok) throw new ToolError(`search returned HTTP ${response.status}`);
    html = await response.text();
  } catch (err: any) {
    if (err instanceof ToolError) throw err;
    throw new ToolError(`Search failed: ${err?.message ?? String(err)}`);
  }

  const links: Array<{ title: string; url: string }> = [];
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(html)) !== null && links.length < max) {
    links.push({ url: decodeDuckUrl(match[1]), title: stripHtml(match[2]) });
  }

  const snippets: string[] = [];
  const snippetRe =
    /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = snippetRe.exec(html)) !== null && snippets.length < links.length) {
    snippets.push(stripHtml(match[1]));
  }

  if (links.length === 0) return `No search results for "${query}".`;
  return links
    .map(
      (link, index) =>
        `${index + 1}. ${link.title}\n   ${link.url}${
          snippets[index] ? `\n   ${oneLine(snippets[index], 300)}` : ""
        }`
    )
    .join("\n\n");
}
