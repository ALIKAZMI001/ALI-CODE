#!/usr/bin/env node
import {
  resolveConfig,
  PROVIDERS,
  PERMISSION_MODES,
  type PermissionMode,
  type ProviderName,
} from "./config.js";
import { buildRouter } from "./keys.js";
import { Agent } from "./agent.js";
import { Permissions } from "./permissions.js";
import { LineReader } from "./input.js";
import { Store, newSessionId, type PersistedSession } from "./session.js";
import { dispatch, matchCommands, type CommandContext } from "./commands.js";
import * as ui from "./ui.js";
import { runAdmin } from "./admin.js";
import { packageInfo } from "./paths.js";

const VERSION = packageInfo().version;

interface Cli {
  prompt: string[];
  provider?: ProviderName;
  model?: string;
  yolo?: boolean;
  dir?: string;
  maxIterations?: number;
  permissionMode?: PermissionMode;
  resume?: true | string;
}

const HELP = `
${ui.style.bold("Ali Code")} — a Claude Code-style coding agent for your terminal

${ui.style.bold("Usage")}
  ali                             start an interactive session in this folder
  ali "add a /health route"       run one task, then exit
  ali --dir ../other-repo         work in another folder
  ali --resume                    continue the most recent session here
  ("ali code …" is accepted as an alias for "ali …")

${ui.style.bold("Commands")}
  ali config                      show / set API keys and preferences
  ali doctor                      check your installation and configuration
  ali update                      check for a newer version (--yes to install it)

  ${ui.style.dim("No API key? It runs on a free model automatically. A key is optional.")}

${ui.style.bold("Options")}
  -y, --yolo                    never ask before using tools
      --permission-mode <mode>  default | accept-edits | plan | yolo
  -m, --model <id>              override the model
      --provider <name>         free | openrouter | groq | openai
  -C, --dir <path>              working directory
      --resume[=<session-id>]   resume a saved session
      --max-iterations <n>      cap on tool round-trips (default 40)
  -h, --help                    show this
  -v, --version                 show version

${ui.style.bold("In the session")}
  /help                 commands          !git status   run a shell command
  /model <id>           change model      /keys         key pool status
  /permissions <mode>   approval mode     /context      context usage
  /compact              summarize         /resume       load a session
  /init                 write AGENTS.md   /undo         revert last change

  ${ui.style.dim("Tip: shift+tab cycles default → accept-edits → plan mode.")}
  ${ui.style.dim("     Type / to see matching commands; tab completes them.")}
`;

function parseArgs(argv: string[]): Cli {
  // `ali code …` is the documented invocation; `ali …` also works.
  const args = argv[0] === "code" ? argv.slice(1) : argv;
  const cli: Cli = { prompt: [] };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith("--resume=")) {
      cli.resume = arg.slice("--resume=".length);
      continue;
    }

    switch (arg) {
      case "-h":
      case "--help":
        process.stdout.write(HELP);
        process.exit(0);
      case "-v":
      case "--version":
        process.stdout.write(`ali-code ${VERSION}\n`);
        process.exit(0);
      case "-y":
      case "--yolo":
        cli.yolo = true;
        cli.permissionMode = "yolo";
        break;
      case "-m":
      case "--model":
        cli.model = args[++i];
        break;
      case "--provider": {
        const value = args[++i];
        if (!value || !(value in PROVIDERS)) {
          ui.error(`Unknown provider "${value}". Use: ${Object.keys(PROVIDERS).join(", ")}`);
          process.exit(1);
        }
        cli.provider = value as ProviderName;
        break;
      }
      case "--permission-mode": {
        const value = args[++i] as PermissionMode;
        if (!PERMISSION_MODES.includes(value)) {
          ui.error(`Unknown mode "${value}". Use: ${PERMISSION_MODES.join(", ")}`);
          process.exit(1);
        }
        cli.permissionMode = value;
        break;
      }
      case "-C":
      case "--dir":
        cli.dir = args[++i];
        break;
      case "--resume":
      case "--continue":
        cli.resume = true;
        break;
      case "--max-iterations":
        cli.maxIterations = Number(args[++i]);
        break;
      default:
        if (arg.startsWith("-") && arg !== "-") {
          ui.error(`Unknown option: ${arg}. Try --help.`);
          process.exit(1);
        }
        cli.prompt.push(arg);
    }
  }

  return cli;
}

/**
 * Ali Code works with no setup: when no API key is configured it uses the free
 * anonymous model. Keys are optional and belong to whoever runs the tool.
 */
