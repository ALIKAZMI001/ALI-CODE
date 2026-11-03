import test from "node:test";
import assert from "node:assert/strict";
import { Permissions } from "../dist/permissions.js";

function makePermissions(mode, answer = "n") {
  const asked = [];
  const perms = new Permissions(async (question) => {
    asked.push(question);
    return answer;
  }, mode);
  return { perms, asked };
}

const request = (name, preview = "") => ({ name, summary: "", preview });

test("read-only tools are allowed without asking", async () => {
  const { perms, asked } = makePermissions("default");
  assert.equal(await perms.confirm(request("read_file")), true);
  assert.equal(await perms.confirm(request("search")), true);
  assert.equal(await perms.confirm(request("todo_write")), true);
  assert.deepEqual(asked, []);
});

test("default mode asks before writes", async () => {
  const { perms, asked } = makePermissions("default", "n");
  assert.equal(await perms.confirm(request("write_file")), false);
  assert.equal(asked.length, 1);
});

test("accept-edits auto-allows edits but still asks for commands", async () => {
  const { perms, asked } = makePermissions("accept-edits", "n");
  assert.equal(await perms.confirm(request("write_file")), true);
  assert.equal(await perms.confirm(request("edit_file")), true);
  assert.equal(await perms.confirm(request("run_command", "ls")), false);
  assert.equal(asked.length, 1);
});

test("plan mode blocks writes and commands", async () => {
  const { perms } = makePermissions("plan");
  assert.equal(await perms.confirm(request("write_file")), false);
  assert.equal(await perms.confirm(request("run_command", "ls")), false);
  assert.equal(await perms.confirm(request("read_file")), true);
});

test("yolo mode allows everything except the deny-list", async () => {
  const { perms } = makePermissions("yolo");
  assert.equal(await perms.confirm(request("write_file")), true);
  assert.equal(await perms.confirm(request("run_command", "npm test")), true);
  assert.equal(await perms.confirm(request("run_command", "rm -rf /")), false);
});

test("the deny-list beats an explicit yes", async () => {
  const { perms } = makePermissions("default", "y");
  assert.equal(await perms.confirm(request("run_command", "rm -rf /")), false);
  assert.equal(await perms.confirm(request("run_command", "shutdown -h now")), false);
});

test("always remembers the choice for the session", async () => {
  const { perms, asked } = makePermissions("default", "a");
  assert.equal(await perms.confirm(request("write_file")), true);
  assert.equal(await perms.confirm(request("write_file")), true);
  assert.equal(asked.length, 1, "only asked once");

  perms.reset();
  assert.ok(perms.autoAllowed().includes("read_file"));
});

test("closed stdin denies instead of hanging", async () => {
  const perms = new Permissions(async () => null, "default");
  assert.equal(await perms.confirm(request("write_file")), false);
});
