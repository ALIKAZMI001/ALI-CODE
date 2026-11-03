import test from "node:test";
import assert from "node:assert/strict";
import { KeyPool, maskKey, Router } from "../dist/keys.js";
import { PROVIDERS } from "../dist/config.js";

const entry = (value) => ({ value, label: maskKey(value), dead: false, cooldownUntil: 0 });

test("maskKey hides the middle of a key", () => {
  const masked = maskKey("sk-or-v1-1234567890abcdef");
  assert.ok(masked.startsWith("sk-or-v"), masked);
  assert.ok(masked.endsWith("cdef"), masked);
  assert.ok(!masked.includes("1234567890"), "middle hidden");
});

test("active() starts at the first key", () => {
  const pool = new KeyPool([entry("a"), entry("b"), entry("c")]);
  assert.equal(pool.active().value, "a");
});

test("rotate() cycles round-robin", () => {
  const pool = new KeyPool([entry("a"), entry("b"), entry("c")]);
  pool.rotate();
  assert.equal(pool.active().value, "b");
  pool.rotate();
  assert.equal(pool.active().value, "c");
  pool.rotate();
  assert.equal(pool.active().value, "a");
});

test("a 402 marks the key dead and moves to the next", () => {
  const pool = new KeyPool([entry("a"), entry("b")]);
  pool.penalize(402);
  assert.equal(pool.keys[0].dead, true);
  assert.equal(pool.keys[0].reason, "out of credits");
  assert.equal(pool.active().value, "b");
  assert.equal(pool.aliveCount(), 1);
});

test("a 401 marks the key rejected", () => {
  const pool = new KeyPool([entry("a"), entry("b")]);
  pool.penalize(401);
  assert.equal(pool.keys[0].reason, "rejected");
  assert.equal(pool.active().value, "b");
});

test("a 429 cools the key down instead of killing it", () => {
  const pool = new KeyPool([entry("a"), entry("b")]);
  pool.penalize(429);
  assert.equal(pool.keys[0].dead, false);
  assert.ok(pool.keys[0].cooldownUntil > Date.now());
  assert.equal(pool.active().value, "b");
  assert.equal(pool.aliveCount(), 1);
});

test("active() is null when every key is dead", () => {
  const pool = new KeyPool([entry("a"), entry("b")]);
  pool.penalize(401);
  pool.penalize(401);
  assert.equal(pool.active(), null);
});

test("failover moves to the next provider when a route is exhausted", () => {
  const route = (provider, keys) => ({
    provider,
    spec: PROVIDERS[provider],
    model: "test-model",
    pool: new KeyPool(keys.map(entry)),
  });

  const router = new Router([
    route("openrouter", ["a"]),
    route("groq", ["b"]),
  ]);

  assert.equal(router.provider, "openrouter");
  assert.equal(router.failover(401), true);
  assert.equal(router.provider, "groq");
  assert.equal(router.failover(401), false, "nothing left");
});

test("failover stays on the route when another key is healthy", () => {
  const route = (provider, keys) => ({
    provider,
    spec: PROVIDERS[provider],
    model: "test-model",
    pool: new KeyPool(keys.map(entry)),
  });

  const router = new Router([route("openrouter", ["a", "b"])]);
  assert.equal(router.failover(402), true);
  assert.equal(router.provider, "openrouter");
  assert.equal(router.key.value, "b");
});

test("switchProvider refuses a route without usable keys", () => {
  const route = (provider, keys) => ({
    provider,
    spec: PROVIDERS[provider],
    model: "test-model",
    pool: new KeyPool(keys.map(entry)),
  });

  const router = new Router([
    route("openrouter", ["a"]),
    route("groq", ["b"]),
  ]);
  router.routes[1].pool.penalize(401);
  assert.equal(router.switchProvider("groq"), false);
  assert.equal(router.provider, "openrouter");
});
