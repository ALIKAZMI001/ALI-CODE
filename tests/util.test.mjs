import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveInside, truncate, countOccurrences } from "../dist/util.js";

const CWD = path.resolve("C:/work/repo");

test("resolveInside accepts nested paths", () => {
  assert.equal(resolveInside(CWD, "src/index.ts"), path.join(CWD, "src/index.ts"));
});

test("resolveInside rejects .. escapes", () => {
  assert.throws(() => resolveInside(CWD, "../secrets.txt"), /outside the workspace/);
  assert.throws(() => resolveInside(CWD, "src/../../etc/passwd"), /outside the workspace/);
});

test("resolveInside rejects absolute paths outside", () => {
  assert.throws(() => resolveInside(CWD, "C:/Windows/System32/drivers/etc/hosts"), /outside/);
});

test("countOccurrences counts non-overlapping matches", () => {
  assert.equal(countOccurrences("aaaa", "aa"), 2);
  assert.equal(countOccurrences("abcabc", "abc"), 2);
  assert.equal(countOccurrences("abc", "zzz"), 0);
  assert.equal(countOccurrences("abc", ""), 0);
});

test("truncate keeps the head and the tail", () => {
  const text = "A".repeat(1000) + "MIDDLE" + "B".repeat(1000);
  const out = truncate(text, 200);
  assert.ok(out.length < 400, "should shrink");
  assert.ok(out.startsWith("A"), "keeps head");
  assert.ok(out.endsWith("B"), "keeps tail");
  assert.match(out, /characters omitted/);
});

test("truncate leaves short text alone", () => {
  assert.equal(truncate("hello", 100), "hello");
});
