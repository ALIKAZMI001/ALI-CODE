import test from "node:test";
import assert from "node:assert/strict";
import { collectKeys } from "../dist/config.js";
import { transcriptMarkdown } from "../dist/session.js";

test("collectKeys filters keys that belong to another provider", () => {
  process.env.OPENROUTER_API_KEYS = "gsk_wrong,sk-or-aaa,sk-or-bbb";
  assert.deepEqual(collectKeys("openrouter"), ["sk-or-aaa", "sk-or-bbb"]);
  delete process.env.OPENROUTER_API_KEYS;
});

test("an explicit key list wins over a stale single-key variable", () => {
  process.env.GROQ_API_KEYS = "gsk_pool1,gsk_pool2";
  process.env.GROQ_API_KEY = "gsk_stale";
  assert.deepEqual(collectKeys("groq"), ["gsk_pool1", "gsk_pool2"]);
  delete process.env.GROQ_API_KEYS;
  delete process.env.GROQ_API_KEY;
});

test("duplicate keys are removed", () => {
  process.env.GROQ_API_KEYS = "gsk_a,gsk_a,gsk_b";
  assert.deepEqual(collectKeys("groq"), ["gsk_a", "gsk_b"]);
  delete process.env.GROQ_API_KEYS;
});

test("transcriptMarkdown keeps user turns and skips compaction summaries", () => {
  const markdown = transcriptMarkdown({
    id: "abc",
    cwd: "C:/repo",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:10:00.000Z",
    provider: "openrouter",
    model: "test-model",
    usage: { prompt: 10, completion: 5, requests: 1 },
    todos: [],
    messages: [
      { role: "user", content: "fix the bug" },
      { role: "assistant", content: "On it.", tool_calls: [] },
      { role: "user", content: "<compacted-summary>\nold stuff\n</compacted-summary>" },
    ],
  });

  assert.match(markdown, /# Ali Code session abc/);
  assert.match(markdown, /fix the bug/);
  assert.match(markdown, /On it\./);
  assert.doesNotMatch(markdown, /old stuff/);
});
