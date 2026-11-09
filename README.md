# Ali Code

A Claude Code–style coding agent for your terminal. It reads and edits real
files, runs commands, tracks a todo list, manages a pool of API keys, and asks
before doing anything destructive — with the same visual language as Claude
Code: the welcome panel, `⏺` tool calls, `⎿` results, a `>` prompt, the mode
line, and the numbered permission dialog.

```
 ╭────────────────────────────────────────────────────────────────────╮
 │                                                                    │
 │                     ✻ Welcome to Ali Code!                         │
 │                                                                    │
 │         /help for help, /status for your current setup             │
 │                                                                    │
 │               cwd: C:\Users\you\Desktop\my-project                 │
 │                                                                    │
 ╰────────────────────────────────────────────────────────────────────╯

  Tips for getting started:
  1. Ask Ali to create a new app or clone a repository
  2. Use Ali to help with file analysis, editing, bash commands and git
  3. Be as specific as you would with another engineer for the best results
  4. Run /init to create an AGENTS.md file with instructions for Ali

  ※ Community (shared, rate-limited) · openai/gpt-oss-120b · no key needed · default permissions

╭─ You · 14:32:05 ────────────────────────────────────────────────╮
│ > add a /health route                                          │
╰────────────────────────────────────────────────────────────────╯
  ? for shortcuts

╭─ ✻ Ali · 14:32:06 ──────────────────────────────────────────────╮
│ I'll add the route, then run the tests to check it.            │
╰────────────────────────────────────────────────────── 1.8s ╯

⏺ Read(src/app.ts)
  ⎿  Read 84 lines

⏺ Update(src/app.ts)
  ⎿  Updated src/app.ts with 6 additions and 0 removals

⏺ Bash(npm test) · 14:32:09
  ⎿  exit code: 0
     42 tests passed
```

Every question and every answer is framed in a box with the time it was
entered, and shell commands carry their start time.

Works with a **real shared model out of the box, no key needed**, and with
**OpenRouter**, **Groq**, **OpenAI**, or any OpenAI-compatible API when you add
a key.

## Requirements

- **Node.js 20 or newer** (check with `node -v`)
- Windows 10/11 (PowerShell), macOS or Linux (bash)
- `git` is optional but recommended
- **No API key required** — an API key is optional and only needed for better
  or faster models

## Install

One command. No token, no registry setup, no repository clone, no API key, and
no `.env` file to share.

```bash
npm install -g ali-code
```

Or try it without installing:

```bash
npx ali-code
```

Both `ali` and `ali-code` become available. Then open any project and run:

```bash
cd C:\Users\you\Desktop\MyProject
ali
```

That is the whole setup. On first run Ali Code uses a shared model and starts
working immediately, like OpenCode and Claude Code.

### Zero-config by default, your key optional

Without any configuration Ali Code routes through a small shared proxy
(`openai/gpt-oss-120b`) funded by the maintainer, so you get a real model with
nothing to sign up for and nothing to share. That shared tier is
**rate-limited** (per visitor and per day) to keep it sustainable for
everyone; if it's ever busy or you hit the limit, Ali Code automatically falls
back to a fully free, unlimited anonymous model (`openai-fast`) so it never
just stops working.

If you want stronger or faster models with no shared limits at all, add your
own key:

```bash
ali config set openrouter sk-or-v1-your-key   # or groq / openai
ali doctor                                    # verify everything
```

The key is saved **on your machine only**, in `~/.ali-code/.env`
(`C:\Users\you\.ali-code\.env` on Windows), readable only by you. It is never
sent to the Ali Code author, never committed to a project, and never shared
between users. Paid providers are preferred automatically ahead of both the
shared and the free tier.

Multiple keys rotate automatically: `ali config set openrouter key1,key2`.

### Use it in any project

```bash
ali                                  # interactive session in this folder
ali "add a health-check route"       # one task, then exit
ali -y "run the tests and fix them"  # no approval prompts
ali -C ../other-repo                 # work in another folder
ali --resume                         # continue the last session here
ali --version                        # print the installed version
ali --help                           # usage
```

`ali code …` is still accepted as an alias for `ali …`.

## Commands

| Command | What it does |
|---|---|
| `ali` | Start the interactive session in the current folder |
| `ali config` | Show saved settings (keys are masked) |
| `ali config set <name> <value>` | Save a key or preference (`openrouter`, `groq`, `openai`, `provider`, `model`, `fallback`, `permission-mode`) |
| `ali config unset <name>` | Remove a saved setting |
| `ali config path` | Print where settings are stored |
| `ali doctor` | Check Node, config, API keys, shell, git and folder access |
| `ali update` | Check for a newer version; `ali update --yes` installs it |
| `ali --version` / `ali --help` | Version and usage |

