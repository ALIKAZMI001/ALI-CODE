import { style } from "./ui.js";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  content: string;
  status: TodoStatus;
}

const SYMBOL: Record<TodoStatus, string> = {
  pending: "☐",
  in_progress: "☐",
  completed: "☒",
};

export class TodoList {
  items: Todo[] = [];

  set(items: Todo[]): void {
    this.items = items
      .filter((item) => item && typeof item.content === "string" && item.content.trim())
      .map((item) => ({
        content: String(item.content).trim(),
        status: (["pending", "in_progress", "completed"] as TodoStatus[]).includes(
          item.status
        )
          ? item.status
          : "pending",
      }));
  }

  load(items: Todo[] | undefined): void {
    if (Array.isArray(items)) this.set(items);
  }

  get done(): number {
    return this.items.filter((item) => item.status === "completed").length;
  }

  summary(): string {
    if (this.items.length === 0) return "no todos";
    return `${this.done}/${this.items.length} done`;
  }

  renderLines(): string[] {
    if (this.items.length === 0) return ["No todos"];
    return this.items.map((item) => {
      const symbol = SYMBOL[item.status];
      const text =
        item.status === "completed"
          ? style.gray(item.content)
          : item.status === "in_progress"
            ? style.bold(item.content)
            : item.content;
      return `${symbol} ${text}`;
    });
  }

  render(): string {
    if (this.items.length === 0) return style.gray("  no todos");
    return this.renderLines()
      .map((line) => `  ${line}`)
      .join("\n");
  }
}