async function main(): Promise<void> {
  const adminExit = await runAdmin(process.argv.slice(2));
  if (adminExit !== null) process.exit(adminExit);

  const cli = parseArgs(process.argv.slice(2));

  const cfg = resolveConfig({
    provider: cli.provider,
    model: cli.model,
    yolo: cli.yolo,
    cwd: cli.dir,
    maxIterations: cli.maxIterations,
    permissionMode: cli.permissionMode,
  });

  const router = buildRouter(cfg);
  const store = new Store(cfg.cwd);

  let resumed: PersistedSession | null = null;
  if (cli.resume) {
    resumed = cli.resume === true ? store.latest() : store.load(cli.resume);
    if (!resumed) {
      ui.warn("no saved session found; starting a new one");
    }
  }

  const reader = new LineReader();
  const permissions = new Permissions(
    (question) => reader.ask(question, false),
    cfg.permissionMode,
    (count, render) => reader.select(count, render)
  );
  const agent = new Agent(
    router,
    cfg,
    permissions,
    store,
    resumed?.id ?? newSessionId(),
    resumed?.createdAt
  );

  if (resumed) {
    agent.restore(resumed);
    if (resumed.provider === router.provider) router.model = resumed.model;
  }

  // `ask_user` renders its own prompt and reuses the same reader.
  agent.askUser = async (question, options) => {
    ui.assistantEnd();
    process.stdout.write(
      "\n" + ui.margin() + "  " +
        ui.style.orange("⏺") +
        " " +
        ui.style.bold("AskUser") +
        " " +
        ui.style.white(question) +
        "\n"
    );
    for (const [index, option] of (options ?? []).entries()) {
      process.stdout.write(ui.margin() + "     " + ui.style.gray(`${index + 1}. ${option}`) + "\n");
    }

    const answer = await reader.ask(ui.margin() + ui.style.cyan("  › "), false);
    if (answer === null) return null;

    const trimmed = answer.trim();
    if (options?.length && /^\d+$/.test(trimmed)) {
      const pick = options[Number(trimmed) - 1];
      if (pick) return pick;
    }
    return trimmed;
  };

  const ctx: CommandContext = { agent, cfg, router, perms: permissions, reader, store };

  const onInterrupt = (): void => {
    if (agent.busy) {
      agent.interrupt();
      return;
    }
    process.stdout.write("\n");
    agent.persist();
    reader.close();
    process.exit(0);
  };
  process.on("SIGINT", onInterrupt);
  reader.onInterrupt = onInterrupt;

  // Shift+Tab cycles the modes Claude Code cycles. yolo is opt-in via flags.
  const CYCLE: PermissionMode[] = ["default", "accept-edits", "plan"];
  reader.onCycleMode = (): void => {
    const index = CYCLE.indexOf(permissions.mode);
    const next = CYCLE[(index + 1) % CYCLE.length] ?? "default";
    permissions.setMode(next);
    cfg.permissionMode = next;
    reader.reprompt(ui.promptFor(next));
  };

  // Slash-command palette: matches appear live under the input, Tab completes.
  let lastCompleted = "";
  let lastMatches: string[] = [];
  let lastIndex = -1;

  reader.onHint = (): string => ui.hintLine(permissions.mode);
  reader.onTitle = (): string => ui.inputTitle(router.model, router.providerLabel);

  reader.onSuggest = (line: string): string | null => {
    if (!line.startsWith("/") || line.includes(" ")) return null;
    const matches = matchCommands(line);
    if (matches.length === 0) return null;
    return ui.suggestionLine(matches);
  };

  reader.onComplete = (line: string): string | null => {
    if (!line.startsWith("/") || line.includes(" ")) return null;

    let matches: string[];
    if (line === lastCompleted && lastMatches.length > 0) {
      matches = lastMatches;
      lastIndex = (lastIndex + 1) % matches.length;
    } else {
      matches = matchCommands(line);
      lastIndex = 0;
    }

    if (matches.length === 0) return null;
    const pick = matches[lastIndex];
    lastCompleted = pick;
    lastMatches = matches;
    return pick;
  };

  ui.banner({
    model: router.model,
    provider: router.providerLabel,
    cwd: cfg.cwd,
    mode: permissions.mode,
    keys: router.provider === "free" ? 0 : router.totalKeys(),
    resumed: resumed?.id,
  });

  // One-shot mode.
  if (cli.prompt.length > 0) {
    const prompt = cli.prompt.join(" ");
    if (process.stdin.isTTY) {
      process.stdout.write(ui.submittedMessage(prompt) + "\n");
      ui.promptBottom(permissions.mode);
    }
    await agent.run(prompt);
    reader.close();
    return;
  }

  // Interactive REPL.
  for (;;) {
    ui.promptTop();
    const line = await reader.ask(ui.promptFor(permissions.mode));
    if (line === null) {
      process.stdout.write("\n");
      break;
    }

    const input = line.trim();
    if (!input) continue;

    ui.promptBottom(permissions.mode);

    if (input.startsWith("/")) {
      await dispatch(input, ctx);
      continue;
    }

    if (input.startsWith("!")) {
      await agent.runShell(input.slice(1).trim());
      continue;
    }

    await agent.run(input);
  }

  agent.persist();
  reader.close();
}

main().catch((err) => {
  ui.error(`fatal: ${err?.message ?? String(err)}`);
  process.exit(1);
});
