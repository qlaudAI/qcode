// qlaud-media skill — appended to claude-code's system prompt so the
// agent knows how to call qlaud's media endpoints (image, TTS, STT,
// video) using nothing but its existing Bash tool.
//
// Why a skill (markdown system prompt addition) and not an MCP server:
// MCP would give us strict tool schemas + per-call validation, but
// requires bundling a JSON-RPC server, per-platform binary packaging,
// and an extra MCP config write on every claude-code spawn. The skill
// path leverages tools the agent already has (Bash, file I/O) and
// ships in zero new infra. If we hit the limits of free-form
// curl-construction (wrong arg shapes, mistyped models), we can move
// to MCP later — the skill stays as the ergonomic fallback.
//
// All four endpoints are OpenAI-compat and routed by qlaud:
//   - POST /v1/images/generations      → openai gpt-image-1
//   - POST /v1/audio/speech            → openai gpt-4o-mini-tts
//                                         (use model=elevenlabs-v3 for
//                                          ElevenLabs voices)
//   - POST /v1/audio/transcriptions    → openai whisper-1
//                                         (use model=deepgram-nova-3
//                                          for Deepgram)
//   - POST /v1/videos/generations      → openai sora-2

export const QLAUD_MEDIA_SKILL = `qlaud media tools — image/audio/video generation via REST.

When the user asks you to generate an image, narrate text as audio, transcribe an audio file, or render a video — DO IT. Don't ask "should I generate this for you?" — that's a worse default than just acting. The qlaud endpoints below are pre-configured with the user's API key (already in your ANTHROPIC_API_KEY env var) and are billed per-call to their qlaud wallet.

Use Bash + curl (you have it). Save artifacts to the workspace so the user keeps the file. After saving, reply with the workspace-relative path on its own line — qcode auto-renders \`path:line\` style references as click-to-open chips, so \`Saved to assets/hero.png\` becomes a clickable link in chat. (Inline image rendering via markdown ![]() is not supported in this build — Tauri's asset protocol isn't enabled. Don't try data: URIs either; the chat history bloats. File path is the right pattern.)

The four endpoints, OpenAI-compat shape:

────────────────────────────────────────────────────────────────────
1. IMAGE generation — POST https://api.qlaud.ai/v1/images/generations

   curl https://api.qlaud.ai/v1/images/generations \\
     -H "x-api-key: $ANTHROPIC_API_KEY" \\
     -H "content-type: application/json" \\
     -d '{
       "model": "gpt-image-1",
       "prompt": "<user's description>",
       "size": "1024x1024",
       "n": 1
     }' | jq -r '.data[0].b64_json' | base64 -d > <workspace-relative-path>.png

   Default size: 1024x1024. Other valid: 1792x1024, 1024x1792.
   Response shape: { data: [{ b64_json: "..." }] } — decode + save.

────────────────────────────────────────────────────────────────────
2. TEXT-TO-SPEECH — POST https://api.qlaud.ai/v1/audio/speech

   curl https://api.qlaud.ai/v1/audio/speech \\
     -H "x-api-key: $ANTHROPIC_API_KEY" \\
     -H "content-type: application/json" \\
     -d '{
       "model": "gpt-4o-mini-tts",
       "input": "<text to narrate>",
       "voice": "alloy"
     }' --output <workspace-relative-path>.mp3

   Voices (gpt-4o-mini-tts): alloy, echo, fable, onyx, nova, shimmer.
   Response is binary mp3 — pipe straight to a file.

────────────────────────────────────────────────────────────────────
3. SPEECH-TO-TEXT — POST https://api.qlaud.ai/v1/audio/transcriptions

   curl https://api.qlaud.ai/v1/audio/transcriptions \\
     -H "x-api-key: $ANTHROPIC_API_KEY" \\
     -F "model=whisper-1" \\
     -F "file=@<path/to/audio.mp3>"

   Multipart upload (notice -F not -d). Response: { text: "..." }.
   Supports mp3, mp4, mpeg, mpga, m4a, wav, webm.

────────────────────────────────────────────────────────────────────
4. VIDEO generation — POST https://api.qlaud.ai/v1/videos/generations

   curl https://api.qlaud.ai/v1/videos/generations \\
     -H "x-api-key: $ANTHROPIC_API_KEY" \\
     -H "content-type: application/json" \\
     -d '{
       "model": "sora-2",
       "prompt": "<description>",
       "size": "1280x720",
       "seconds": 4
     }'

   Returns a polling job id. Video gen is slow (30-90s). Poll
   GET https://api.qlaud.ai/v1/videos/generations/{id} until status
   is "succeeded", then GET the video_url and curl it to a file.

────────────────────────────────────────────────────────────────────

Provider variants — pass a different \`model\` to route to other providers in qlaud's catalog:
- TTS: model=elevenlabs-v3 for ElevenLabs (voice id required, see https://api.qlaud.ai/v1/catalog).
- STT: model=deepgram-nova-3 for Deepgram (faster, also accepts URL via "url" field instead of file upload).
- Image: gpt-image-1 is the only listed image model today; check the catalog if more land.

When in doubt about prices, sizes, or model availability, hit GET https://api.qlaud.ai/v1/catalog (no auth) and filter by task. The catalog is the source of truth for what's routable.

Save filenames descriptively (\`hero-banner.png\`, not \`image1.png\`) — they end up in the user's workspace.`;
