import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  PROVIDERS,
  PERMISSION_MODES,
  collectKeys,
  loadEnvFiles,
  resolveConfig,
  type ProviderName,
} from "./config.js";
import { configRoot, packageInfo, packageRoot, userEnvFile } from "./paths.js";
import { style } from "./ui.js";

/**
 * Non-interactive subcommands: `ali config`, `ali doctor`, `ali update`.
 * `runAdmin` returns an exit code when argv was one of them, or null so the
 * normal interactive/one-shot flow continues.
 */

const out = (text = ""): void => void process.stdout.write(text + "\n");
const ok = (text: string): void => out(`  ${style.green("✓")} ${text}`);
const warn = (text: string): void => out(`  ${style.yellow("!")} ${text}`);
const bad = (text: string): void => out(`  ${style.red("✗")} ${text}`);

export function maskSecret(value: string): string {
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 4)}…${value.slice(-3)}`;
}

/* ------------------------------------------------------------------ *
 * ali config
 * ------------------------------------------------------------------ */

/** Friendly names accepted by `ali config set`. */
const CONFIG_ALIASES: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEYS",
  groq: "GROQ_API_KEYS",
  openai: "OPENAI_API_KEYS",
  provider: "ALI_PROVIDER",
  model: "ALI_MODEL",
  fallback: "ALI_FALLBACK_PROVIDERS",
  "fallback-model": "ALI_FALLBACK_MODEL",
  "permission-mode": "ALI_PERMISSION_MODE",
  "base-url": "ALI_BASE_URL",
};

const SECRET_NAME = /KEY|TOKEN|SECRET/i;

function resolveName(raw: string): string | null {
  const lower = raw.trim().toLowerCase();
  if (CONFIG_ALIASES[lower]) return CONFIG_ALIASES[lower];
  const upper = raw.trim().toUpperCase();
  if (/^ALI_[A-Z0-9_]+$/.test(upper) || /^(OPENROUTER|GROQ|OPENAI)_API_KEYS?$/.test(upper)) {
    return upper;
  }
  return null;
}

function readEnvLines(file: string): string[] {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
}

function writeEnvLines(file: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = lines.join("\n").replace(/\n+$/, "") + "\n";
  fs.writeFileSync(file, text, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600); // no-op on Windows; keeps keys private on macOS/Linux
  } catch {
    /* best effort */
  }
}

function lineName(line: string): string | null {
  const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  return m ? m[1] : null;
}

function readUserEntries(): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const line of readEnvLines(userEnvFile())) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) entries.push([m[1], m[2].trim().replace(/^(['"])(.*)\1$/, "$2")]);
  }
  return entries;
}

function validateConfigValue(name: string, value: string): string | null {
  if (/[\r\n]/.test(value)) return "value must be a single line";
  if (name === "ALI_PROVIDER" && !(value.toLowerCase() in PROVIDERS)) {
    return `unknown provider "${value}". Use: ${Object.keys(PROVIDERS).join(", ")}`;
  }
  if (name === "ALI_PERMISSION_MODE" && !PERMISSION_MODES.includes(value as never)) {
    return `unknown mode "${value}". Use: ${PERMISSION_MODES.join(", ")}`;
  }
  return null;
}

/**
 * Write one user-level setting. Used by `ali config set` and by the first-run
 * setup prompt. Returns the settings file, or null for an unknown name.
 */
export function saveUserSetting(rawName: string, rawValue: string): string | null {
  const name = resolveName(rawName);
  if (!name) return null;

  let value = rawValue.trim();
  if (!value) return null;
  if (/_API_KEYS?$/.test(name)) {
    value = value.split(/[,\s;]+/).filter(Boolean).join(",");
  }
  if (validateConfigValue(name, value)) return null;

  const file = userEnvFile();
  const lines = readEnvLines(file);
  const index = lines.findIndex((line) => lineName(line) === name);
  const entry = `${name}=${value}`;
  if (index >= 0) lines[index] = entry;
  else lines.push(entry);
  writeEnvLines(file, lines);
  return file;
}

function configHelp(): void {
  out(`${style.bold("ali config")} — manage your user-level settings

  ali config                        show current settings (keys are masked)
  ali config path                   print the settings file location
  ali config set <name> <value>     save a setting
  ali config unset <name>           remove a setting

${style.bold("Names")}
  openrouter | groq | openai        optional API keys (comma-separated pool)
  provider                          free | community | openrouter | groq | openai
  model                             default model id
  fallback                          fallback providers, e.g. groq
  permission-mode                   ${PERMISSION_MODES.join(" | ")}
  …or any ALI_* / *_API_KEYS environment variable name

