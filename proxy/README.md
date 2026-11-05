# Ali Code proxy (Cloudflare Worker)

Lets anyone who installs `ali-code` use a real model (`openai/gpt-oss-120b`)
with **zero setup**, backed by your own Groq/OpenRouter keys — and lets
friends get unlimited access with their own personal token. The keys live
only as encrypted secrets on Cloudflare; this folder is not part of the npm
package.

There are two tiers:

| Tier | Token | Limits |
|---|---|---|
| **Public (default)** | one token, baked into the published `ali-code` package | rate-limited per visitor and per day (see below) |
| **Friends** | a personal token you hand out yourself | none from this Worker — you control access by adding/removing their token |

## Deploy from the Cloudflare dashboard (no command line)

1. Verify your email (the banner on the dashboard home), then open
   **Compute → Workers & Pages → Create → Create Worker**. Name it `ali-proxy`
   and click **Deploy**.
2. Click **Edit code**, delete everything, paste the contents of `worker.js`,
   and click **Deploy**.
3. Open the Worker → **Settings → Variables and Secrets → Add**. Add each of
   these with type **Secret** (not "Text"):

   | Name | Value |
   |---|---|
   | `PUBLIC_TOKEN` | must exactly match `COMMUNITY_TOKEN` in `src/config.ts` of the ali-code repo — this is what every zero-config install uses |
   | `TEAM_TOKENS` | access tokens you invent for friends, comma-separated, e.g. `sk-ali-bob-8f3k,sk-ali-sara-2m9x` |
   | `GROQ_API_KEYS` | your Groq keys, comma-separated |
   | `OPENROUTER_API_KEYS` | your OpenRouter keys, comma-separated |

   Optionally add these as plain **Text** variables to tune the public tier's
   limits (sane defaults apply if you skip this):

   | Name | Value |
   |---|---|
   | `PUBLIC_PER_IP_HOUR` | requests/hour per visitor on the public token (default `15`) |
   | `PUBLIC_DAILY_CAP` | total requests/day on the public token (default `300`) |

   Click **Deploy** again so the secrets apply.
4. Copy the Worker URL, e.g. `https://ali-proxy.YOURNAME.workers.dev`, and
   make sure it matches `community.baseURL` in `src/config.ts` (with `/v1`
   appended), then build and publish `ali-code` as usual.

Models available: `openai/gpt-oss-120b` and `openai/gpt-oss-20b`
(edit `ALLOWED_MODELS` in `worker.js` to change this).

## What a friend runs for unlimited access (once)

Anyone who just runs `ali` already gets the public tier automatically, no
setup. A friend you want to give unlimited, un-rate-limited access to runs:

```powershell
npm install -g ali-code@latest
ali config set base-url https://ali-proxy.YOURNAME.workers.dev/v1
ali config set openai sk-ali-bob-8f3k
ali config set provider openai
ali config set model openai/gpt-oss-120b
ali doctor
```

## Day to day

- **Cut a friend off:** remove their token from `TEAM_TOKENS` and deploy.
- **Pull the public default entirely:** delete `PUBLIC_TOKEN` and deploy —
  every zero-config install falls back to ali-code's own always-free model
  automatically, no breakage.
- **Rotate a provider key:** edit `GROQ_API_KEYS` / `OPENROUTER_API_KEYS`.
- **Watch usage:** Worker → **Metrics**. The free Cloudflare plan allows
  100,000 requests/day; the Groq and OpenRouter free tiers have their own
  limits; `PUBLIC_DAILY_CAP` bounds the worst case from the public token
  specifically.
- **About the rate limiting:** it is in-memory per Worker instance (resets on
  cold start, not synced across Cloudflare's regions), so treat the numbers
  above as a soft, best-effort ceiling rather than an exact global cap. If you
  need a hard global guarantee, bind a Workers KV namespace and extend
  `checkPublicLimits()` in `worker.js` to read/write counters there instead of
  the in-memory `Map`.
