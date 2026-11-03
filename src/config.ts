import fs from "node:fs";
import path from "node:path";

export type ProviderName = "openrouter" | "groq" | "openai";
export type PermissionMode = "default" | "accept-edits" | "plan" | "yolo";

export const PERMISSION_MODES: PermissionMode[] = [
  "default",
  "accept-edits",
  "plan",
  "yolo",
];

export interface ProviderSpec {
  baseURL: string;
  model: string;
  /** Legacy single-key variable. */
  keyEnv: string;
  /** Comma/space separated list of keys. */
  keysEnv: string;
  label: string;
  keyPattern?: RegExp;
  extraHeaders?: Record<string, string>;
}

export const PROVIDERS: Record<ProviderName, ProviderSpec> = {
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    model: "anthropic/claude-sonnet-4.5",
    keyEnv: "OPENROUTER_API_KEY",
    keysEnv: "OPENROUTER_API_KEYS",
    label: "OpenRouter",
    keyPattern: /^sk-or-/,
    extraHeaders: {
      "HTTP-Referer": "https://github.com/local/ali-code",
      "X-Title": "ali-code",
    },
  },
  groq: {
    baseURL: "https://api.groq.com/openai/v1",
    model: "openai/gpt-oss-120b",
    keyEnv: "GROQ_API_KEY",
    keysEnv: "GROQ_API_KEYS",
    label: "Groq",
    keyPattern: /^gsk_/,
  },
  openai: {
    baseURL: "https://api.openai.com/v1",
    model: "gpt-4.1",
    keyEnv: "OPENAI_API_KEY",
    keysEnv: "OPENAI_API_KEYS",
    label: "OpenAI",
    keyPattern: /^sk-/,
  },
};

export interface Config {
  cwd: string;
  permissionMode: PermissionMode;
  maxTokens: number;
  maxContextTokens: number;
  maxIterations: number;
  primary: ProviderName;
  model: string;
  fallbacks: ProviderName[];
}

export interface CliOptions {
  provider?: ProviderName;
  model?: string;
  yolo?: boolean;
  cwd?: string;
  maxIterations?: number;
  permissionMode?: PermissionMode;
}

/** All keys configured for a provider, de-duplicated and prefix-checked. */
export function collectKeys(provider: ProviderName): string[] {
  const spec = PROVIDERS[provider];
  const raw: string[] = [];

  // An explicit list wins. Otherwise fall back to the single-key variable, so a
  // stale machine-wide GROQ_API_KEY cannot sneak into a configured pool.
  const list = process.env[spec.keysEnv];
  const sources = list && list.trim() ? [list] : [process.env[spec.keyEnv] ?? ""];

  for (const value of sources) {
    for (const part of value.split(/[,\s;]+/)) {
      const key = part.trim();
      if (key) raw.push(key);
    }
  }

  const unique = [...new Set(raw)];
  if (spec.keyPattern) {
    const matching = unique.filter((key) => spec.keyPattern!.test(key));
    if (matching.length > 0) return matching;
  }
  return unique;
}

export function hasKeys(provider: ProviderName): boolean {
  return collectKeys(provider).length > 0;
}

