import type OpenAI from "openai";
import type { Config } from "./config.js";
import { executeTool, type ToolContext } from "./tools.js";
import { TOOL_DEFS, summarizeCall, previewFor, resultSummary, type Permissions } from "./permissions.js";
import { buildSystemPrompt } from "./prompt.js";
import { TodoList } from "./todos.js";
import {
  History,
  type PersistedSession,
  type Store,
  type Usage,
} from "./session.js";
import type { Router } from "./keys.js";
import * as ui from "./ui.js";
import { oneLine } from "./util.js";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

interface PendingCall {
  id: string;
  name: string;
  args: string;
}

export interface RunResult {
  ok: boolean;
  aborted: boolean;
}

const FAILOVER_STATUS = new Set([401, 402, 403, 404, 408, 409, 429, 500, 502, 503, 504]);

export class Agent {
  messages: Msg[] = [];
  readonly todos = new TodoList();
  readonly history = new History();
  readonly usage: Usage = { prompt: 0, completion: 0, requests: 0 };

  private system: string;
  private ctx: ToolContext;
  private abort: AbortController | null = null;
  private denials = 0;
  private createdAt: string;

  constructor(
    private router: Router,
    private cfg: Config,
    private perms: Permissions,
    private store: Store,
    public sessionId: string = "session",
    createdAt?: string
  ) {
    this.createdAt = createdAt ?? new Date().toISOString();
    this.system = buildSystemPrompt(cfg.cwd);
    this.ctx = {
      cwd: cfg.cwd,
      readFiles: new Set(),
      history: this.history,
      todos: this.todos,
      runSubagent: (prompt) => this.runSubagent(prompt),
    };
  }

  get busy(): boolean {
    return this.abort !== null;
  }

  get model(): string {
    return this.router.model;
  }

  get providerLabel(): string {
    return this.router.providerLabel;
  }

  clear(): void {
    this.messages = [];
    this.ctx.readFiles.clear();
    this.history.clear();
    this.todos.set([]);
    this.usage.prompt = 0;
    this.usage.completion = 0;
    this.usage.requests = 0;
  }

  interrupt(): void {
    this.abort?.abort();
  }

  /* ------------------------------------------------------------------ *
   * The loop
   * ------------------------------------------------------------------ */

  async run(userInput: string): Promise<RunResult> {
    this.messages.push({ role: "user", content: userInput });
    this.abort = new AbortController();
    this.denials = 0;
    let succeeded = false;

    try {
      for (let iteration = 0; iteration < this.cfg.maxIterations; iteration++) {
        await this.maybeCompact();

        const { text, calls } = await this.withFailover(() => this.streamTurn());

        if (text.trim() || calls.length > 0) {
          this.messages.push({
            role: "assistant",
            content: text.trim() ? text : null,
            tool_calls: calls.length
              ? calls.map((call) => ({
                  id: call.id,
                  type: "function" as const,
                  function: { name: call.name, arguments: call.args || "{}" },
                }))
              : undefined,
          });
        }

        if (calls.length === 0) {
          succeeded = true;
          return { ok: true, aborted: false };
        }

        for (const call of calls) {
          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: await this.handleToolCall(call),
          });
        }

        if (this.denials >= 3) {
          ui.warn("Three tool calls were denied. Stopping — tell me how you'd like to proceed.");
          return { ok: false, aborted: false };
        }
      }

