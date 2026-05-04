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

## Recommended product shape

**Headline: qlaud edge translation upgrades are the universal lever,
not adding a second engine.** Adding Codex CLI does not unlock any
Tier 3 provider — the same translation gaps exist regardless of
whether the request enters qlaud as Anthropic-shape (claude-code)
or OpenAI-shape (codex). The bugs are in the *exit* translation
(qlaud → Gemini/Qwen/Kimi native protocols), not the entry shape.

What this means concretely:

- ✅ **Phase 1 (today):** Ship claude-code engine with the 8 Tier 1
  models in the picker. 67% of catalog working with zero new
  engineering.

- ⏩ **Phase 2 (qlaud edge):** Four targeted translation fixes
  unblock the remaining four providers. Same effort whether the
  entry shape is Anthropic or OpenAI.

  - `apps/edge/src/routes/messages.ts` (or chat-completions.ts)
  - Gemini: preserve `thought_signature` from prior response when
    forwarding tool replays. Affects follow-up turns only.
  - Qwen: detect `✿TASK✿/✿ARGS✿` in response text and emit as
    proper `tool_use` content blocks.
  - Kimi: preserve `reasoning_content` field on the round-trip
    when thinking mode is enabled.
  - MiniMax: lowercase or pre-canonicalize the slug at the
    catalog/route boundary.

- 🟡 **Phase 3 (optional, perf-only):** Add Codex CLI as a second
  engine specifically for OpenAI models. Native OpenAI passthrough
  saves ~50-200ms per turn vs Anthropic-shape translation. NOT
  required for any provider to work — pure latency optimization.
  ```ts
  const engineForModel = (slug: string): 'claude-code' | 'codex' =>
    /^(gpt|o[0-9])/.test(slug) ? 'codex' : 'claude-code';
  ```

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
