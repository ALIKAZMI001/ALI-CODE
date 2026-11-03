# Testing Ali Code yourself

Three layers: offline tests, a live smoke test, then failure drills. The first
layer costs nothing and should always pass.

---

## 1. Offline tests (no API calls, no credits)

```powershell
npm test
```

Expected: `42 pass, 0 fail`. These cover the parts that are easy to get subtly
wrong:

| File | Covers |
|---|---|
| `tests/util.test.mjs` | path escape rejection, truncation, occurrence counting |
| `tests/tools.test.mjs` | read/write/edit roundtrip, ambiguous edits, read-before-edit, search, list, shell exit codes, todos, undo |
| `tests/permissions.test.mjs` | all four modes, the deny-list, "always", closed stdin |
| `tests/keys.test.mjs` | rotation, dead keys, cooldowns, provider failover, provider switching |
| `tests/session.test.mjs` | key-list parsing, prefix filtering, transcript export |

Run one file while you iterate:

```powershell
npm run build
node --test "tests/tools.test.mjs"
```

---

## 2. Live smoke test (about 2 minutes, ~3 requests)

```powershell
npm run build
ali code -y "Create hello.js that prints hello, run it with node, then delete it. Use the todo tool."
```

You should see, in order:

1. The rounded `✻ Welcome to Ali Code!` panel and a `※ OpenRouter · <model> · N keys · bypass permissions` line.
2. `⏺ Update Todos` with three `☐` items, the first one bold (in progress).
3. `⏺ Write(hello.js)` → `⎿ Wrote 1 line to hello.js`.
4. `⏺ Update Todos` marking the first `☒` and the next bold.
5. `⏺ Bash(node hello.js)` → `⎿ hello` (and an exit-code line).
6. `⏺ Bash(del hello.js)` → `⎿ (no output)`.
7. A final `⏺ Update Todos` with all three `☒`, then a one-line summary.

If that works, the loop, streaming, tool calling, approvals and todos are all
wired correctly.

---

## 3. Command checklist

Start an interactive session with `ali code` and run these.

| Type this | Expect |
|---|---|
| `/help` | grouped command list |
| `/status` | folder, provider, model, key counts, mode, git branch |
| `/keys` | every key masked, `*` on the active one, all `ok` |
| `/doctor` | `ok` next to each key (this makes real network calls) |
| `/models free` | a list of free model ids |
| `/model` | current model only |
| `/permissions` | mode + auto-allowed tools |
| `/context` | a bar with % of the context window used |
| `/cost` | request and token counts, non-zero after a task |
| `/todos` | the last todo list from the smoke test |
| `/diff` | git diff, or `not a git repository` |
| `/export` | writes `ali-code-<session>.md` into the folder |
| `/exit` | session saved, process exits |

Also try **shift+tab**: the line under the prompt cycles
`? for shortcuts` → `⏵⏵ accept edits on` → `⏸ plan mode on`.

Type `/` to open the command palette: every matching command (aliases too) is
listed under the input, **Tab** completes it, Tab again cycles. `/us` suggests
`/usage` and `/status`; `/usag` runs `/usage` directly.

---

## 4. Failure drills

These are the behaviours that matter when things go wrong. Each takes under a
minute.

### 4a. Bad key fails over silently

Put a fake key first, keeping the real ones after it:

```powershell
$real = (Select-String -Path .env -Pattern '^OPENROUTER_API_KEYS=(.+)$').Matches.Groups[1].Value
$env:OPENROUTER_API_KEYS = "FAKE-INVALID-KEY-FOR-TESTING-ONLY," + $real
ali code -y "Reply with exactly: failover worked"
```

Expected:

```
  ↻ 401 on OpenRouter/<model> [FAKE-INVALID-KEY…ONLY] — retrying with OpenRouter/<model> [sk-or-v…xxxx]
failover worked
```

The fake key is now dead for that process only; `.env` is untouched.

### 4b. The deny-list beats `--yolo`

```powershell
ali code -y "Run the shell command: rm -rf /"
```

Expected:

```
⏺ Bash(rm -rf /)
  ⎿  Blocked: recursive delete of root/home
     This command is on the hard deny-list, even in bypass mode.
```

The model is told the call was denied. It must not run.

### 4c. Plan mode is read-only

