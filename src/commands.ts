import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Config, PermissionMode, ProviderName } from "./config.js";
import { PERMISSION_MODES, PROVIDERS, collectKeys } from "./config.js";
import type { Router } from "./keys.js";
import type { Agent } from "./agent.js";
import type { Permissions } from "./permissions.js";
import type { LineReader } from "./input.js";
import type { Store } from "./session.js";
import { transcriptMarkdown } from "./session.js";
import { style, info, warn, error } from "./ui.js";
import { truncate, formatBytes } from "./util.js";

export interface CommandContext {
  agent: Agent;
  cfg: Config;
  router: Router;
  perms: Permissions;
  reader: LineReader;
  store: Store;
}

export interface Command {
  name: string;
  aliases?: string[];
  usage?: string;
  summary: string;
  run: (ctx: CommandContext, args: string) => Promise<void> | void;
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 20_000 });
  if (result.error) return `git error: ${result.error.message}`;
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return out || "(no output)";
}

function isGitRepo(cwd: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  });
  return result.status === 0 && (result.stdout ?? "").trim() === "true";
}

function print(text: string): void {
  process.stdout.write(text + "\n");
}

/* ------------------------------------------------------------------ *
 * commands
 * ------------------------------------------------------------------ */

export const COMMANDS: Command[] = [
  {
    name: "help",
    aliases: ["?"],
    usage: "/help [command]",
    summary: "list commands, or show one in detail",
    run: (ctx, args) => {
      const wanted = args.trim().replace(/^\//, "");
      if (wanted) {
        const command = findCommand(wanted);
        if (!command) {
          error(`no such command: /${wanted}`);
          return;
        }
        print(
          `${style.bold("/" + command.name)}  ${command.summary}\n` +
            style.gray(`usage: ${command.usage ?? "/" + command.name}`)
        );
        return;
      }
      print(helpText());
    },
  },
  {
    name: "exit",
    aliases: ["quit", "q"],
    summary: "quit Ali Code",
    run: (ctx) => {
      ctx.store.save(ctx.agent.transcript());
      ctx.reader.close();
      process.exit(0);
    },
  },
  {
    name: "clear",
    summary: "forget the conversation and start fresh",
    run: (ctx) => {
      ctx.agent.clear();
      info("conversation cleared");
    },
  },
  {
    name: "context",
    summary: "show context-window usage",
    run: (ctx) => print(ctx.agent.contextReport()),
  },
  {
    name: "cost",
    aliases: ["usage"],
    summary: "show token usage for this session",
    run: (ctx) => print(ctx.agent.usageReport()),
  },
  {
    name: "compact",
    usage: "/compact [what to keep]",
    summary: "summarize history to free context space",
    run: async (ctx, args) => {
      await ctx.agent.forceCompact(args.trim() || undefined);
      info("compact done");
    },
  },
  {
    name: "model",
    usage: "/model [id]",
    summary: "show or change the model",
    run: (ctx, args) => {
      const next = args.trim();
      if (!next) {
        print(`${style.bold(ctx.router.model)}  ${style.gray(ctx.router.providerLabel)}`);
        info("change with /model <id>, list with /models");
        return;
      }
      ctx.router.model = next;
      ctx.cfg.model = next;
      ctx.agent.persist();
      info(`model set to ${next}`);
    },
  },
  {
    name: "models",
    usage: "/models [filter]",
    summary: "list models available to the current provider",
    run: async (ctx, args) => {
      const filter = args.trim().toLowerCase();
      const route = ctx.router.route;
      const key = ctx.router.key;
      if (!key) {
        error("no usable key for this provider");
        return;
      }

      info(`fetching models from ${route.spec.label}…`);
      try {
        const response = await fetch(`${route.spec.baseURL}/models`, {
          headers: { Authorization: `Bearer ${key.value}` },
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) {
          error(`provider returned ${response.status}`);
          return;
        }
        const payload: any = await response.json();
        let ids: string[] = (payload.data ?? [])
          .map((model: any) => String(model.id))
          .sort();
        if (filter) ids = ids.filter((id) => id.toLowerCase().includes(filter));
        if (ids.length === 0) {
          warn("no models matched");
          return;
        }
        const shown = ids.slice(0, 80);
        print(shown.join("\n"));
        if (ids.length > shown.length) {
          info(`… ${ids.length - shown.length} more. Narrow with /models <filter>`);
        }
      } catch (err: any) {
        error(`could not list models: ${err?.message ?? String(err)}`);
      }
    },
  },
  {
    name: "provider",
    usage: "/provider [name]",
    summary: "show providers/routes, or switch to another one",
    run: (ctx, args) => {
      const name = args.trim().toLowerCase();
      if (!name) {
        print(ctx.router.statusLines().join("\n"));
        return;
      }
      if (!(name in PROVIDERS)) {
        error(`unknown provider "${name}". Use: ${Object.keys(PROVIDERS).join(", ")}`);
        return;
      }
      if (ctx.router.switchProvider(name as ProviderName)) {
        info(`now using ${ctx.router.describe()}`);
        ctx.agent.persist();
      } else {
        error(`no usable keys for ${name}. Add them to .env, then restart.`);
      }
    },
  },
  {
    name: "keys",
    summary: "show every key, its state, and remaining rotations",
    run: (ctx) => {
      print(ctx.router.statusLines().join("\n"));
      info("dead keys are skipped; rate-limited keys cool down for 60s");
    },
  },
  {
    name: "permissions",
    aliases: ["permission-mode", "mode"],
    usage: "/permissions [default|accept-edits|plan|yolo|reset]",
    summary: "show or change how tool use is approved",
    run: (ctx, args) => {
      const arg = args.trim().toLowerCase();

      if (!arg) {
        print(
          [
            `mode      ${style.bold(ctx.perms.mode)}`,
            `auto      ${ctx.perms.autoAllowed().join(", ")}`,
            `modes     ${PERMISSION_MODES.join(" · ")}`,
            "",
            style.gray("  default       ask before edits and commands"),
            style.gray("  accept-edits  edits apply automatically, commands still ask"),
            style.gray("  plan          read-only: no edits, no commands"),
            style.gray("  yolo          never ask (hard deny-list still applies)"),
          ].join("\n")
        );
        return;
      }

      if (arg === "reset") {
        ctx.perms.reset();
        info("session tool allowlist cleared");
        return;
      }

      if (!PERMISSION_MODES.includes(arg as PermissionMode)) {
        error(`unknown mode "${arg}". Use: ${PERMISSION_MODES.join(", ")}`);
        return;
      }

      ctx.perms.setMode(arg as PermissionMode);
      ctx.cfg.permissionMode = arg as PermissionMode;
      info(`permission mode set to ${arg}`);
    },
  },
  {
    name: "plan",
    summary: "toggle read-only plan mode",
    run: (ctx) => {
      const next: PermissionMode = ctx.perms.mode === "plan" ? "default" : "plan";
      ctx.perms.setMode(next);
      ctx.cfg.permissionMode = next;
      info(`permission mode set to ${next}`);
    },
  },
  {
    name: "undo",
    summary: "revert the most recent file change",
    run: (ctx) => {
      const result = ctx.agent.history.undo();
      if (!result) {
        info("nothing to undo");
        return;
      }
      const relative = path.relative(ctx.cfg.cwd, result.path);
      info(`reverted ${relative}`);
    },
  },
  {
    name: "diff",
    summary: "show uncommitted changes",
    run: (ctx) => {
      if (!isGitRepo(ctx.cfg.cwd)) {
        warn("not a git repository");
        return;
      }
      print(style.gray(git(ctx.cfg.cwd, ["diff", "--stat"])));
      print(truncate(git(ctx.cfg.cwd, ["diff"]), 20_000));
    },
  },
  {
    name: "status",
    summary: "show folder, model, keys, git branch and context",
    run: (ctx) => {
      const branch = isGitRepo(ctx.cfg.cwd)
        ? git(ctx.cfg.cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
        : "(not a git repo)";
      print(
        [
          `folder    ${ctx.cfg.cwd}`,
          `provider  ${ctx.router.providerLabel}`,
          `model     ${ctx.router.model}`,
          `keys      ${ctx.router.route.pool.aliveCount()}/${ctx.router.route.pool.size} usable on this route · ${ctx.router.totalKeys()} total`,
          `mode      ${ctx.perms.mode}`,
          `git       ${branch}`,
          `session   ${ctx.agent.sessionId}`,
          `todos     ${ctx.agent.todos.summary()}`,
        ].join("\n")
      );
      print(style.gray(ctx.agent.contextReport()));
    },
  },
  {
    name: "todos",
    summary: "show the task list",
    run: (ctx) => print(ctx.agent.todos.render()),
  },
  {
    name: "init",
    summary: "analyze the repo and write AGENTS.md",
    run: async (ctx) => {
      await ctx.agent.run(
        [
          "Analyze this repository and create or update AGENTS.md at the workspace root.",
          "Use list_files, read_file and search to understand the project: purpose, stack,",
          "structure, build/test/lint commands, conventions, and gotchas.",
          "Keep it under 60 lines and genuinely useful to a new coding agent.",
          "If AGENTS.md already exists, read it first and improve it instead of discarding content.",
        ].join(" ")
      );
    },
  },
  {
    name: "review",
    summary: "review uncommitted changes without editing",
    run: async (ctx) => {
      await ctx.agent.run(
        [
          "Review the current uncommitted changes in this repository.",
          "Use run_command to get `git diff` and `git diff --stat`, and read the affected files if needed.",
          "Report real bugs, risky changes and missing tests. Do not modify any files. Be concise.",
        ].join(" ")
      );
    },
  },
  {
    name: "export",
    usage: "/export [path]",
    summary: "write the transcript to a markdown file",
    run: (ctx, args) => {
      const target = path.resolve(
        ctx.cfg.cwd,
        args.trim() || `ali-code-${ctx.agent.sessionId}.md`
      );
      const markdown = transcriptMarkdown(ctx.agent.transcript());
      try {
        fs.writeFileSync(target, markdown, "utf8");
        info(`wrote ${path.relative(ctx.cfg.cwd, target)} (${formatBytes(Buffer.byteLength(markdown))})`);
      } catch (err: any) {
        error(`could not write ${target}: ${err?.message ?? String(err)}`);
      }
    },
  },
  {
    name: "resume",
    usage: "/resume [session-id]",
    summary: "list saved sessions, or load one",
    run: async (ctx, args) => {
      const wanted = args.trim();

      if (wanted) {
        const session = ctx.store.load(wanted);
        if (!session) {
          error(`no session "${wanted}" for this folder`);
          return;
        }
        ctx.agent.restore(session);
        if (session.provider === ctx.router.provider) ctx.router.model = session.model;
        info(`resumed ${session.id} (${session.messages.length} messages)`);
        return;
      }

      const sessions = ctx.store.list();
      if (sessions.length === 0) {
        info("no saved sessions for this folder yet");
        return;
      }

      print(
        sessions
          .slice(0, 12)
          .map(
            (session, index) =>
              `  ${index + 1}. ${session.id}  ${session.updatedAt.slice(0, 19).replace("T", " ")}  ${session.turns} msgs  ${style.gray(session.model)}`
          )
          .join("\n")
      );

      const answer = await ctx.reader.ask(style.yellow("resume which? [number, enter to cancel] "), false);
      if (answer === null || !answer.trim()) return;

      const index = Number(answer.trim()) - 1;
      const chosen = sessions[index];
      if (!chosen) {
        error("invalid choice");
        return;
      }
      const session = ctx.store.load(chosen.id);
      if (!session) {
        error("session could not be read");
        return;
      }
      ctx.agent.restore(session);
      if (session.provider === ctx.router.provider) ctx.router.model = session.model;
      info(`resumed ${session.id} (${session.messages.length} messages)`);
    },
  },
  {
    name: "doctor",
    summary: "check node, config, keys and connectivity",
    run: async (ctx) => {
      const lines: string[] = [
        `node        ${process.version} (${process.platform})`,
        `folder      ${ctx.cfg.cwd} ${fs.existsSync(ctx.cfg.cwd) ? "ok" : "MISSING"}`,
        `env         .env ${fs.existsSync(path.join(ctx.cfg.cwd, ".env")) ? "present" : "not found"}`,
        `git         ${isGitRepo(ctx.cfg.cwd) ? "ok" : "not a repo"}`,
      ];

      for (const route of ctx.router.routes) {
        for (const key of route.pool.keys) {
          const url =
            route.provider === "openrouter"
              ? `${route.spec.baseURL}/key`
              : `${route.spec.baseURL}/models`;
          let state = "?";
          try {
            const response = await fetch(url, {
              headers: { Authorization: `Bearer ${key.value}` },
              signal: AbortSignal.timeout(15_000),
            });
            state = response.ok ? "ok" : `HTTP ${response.status}`;
          } catch (err: any) {
            state = `unreachable (${err?.message ?? "error"})`;
          }
          lines.push(`${route.spec.label.padEnd(10)}  ${key.label}  ${state}`);
        }
      }

      print(lines.join("\n"));
    },
  },
  {
    name: "version",
    summary: "print the version",
    run: () => print("ali-code 1.0.0"),
  },
];

/* ------------------------------------------------------------------ */

export function findCommand(name: string): Command | undefined {
  const clean = name.replace(/^\//, "").toLowerCase();
  return COMMANDS.find(
    (command) => command.name === clean || command.aliases?.includes(clean)
  );
}

export function helpText(): string {
  const rows = COMMANDS.map((command) => {
    const label = `/${command.name}`;
    return `  ${label.padEnd(14)} ${style.gray(command.summary)}`;
  });
  return [
    style.bold("Commands"),
    ...rows,
    "",
    style.gray("  !<cmd>          run a shell command directly, e.g. !git status"),
    style.gray("  anything else   talk to Ali"),
  ].join("\n");
}

export async function dispatch(
  line: string,
  ctx: CommandContext
): Promise<"continue" | "exit"> {
  const input = line.replace(/^\//, "");
  const [name, ...rest] = input.split(/\s+/);
  let command = findCommand(name);

  // `/usag` is close enough to `/usage`: resolve a lone fuzzy match.
  if (!command) {
    const matches = matchCommands(name);
    if (matches.length === 1) command = findCommand(matches[0]);
  }

  if (!command) {
    error(`unknown command: /${name}`);
    info("try /help");
    return "continue";
  }

  try {
    await command.run(ctx, rest.join(" "));
  } catch (err: any) {
    error(`/${command.name} failed: ${err?.message ?? String(err)}`);
  }
  return "continue";
}

export function providerSummary(): string {
  return (["openrouter", "groq", "openai"] as ProviderName[])
    .map((provider) => `${provider}:${collectKeys(provider).length}`)
    .join("  ");
}

/**
 * Fuzzy slash-command lookup for the live suggestion line and Tab completion.
 * Prefix matches rank above substring matches, aliases included.
 */
export function suggestCommands(prefix: string): Command[] {
  const query = prefix.replace(/^\//, "").trim().toLowerCase();
  if (!query) return COMMANDS;

  const scored: Array<{ command: Command; score: number }> = [];
  for (const command of COMMANDS) {
    let score = 0;
    for (const label of [command.name, ...(command.aliases ?? [])]) {
      if (label === query) score = Math.max(score, 100);
      else if (label.startsWith(query)) score = Math.max(score, 80 - label.length);
      else if (label.includes(query)) score = Math.max(score, 40 - label.length);
    }
    if (score > 0) scored.push({ command, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.command.name.localeCompare(b.command.name))
    .map((entry) => entry.command);
}

/**
 * The strings the palette and Tab completion actually use. Aliases count, so
 * typing `/us` suggests `/usage`, not the primary name `/cost`.
 */
export function matchCommands(prefix: string): string[] {
  const query = prefix.replace(/^\//, "").trim().toLowerCase();
  if (!query) return COMMANDS.map((command) => `/${command.name}`);

  const scored: Array<{ label: string; name: string; score: number }> = [];

  for (const command of COMMANDS) {
    let best: { label: string; score: number } | null = null;
    for (const label of [command.name, ...(command.aliases ?? [])]) {
      let score = 0;
      if (label === query) score = 100;
      else if (label.startsWith(query)) score = 80 - label.length;
      else if (label.includes(query)) score = 40 - label.length;
      if (score > 0 && (!best || score > best.score)) best = { label, score };
    }
    if (best) scored.push({ ...best, name: command.name });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map((entry) => `/${entry.label}`);
}
