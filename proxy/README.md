# Ali Code team proxy (Cloudflare Worker)

Lets friends use your Groq/OpenRouter keys **without ever seeing them**. The
keys live only as encrypted secrets on Cloudflare. This folder is not part of
the npm package.

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
   | `GROQ_API_KEYS` | your Groq keys, comma-separated |
   | `OPENROUTER_API_KEYS` | your OpenRouter keys, comma-separated |
   | `TEAM_TOKENS` | access tokens you invent, comma-separated, e.g. `sk-ali-bob-8f3k,sk-ali-sara-2m9x` |

   Click **Deploy** again so the secrets apply.
4. Copy the Worker URL, e.g. `https://ali-proxy.YOURNAME.workers.dev`.

## What each friend runs (once)

```powershell
npm install -g ali-code@latest
ali config set base-url https://ali-proxy.YOURNAME.workers.dev/v1
ali config set openai sk-ali-bob-8f3k
ali config set provider openai
ali config set model openai/gpt-oss-120b
ali doctor
```

Models available: `openai/gpt-oss-120b` and `openai/gpt-oss-20b`
(edit `ALLOWED_MODELS` in `worker.js` to change this).

## Day to day

- **Cut someone off:** remove their token from `TEAM_TOKENS` and deploy.
- **Rotate a provider key:** edit `GROQ_API_KEYS` / `OPENROUTER_API_KEYS`.
- **Watch usage:** Worker → **Metrics**. The free plan allows 100,000
  requests/day; the Groq and OpenRouter free tiers have their own limits.
