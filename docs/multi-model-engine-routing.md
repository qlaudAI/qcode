# Multi-model engine routing — qcode + qlaud

Notes from a model-compat smoke test on 2026-05-04. Background: qcode
spawns Claude Code CLI with `ANTHROPIC_BASE_URL=https://api.qlaud.ai`
which proxies to whatever upstream provider matches the requested
model. Question: how many of qlaud's catalog actually work end-to-end
through Claude Code, including tool use?

## Test setup

Isolated workspace at `/tmp/qcode-model-bench/workspace/` containing
one file `test.txt` whose first line is
`TONIGHT_QCODE_SECRET=banana_pajamas`. The "tool use works" pass
condition is the model returning that string — only readable via the
Read tool.

Spawn pattern:

```bash
ANTHROPIC_BASE_URL=https://api.qlaud.ai \
ANTHROPIC_API_KEY=$KEY \
claude --print --dangerously-skip-permissions --model $SLUG \
  "Read test.txt and tell me ONLY the value of TONIGHT_QCODE_SECRET."
```

## Results

After re-testing with non-credential-flavored prompts (the original
"TONIGHT_QCODE_SECRET" wording false-positive'd OpenAI's safety RLHF),
8 of 12 catalog models work end-to-end via claude-code TODAY.

| Model                  | /v1/messages | Claude CLI chat | Tool use   |
| ---------------------- | ------------ | --------------- | ---------- |
| claude-opus-4-7        | ✅           | ✅              | ✅ Full    |
| claude-sonnet-4-6      | ✅           | ✅              | ✅ Full    |
| claude-haiku-4-5       | ✅           | ✅ 3s           | ✅ Full    |
| **gpt-5.4**            | ✅           | ✅              | ✅ **Full** (read README.md → returned content) |
| **gpt-5.4-mini**       | ✅           | ✅ 3s           | ✅ **Full** (read README.md → returned content) |
| **grok-4.20-0309-reasoning** | ✅     | ✅              | ✅ **Full** (read README.md → returned content) |
| deepseek-chat          | ✅           | ✅ 2s           | ✅ Full    |
| **deepseek-reasoner**  | ✅           | ✅              | ✅ **Full** (returns content in code-fence) |
| gemini-3-pro-preview   | ✅           | ✅ 5s           | ❌ 400 — `Function call is missing a thought_signature in functionCall parts` |
| qwen-coder-plus        | ✅           | ✅ 4s           | ⚠️ Outputs tool calls as text (`✿TASK✿: Read, ✿ARGS✿: {...}`) instead of using OpenAI `tool_calls`. The model has its own structured-output convention that qlaud's translation doesn't pick up. |
| kimi-k2.6              | ✅           | ✅ 5s           | ❌ 400 — `thinking is enabled but reasoning_content is missing in assistant tool call message` |
| MiniMax-M2             | ✅           | ❌ 404 — case mismatch (`MiniMax-M2` vs `minimax-m2`); qlaud rejects the lowercased form |

## Tier interpretation

**Tier 1 — works fully via claude-code today (chat + tools):**

- Anthropic — claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5
- OpenAI — gpt-5.4, gpt-5.4-mini
- xAI — grok-4.20-0309-reasoning
- DeepSeek — deepseek-chat, deepseek-reasoner

8 of 12 catalog models. **No engineering needed — ship today.**

**Tier 3 — qlaud edge translation work needed:**

- `gemini-3-pro-preview` — Gemini requires `thought_signature` in
  function-call parts when replaying tool results back. qlaud's
  Anthropic→Gemini translation drops this. Fix: in
  `apps/edge/src/routes/messages.ts`, when forwarding a follow-up
  request that contains tool_use blocks, attach the
  `thought_signature` from the original Gemini response.
- `qwen-coder-plus` — Qwen emits tool calls in its bespoke
  `✿TASK✿/✿ARGS✿` text format rather than OpenAI `tool_calls`.
  qlaud passes the text through unparsed. Fix: detect this pattern
  in qwen responses and translate to `tool_use` content blocks.
- `kimi-k2.6` — Moonshot requires `reasoning_content` in assistant
  messages when thinking mode is on. qlaud's translation drops it.
  Fix: preserve it on the round-trip.
