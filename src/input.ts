import readline from "node:readline";
import { submittedMessage, margin, boxWidth, topBorder, bottomBorder, style } from "./ui.js";

const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * Readline wrapper that never loses input. Lines that arrive before we ask a
 * question (piped input, fast typists) are queued instead of dropped.
 *
 * It also draws a one-line command palette under the prompt while you type a
 * slash command, and completes the highlighted command on Tab.
 */
export class LineReader {
  private queue: string[] = [];
  private waiters: Array<(line: string | null) => void> = [];
  private closed = false;
  private waiting = false;
  private framed = false;
  private boxLine = true;
  private readonly rl: readline.Interface;
  private promptText = "> ";

  onInterrupt?: () => void;
  /** Esc: cancel an in-progress response. Unlike onInterrupt, never exits the app. */
  onEscape?: () => void;
  /** Shift+Tab, the Claude Code shortcut for cycling permission modes. */
  onCycleMode?: () => void;
  /** Title shown in the top edge of the input box (current model). */
  onTitle?: () => string;
  /** The default hint row under the input box (mode status). */
  onHint?: () => string;
  /** Return the command-palette line to draw, or null to hide it. */
  onSuggest?: (line: string) => string | null;
  /** Return the completion for Tab, or null when there is nothing to complete. */
  onComplete?: (line: string) => string | null;

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdin.isTTY),
      // A lone Esc is ambiguous with the start of an arrow-key sequence, so
      // readline waits before reporting it (500 ms by default) — long enough
      // that tapping Esc to stop a response feels like nothing happened.
      escapeCodeTimeout: 50,
    });

    this.rl.on("line", (line) => {
      this.waiting = false;
      this.renderSubmitted(line);
      this.push(line);
    });
    this.rl.on("close", () => {
      this.waiting = false;
      this.finish();
    });
    this.rl.on("SIGINT", () => this.onInterrupt?.());

    if (process.stdin.isTTY) {
      readline.emitKeypressEvents(process.stdin, this.rl);
      process.stdin.on("keypress", (sequence, key) => {
        if (!key) return;

        if (key.name === "tab" && (key.shift || sequence === "\u001b[Z")) {
          this.onCycleMode?.();
          return;
        }

        if (key.name === "escape") {
          this.onEscape?.();
          return;
        }

        if (key.name === "tab") {
          const completion = this.onComplete?.(this.rl.line ?? "");
          if (completion) {
            // Ctrl+A then Ctrl+K: select the whole line, then type the command.
            this.rl.write(null, { ctrl: true, name: "a" });
            this.rl.write(null, { ctrl: true, name: "k" });
            this.rl.write(completion);
          }
          setImmediate(() => this.refreshSuggestions());
          return;
        }

        if (key.name === "return" || key.name === "enter") return;
        setImmediate(() => this.refreshSuggestions());
      });
    }
  }

  private push(line: string): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(line);
    else this.queue.push(line);
  }

  private finish(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.(null);
    }
  }

  /** Returns the next line, or null when stdin is closed. */
  ask(prompt: string, box = true): Promise<string | null> {
    this.promptText = prompt;
    this.boxLine = box;
    this.waiting = true;
    this.framed =
      box && Boolean(process.stdin.isTTY) && this.queue.length === 0 && !this.closed;

    if (process.stdin.isTTY) {
      if (this.framed) this.openFrame();
      this.rl.setPrompt(prompt);
      this.rl.prompt();
      if (this.framed) this.drawFrame();
    } else {
      process.stdout.write(prompt);
    }

    if (this.queue.length > 0) {
      this.waiting = false;
      return Promise.resolve(this.finishLine(this.queue.shift()!));
    }
    if (this.closed) {
      this.waiting = false;
      return Promise.resolve(null);
    }
    return new Promise((resolve) =>
      this.waiters.push((line) => resolve(line === null ? null : this.finishLine(line)))
    );
  }

  /**
   * Arrow-key menu. ↑/↓ (or k/j) move, 1-9 pick directly, Enter confirms,
   * Esc cancels. Resolves to the chosen index, or null on cancel / no TTY.
   * While open, readline's own key handling is detached so nothing is echoed.
   */
  select(
    count: number,
    render: (index: number, active: boolean) => string,
    initial = 0
  ): Promise<number | null> {
    if (!process.stdin.isTTY || this.closed || count <= 0) return Promise.resolve(null);

    return new Promise((resolve) => {
      const stdin = process.stdin;
      const out = process.stdout;
      const saved = stdin.listeners("keypress") as Array<(...args: any[]) => void>;
      for (const listener of saved) stdin.off("keypress", listener);

      let index = Math.min(Math.max(initial, 0), count - 1);
      const draw = (first: boolean): void => {
        if (!first) out.write(`\u001b[${count}A`);
        for (let i = 0; i < count; i++) {
          out.write("\r\u001b[2K" + render(i, i === index) + "\n");
        }
      };

      const finish = (result: number | null): void => {
        stdin.off("keypress", onKey);
        for (const listener of saved) stdin.on("keypress", listener);
        out.write("\u001b[?25h");
        resolve(result);
      };

      const onKey = (sequence: string, key: readline.Key | undefined): void => {
        if (!key) return;
        if (key.ctrl && key.name === "c") {
          finish(null);
          this.onInterrupt?.();
          return;
        }
        if (key.name === "up" || key.name === "k" || (key.name === "tab" && key.shift)) {
          index = (index - 1 + count) % count;
          draw(false);
        } else if (key.name === "down" || key.name === "j" || key.name === "tab") {
          index = (index + 1) % count;
          draw(false);
        } else if (key.name === "return" || key.name === "enter") {
          finish(index);
        } else if (key.name === "escape") {
          finish(null);
        } else if (sequence && /^[1-9]$/.test(sequence) && Number(sequence) <= count) {
          index = Number(sequence) - 1;
          draw(false);
          finish(index);
        }
      };

      out.write("\u001b[?25l");
      draw(true);
      stdin.on("keypress", onKey);
    });
  }

  /** Redraw the live input line, e.g. after the permission mode changes. */
  reprompt(prompt?: string): void {
    if (!process.stdin.isTTY) return;
    if (prompt) {
      this.promptText = prompt;
      this.rl.setPrompt(prompt);
    }
    process.stdout.write("\r\u001b[2K");
    this.rl.prompt();
    this.drawFrame();
    setImmediate(() => this.refreshSuggestions());
  }

  get prompt(): string {
    return this.promptText;
  }

  /* ------------------------------------------------------------------ *
   * Input box: ╭──╮ / │ > text │ / ╰──╯ plus a hint row underneath
   * ------------------------------------------------------------------ */

  /** Reserve rows for the box and put the cursor on the input row. */
  private openFrame(): void {
    const hint = this.onHint?.() ?? "";
    process.stdout.write(
      topBorder(this.onTitle?.() ?? "") + "\n" + "\n" + bottomBorder() + "\n" + hint + "\u001b[2A\r"
    );
  }

  /**
   * (Re)draw the right edge, bottom edge and hint row around the input row.
   * Skipped once the text is wide enough to wrap, since the box cannot grow.
   */
  private drawFrame(hint?: string): void {
    if (!this.framed || !process.stdin.isTTY) return;

    const promptWidth = [...this.promptText.replace(ANSI, "")].length;
    const used = promptWidth + [...(this.rl.line ?? "")].length;
    const rightCol = margin().length + boxWidth(); // 1-based column of "│"
    if (used + 1 >= rightCol) return;

    const row = hint ?? this.onHint?.() ?? "";
    process.stdout.write(
      "\u001b7" +
        `\r\u001b[${rightCol}G` +
        style.gray("│") +
        "\u001b[B\r\u001b[2K" +
        bottomBorder() +
        "\u001b[B\r\u001b[2K" +
        row +
        "\u001b8"
    );
  }

  /**
   * Replace the live input box with the framed, timestamped history entry.
   * After Enter the cursor sits on the row below the input.
   */
  private renderSubmitted(line: string): void {
    const wasFramed = this.framed;
    this.framed = false;
    if (!process.stdin.isTTY) return;

    // A long question wraps over several terminal rows: erase all of them.
    const cols = Math.max(1, process.stdout.columns ?? 80);
    const used = [...this.promptText.replace(ANSI, "")].length + [...line].length;
    const rows = Math.max(1, Math.ceil(used / cols));
    const up = wasFramed ? rows + 1 : rows;
    process.stdout.write("\r\u001b[2K" + "\u001b[A".repeat(up) + "\r\u001b[J");
    if (!this.boxLine || !line.trim()) return;

    process.stdout.write(submittedMessage(line) + "\n");
  }

  private refreshSuggestions(): void {
    if (!process.stdin.isTTY || !this.waiting || !this.framed) return;
    const text = this.onSuggest?.(this.rl.line ?? "") ?? null;
    this.drawFrame(text ?? undefined);
  }

  /** Piped stdin is not echoed by the terminal, so keep the output readable. */
  private finishLine(line: string): string {
    if (!process.stdin.isTTY) process.stdout.write("\n");
    return line;
  }

  close(): void {
    this.finish();
    this.rl.close();
  }
}
