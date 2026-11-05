/**
 * Ali Code proxy — a Cloudflare Worker.
 *
 * Two kinds of access:
 *   - TEAM_TOKENS   per-person tokens you hand out yourself. Unlimited by this
 *                    Worker; you control access by adding/removing a token.
 *   - PUBLIC_TOKEN   the one token baked into the public "ali-code" npm
 *                    package as its zero-config default. Anyone who installs
 *                    ali-code can use it, so it is rate-limited hard — both
 *                    per visitor and in total per day — to bound the worst
 *                    case against your own Groq/OpenRouter quota. It is not a
 *                    secret: it ships in public source, so the limits below
 *                    are the real defense, not keeping it hidden.
 *
 * Secrets (Worker → Settings → Variables and Secrets → type "Secret"):
 *   TEAM_TOKENS          comma-separated personal tokens you invent (optional)
 *   PUBLIC_TOKEN         the single public/default token (see src/config.ts
 *                        COMMUNITY_TOKEN in the ali-code repo for the value
 *                        that must match here)
 *   GROQ_API_KEYS        comma-separated Groq keys        (optional)
 *   OPENROUTER_API_KEYS  comma-separated OpenRouter keys  (optional)
 *
 * Plain variables (type: Text, optional — sane defaults below if unset):
 *   PUBLIC_PER_IP_HOUR   requests/hour per visitor on the public token (15)
 *   PUBLIC_DAILY_CAP     total requests/day on the public token        (300)
 *
 * Rate limiting below is in-memory per Worker instance: a best-effort brake
 * against obvious abuse (a script hammering the endpoint), not a hard global
 * guarantee — Cloudflare may run several instances across regions/PoPs, and a
 * cold start resets the counters. That is an intentional trade-off to avoid
 * requiring a paid plan or a KV namespace; bind one and extend this file for
 * a stronger, globally-consistent limit if you ever need it.
 *
 * Remove a friend: delete their token from TEAM_TOKENS and deploy.
 * Pull the public default entirely: delete PUBLIC_TOKEN and deploy — anyone
 * still on it falls back to ali-code's own always-free model automatically.
 */

const ALLOWED_MODELS = [
  // Groq models
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",

  // OpenRouter Free models
  "cohere/north-mini-code:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
  "liquid/lfm-2.5-2.6b:free",
  "nvidia/nemotron-3.5-lightning:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
];
const MAX_TOKENS_CAP = 8192;
const DEFAULT_PUBLIC_PER_IP_HOUR = 15;
const DEFAULT_PUBLIC_DAILY_CAP = 300;

const UPSTREAMS = [
  { name: "groq", url: "https://api.groq.com/openai/v1/chat/completions", keys: "GROQ_API_KEYS" },
  { name: "openrouter", url: "https://openrouter.ai/api/v1/chat/completions", keys: "OPENROUTER_API_KEYS" },
];

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const list = (value) => (value || "").split(/[,\s;]+/).filter(Boolean);

function shuffled(items) {
  return [...items].sort(() => Math.random() - 0.5);
}

/* ------------------------------------------------------------------ *
 * Rate limiting for the public token only. Per-isolate state: resets on
 * cold start, not shared across regions. See the header comment above.
 * ------------------------------------------------------------------ */

const perIp = new Map(); // ip -> { count, windowStart }
let dailyCount = 0;
let dailyDay = "";

function sweepPerIp(now) {
  for (const [ip, entry] of perIp) {
    if (now - entry.windowStart > 60 * 60 * 1000) perIp.delete(ip);
  }
}

/** Returns an error message if the public token is over its limit, else null. */
function checkPublicLimits(ip, env) {
  const perIpLimit = Number(env.PUBLIC_PER_IP_HOUR) || DEFAULT_PUBLIC_PER_IP_HOUR;
  const dailyLimit = Number(env.PUBLIC_DAILY_CAP) || DEFAULT_PUBLIC_DAILY_CAP;
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);

  if (dailyDay !== today) {
    dailyDay = today;
    dailyCount = 0;
  }
  if (dailyCount >= dailyLimit) {
    return "The shared community tier hit its daily limit. Add your own key: ali config set groq <key>";
  }

  sweepPerIp(now);
  const entry = perIp.get(ip) ?? { count: 0, windowStart: now };
  if (now - entry.windowStart > 60 * 60 * 1000) {
    entry.count = 0;
    entry.windowStart = now;
  }
  if (entry.count >= perIpLimit) {
    return "You hit the shared community tier's per-hour limit. Add your own key: ali config set groq <key>";
  }

  entry.count++;
  perIp.set(ip, entry);
  dailyCount++;
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Access control: every request needs a token, either a personal one in
    // TEAM_TOKENS or the one public token everyone's ali-code install ships.
    const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    const isPublic = Boolean(env.PUBLIC_TOKEN) && token === env.PUBLIC_TOKEN;
    const isTeamMember = list(env.TEAM_TOKENS).includes(token);
    if (!token || !(isPublic || isTeamMember)) {
      return json({ error: { message: "Invalid or missing access token." } }, 401);
    }

    if (isPublic) {
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      const reason = checkPublicLimits(ip, env);
      if (reason) return json({ error: { message: reason } }, 429);
    }

    if (request.method === "GET" && url.pathname.endsWith("/models")) {
      return json({ object: "list", data: ALLOWED_MODELS.map((id) => ({ id, object: "model" })) });
    }

    if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      return json({ error: { message: "Not found." } }, 404);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: { message: "Body must be JSON." } }, 400);
    }

    if (!ALLOWED_MODELS.includes(body.model)) {
      return json(
        { error: { message: `Model not available here. Use one of: ${ALLOWED_MODELS.join(", ")}` } },
        400
      );
    }
    if (!body.max_tokens || body.max_tokens > MAX_TOKENS_CAP) body.max_tokens = MAX_TOKENS_CAP;
    if (body.max_completion_tokens > MAX_TOKENS_CAP) body.max_completion_tokens = MAX_TOKENS_CAP;

    // Try every upstream key (Groq first, then OpenRouter) until one answers.
    let last = json({ error: { message: "No upstream keys are configured." } }, 503);
    for (const upstream of UPSTREAMS) {
      for (const key of shuffled(list(env[upstream.keys]))) {
        let response;
        try {
          response = await fetch(upstream.url, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
            body: JSON.stringify(body),
          });
        } catch {
          continue;
        }
        // Rate limited, bad key, out of credit or upstream down: try the next key.
        if ([400, 401, 402, 403, 404, 422, 429].includes(response.status) || response.status >= 500) {
          last = response;
          continue;
        }
        return new Response(response.body, {
          status: response.status,
          headers: {
            "content-type": response.headers.get("content-type") || "application/json",
            "cache-control": "no-store",
          },
        });
      }
    }
    return new Response(last.body, { status: last.status, headers: { "content-type": "application/json" } });
  },
};
