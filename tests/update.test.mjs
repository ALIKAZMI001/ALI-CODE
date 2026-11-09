import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions, isSourceCheckout, updateCommand } from "../dist/admin.js";
import { findCommand, helpText } from "../dist/commands.js";

test("compareVersions orders by number, not by string", () => {
  assert.equal(compareVersions("1.0.2", "1.0.3"), -1);
  assert.equal(compareVersions("1.0.3", "1.0.2"), 1);
  assert.equal(compareVersions("1.0.3", "1.0.3"), 0);
  // "1.0.10" is newer than "1.0.9" even though it sorts first as a string.
  assert.equal(compareVersions("1.0.9", "1.0.10"), -1);
  assert.equal(compareVersions("1.2.0", "1.10.0"), -1);
  assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
});

test("updateCommand installs the published package globally", () => {
  assert.equal(updateCommand(), "npm install -g ali-code@latest");
});

test("running from the repo counts as a source checkout, so update never overwrites it", () => {
  // The tests run against dist/ inside the repo, which has src/ and .git next to it.
  assert.equal(isSourceCheckout(), true);
});

test("/update is registered, aliased as /upgrade, and listed in /help", () => {
  const command = findCommand("update");
  assert.ok(command, "/update should exist");
  assert.equal(findCommand("upgrade"), command);
  assert.match(helpText(), /\/update/);
});