```powershell
'plan mode','/permissions plan','Explain what package.json does without changing anything','/exit' -join "`n" | ali code
```

Then try to force a write:

```powershell
'Write a file called test.txt with the word hi','/exit' -join "`n" | ali code
```

Expected after `/permissions plan`: the status line becomes
`⏸ plan mode on (shift+tab to cycle)`, and a write attempt prints:

```
⏺ Write(test.txt)
  ⎿  Blocked: plan mode is read-only
     Shift+tab to leave plan mode, or run /permissions default.
```

### 4d. Approvals actually block

```powershell
'Create notes.txt with the text hi','3','/exit' -join "`n" | ali code
```

Expected: the diff/content preview, then the Claude Code dialog:

```
Write(notes.txt)

Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for Write
  3. No, and tell Ali what to do differently
```

Answering `3` prints `⎿ denied`. The file must not exist afterwards
(`Test-Path notes.txt` → `False`).

### 4e. Undo reverts the last edit

```powershell
'Read package.json, then add a "smoke": "echo ok" script to it','1','/undo','/exit' -join "`n" | ali code
```

Expected: `reverted package.json`, and `git diff package.json` (or a fresh read)
shows the original content. This is your safety net if the model edits something
you did not want.

### 4f. Sessions resume

```powershell
ali code
# ask one question, then /exit
ali code --resume
```

Expected: the welcome panel says `resumed session <id>` and `/context` shows the
earlier messages. Sessions live in `~/.ali-code/sessions/<hash-of-folder>/`, not
in the repo. Old `~/.mini` sessions are still picked up.

### 4g. Compaction

Force it with a tiny context budget, then have a few exchanges:

```powershell
$env:ALI_CONTEXT_TOKENS = "6000"
ali code -y "Remember the number 42. Then run: echo a; echo b; echo c"
```

Expected: `✻ Compacting conversation…` (then the spinner clears), and the
conversation continues rather than erroring with a context-length message.

Remove the variable afterwards (`Remove-Item Env:ALI_CONTEXT_TOKENS`) or it
applies to every new shell.

### 4h. Path escape is refused

```powershell
ali code -y "Read the file ../../Windows/System32/drivers/etc/hosts"
```

Expected: `Error: Path "..." is outside the workspace`.

---

## 5. Testing without burning quota

- Prefer `npm test` — it never touches the network.
- The smoke test costs roughly 3 requests.
- `ALI_MAX_ITERATIONS=6 ali code ...` caps runaway loops.
- `/models free` lists models that cost nothing on OpenRouter.
- `/doctor` costs one lightweight request per key.
- Each OpenRouter free key allows 50 requests/day; the pool spreads load.
- Groq keys are the fallback and have their own separate quota.

---

## 6. Reading the output

```
╭───────────────────────────╮
│ 14:32:05  > your turn     │    boxed question + the time it was entered
╰───────────────────────────╯
  ? for shortcuts                approval mode (shift+tab cycles it)
───────────────────────────
response text                   responses are framed by rules
───────────────────────────
⏺ Read(src/a.ts)                a tool call, Claude Code style
  ⎿  Read 42 lines               its result
⏺ Bash(npm test) · 14:32:09      shell commands show their start time
  ⎿  ... output
  ↳ /usage  /status             slash-command palette (tab completes)
⏺ Update Todos
  ⎿  ☒ done  ☐ pending           todo states
  ↻ 401 ...                      a key failed and was replaced
  ⎿  Blocked: ...                deny-list or plan mode
```

---

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `No API keys found` | no keys. Check `.env` is in the folder you launch from, and uses the plural `..._API_KEYS`. |
| `401` on everything | keys are wrong or expired. Run `/doctor`; rotate the key. |
| `402` / "out of credits" | free tier exhausted or a paid model selected. Use `/models free`, or add credits. |
| `404` on a model | model id is wrong for that provider. Check `/models`. |
| It keeps asking for approval | use `/permissions accept-edits`, or answer `2` once. |
| Model ignores tools | small/free models are weaker. Try a bigger model or the Groq fallback. |
| Context errors | lower `ALI_CONTEXT_TOKENS` so compaction triggers earlier, or run `/compact`. |
| `ali` is not recognized | run `npm link` in this folder, then open a new terminal. |
