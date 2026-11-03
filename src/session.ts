import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export interface Usage {
  prompt: number;
  completion: number;
  requests: number;
}

export interface PersistedSession {
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  provider: string;
  model: string;
  messages: unknown[];
  todos: unknown[];
  usage: Usage;
}

export function newSessionId(): string {
  return crypto.randomBytes(4).toString("hex");
}

/** Sessions live under ~/.ali-code so they never pollute the user's repo. */
export class Store {
  readonly dir: string;
  readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
    const hash = crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 12);

    // Keep using ~/.mini when it is the only one that exists, so old sessions
    // stay resumable after the rename.
    const home = os.homedir();
    const preferred = path.join(home, ".ali-code");
    const legacy = path.join(home, ".mini");
    const root =
      fs.existsSync(preferred) || !fs.existsSync(legacy) ? preferred : legacy;

    this.dir = path.join(root, "sessions", hash);
  }

  save(session: PersistedSession): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(
        path.join(this.dir, `${session.id}.json`),
        JSON.stringify(session, null, 2),
        "utf8"
      );
    } catch {
      /* never let persistence break a run */
    }
  }

  list(): Array<{ id: string; updatedAt: string; turns: number; model: string }> {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }

    const sessions: Array<{ id: string; updatedAt: string; turns: number; model: string }> = [];
    for (const name of names) {
      const data = this.read(path.join(this.dir, name));
      if (!data) continue;
      sessions.push({
        id: data.id,
        updatedAt: data.updatedAt,
        turns: data.messages.length,
        model: data.model,
      });
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  load(id: string): PersistedSession | null {
    return this.read(path.join(this.dir, `${id}.json`));
  }

  latest(): PersistedSession | null {
    const first = this.list()[0];
    return first ? this.load(first.id) : null;
  }

  private read(file: string): PersistedSession | null {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as PersistedSession;
    } catch {
      return null;
    }
  }
}

export interface UndoEntry {
  path: string;
  before: string | null;
  at: number;
}

/** In-memory file snapshots so /undo can roll back the last edit. */
export class History {
  private stack: UndoEntry[] = [];

  get size(): number {
    return this.stack.length;
  }

  snapshot(absolutePath: string): void {
    let before: string | null = null;
    try {
      before = fs.readFileSync(absolutePath, "utf8");
    } catch {
      before = null;
    }
    this.stack.push({ path: absolutePath, before, at: Date.now() });
    if (this.stack.length > 100) this.stack.shift();
  }

  undo(): { path: string; recreated: boolean } | null {
    const entry = this.stack.pop();
    if (!entry) return null;

    if (entry.before === null) {
      try {
        fs.unlinkSync(entry.path);
      } catch {
        /* already gone */
      }
      return { path: entry.path, recreated: false };
    }

    fs.mkdirSync(path.dirname(entry.path), { recursive: true });
    fs.writeFileSync(entry.path, entry.before, "utf8");
    return { path: entry.path, recreated: true };
  }

  clear(): void {
    this.stack = [];
  }
}

export function transcriptMarkdown(session: PersistedSession): string {
  const lines: string[] = [
    `# Ali Code session ${session.id}`,
    ``,
    `- folder: \`${session.cwd}\``,
    `- model: ${session.provider} / ${session.model}`,
    `- started: ${session.createdAt}`,
    `- updated: ${session.updatedAt}`,
    `- tokens: ${session.usage.prompt} in / ${session.usage.completion} out`,
    ``,
  ];

  for (const raw of session.messages) {
    const message = raw as any;
    if (message.role === "user") {
      const text =
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content);
      if (text.startsWith("<compacted-summary>")) continue;
      lines.push(`## User`, ``, text, ``);
    } else if (message.role === "assistant") {
      if (message.content) lines.push(`### Assistant`, ``, String(message.content), ``);
      for (const call of message.tool_calls ?? []) {
        lines.push(`> tool \`${call.function?.name}\` \`${String(call.function?.arguments).slice(0, 400)}\``, ``);
      }
    }
  }

  return lines.join("\n");
}
