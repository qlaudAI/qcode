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

Use Bash + curl (you have it). After saving, reply with the workspace-relative path on its own line — qcode auto-renders \`path:line\` style references as click-to-open chips, so \`Saved to .qcode/media/2026-05-04/hero.png\` becomes a clickable link in chat. (Inline image rendering via markdown ![]() is not supported in this build — Tauri's asset protocol isn't enabled. Don't try data: URIs either; the chat history bloats. File path is the right pattern.)

CANONICAL OUTPUT PATH — qcode standardizes generated media under a single folder per workspace so users always know where their AI-generated artifacts went:

  <workspace>/.qcode/media/<YYYY-MM-DD>/<descriptive-name>.<ext>

Rules:
  • Create the directory tree with \`mkdir -p\` before saving.
  • Use today's date for the folder. Get it via \`date +%Y-%m-%d\`.
  • Pick a descriptive filename (\`hero-banner.png\`, not \`output.png\`).
    The user will see this name in the file tree and the agent's
    reply, so make it self-explanatory.
  • The \`.qcode/\` prefix means qcode-generated artifacts live in
    one place, easy to gitignore (\`.qcode/\` is auto-suggested) or
    delete in bulk.

If there is no workspace (rare; pure-chat mode), fall back to \`/tmp/qcode-media/\` and warn the user that the artifact won't persist past a reboot.

The four endpoints, OpenAI-compat shape:

────────────────────────────────────────────────────────────────────
1. IMAGE generation — POST https://api.qlaud.ai/v1/images/generations

   DEST=".qcode/media/$(date +%Y-%m-%d)"
   mkdir -p "$DEST"
   curl https://api.qlaud.ai/v1/images/generations \\
     -H "x-api-key: $ANTHROPIC_API_KEY" \\
     -H "content-type: application/json" \\
     -d '{
       "model": "gpt-image-1",
       "prompt": "<user's description>",
       "size": "1024x1024",
       "n": 1
     }' | jq -r '.data[0].b64_json' | base64 -d > "$DEST/hero-banner.png"

   Default size: 1024x1024. Other valid: 1792x1024, 1024x1792.
   Response shape: { data: [{ b64_json: "..." }] } — decode + save.

────────────────────────────────────────────────────────────────────
2. TEXT-TO-SPEECH — POST https://api.qlaud.ai/v1/audio/speech

   DEST=".qcode/media/$(date +%Y-%m-%d)"
   mkdir -p "$DEST"
   curl https://api.qlaud.ai/v1/audio/speech \\
     -H "x-api-key: $ANTHROPIC_API_KEY" \\
     -H "content-type: application/json" \\
     -d '{
       "model": "gpt-4o-mini-tts",
       "input": "<text to narrate>",
       "voice": "alloy"
     }' --output "$DEST/intro-narration.mp3"

   Voices (gpt-4o-mini-tts): alloy, echo, fable, onyx, nova, shimmer.
   Response is binary mp3 — pipe straight to a file.

────────────────────────────────────────────────────────────────────
3. SPEECH-TO-TEXT — POST https://api.qlaud.ai/v1/audio/transcriptions

   curl https://api.qlaud.ai/v1/audio/transcriptions \\
     -H "x-api-key: $ANTHROPIC_API_KEY" \\
     -F "model=whisper-1" \\
     -F "file=@<path/to/audio.mp3>"

   Multipart upload (notice -F not -d). Response: { text: "..." }.
   Transcripts go inline in your reply — no file output needed
   unless the user explicitly asks for one. Supports mp3, mp4,
   mpeg, mpga, m4a, wav, webm.

────────────────────────────────────────────────────────────────────
4. VIDEO generation — POST https://api.qlaud.ai/v1/videos/generations

   DEST=".qcode/media/$(date +%Y-%m-%d)"
   mkdir -p "$DEST"
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
   is "succeeded", then GET the video_url and curl it to "$DEST/<name>.mp4".

────────────────────────────────────────────────────────────────────

Provider variants — qlaud's catalog has more than the OpenAI-shape defaults. Two ways to reach them:

  • OpenAI-shape \`/v1/audio/speech\` always routes to OpenAI's gpt-4o-mini-tts. The \`model\` field there isn't honored for cross-provider routing.
  • Native passthrough URLs accept each provider's NATIVE request body verbatim:
      ElevenLabs (premium voices): POST https://api.qlaud.ai/elevenlabs/v1/text-to-speech/{voice_id}
        Body: {"text":"...","model_id":"eleven_multilingual_v2","voice_settings":{"stability":0.5,"similarity_boost":0.75}}
        Response: binary mp3.
      Deepgram (fast STT, also accepts URL): POST https://api.qlaud.ai/deepgram/v1/listen
        Body: binary audio file or {"url":"https://..."}.
      Cartesia: POST https://api.qlaud.ai/cartesia/v1/tts (their native shape).

When in doubt about prices, sizes, voices, or model availability, hit GET https://api.qlaud.ai/v1/catalog (no auth) and filter by task. The catalog is the source of truth for what's routable. ElevenLabs voice IDs come from their own /v1/voices endpoint — proxy via /elevenlabs/v1/voices on qlaud.

Save filenames descriptively (\`hero-banner.png\`, not \`image1.png\`) — they end up in the user's workspace.

────────────────────────────────────────────────────────────────────
OPTIONAL CLOUD SYNC — only when \$QCODE_MEDIA_CLOUD_SYNC=1 is set.

When the user opted in to cross-device media sync (Settings →
"Sync generated media to qlaud cloud"), qcode passes that env var.
After saving locally, also upload the artifact to qlaud's R2-backed
storage so it's accessible from the user's other devices and from
qcode-web. Skip this entire section when the env var isn't '1'.

Three-step flow per artifact:

  # 1. Init — declare what you're uploading; get back an artifact_id
  # and an upload URL. The current thread is auto-scoped via
  # \$QCODE_THREAD_ID so the artifact is filed under this conversation.
  INIT=\$(curl -s https://api.qlaud.ai/v1/artifacts/init \\
    -H "x-api-key: \$ANTHROPIC_API_KEY" \\
    -H "content-type: application/json" \\
    -d '{
      "thread_id": "'"\$QCODE_THREAD_ID"'",
      "mime": "image/png",
      "byte_size": '"\$(wc -c < .qcode/media/\$(date +%Y-%m-%d)/hero.png)"',
      "original_name": "hero.png",
      "prompt_excerpt": "<truncate the user prompt to ~200 chars>"
    }')
  ARTIFACT_ID=\$(echo "\$INIT" | jq -r '.artifact_id')
  UPLOAD_URL=\$(echo "\$INIT" | jq -r '.upload_url')

  # 2. Upload the bytes. The route is /v1/artifacts/<id>/upload —
  # qlaud relays it into R2 with the correct content-type. PUT, not
  # POST. 50 MB hard cap.
  curl -s -X PUT "https://api.qlaud.ai\$UPLOAD_URL" \\
    -H "x-api-key: \$ANTHROPIC_API_KEY" \\
    -H "content-type: image/png" \\
    --data-binary @.qcode/media/\$(date +%Y-%m-%d)/hero.png

  # 3. (Optional) Confirm — for v0 the upload route already flips
  # the row to ready, so /finalize is idempotent. Skip unless you
  # changed the upload pattern.

After step 2, reply with BOTH paths:
  • Local: \`.qcode/media/<date>/hero.png\` (always — the user's
    canonical copy)
  • Cloud: \`https://api.qlaud.ai/v1/artifacts/\$ARTIFACT_ID/download\`
    (multi-device + shareable)

Do NOT upload local files the user attached themselves to chat —
those are already in the workspace and not in scope for this sync.
Only sync artifacts YOU generated this turn via the qlaud media
endpoints above.`;