${style.bold("Examples")}
  ali config set openrouter sk-or-xxxx,sk-or-yyyy
  ali config set groq gsk_xxxx
  ali config set model cohere/north-mini-code:free

No key is required: Ali Code uses a shared, rate-limited model out of the
box, with a fully free fallback if that is ever busy. A key is optional and
gives you better or faster models with no shared limits.

Settings are stored in ${userEnvFile()}
A .env in a project folder, or a real environment variable, takes precedence.`);
}

function runConfig(args: string[]): number {
  const [sub, ...rest] = args;

  if (!sub || sub === "show" || sub === "list") {
    out(style.bold("Ali Code settings"));
    out(style.gray(`  file  ${userEnvFile()}${fs.existsSync(userEnvFile()) ? "" : "  (not created yet)"}`));
    const entries = readUserEntries();
    if (entries.length === 0) {
      out(style.gray("  (no saved settings)  — try: ali config set openrouter <key>"));
    }
    for (const [name, value] of entries) {
      const shown = SECRET_NAME.test(name)
        ? value
            .split(/[,\s;]+/)
            .filter(Boolean)
            .map(maskSecret)
            .join(", ")
        : value;
      out(`  ${name.padEnd(24)} ${shown}`);
    }
    return 0;
  }

  if (sub === "path") {
    out(userEnvFile());
    return 0;
  }

  if (sub === "help" || sub === "-h" || sub === "--help") {
    configHelp();
    return 0;
  }

  if (sub === "set") {
    const [rawName, ...valueParts] = rest;
    const name = rawName ? resolveName(rawName) : null;
    if (!name) {
      out(style.red(`Unknown setting "${rawName ?? ""}".`) + " Run: ali config help");
      return 1;
    }
    let value = valueParts.join(" ").trim();
    if (!value) {
      out(style.red("Missing value.") + ` Usage: ali config set ${rawName} <value>`);
      return 1;
    }
    if (/_API_KEYS?$/.test(name)) value = value.split(/[,\s;]+/).filter(Boolean).join(",");
    const problem = validateConfigValue(name, value);
    if (problem) {
      out(style.red(problem));
      return 1;
    }

    const file = userEnvFile();
    const lines = readEnvLines(file);
    const index = lines.findIndex((line) => lineName(line) === name);
    const entry = `${name}=${value}`;
    if (index >= 0) lines[index] = entry;
    else lines.push(entry);
    writeEnvLines(file, lines);

    const shown = SECRET_NAME.test(name)
      ? value.split(",").map(maskSecret).join(", ")
      : value;
    out(`${style.green("✓")} saved ${style.bold(name)} = ${shown}`);
    out(style.gray(`  ${file}`));
    return 0;
  }

  if (sub === "unset" || sub === "remove" || sub === "rm") {
    const name = rest[0] ? resolveName(rest[0]) : null;
    if (!name) {
      out(style.red(`Unknown setting "${rest[0] ?? ""}".`) + " Run: ali config help");
      return 1;
    }
    const file = userEnvFile();
    const lines = readEnvLines(file);
    const kept = lines.filter((line) => lineName(line) !== name);
    if (kept.length === lines.length) {
      out(style.yellow(`${name} was not set.`));
      return 0;
    }
    writeEnvLines(file, kept);
    out(`${style.green("✓")} removed ${style.bold(name)}`);
    return 0;
  }

  out(style.red(`Unknown config command "${sub}".`));
  configHelp();
  return 1;
}

/* ------------------------------------------------------------------ *
 * ali doctor
 * ------------------------------------------------------------------ */

function canRun(file: string, args: string[]): boolean {
  try {
    const result = spawnSync(file, args, { stdio: "ignore", timeout: 10_000, windowsHide: true });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

function runDoctor(): number {
  const pkg = packageInfo();
  let failures = 0;
  const fail = (text: string): void => {
    failures++;
    bad(text);
  };

  out(`${style.bold("Ali Code doctor")} ${style.gray(`· ${pkg.name} ${pkg.version}`)}\n`);

  out(style.bold("Installation"));
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) ok(`Node.js ${process.versions.node}`);
  else fail(`Node.js ${process.versions.node} — Ali Code needs Node 20 or newer`);
  ok(`${process.platform} ${process.arch}`);
  ok(`installed at ${packageRoot()}`);
  process.stdout.isTTY ? ok("interactive terminal detected") : warn("not an interactive terminal (piped output)");

  out("\n" + style.bold("Project"));
  const cwd = process.cwd();
  ok(`working directory ${cwd}`);
  try {
    fs.accessSync(cwd, fs.constants.R_OK | fs.constants.W_OK);
    ok("read/write access to the working directory");
  } catch {
    fail("cannot read/write the working directory");
  }
  const projectEnv = path.join(cwd, ".env");
  fs.existsSync(projectEnv)
    ? ok(`project .env found (${projectEnv})`)
    : out(style.gray("  · no project .env (optional)"));

  out("\n" + style.bold("User configuration"));
  const root = configRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.accessSync(root, fs.constants.W_OK);
    ok(`data directory ${root}`);
  } catch {
    fail(`cannot write to ${root}`);
  }
  fs.existsSync(userEnvFile())
    ? ok(`settings file ${userEnvFile()}`)
    : out(style.gray(`  · no settings file yet (optional) — add a key with: ali config set openrouter <key>`));

  out("\n" + style.bold("API keys (optional)"));
  loadEnvFiles(cwd);
  let anyKeys = false;
  for (const name of Object.keys(PROVIDERS) as ProviderName[]) {
    if (name === "free" || name === "community") continue;
    const keys = collectKeys(name);
    if (keys.length > 0) {
      anyKeys = true;
      ok(`${PROVIDERS[name].label}: ${keys.length} key${keys.length === 1 ? "" : "s"} (${keys.map(maskSecret).join(", ")})`);
    } else {
      out(style.gray(`  · ${PROVIDERS[name].label}: no keys`));
    }
  }
  if (!anyKeys) {
    ok(`community model: always available (${PROVIDERS.community.model}), shared and rate-limited, no key needed`);
    out(style.gray(`  · ${PROVIDERS.free.model} (fully free, no limits) is the automatic fallback`));
  }

  try {
    const cfg = resolveConfig({});
    ok(`active provider ${PROVIDERS[cfg.primary].label}, model ${cfg.model}`);
    if (cfg.fallbacks.length > 0) {
      ok(`fallback: ${cfg.fallbacks.map((p) => PROVIDERS[p].label).join(", ")}`);
    }
  } catch (err: any) {
    fail(err?.message ?? String(err));
  }

  out("\n" + style.bold("Tools"));
  if (process.platform === "win32") {
    canRun("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"])
      ? ok("PowerShell available (used for shell commands)")
      : fail("powershell.exe not found — shell commands will not work");
  } else {
    canRun("bash", ["-c", "exit 0"])
      ? ok("bash available (used for shell commands)")
      : fail("bash not found — shell commands will not work");
  }
  canRun("git", ["--version"])
    ? ok("git available")
    : warn("git not found — /diff and git helpers will be limited");

  out("");
  if (failures === 0) out(style.green("All checks passed. Start with: ali"));
  else out(style.red(`${failures} problem${failures === 1 ? "" : "s"} found.`));
  return failures === 0 ? 0 : 1;
}

/* ------------------------------------------------------------------ *
 * ali update
 * ------------------------------------------------------------------ */

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function runUpdate(args: string[]): number {
  const pkg = packageInfo();
  const install = args.includes("--yes") || args.includes("-y") || args.includes("install");
  const command = `npm install -g ${pkg.name}@latest`;

  out(`${style.bold("Ali Code update")} ${style.gray(`· installed ${pkg.version}`)}`);

  // shell:true so Windows resolves npm.cmd.
  const view = spawnSync(`npm view ${pkg.name} version`, {
    shell: true,
    encoding: "utf8",
    timeout: 30_000,
  });
  const latest = (view.stdout ?? "").trim().split(/\r?\n/).pop() ?? "";

  if (view.status !== 0 || !/^\d/.test(latest)) {
    warn("could not look up the latest version from npm.");
    out(style.gray("  Check your network and that you are using the public npm registry (npm config get registry)."));
    out(`  To update manually, run:\n\n    ${style.bold(command)}\n`);
    return install ? 1 : 0;
  }

  const cmp = compareVersions(pkg.version, latest);
  if (cmp >= 0) {
    ok(`you are on the latest version (${pkg.version})`);
    return 0;
  }

  out(`  ${style.yellow("↑")} version ${style.bold(latest)} is available`);
  if (!install) {
    out(`\n  Run:  ${style.bold(command)}`);
    out(style.gray("  or:   ali update --yes   (runs that command for you)\n"));
    return 0;
  }

  out(style.gray(`\n  running: ${command}\n`));
  const result = spawnSync(command, { shell: true, stdio: "inherit" });
  if (result.status === 0) {
    ok(`updated to ${latest}. Restart Ali Code to use it.`);
    return 0;
  }
  bad("update failed — see the npm output above.");
  return 1;
}

/* ------------------------------------------------------------------ */

export async function runAdmin(argv: string[]): Promise<number | null> {
  const [command, ...rest] = argv;
  switch (command) {
    case "config":
      return runConfig(rest);
    case "doctor":
      return runDoctor();
    case "update":
    case "upgrade":
      return runUpdate(rest);
    default:
      return null;
  }
}
