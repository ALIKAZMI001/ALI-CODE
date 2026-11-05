/**
 * Ali Code team proxy — a Cloudflare Worker.
 *
 * Friends point Ali Code at this Worker with a personal access token. The real
 * Groq / OpenRouter keys exist ONLY here, as encrypted Worker secrets.
 *
 * Secrets (Worker → Settings → Variables and Secrets → type "Secret"):
 *   TEAM_TOKENS        comma-separated access tokens, e.g. sk-ali-bob,sk-ali-sara
 *   GROQ_API_KEYS      comma-separated Groq keys        (optional)
 *   OPENROUTER_API_KEYS comma-separated OpenRouter keys  (optional)
 *
 * Remove someone's access by deleting their token from TEAM_TOKENS.
 */

// Only these models can be used through the proxy (protects your quota).
const ALLOWED_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];
const MAX_TOKENS_CAP = 8192;

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Access control: every request needs a team token.
    const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!token || !list(env.TEAM_TOKENS).includes(token)) {
      return json({ error: { message: "Invalid or missing access token." } }, 401);
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
        if ([401, 402, 403, 429].includes(response.status) || response.status >= 500) {
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