## Where things are stored

| What | Location |
|---|---|
| Installed program (read-only) | your npm global prefix, e.g. `%AppData%\npm\node_modules\ali-code` |
| API keys and preferences | `~/.ali-code/.env` (`C:\Users\you\.ali-code\.env`) |
| Saved sessions | `~/.ali-code/sessions/` |
| Your project | the folder you ran `ali` in — nothing of Ali Code's is written there |

Set `ALI_HOME` to use a different data directory.

**Precedence (highest first):** real environment variables → `.env.local` in
the project → `.env` in the project → `~/.ali-code/.env`. A project can
therefore override your personal defaults without touching them. Keys are never
printed in full (`ali config` and `ali doctor` mask them), and the settings
file is created readable only by you where the OS supports it.

## Updating

From your terminal:

```bash
ali update            # shows whether a newer version exists
ali update --yes      # installs it
# or directly:
npm install -g ali-code@latest
```

Or without leaving a session, type **`/update`**. It checks npm, tells you if a
newer version exists, and offers an **Install now / Not now** menu (`/update
--yes` skips the menu). Restart Ali Code afterwards to run the new version.

If you run Ali Code from a source checkout or `npm link` (for development),
`/update` and `ali update` report what's available but never replace your copy
with the published one — update that with `git pull && npm run build`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ali` is not recognized | Close and reopen the terminal. Check `npm config get prefix` is on your `PATH`. |
| `npm error 404` on install | Make sure the package name is exactly `ali-code` and you are on the public npm registry (`npm config get registry`). |
| `No API keys found` (old versions) | Update with `npm install -g ali-code@latest`. Current versions need no key and use a shared model automatically. |
| Shared model is slow, busy, or rate-limited | That is the shared community tier — it falls back to the fully free tier automatically, or add your own key with `ali config set openrouter <key>`, then `ali doctor`. |
| PowerShell: "running scripts is disabled" | Use `ali.cmd`, or run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. |
| Wrong provider or model | `ali config` shows saved values; a project `.env` or environment variable may be overriding them. |
| A stale key keeps being used | Check for machine-wide variables such as `GROQ_API_KEY`: `ali doctor` lists what is active. |
| Anything else | `ali doctor` |

## Architecture

```text
                [ User CLI / Terminal Input ]
                              │
                              ▼ (Interactive REPL Parser)
  ┌───────────────────────────────────────────────────────┐
  │     System Prompt & Workspace Context (AGENTS.md)     │
  └───────────────────────────┬───────────────────────────┘
                              │
                              ▼
  ┌───────────────────────────────────────────────────────┐
  │       Resilient Key-Pool & Failover API Router        │
  │    OpenRouter  ──►  Groq Cloud  ──►  OpenAI Direct    │
  │  (Automatic Key Rotation • Cooldown • Auto-Fallback)  │
  └───────────────────────────┬───────────────────────────┘
                              │
                              ▼ (Streaming Token Evaluation)
  ┌───────────────────────────────────────────────────────┐
  │      Autonomous Agent Engine & Tool Calling Loop      │
  └───────────────────────────┬───────────────────────────┘
                              │
                              ▼ (Dispatched Tool Calls)
  ┌───────────────────────────────────────────────────────┐
  │   Security & Permission Gate (Workspace Sandboxed)    │
  │    Modes: default (confirm) │ accept-edits │ yolo     │
  └───────────────────────────┬───────────────────────────┘
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
    ┌───────────────┐ ┌───────────────┐ ┌───────────────┐
    │ File System   │ │ Shell Command │ │ Subagent Task │
    │ Read/Write/Edt│ │ Bash / Git    │ │ Delegated Job │
    └───────┬───────┘ └───────┬───────┘ └───────┬───────┘
            └─────────────────┼─────────────────┘
                              │
                              ▼ (Sanitized Execution Result ≤ 30k chars)
  ┌───────────────────────────────────────────────────────┐
  │   Context Compaction Engine (Auto-Summarize @ 75%)    │
  └───────────────────────────┬───────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼ (Next Action Loop)            ▼ (Task Completed)
    ┌───────────────────┐           ┌───────────────────┐
    │ Feed History Back │           │ Claude-Style UI   │
    │ (↺ Next Turn Loop)│           │ Boxed Diff & Text │
    └─────────┬─────────┘           └─────────┬─────────┘
              │                               │
              └──► (Next Iteration)           ▼
                                  [ User Terminal / REPL ]
