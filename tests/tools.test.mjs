import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeTool } from "../dist/tools.js";
import { History } from "../dist/session.js";
import { TodoList } from "../dist/todos.js";

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mini-test-"));
}

function makeCtx(cwd) {
  return {
    cwd,
    readFiles: new Set(),
    history: new History(),
    todos: new TodoList(),
  };
}

test("write_file creates a file, read_file returns it with line numbers", async () => {
  const cwd = workspace();
  const ctx = makeCtx(cwd);

  await executeTool("write_file", { path: "notes/a.txt", content: "one\ntwo\n" }, ctx);

  assert.equal(fs.readFileSync(path.join(cwd, "notes/a.txt"), "utf8"), "one\ntwo\n");

  const out = await executeTool("read_file", { path: "notes/a.txt" }, ctx);
  assert.match(out, /1\s+one/);
  assert.match(out, /2\s+two/);
  assert.ok(ctx.readFiles.size >= 1, "read_file records the file");
});

test("edit_file refuses to run before the file was read", async () => {
  const cwd = workspace();
  fs.writeFileSync(path.join(cwd, "a.txt"), "hello world");
  const ctx = makeCtx(cwd);

  await assert.rejects(
    () => executeTool("edit_file", { path: "a.txt", old_string: "world", new_string: "there" }, ctx),
    /read_file/
  );
});

test("edit_file replaces a unique string after reading", async () => {
  const cwd = workspace();
  fs.writeFileSync(path.join(cwd, "a.txt"), "hello world");
  const ctx = makeCtx(cwd);
  await executeTool("read_file", { path: "a.txt" }, ctx);

  const out = await executeTool(
    "edit_file",
    { path: "a.txt", old_string: "world", new_string: "agent" },
    ctx
  );

  assert.match(out, /replaced 1 occurrence/);
  assert.equal(fs.readFileSync(path.join(cwd, "a.txt"), "utf8"), "hello agent");
});

test("edit_file rejects an ambiguous old_string", async () => {
  const cwd = workspace();
  fs.writeFileSync(path.join(cwd, "a.txt"), "x\nx\n");
  const ctx = makeCtx(cwd);
  await executeTool("read_file", { path: "a.txt" }, ctx);

  await assert.rejects(
    () => executeTool("edit_file", { path: "a.txt", old_string: "x", new_string: "y" }, ctx),
    /appears 2 times/
  );
});

test("edit_file replace_all replaces every occurrence", async () => {
  const cwd = workspace();
  fs.writeFileSync(path.join(cwd, "a.txt"), "x\nx\n");
  const ctx = makeCtx(cwd);
  await executeTool("read_file", { path: "a.txt" }, ctx);

  await executeTool(
    "edit_file",
    { path: "a.txt", old_string: "x", new_string: "y", replace_all: true },
    ctx
  );

  assert.equal(fs.readFileSync(path.join(cwd, "a.txt"), "utf8"), "y\ny\n");
});

test("edit_file rejects a missing old_string with a helpful error", async () => {
  const cwd = workspace();
  fs.writeFileSync(path.join(cwd, "a.txt"), "hello");
  const ctx = makeCtx(cwd);
  await executeTool("read_file", { path: "a.txt" }, ctx);

  await assert.rejects(
    () => executeTool("edit_file", { path: "a.txt", old_string: "nope", new_string: "x" }, ctx),
    /not found/
  );
});

test("tools refuse paths outside the workspace", async () => {
  const cwd = workspace();
  const ctx = makeCtx(cwd);

  await assert.rejects(
    () => executeTool("read_file", { path: "../../etc/passwd" }, ctx),
    /outside the workspace/
  );
  await assert.rejects(
    () => executeTool("write_file", { path: "../escape.txt", content: "x" }, ctx),
    /outside the workspace/
  );
});

test("search finds matches and reports line numbers", async () => {
  const cwd = workspace();
  fs.writeFileSync(path.join(cwd, "a.js"), "const needle = 1;\n");
  fs.writeFileSync(path.join(cwd, "b.js"), "nothing here\n");
  const ctx = makeCtx(cwd);

  const out = await executeTool("search", { pattern: "needle" }, ctx);
  assert.match(out, /a\.js:1:/);
  assert.doesNotMatch(out, /b\.js:/);
});

test("list_files skips node_modules and build output", async () => {
  const cwd = workspace();
  fs.mkdirSync(path.join(cwd, "node_modules/pkg"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "node_modules/pkg/index.js"), "x");
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src/app.js"), "x");
  const ctx = makeCtx(cwd);

  const out = await executeTool("list_files", {}, ctx);
  assert.match(out, /src\/app\.js/);
  assert.doesNotMatch(out, /node_modules/);
});

test("run_command runs and reports the exit code", async () => {
  const cwd = workspace();
  const ctx = makeCtx(cwd);

  const out = await executeTool("run_command", { command: "echo hello-from-test" }, ctx);
  assert.match(out, /exit code: 0/);
  assert.match(out, /hello-from-test/);
});

test("run_command reports a non-zero exit code", async () => {
  const cwd = workspace();
  const ctx = makeCtx(cwd);

  const out = await executeTool("run_command", { command: "exit 3" }, ctx);
  assert.match(out, /exit code: [13]/);
});

test("todo_write stores and summarises the list", async () => {
  const cwd = workspace();
  const ctx = makeCtx(cwd);

  const out = await executeTool(
    "todo_write",
    {
      todos: [
        { content: "first", status: "completed" },
        { content: "second", status: "in_progress" },
      ],
    },
    ctx
  );

  assert.equal(ctx.todos.items.length, 2);
  assert.equal(ctx.todos.done, 1);
  assert.match(out, /1\/2 done/);
});

test("history.undo restores the previous file contents", async () => {
  const cwd = workspace();
  const file = path.join(cwd, "a.txt");
  fs.writeFileSync(file, "before");
  const ctx = makeCtx(cwd);

  await executeTool("read_file", { path: "a.txt" }, ctx);
  await executeTool("edit_file", { path: "a.txt", old_string: "before", new_string: "after" }, ctx);
  assert.equal(fs.readFileSync(file, "utf8"), "after");

  const undone = ctx.history.undo();
  assert.ok(undone);
  assert.equal(fs.readFileSync(file, "utf8"), "before");
});

test("history.undo deletes a file that was created", async () => {
  const cwd = workspace();
  const ctx = makeCtx(cwd);

  await executeTool("write_file", { path: "new.txt", content: "x" }, ctx);
  assert.ok(fs.existsSync(path.join(cwd, "new.txt")));

  ctx.history.undo();
  assert.ok(!fs.existsSync(path.join(cwd, "new.txt")));
});