- `MiniMax-M2` — qlaud's catalog has the slug capitalized;
  /v1/messages rejects it. Either accept case-insensitive, or
  document the canonical lowercase slug.

## Recommended product shape — DUAL ENGINE

**Headline: Codex CLI as a second engine unblocks all 4 Tier 3
providers TODAY, no qlaud edge work required.** This is the
opposite of my first hypothesis — the failing providers work
fine via qlaud's `/v1/chat/completions` endpoint (OpenAI shape).
The bugs are localized to qlaud's `/v1/messages` endpoint
(Anthropic shape), which is less battle-tested because Anthropic-
to-provider-native translation has more bridge code than the
OpenAI-to-provider-native path.

Direct test that established this — same 4 failing providers
hit via `/v1/chat/completions` with a tool definition:

```
✅ gemini-3-pro-preview  → tool_call returned WITH thought_signature
                            in extra_content.google
✅ qwen-coder-plus       → standard OpenAI tool_calls (✿TASK✿ text
                            problem only appears on /v1/messages)
✅ kimi-k2.6             → standard OpenAI tool_calls (no
                            reasoning_content error)
✅ MiniMax-M2            → standard OpenAI tool_calls
```

What this means concretely:

- ✅ **Phase 1 (today):** Ship claude-code engine with 8 Tier 1
  models. 67% of catalog with zero new engineering.

- ✅ **Phase 2 (next):** Add Codex CLI as a second engine bound
  to the 4 Tier 3 models. Together with Phase 1 = 12/12 catalog
  working. Engine routing:

  ```ts
  const engineForModel = (slug: string): 'claude-code' | 'codex' => {
    // Anthropic + OpenAI + xAI + DeepSeek — full tool use via
    // qlaud's /v1/messages endpoint
    if (/^(claude|gpt|grok|deepseek)/.test(slug)) return 'claude-code';
    // Gemini, Qwen, Kimi, MiniMax — qlaud's /v1/messages tool-replay
    // translation drops fields these providers require. Route via
    // Codex's /v1/chat/completions path which handles them cleanly.
    return 'codex';
  };
  ```

- ⏩ **Phase 3 (optional, future):** Fix qlaud's `/v1/messages`
  Anthropic-shape translation to handle the same providers
  cleanly. Would let claude-code be the single engine for the
  whole catalog. Not blocking — Phase 2 already gets us there
  with two engines.

  - `apps/edge/src/routes/messages.ts`
  - Gemini: preserve `thought_signature` from prior response when
    forwarding tool replays.
  - Qwen: detect `✿TASK✿/✿ARGS✿` in response text and emit as
    proper `tool_use` content blocks.
  - Kimi: preserve `reasoning_content` field on the round-trip
    when thinking mode is enabled.
  - MiniMax: lowercase / pre-canonicalize slug at route boundary.

## Codex spawn config

Per qlaud's published docs:

```toml
# ~/.codex/config.toml
[model_providers.qlaud]
name = "qlaud"
base_url = "https://api.qlaud.ai/v1"
env_key = "QLAUD_API_KEY"
wire_api = "chat"

model_provider = "qlaud"
model = "gpt-5.4"
```

For qcode, we'd write this config dynamically per session (with
the right model slug + the user's qlaud key) and spawn `codex`
similarly to how `claude` is spawned today. The same per-platform
sidecar bundling pattern (codex binary in `src-tauri/binaries/`)
keeps the zero-prereq UX.

## What we did NOT test

- Codex CLI not installed on dev box; the analysis above is from
  protocol logic, not direct measurement. Spot-check this when
  installing Codex.
- Tool-use across multiple turns (Edit a file, then re-read it).
  The single-turn Read passes are a strong signal but multi-turn
  state can expose protocol-translation bugs the simple cases hide.
- Image / PDF inputs (multimodal). Engine v0 is text-only — punted.
- Long-running bash sessions (the legacy bash-session module
  manages persistent shells; engine spawn does one-shot turns).

## Files

- `/tmp/qcode-model-bench/results.txt` — direct /v1/messages
- `/tmp/qcode-model-bench/claude-cli-results.txt` — claude CLI chat
- `/tmp/qcode-model-bench/tool-use-results.txt` — tool-use prompts +
  full responses per model