      ui.warn(
        `Stopped after ${this.cfg.maxIterations} tool iterations. Ask me to continue if you want.`
      );
      return { ok: false, aborted: false };
    } catch (err: any) {
      if (err?.name === "AbortError" || this.abort?.signal.aborted) {
        ui.assistantEnd();
        ui.info("  ⎿  Interrupted by user");
        return { ok: false, aborted: true };
      }
      ui.assistantEnd();
      const status = err?.status ? ` (HTTP ${err.status})` : "";
      ui.error(`\nAPI error${status}: ${err?.message ?? String(err)}`);
      this.explainApiError(err);
      return { ok: false, aborted: false };
    } finally {
      this.abort = null;
      if (succeeded) this.router.nextKey();
      this.persist();
    }
  }

  private explainApiError(err: any): void {
    if (err?.status === 401 || err?.status === 403) {
      ui.info(
        `All keys for ${this.router.providerLabel} were rejected. Run /keys, or add a working key to .env.`
      );
    } else if (err?.status === 402) {
      ui.info(
        "Out of credits on every configured key. Add credits or use a ':free' model (see /models free)."
      );
    } else if (err?.status === 429) {
      ui.info("Every key is rate limited. Wait a minute, or run /keys to inspect cooldowns.");
    } else if (err?.status === 404) {
      ui.info(`Model "${this.router.model}" may not exist for ${this.router.providerLabel}. Try /models.`);
    }
  }

  /** Retry transient/auth failures against the next key or provider. */
  private async withFailover<T>(fn: () => Promise<T>): Promise<T> {
    const attempts = this.router.maxAttempts();
    let lastError: any;

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        lastError = err;
        if (err?.name === "AbortError" || this.abort?.signal.aborted) throw err;

        const status = Number(err?.status ?? 0);
        if (!FAILOVER_STATUS.has(status)) throw err;

        const from = this.router.describe();
        if (!this.router.failover(status)) throw err;

        ui.assistantEnd();
        ui.warn(`  ↻ ${status} on ${from} — retrying with ${this.router.describe()}`);
      }
    }

    throw lastError;
  }

  private async streamTurn(): Promise<{ text: string; calls: PendingCall[] }> {
    ui.startThinking();

    const stream = await this.router.client().chat.completions.create(
      {
        model: this.router.model,
        messages: [{ role: "system", content: this.system }, ...this.messages],
        tools: TOOL_DEFS,
        tool_choice: "auto",
        max_tokens: this.cfg.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: this.abort?.signal }
    );

    let text = "";
    const byIndex = new Map<number, PendingCall>();

    for await (const chunk of stream) {
      if (chunk.usage) {
        this.usage.prompt += chunk.usage.prompt_tokens ?? 0;
        this.usage.completion += chunk.usage.completion_tokens ?? 0;
        this.usage.requests++;
      }

      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        text += delta.content;
        ui.assistantDelta(delta.content);
      }

      for (const tc of delta.tool_calls ?? []) {
        const index = tc.index ?? 0;
        const current = byIndex.get(index) ?? { id: "", name: "", args: "" };
        if (tc.id) current.id = tc.id;
        if (tc.function?.name) current.name = tc.function.name;
        if (tc.function?.arguments) current.args += tc.function.arguments;
        byIndex.set(index, current);
      }
    }

    ui.assistantEnd();

    const calls = [...byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => call)
      .filter((call) => call.name);

    return { text, calls };
  }

  private async handleToolCall(call: PendingCall): Promise<string> {
    let input: any;
    try {
      input = call.args ? JSON.parse(call.args) : {};
    } catch {
      ui.toolStart(call.name, "(bad arguments)");
      ui.toolEnd(false, "invalid JSON arguments");
      return `Error: could not parse tool arguments as JSON: ${call.args.slice(0, 200)}`;
    }

    ui.toolStart(
      call.name,
      summarizeCall(call.name, input),
      call.name === "run_command" ? new Date() : undefined
    );

    const approved = await this.perms.confirm({
      name: call.name,
      summary: summarizeCall(call.name, input),
      preview: previewFor(call.name, input, this.cfg.cwd),
    });

    if (!approved) {
      this.denials++;
      ui.toolEnd(false, "denied");
      return "Error: the user denied this tool call. Do not retry it. Ask the user what they want instead, or stop.";
    }

    try {
      const result = await executeTool(call.name, input, this.ctx);
      if (call.name === "todo_write") {
        ui.toolEnd(true, this.todos.renderLines());
      } else {
        ui.toolEnd(true, resultSummary(call.name, input, result));
      }
      return result;
    } catch (err: any) {
      ui.toolEnd(false, oneLine(err?.message ?? String(err), 90));
      return `Error: ${err?.message ?? String(err)}`;
    }
  }

  /* ------------------------------------------------------------------ *
   * Direct shell commands (`!cmd`)
   * ------------------------------------------------------------------ */

  async runShell(command: string): Promise<void> {
    if (!command.trim()) return;

    const approved = await this.perms.confirm({
      name: "run_command",
      summary: command,
      preview: previewFor("run_command", { command }, this.cfg.cwd),
    });
    if (!approved) {
      ui.info("cancelled");
      return;
    }

    ui.toolStart("run_command", command, new Date());
    try {
      const output = await executeTool("run_command", { command }, this.ctx);
      ui.assistantEnd();
      ui.toolEnd(true, resultSummary("run_command", { command }, output));
    } catch (err: any) {
      ui.toolEnd(false, oneLine(err?.message ?? String(err), 90));
    }
  }

  /* ------------------------------------------------------------------ *
   * Subagents (the `task` tool)
   * ------------------------------------------------------------------ */

  private async runSubagent(prompt: string): Promise<string> {
    const tools = TOOL_DEFS.filter((tool) => tool.function.name !== "task");
    const subSystem =
      this.system +
      "\n\n# Subagent\nYou are a focused subagent. You cannot ask the user questions. " +
      "Investigate, use tools, and finish with a concise report for the main agent.";

    const messages: Msg[] = [{ role: "user", content: prompt }];
    let finalText = "";

    for (let iteration = 0; iteration < 8; iteration++) {
      const response = await this.withFailover(() =>
        this.router.client().chat.completions.create({
          model: this.router.model,
          messages: [{ role: "system", content: subSystem }, ...messages],
          tools,
          tool_choice: "auto",
          max_tokens: this.cfg.maxTokens,
        })
      );

      if (response.usage) {
        this.usage.prompt += response.usage.prompt_tokens ?? 0;
        this.usage.completion += response.usage.completion_tokens ?? 0;
        this.usage.requests++;
      }

      const message = response.choices[0]?.message;
      if (!message) break;

      if (message.content) finalText = message.content;

      const calls: PendingCall[] = (message.tool_calls ?? [])
        .filter((call) => call.type === "function")
        .map((call) => ({
          id: call.id,
          name: call.function.name,
          args: call.function.arguments,
        }));

      messages.push({
        role: "assistant",
        content: message.content || null,
        tool_calls: message.tool_calls,
      } as Msg);

      if (calls.length === 0) break;

      for (const call of calls) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: await this.handleToolCall(call),
        });
      }
    }

    return finalText.trim() || "Subagent finished without a written summary.";
  }

  /* ------------------------------------------------------------------ *
   * Context management
   * ------------------------------------------------------------------ */

  estimateContext(): number {
    let chars = this.system.length;
    for (const message of this.messages) {
      if (typeof message.content === "string") chars += message.content.length;
      else if (Array.isArray(message.content)) chars += JSON.stringify(message.content).length;
      if ("tool_calls" in message && message.tool_calls) {
        chars += JSON.stringify(message.tool_calls).length;
      }
    }
    return Math.ceil(chars / 4) + 2000;
  }

  contextReport(): string {
    const used = this.estimateContext();
    const pct = Math.min(100, Math.round((used / this.cfg.maxContextTokens) * 100));
    const filled = Math.round((pct / 100) * 24);
    const bar = "█".repeat(filled) + "░".repeat(Math.max(0, 24 - filled));
    return [
      `context   ${used.toLocaleString()} / ${this.cfg.maxContextTokens.toLocaleString()} tokens  ${bar} ${pct}%`,
      `history   ${this.messages.length} messages · ${this.ctx.readFiles.size} files read`,
      `todos     ${this.todos.summary()}`,
      `session   ${this.sessionId}  (${this.store.dir})`,
    ].join("\n");
  }

  usageReport(): string {
    return [
      `requests  ${this.usage.requests}`,
      `input     ${this.usage.prompt.toLocaleString()} tokens`,
      `output    ${this.usage.completion.toLocaleString()} tokens`,
      `total     ${(this.usage.prompt + this.usage.completion).toLocaleString()} tokens`,
    ].join("\n");
  }

  private async maybeCompact(): Promise<void> {
    if (this.estimateContext() < this.cfg.maxContextTokens * 0.75) return;
    await this.compact(false);
  }

  async forceCompact(hint?: string): Promise<void> {
    const did = await this.compact(true, hint);
    if (!did) ui.info("nothing to compact yet");
  }

  private async compact(force: boolean, hint?: string): Promise<boolean> {
    const keep = force ? 4 : 6;
    if (this.messages.length < 4) return false;
    // Force-compacting fewer than `keep` messages would delete everything.
    if (force && this.messages.length <= keep) return false;

    let cut = Math.max(0, this.messages.length - keep);
    // Never start the kept tail with a tool result: it would be orphaned.
    while (cut < this.messages.length && this.messages[cut].role !== "user") cut++;
    if (cut <= 0 || cut >= this.messages.length) return false;

    const older = this.messages.slice(0, cut);
    const recent = this.messages.slice(cut);
    const transcript = older
      .map((message) => {
        const content =
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content);
        return `[${message.role}] ${content}`;
      })
      .join("\n")
      .slice(-60_000);

    ui.startThinking("Compacting conversation");

    try {
      const response = await this.withFailover(() =>
        this.router.client().chat.completions.create({
          model: this.router.model,
          messages: [
            {
              role: "system",
              content:
                "Summarize this coding-agent transcript for another agent that will continue the work. Preserve: the user's goal, files touched, decisions made, errors hit, and what is still pending. Be specific and terse.",
            },
            {
              role: "user",
              content:
                (hint ? `Focus: ${hint}\n\n` : "") + transcript,
            },
          ],
          max_tokens: 1500,
        })
      );

      ui.stopThinking();

      if (response.usage) {
        this.usage.prompt += response.usage.prompt_tokens ?? 0;
        this.usage.completion += response.usage.completion_tokens ?? 0;
        this.usage.requests++;
      }

      const summary = response.choices[0]?.message?.content?.trim();
      if (!summary) return false;

      this.messages = [
        { role: "user", content: `<compacted-summary>\n${summary}\n</compacted-summary>` },
        ...recent,
      ];
      return true;
    } catch {
      ui.stopThinking();
      ui.warn("compaction failed; continuing with the full history");
      return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * Persistence
   * ------------------------------------------------------------------ */

  transcript(): PersistedSession {
    return {
      id: this.sessionId,
      cwd: this.cfg.cwd,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      provider: this.router.provider,
      model: this.router.model,
      messages: this.messages,
      todos: this.todos.items,
      usage: { ...this.usage },
    };
  }

  persist(): void {
    this.store.save(this.transcript());
  }

  restore(session: PersistedSession): void {
    this.messages = (Array.isArray(session.messages) ? session.messages : []) as Msg[];
    this.todos.load(session.todos as any);
    if (session.usage) {
      this.usage.prompt = session.usage.prompt ?? 0;
      this.usage.completion = session.usage.completion ?? 0;
      this.usage.requests = session.usage.requests ?? 0;
    }
    this.sessionId = session.id;
    this.createdAt = session.createdAt;
    this.ctx.readFiles.clear();
  }
}