```

## Developing Ali Code

```bash
git clone https://github.com/ALIKAZMI001/ALI-CODE.git
cd ALI-CODE
npm install
cp .env.example .env        # Windows: copy .env.example .env
npm run dev                 # run from source with tsx
npm run build               # compile to dist/
npm run typecheck
npm test
npm link                    # use your working copy as the global `ali`
```

### Publishing a new version (maintainers)

The public npm package is `ali-code`. Anyone can then install it with
`npm install -g ali-code`.

```bash
npm login                   # once, with your npmjs.com account
npm version patch           # or minor / major — updates package.json and tags
npm run typecheck && npm test
npm pack --dry-run          # inspect exactly what will ship
npm publish                 # prepublishOnly re-runs typecheck + tests
```

The package contents are limited by the `files` allowlist in `package.json`:
only compiled `dist/**/*.js`, `README.md` and `.env.example` ship — no source,
tests, source maps or `.env` files. Compiled JavaScript is readable, as with
Claude Code and OpenCode.

For a scoped name instead (`@yourname/ali-code`), keep
`"publishConfig": { "access": "public" }` and run
`npm publish --access public`.

## Keys: pools, rotation and failover

Every provider accepts a comma-separated list. All keys are used, round-robin,
so several small free quotas behave like one bigger one:

```env
OPENROUTER_API_KEYS=sk-or-v1-aaa,sk-or-v1-bbb
GROQ_API_KEYS=gsk_aaa,gsk_bbb,gsk_ccc,gsk_ddd
ALI_FALLBACK_PROVIDERS=groq
```

What happens on failure:

| Failure | Behaviour |
|---|---|
| `401` / `403` bad key | key marked dead for the session, next key tried |
| `402` no credits | key marked dead, next key, then next provider |
| `429` rate limited | key cools down for 60s, next key |
| `5xx` / timeout | key cools down for 20s, next key |

The request is retried transparently on the next key or provider. If everything
is exhausted you get a plain explanation instead of a stack trace.

`/keys` shows the live state of every key. `/doctor` checks them against the
provider.

Because each key has its own free quota, the agent rotates keys between turns
(`/cost` shows the total burn). Prompt caching is per key, so rotation trades a
little cache reuse for much more headroom — a good trade on free tiers.

## Tools

Ali Code ships the full set of tools a coding agent normally needs:

| Tool | Purpose |
|---|---|
| `Read` | read a file with line numbers |
| `Write` | create or replace a file |
| `Edit` | exact-string edit |
| `MultiEdit` | several exact edits to one file in one call |
| `List` | list the tree |
| `Glob` | find files by pattern (`**/*.ts`) |
| `Grep` | regex content search |
| `Bash` | run a shell command |
| `NotebookRead` / `NotebookEdit` | read and edit `.ipynb` cells |
| `WebFetch` | fetch a URL as readable text |
| `WebSearch` | search the web |
| `Task` | delegate focused research to a subagent |
| `Update Todos` | maintain the visible task list |

Read-only tools run without asking. Edits and shell commands ask unless the mode
says otherwise. `Task` subagents use the same tools (except `task`, so they
cannot recurse) and report back a summary.

## Commands

| Command | What it does |
|---|---|
| `/help [command]` | list commands or explain one |
| `/status` | folder, provider, model, keys, git branch, todos |
| `/keys` | every key, its state, and cooldowns |
| `/doctor` | check node, `.env`, keys and connectivity |
| `/update [--yes]` | check npm for a newer version and install it |
| `/version` | print the installed version |
| `/model [id]` | show or change the model |
| `/models [filter]` | list models from the current provider |
| `/provider [name]` | list routes or switch provider |
| `/permissions [mode]` | show or change approval mode |
| `/plan` | toggle read-only plan mode |
| `/context` | context-window usage |
| `/cost` (alias `/usage`) | token usage this session |
| `/compact [hint]` | summarize history now |
| `/todos` | show the task list |
| `/undo` | revert the most recent file change |
| `/diff` | show uncommitted git changes |
| `/init` | analyze the repo and write `AGENTS.md` |
| `/review` | review uncommitted changes, no edits |
| `/export [path]` | write the transcript as markdown |
| `/resume [id]` | list or load a saved session |
| `/clear` | forget the conversation |
| `/exit` | quit |

Anything else is a message to the agent. `!command` runs a shell command
directly, with the same approval rules.

Start typing `/` and a palette appears under the input with every matching
command (aliases included). **Tab** completes the highlighted one; Tab again
cycles through the other matches. For example `/us` suggests `/usage` and
`/status`.

## Permission modes

| Mode | Edits | Commands | Status line |
|---|---|---|---|
| `default` | ask | ask | `? for shortcuts` |
| `accept-edits` | auto | ask | `⏵⏵ accept edits on` |
| `plan` | blocked | blocked (read-only investigation) | `⏸ plan mode on` |
| `yolo` | auto | auto | `⏵⏵ bypass permissions on` |

Set with `/permissions <mode>`, `--permission-mode`, or **shift+tab** to cycle
through `default → accept-edits → plan`. A small hard deny-list (`rm -rf /`,
disk formatting, drive-wide deletes, shutdown) applies in **every** mode,
including yolo. Paths are confined to the workspace root.

Writes and commands show a Claude Code-style confirmation:

```
⏺ Bash(npm test)

  npm test

Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for `npm test` commands
  3. No, and tell Ali what to do differently
```

## How it works

```
src/
  index.ts        CLI parsing, REPL, prompt, shift+tab, signals
  admin.ts        `ali config`, `ali doctor`, `ali update`
  paths.ts        package root, version, user data directory
  agent.ts        the loop: stream → tool calls → results → repeat
  keys.ts         key pools, round-robin rotation, failover, provider routing
  tools.ts        read/write/edit/multi-edit/glob/grep/list/shell/notebook/web/task/todo
  permissions.ts  tool schemas, approval modes, deny-list, previews
  commands.ts     slash commands
  session.ts      session persistence, undo snapshots, transcript export
  todos.ts        todo list state and rendering
  prompt.ts       system prompt (+ AGENTS.md / CLAUDE.md)
  config.ts       provider/model/key/mode resolution, .env parsing
  input.ts        readline wrapper that never loses a line
  ui.ts           Claude Code–style rendering, spinner, diffs
  util.ts         path sandboxing, tree walking, truncation
```

The loop in `Agent.run`:

1. Push the user message.
2. Compact history if it exceeds 75% of the context budget.
3. Stream a completion with `tools` + `tool_choice: "auto"`.
4. No tool calls? Done.
5. Otherwise run each call (with approval), append one `tool` message per call,
   and loop — up to `--max-iterations`.

Design choices worth stealing:

- **Exact-string edits.** `edit_file` refuses when `old_string` is missing or
  ambiguous, and refuses if the file was not read this session.
- **Truncation everywhere.** Tool output is capped at 30k chars (head + tail),
  reads at 2,000 lines. One runaway command cannot blow the context.
- **Stable system prompt.** Built once, so provider-side caching can hit.
- **Compaction.** Old turns are summarized; the kept tail never starts with an
  orphaned tool result.
- **Denial counter.** After three refusals in a turn the agent stops instead of
  arguing with you.
- **Undo snapshots.** Every write is snapshotted before it happens.
- **Persistent sessions.** Saved to `~/.ali-code/sessions/<folder-hash>/`, so
  your repo stays clean. Old `~/.mini` sessions are still readable.

## Configuration

Settings come from `~/.ali-code/.env` (written by `ali config set`), a `.env` in the folder you launch `ali` from, or real environment variables (see "Where things are stored"):

```env
# Optional. Leave everything out to use the shared community model.
ALI_PROVIDER=openrouter
ALI_MODEL=anthropic/claude-sonnet-4.5
ALI_FALLBACK_PROVIDERS=groq
OPENROUTER_API_KEYS=key1,key2
GROQ_API_KEYS=key1,key2
ALI_PERMISSION_MODE=default
```

The old `MINI_*` names still work.

## Adding a tool

1. Add a schema to `TOOL_DEFS` in `src/permissions.ts`.
2. Add a `case` in `executeTool` in `src/tools.ts`.
3. If it mutates anything, add a preview in `previewFor` and leave it out of
   `READ_ONLY_TOOLS`.
4. Add a `⏺` label in `toolLabel` and a `⎿` summary in `resultSummary`
   (both in `src/ui.ts` / `src/permissions.ts`).

## Testing

See [TESTING.md](TESTING.md). Short version:

```bash
npm test          # 42 offline tests, no API calls, no credits
```

## Security

This agent executes model-written shell commands on your machine. Keep approval
prompts on for unfamiliar repos, and never run `--yolo` on code you do not
trust. API keys sit in plaintext in `.env`; it is gitignored. Rotate any key that
leaks.
