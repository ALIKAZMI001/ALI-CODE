import readline from "node:readline";
import { submittedMessage } from "./ui.js";

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
  private suggestionDrawn = false;
  private boxLine = true;
  private readonly rl: readline.Interface;
  private promptText = "> ";

  onInterrupt?: () => void;
  /** Shift+Tab, the Claude Code shortcut for cycling permission modes. */
  onCycleMode?: () => void;
  /** Return the command-palette line to draw, or null to hide it. */
  onSuggest?: (line: string) => string | null;
  /** Return the completion for Tab, or null when there is nothing to complete. */
  onComplete?: (line: string) => string | null;

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdin.isTTY),
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
          this.clearSuggestion();
          this.onCycleMode?.();
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

    if (process.stdin.isTTY) {
      this.rl.setPrompt(prompt);
      this.rl.prompt();
    } else {
      process.stdout.write(prompt);
    }

    if (this.queue.length > 0) {
      this.waiting = false;
      this.clearAfterSubmit();
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

  /** Redraw the live input line, e.g. after the permission mode changes. */
  reprompt(prompt?: string): void {
    if (!process.stdin.isTTY) return;
    this.clearSuggestion();
    if (prompt) {
      this.promptText = prompt;
      this.rl.setPrompt(prompt);
    }
    process.stdout.write("\r\u001b[2K");
    this.rl.prompt();
    setImmediate(() => this.refreshSuggestions());
  }

  get prompt(): string {
    return this.promptText;
  }

  /* ------------------------------------------------------------------ *
   * Suggestion line (below the input)
   * ------------------------------------------------------------------ */

  private desiredColumn(): number {
    const promptWidth = [...this.promptText.replace(ANSI, "")].length;
    return promptWidth + (this.rl.cursor ?? 0);
  }

  private moveToInput(): void {
    const column = this.desiredColumn();
    process.stdout.write("\r");
    if (column > 0) process.stdout.write(`\u001b[${column}C`);
  }

  private clearSuggestion(): void {
    if (!this.suggestionDrawn) return;
    process.stdout.write("\u001b[B\r\u001b[2K\u001b[A");
    this.suggestionDrawn = false;
    this.moveToInput();
  }

  /** After Enter, the cursor already sits on the suggestion line: wipe it. */
  private clearAfterSubmit(): void {
    if (!this.suggestionDrawn) return;
    process.stdout.write("\r\u001b[2K");
    this.suggestionDrawn = false;
  }

  /**
   * Replace the live prompt line with the framed, timestamped history entry.
   * The cursor is one line below the input after Enter (suggestion or blank).
   */
  private renderSubmitted(line: string): void {
    this.suggestionDrawn = false;
    if (!process.stdin.isTTY || !this.boxLine) return;

    process.stdout.write("\r\u001b[2K\u001b[A\r\u001b[2K");
    if (!line.trim()) return;

    process.stdout.write(submittedMessage(line) + "\n");
  }

  private refreshSuggestions(): void {
    if (!process.stdin.isTTY || !this.waiting || !this.onSuggest) return;

    const text = this.onSuggest(this.rl.line ?? "");
    this.clearSuggestion();
    if (!text) return;

    // "\n" makes room (scrolling if needed); "\u001b[A" climbs back to input.
    process.stdout.write("\n\r\u001b[2K" + text + "\u001b[A");
    this.suggestionDrawn = true;
    this.moveToInput();
  }

  /** Piped stdin is not echoed by the terminal, so keep the output readable. */
  private finishLine(line: string): string {
    if (!process.stdin.isTTY) process.stdout.write("\n");
    return line;
  }

  close(): void {
    this.clearSuggestion();
    this.finish();
    this.rl.close();
  }
}