/** Minimal .env parser so we do not need a dependency. */
function parseDotenv(file: string, override: boolean): void {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (override || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function loadEnvFiles(cwd: string): void {
  parseDotenv(path.join(cwd, ".env"), false);
  parseDotenv(path.join(cwd, ".env.local"), true);
  applyEnvAliases();
}

/** `ALI_*` is the current spelling; `MINI_*` still works for old .env files. */
const ENV_ALIASES: Array<[string, string]> = [
  ["MINI_PROVIDER", "ALI_PROVIDER"],
  ["MINI_MODEL", "ALI_MODEL"],
  ["MINI_FALLBACK_PROVIDERS", "ALI_FALLBACK_PROVIDERS"],
  ["MINI_FALLBACK_MODEL", "ALI_FALLBACK_MODEL"],
  ["MINI_PERMISSION_MODE", "ALI_PERMISSION_MODE"],
  ["MINI_YOLO", "ALI_YOLO"],
  ["MINI_MAX_TOKENS", "ALI_MAX_TOKENS"],
  ["MINI_CONTEXT_TOKENS", "ALI_CONTEXT_TOKENS"],
  ["MINI_MAX_ITERATIONS", "ALI_MAX_ITERATIONS"],
];

function applyEnvAliases(): void {
  for (const [legacy, current] of ENV_ALIASES) {
    if (process.env[legacy] === undefined && process.env[current] !== undefined) {
      process.env[legacy] = process.env[current];
    }
  }
}

function parseMode(value: string | undefined): PermissionMode | undefined {
  if (!value) return undefined;
  const mode = value.trim().toLowerCase() as PermissionMode;
  return PERMISSION_MODES.includes(mode) ? mode : undefined;
}

export function resolveConfig(opts: CliOptions): Config {
  const cwd = path.resolve(opts.cwd ?? process.cwd());

  // Read the .env next to where Ali Code was launched, then the target folder's.
  const invocationCwd = process.cwd();
  loadEnvFiles(invocationCwd);
  if (cwd !== invocationCwd) loadEnvFiles(cwd);

  const envProvider = process.env.MINI_PROVIDER?.trim().toLowerCase();
  let primary: ProviderName | undefined = opts.provider;

  if (!primary && envProvider) {
    if (!(envProvider in PROVIDERS)) {
      throw new Error(
        `Unknown ALI_PROVIDER "${envProvider}". Use one of: ${Object.keys(PROVIDERS).join(", ")}`
      );
    }
    primary = envProvider as ProviderName;
  }

  if (!primary) {
    primary = (["openrouter", "groq", "openai"] as ProviderName[]).find(hasKeys) ?? "openrouter";
  }

  if (!hasKeys(primary)) {
    const alternative = (["openrouter", "groq", "openai"] as ProviderName[]).find(
      (p) => p !== primary && hasKeys(p)
    );
    if (!alternative) {
      throw new Error(
        `No API keys found. Put OPENROUTER_API_KEYS=key1,key2 (or GROQ_API_KEYS / OPENAI_API_KEYS) in .env in ${invocationCwd}.`
      );
    }
    process.stderr.write(
      `! ${PROVIDERS[primary].label} has no keys; using ${PROVIDERS[alternative].label} instead.\n`
    );
    primary = alternative;
  }

  const configuredFallbacks = (process.env.MINI_FALLBACK_PROVIDERS ?? "")
    .split(/[,\s]+/)
    .map((p) => p.trim().toLowerCase())
    .filter((p): p is ProviderName => {
      if (!(p in PROVIDERS)) return false;
      const name = p as ProviderName;
      return name !== primary && hasKeys(name);
    });

  const autoFallbacks = (["openrouter", "groq", "openai"] as ProviderName[]).filter(
    (p) => p !== primary && hasKeys(p)
  );

  const fallbacks = (configuredFallbacks.length > 0 ? configuredFallbacks : autoFallbacks).filter(
    (p, i, arr) => arr.indexOf(p) === i
  );

  const permissionMode: PermissionMode =
    opts.permissionMode ??
    parseMode(process.env.MINI_PERMISSION_MODE) ??
    (opts.yolo || process.env.MINI_YOLO === "1" ? "yolo" : "default");

  const model =
    opts.model ||
    process.env.MINI_MODEL?.trim() ||
    PROVIDERS[primary].model;

  return {
    cwd,
    permissionMode,
    maxTokens: Number(process.env.MINI_MAX_TOKENS ?? 8192),
    maxContextTokens: Number(process.env.MINI_CONTEXT_TOKENS ?? 128_000),
    maxIterations: opts.maxIterations ?? Number(process.env.MINI_MAX_ITERATIONS ?? 40),
    primary,
    model,
    fallbacks,
  };
}
