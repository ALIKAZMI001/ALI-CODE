import OpenAI from "openai";
import {
  PROVIDERS,
  collectKeys,
  type Config,
  type ProviderName,
  type ProviderSpec,
} from "./config.js";

export interface KeyEntry {
  value: string;
  label: string;
  dead: boolean;
  reason?: string;
  cooldownUntil: number;
}

export function maskKey(key: string): string {
  if (key.length <= 12) return key.slice(0, 4) + "…";
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

/**
 * A rotating pool of API keys for one provider.
 * Dead keys are skipped for the rest of the session; rate-limited keys get a
 * cooldown. Round-robin spreading keeps per-key daily quotas from running out.
 */
export class KeyPool {
  private index = 0;

  constructor(public readonly keys: KeyEntry[]) {}

  get size(): number {
    return this.keys.length;
  }

  active(): KeyEntry | null {
    const now = Date.now();
    for (let offset = 0; offset < this.keys.length; offset++) {
      const key = this.keys[(this.index + offset) % this.keys.length];
      if (key.dead) continue;
      if (key.cooldownUntil > now) continue;
      this.index = (this.index + offset) % this.keys.length;
      return key;
    }
    return null;
  }

  aliveCount(): number {
    const now = Date.now();
    return this.keys.filter((k) => !k.dead && k.cooldownUntil <= now).length;
  }

  /** Move to the next usable key. Returns true if the active key changed. */
  rotate(): boolean {
    const before = this.active();
    for (let offset = 1; offset <= this.keys.length; offset++) {
      const candidate = this.keys[(this.index + offset) % this.keys.length];
      if (candidate.dead || candidate.cooldownUntil > Date.now()) continue;
      if (candidate === before) return false;
      this.index = (this.index + offset) % this.keys.length;
      return true;
    }
    return false;
  }

  penalize(status: number): void {
    const key = this.active();
    if (!key) return;

    if (status === 401 || status === 402 || status === 403) {
      key.dead = true;
      key.reason = status === 402 ? "out of credits" : "rejected";
    } else if (status === 429) {
      key.cooldownUntil = Date.now() + 60_000;
      key.reason = "rate limited";
    } else {
      key.cooldownUntil = Date.now() + 20_000;
      key.reason = `error ${status}`;
    }
    // Re-settle on the next healthy key (active() skips dead/cooling entries).
    this.active();
  }
}

export interface Route {
  provider: ProviderName;
  spec: ProviderSpec;
  model: string;
  pool: KeyPool;
}

export class Router {
  private index = 0;
  private clients = new Map<string, OpenAI>();

  constructor(public readonly routes: Route[]) {
    if (routes.length === 0) throw new Error("Router needs at least one route with keys.");
  }

  get route(): Route {
    return this.routes[this.index];
  }

  get provider(): ProviderName {
    return this.route.provider;
  }

  get providerLabel(): string {
    return this.route.spec.label;
  }

  get model(): string {
    return this.route.model;
  }

  set model(value: string) {
    this.route.model = value;
  }

  get key(): KeyEntry | null {
    return this.route.pool.active();
  }

  /** OpenAI client bound to the current route + key. */
  client(): OpenAI {
    const key = this.key;
    if (!key) throw new Error(`No usable keys left for ${this.providerLabel}.`);

    const cacheKey = `${this.route.provider}|${key.value}`;
    const cached = this.clients.get(cacheKey);
    if (cached) return cached;

    const client = new OpenAI({
      apiKey: key.value,
      baseURL: this.route.spec.baseURL,
      defaultHeaders: this.route.spec.extraHeaders,
      timeout: 10 * 60 * 1000,
      maxRetries: 0, // our own failover handles retries
    });
    this.clients.set(cacheKey, client);
    return client;
  }

  totalKeys(): number {
    return this.routes.reduce((sum, route) => sum + route.pool.size, 0);
  }

  maxAttempts(): number {
    return Math.max(1, this.totalKeys());
  }

  /**
   * Penalize the current key for an HTTP failure and move to a healthy one.
   * Returns false when nothing usable is left.
   */
  failover(status: number): boolean {
    this.route.pool.penalize(status);
    if (this.route.pool.active()) return true;
    return this.advanceRoute();
  }

  private advanceRoute(): boolean {
    for (let offset = 1; offset <= this.routes.length; offset++) {
      const route = this.routes[(this.index + offset) % this.routes.length];
      if (route.pool.active()) {
        this.index = (this.index + offset) % this.routes.length;
        return true;
      }
    }
    return false;
  }

  /** Spread usage across keys: called after each successful turn. */
  nextKey(): void {
    this.route.pool.rotate();
  }

  switchProvider(name: ProviderName, model?: string): boolean {
    const index = this.routes.findIndex((route) => route.provider === name);
    if (index === -1) return false;
    if (!this.routes[index].pool.active()) return false;
    this.index = index;
    if (model) this.routes[index].model = model;
    return true;
  }

  describe(): string {
    const key = this.key;
    return `${this.providerLabel}/${this.route.model}${key ? ` [${key.label}]` : ""}`;
  }

  statusLines(): string[] {
    const lines: string[] = [];
    this.routes.forEach((route, routeIndex) => {
      const marker = routeIndex === this.index ? "▸" : " ";
      if (route.provider === "free") {
        lines.push(`${marker} ${route.spec.label}  ${route.model}  no key needed`);
        return;
      }
      lines.push(
        `${marker} ${route.spec.label}  ${route.model}  ${
          route.pool.aliveCount()
        }/${route.pool.size} keys usable`
      );
      for (const key of route.pool.keys) {
        const now = Date.now();
        const state = key.dead
          ? `dead (${key.reason})`
          : key.cooldownUntil > now
            ? `cooling down (${key.reason})`
            : "ok";
        const isActive = routeIndex === this.index && key === route.pool.active();
        lines.push(`    ${isActive ? "*" : " "} ${key.label}  ${state}`);
      }
    });
    return lines;
  }
}

/**
 * The OpenAI route can point at any OpenAI-compatible endpoint through
 * ALI_BASE_URL (for example a team proxy). Its "key" is then that endpoint's
 * access token.
 */
function specFor(provider: ProviderName): ProviderSpec {
  const spec = PROVIDERS[provider];
  const custom = process.env.ALI_BASE_URL?.trim();
  if (provider === "openai" && custom) {
    return { ...spec, baseURL: custom.replace(/\/+$/, ""), label: "Team proxy", keyPattern: undefined };
  }
  return spec;
}

export function buildRouter(cfg: Config): Router {
  const order: ProviderName[] = [
    cfg.primary,
    ...cfg.fallbacks.filter((p) => p !== cfg.primary),
  ];

  const routes: Route[] = [];
  for (const provider of order) {
    const keys = collectKeys(provider);
    if (keys.length === 0) continue;

    const model =
      provider === cfg.primary
        ? cfg.model
        : process.env.MINI_FALLBACK_MODEL?.trim() || PROVIDERS[provider].model;

    routes.push({
      provider,
      spec: specFor(provider),
      model,
      pool: new KeyPool(
        keys.map((value) => ({
          value,
          label: provider === "free" ? "no key" : maskKey(value),
          dead: false,
          cooldownUntil: 0,
        }))
      ),
    });
  }

  return new Router(routes);
}
