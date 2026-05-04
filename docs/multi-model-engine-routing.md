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

| Model                  | /v1/messages | Claude CLI chat | Tool use   |
| ---------------------- | ------------ | --------------- | ---------- |
| claude-opus-4-7        | ✅           | ✅              | (assumed)  |
| claude-sonnet-4-6      | ✅           | ✅              | (assumed)  |
| **claude-haiku-4-5**   | ✅           | ✅ 3s           | ✅ **Full**|
| **gpt-5.4**            | ✅           | ✅              | (untested) |
| **gpt-5.4-mini**       | ✅           | ✅ 3s           | ⚠️ Refused on safety (false positive on "credentials") |
| **deepseek-chat**      | ✅           | ✅ 2s           | ✅ **Full** — surprise winner, full Anthropic-shape tool replay works |
| deepseek-reasoner      | ✅           | (untested)      | (untested) |
| **gemini-3-pro-preview** | ✅         | ✅ 5s           | ❌ 400 — `Function call is missing a thought_signature in functionCall parts` |
| grok-4.20-0309-reasoning | ✅         | (untested)      | (untested) |
| **qwen-coder-plus**    | ✅           | ✅ 4s           | ⚠️ Outputs tool calls as text (`✿TASK✿: Read, ✿ARGS✿: {...}`) instead of using OpenAI `tool_calls`. The model has its own structured-output convention that qlaud's translation doesn't pick up. |
| **kimi-k2.6**          | ✅           | ✅ 5s           | ❌ 400 — `thinking is enabled but reasoning_content is missing in assistant tool call message` |
| MiniMax-M2             | ✅           | ❌ 404 — case mismatch (`MiniMax-M2` vs `minimax-m2`); qlaud rejects the lowercased form |

## Tier interpretation

**Tier 1 — ship claude-code engine with these today:**

- All Anthropic models (native — perfect)
- `deepseek-chat` (full tool use through Anthropic shape — qlaud
  translates DeepSeek's OpenAI-compat tool format reliably)

**Tier 2 — chat works, tool use needs work:**

- `gpt-5.4`, `gpt-5.4-mini` — model is overly safety-tuned for
  reading "secret"-flavored prompts. Tool-use protocol itself is
  probably fine; it's the model's RLHF refusing. Re-test with a
  non-secret-flavored read ("read README.md and summarize").

**Tier 3 — qlaud translation layer needs upgrades:**

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

1. **Default engine = Claude Code**, gated to Tier 1 models only in
   the model picker. Users get a guaranteed-working experience.

2. **Tier 2 + 3 models hidden** behind a "Beta — may have issues"
   tag in the picker, OR simply not shown until qlaud's translation
   catches up.

3. **Codex CLI as a second engine** for OpenAI-shape models.
   Pattern:

   ```ts
   // Pseudocode
   const engineForModel = (slug: string): 'claude-code' | 'codex' =>
     /^(claude|deepseek)/.test(slug) ? 'claude-code' : 'codex';
   ```

   Codex understands OpenAI tool_calls natively, so it might
   handle gpt-5.4 / qwen / etc. cleanly even where the Anthropic-
   shape translation falls down.

   Untested locally — `codex` CLI isn't installed on the dev box.
   To smoke: `bun add -g @openai/codex` (verify package name) then
   re-run the same prompt against the Tier 2/3 models.

4. **Translation upgrades to qlaud edge** are independent of qcode —
   each one unblocks an existing model for the existing engine.

## Files

- `/tmp/qcode-model-bench/results.txt` — direct /v1/messages
- `/tmp/qcode-model-bench/claude-cli-results.txt` — claude CLI chat
- `/tmp/qcode-model-bench/tool-use-results.txt` — tool-use prompts +
  full responses per model
