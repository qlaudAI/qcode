// Engine Mode v0 — Claude Code adapter.
//
// Spawns the official `claude` CLI inside the user's workspace with
// ANTHROPIC_BASE_URL pointed at qlaud, parses its --output-format
// stream-json events, and emits them as AgentEvent shapes the existing
// ChatSurface render pipeline understands.
//
// The whole point of Engine Mode: stop reimplementing the agent loop,
// reuse Anthropic's. qcode becomes a transport + GUI; Claude Code does
// the model loop, tool dispatch, context management, compaction. Every
// improvement Anthropic ships lands here automatically.
//
// The CLI's --output-format stream-json gives us a JSON-line stream
// where most events are `{type:"stream_event", event:{...Anthropic SSE...}}`.
// Inside `event` is the LITERAL Anthropic SSE shape (message_start,
// content_block_start, content_block_delta, content_block_stop,
// message_delta, message_stop). We map those to AgentEvent so
// ChatSurface doesn't know it's not coming from qlaud.
//
// What we do NOT need:
//   - An agent loop (claude has one)
//   - Tool dispatch (claude has one)
//   - Approval gating (claude has one — for v0 we use --dangerously-skip-permissions
//     in YOLO mode; later we'll intercept and route to qcode's approval UI)
//   - Compaction (claude has one)
//   - System prompt building (claude has one)
//
// What we DO:
//   - Spawn one process per workspace per turn (for v0; later: long-lived per workspace)
//   - Inject ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY env so traffic flows through qlaud
//   - Pass --resume <session-id> when continuing a thread (claude owns the conversation state)
//   - Parse JSON-line stdout, emit AgentEvent
//
// Where this fits: `runEngineClaudeCode(opts)` has the SAME signature
// as `runThreadAgent(opts)` from legacy/agent.ts. ChatSurface picks
// based on `settings.engine` — that's the only client-side branch.

import { Command } from '@tauri-apps/plugin-shell';
import type { AgentEvent } from '../legacy/agent';
import type { ContentBlock } from '../qlaud-client';
import { getKey } from '../auth';
import { getSettings, patchSettings } from '../settings';

/** Tight, surgical addendum we hand to Claude Code via
 *  `--append-system-prompt`. Doesn't replace Claude's default
 *  agent persona — adds qcode-specific dev-workflow guidance the
 *  default prompt doesn't cover. Keep this LEAN; every token here
 *  is in every turn's input.
 *
 *  Why ports and not other things: dev-server ports change every
 *  run (Vite tries 5173 → falls back to 5174 if busy; Next does
 *  the same on 3000 → 3001). Claude code without this hint will
 *  hardcode 3000/5173 from package.json scripts and break
 *  intermittently. Telling it to verify via `lsof` or recent
 *  bash output costs ~40 tokens per turn and saves the user
 *  every "why didn't it work?" debugging round.
 *
 *  Other CLIs (codex, qwen, aider) get equivalent appendages via
 *  their own hint constants once their adapters land. */
const QCODE_ENGINE_HINT = `qcode dev-workflow hints (running you inside the qcode desktop app):

LIVE PREVIEW PANE — qcode shows a live iframe of any localhost URL on the right side of the chat. It auto-syncs to whatever localhost URL appears in your bash output ("Local: http://localhost:5174" / "ready on http://localhost:3000" banners). The user can SEE the running app rendered live without leaving qcode. So when you boot a dev server, the user already sees it. You don't need to "tell them to open it in their browser."

VERIFYING RUNNING APPS — you do NOT have a built-in browser tool here. Use Playwright via Bash. DO NOT install per-project (no \`npm i -D @playwright/test\` in the user's project) — that pollutes their package.json and re-downloads Chromium for every workspace. Use the GLOBAL qcode-runtime install at \`~/.qcode/runtime\` instead, which is shared across every chat and every project.

DO NOT ask the user permission first ("Want me to do that?" is the wrong default). Just do it.

  # ─── ONE-TIME bootstrap (only if ~/.qcode/runtime/node_modules/playwright doesn't exist yet)
  # Prefer bun (~3-5s install) → pnpm (~8s) → npm (~25s) for the install
  # step. They all produce a node_modules/playwright that imports the
  # same way, so the verify script below is package-manager agnostic.
  if [ ! -d "$HOME/.qcode/runtime/node_modules/playwright" ]; then
    mkdir -p "$HOME/.qcode/runtime" && cd "$HOME/.qcode/runtime"
    if command -v bun >/dev/null 2>&1; then
      bun init -y >/dev/null 2>&1 || true
      bun add playwright >/dev/null
    elif command -v pnpm >/dev/null 2>&1; then
      pnpm init >/dev/null 2>&1 || true
      pnpm add playwright >/dev/null
    else
      npm init -y >/dev/null
      npm i playwright >/dev/null
    fi
    # chrome-headless-shell is Playwright's slim ~80MB build (vs full
    # Chromium ~150MB) — enough for navigate/screenshot/eval/click,
    # which is all we use it for.
    npx playwright install chrome-headless-shell >/dev/null
    cd - >/dev/null
  fi

  # ─── verify a running app
  cat > /tmp/verify.mjs <<'EOF'
  import { chromium } from \`\${process.env.HOME}/.qcode/runtime/node_modules/playwright\`;
  const b = await chromium.launch({ channel: 'chrome-headless-shell' });
  const p = await b.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  const r = await p.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  console.log('status', r.status());
  console.log('title', await p.title());
  console.log('h1', await p.$eval('h1', e => e.innerText).catch(() => '(none)'));
  await p.screenshot({ path: '/tmp/preview.png' });
  console.log('errors', errors.length ? errors : 'none');
  await b.close();
  EOF
  node /tmp/verify.mjs

The bootstrap step takes ~30s the FIRST time the user uses qcode (one-time across their machine, not per project). Every subsequent run is instant — \`~/.qcode/runtime\` persists between projects, restarts, even qcode upgrades. Same approach works for clicking buttons, filling forms, e2e flows — extend the script with page.click / page.fill / page.waitForSelector.

Localhost / dev-server access — ports change between runs (Vite picks 5174 if 5173 is busy; Next picks 3001 if 3000 is taken). NEVER hardcode a port from package.json scripts. Before any \`curl\`, \`fetch\`, or playwright \`page.goto\` to a localhost URL, verify the LIVE port two ways:
  1. Scan recent bash output for "Local:" / "ready on" / "Listening on" / "started server" banners — Vite, Next, Astro, Storybook, Remix, Nuxt, SvelteKit, Tauri's vite, Express, Fastify, NestJS, Django, Flask, Rails all print one of those.
  2. If no recent banner, run: \`lsof -i -P -n -sTCP:LISTEN | grep LISTEN\` (or \`netstat -tnlp | grep LISTEN\` on Linux when lsof isn't available). Pick the port matching the project's dev framework (3000 for Next, 5173 for Vite, 4321 for Astro, 6006 for Storybook, etc.).
The user is on a desktop app, so localhost is THEIR machine. Treat dev servers as state-you-can-inspect, not state-you-can-guess.`;

/** Where the gateway lives. Claude Code reads ANTHROPIC_BASE_URL and
 *  appends /v1/messages. We use the standard URL — no path prefix,
 *  no custom headers, nothing that breaks api.qlaud.ai's "drop-in
 *  Anthropic-compat" promise. Per-thread session attribution flows
 *  via Anthropic's standard body.metadata.user_id (which Claude
 *  Code populates with its session id) → qlaud edge captures and
 *  forwards as cf-aig-metadata.client_session_id. */
const QLAUD_BASE_URL = 'https://api.qlaud.ai';

/** Same shape as RunThreadAgentOpts but trimmed to what an engine
 *  actually needs. Custom approval / autoApprove / autoCommit fields
 *  from the legacy path are ignored — claude handles those itself. */
export type RunEngineClaudeCodeOpts = {
  /** Claude Code session id. Pass an existing one to --resume; pass
   *  null on first turn and we capture whatever id claude assigns.
   *  Persisted by ChatSurface per workspace so the next turn picks
   *  up where this one left off, AND used to filter the AI Gateway
   *  log on thread rehydrate (claude code populates Anthropic's
   *  body.metadata.user_id with this session id, qlaud edge copies
   *  it into cf-aig-metadata.client_session_id). */
  sessionId: string | null;
  /** Capture the assigned session id back to the caller so it can
   *  persist for the next turn. Fired exactly once per run, after
   *  the system/init event arrives. */
  onSessionId?: (id: string) => void;
  /** User picked model (e.g. "claude-sonnet-4-5", "claude-haiku-4-5").
   *  We pass via --model; claude resolves to its current upstream slug. */
  model: string;
  /** Workspace dir. Claude runs with cwd=this — its file tools see
   *  this as the project root. */
  workspace: string;
  /** New user turn — same content-block array the qlaud path uses.
   *  For v0 we flatten to plain text and pass via --print (the prompt
   *  arg). When claude's --input-format stream-json is fully reliable
   *  we'll switch to bidirectional stdin. */
  content: ContentBlock[];
  signal?: AbortSignal;
  onEvent: (e: AgentEvent) => void;
};

export async function runEngineClaudeCode(
  opts: RunEngineClaudeCodeOpts,
): Promise<void> {
  const apiKey = getKey();
  if (!apiKey) {
    opts.onEvent({
      type: 'error',
      message: 'Not signed in to qlaud — open Settings and add your API key first.',
    });
    return;
  }

  // Flatten content blocks to a single text prompt for v0. Multimodal
  // (images, documents) needs claude's --input-format stream-json to
  // be reliable; punt for now, document the limitation.
  const promptText = opts.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
  if (!promptText) {
    opts.onEvent({
      type: 'error',
      message: 'Engine Mode v0 only supports text prompts. Multimodal (images / PDFs) coming after the long-lived-process refactor.',
    });
    return;
  }

  // First turn renders before any output arrives — gives the user
  // immediate feedback that the engine spawned. ChatSurface is already
  // listening for turn_start from the legacy path so this slots in.
  opts.onEvent({ type: 'turn_start', turn: 0 });

  // Build the claude argv. The flags chosen here, with rationale:
  //
  //   --bare           Skips keychain + OAuth reads. Auth is strictly
  //                    ANTHROPIC_API_KEY (which we inject below). No
  //                    auto-memory, no plugin sync, no LSP, no CLAUDE.md
  //                    auto-discovery. We want a clean spawn from a
  //                    GUI-managed env, not the user's interactive one.
  //   --print          Non-interactive: take the prompt arg, run, exit.
  //                    For v0 we spawn-per-turn. Later we'll switch to
  //                    --input-format stream-json for a long-lived child.
  //   --output-format stream-json
  //                    JSON-line on stdout — that's what we parse.
  //   --include-partial-messages
  //                    Stream content_block_delta events as they arrive
  //                    instead of buffering whole messages. Required
  //                    for live text streaming in the UI.
  //   --verbose        Required by claude when using stream-json + print
  //                    together (without it, --output-format is rejected).
  //   --dangerously-skip-permissions
  //                    v0 only. We'll properly intercept claude's
  //                    permission prompts in v1 and route to qcode's
  //                    ApprovalCard. For the smoke test we trust the
  //                    user's workspace — same posture as YOLO mode in
  //                    the legacy path.
  //   --model <slug>   User's model pick.
  //   --resume <id>    Multi-turn continuity. Claude restores its
  //                    entire conversation state from disk; qcode never
  //                    sees or stores it.
  //   --append-system-prompt
  //                    Carries qcode-specific dev-workflow hints
  //                    (port detection, etc.) WITHOUT overriding
  //                    Claude Code's default agent prompt. We're
  //                    nudging behavior, not replacing it.
  //   --permission-mode / --dangerously-skip-permissions /
  //   --disallowedTools
  //                    Mapped from settings.autoApprove. See
  //                    permissionFlags() for the YOLO/Smart/Strict
  //                    rules. v1 — coarse buckets; v2 will route
  //                    each request through qcode's ApprovalCard
  //                    via a bundled --permission-prompt-tool MCP
  //                    server.
  const args: string[] = [
    '--bare',
    '--print',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    ...permissionFlags(getSettings().autoApprove),
    '--model', opts.model,
    '--append-system-prompt', QCODE_ENGINE_HINT,
  ];
  if (opts.sessionId) {
    args.push('--resume', opts.sessionId);
  }
  args.push(promptText);

  const cmd = Command.create('claude', args, {
    cwd: opts.workspace,
    env: {
      ANTHROPIC_BASE_URL: QLAUD_BASE_URL,
      ANTHROPIC_API_KEY: apiKey,
      // Disable claude's own telemetry. We're routing through qlaud
      // for billing + observability; redundant + slightly leaky
      // otherwise.
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
    },
  });

  // ─── Per-turn state ────────────────────────────────────────────
  // input_json_delta accumulates per-content-block-index until the
  // matching content_block_stop fires. Same accumulator pattern the
  // qlaud-client SSE consumer uses — we keep both consistent so the
  // event reducer in ChatSurface doesn't have to branch on source.
  type ToolUseAccum = { id: string; name: string; jsonText: string };
  const toolAccum = new Map<number, ToolUseAccum>();
  let totalInput = 0;
  let totalOutput = 0;
  let sessionIdEmitted = false;
  let stderrBuf = '';

  // JSON-line buffer. claude sometimes emits multi-KB events that
  // arrive split across read chunks; accumulate until newline.
  let stdoutBuf = '';

  const handleClaudeLine = (raw: string) => {
    let ev: ClaudeStreamLine;
    try {
      ev = JSON.parse(raw) as ClaudeStreamLine;
    } catch {
      // Ignore unparseable lines. Could be a debug print on stderr
      // that bled into stdout (rare); skipping is safer than crashing
      // the run.
      return;
    }

    // System init — first line claude emits. Carries the session_id
    // we need to persist for next-turn --resume. Also lists the tools
    // and skills available, which we could surface in the UI later.
    if (ev.type === 'system' && ev.subtype === 'init') {
      if (!sessionIdEmitted && typeof ev.session_id === 'string') {
        sessionIdEmitted = true;
        opts.onSessionId?.(ev.session_id);
      }
      return;
    }

    // Status events ("requesting", "tool_use_running", etc.) — we
    // could map to a typing indicator but for v0 we ignore. The
    // stream_event payloads below carry the actual content.
    if (ev.type === 'system' && ev.subtype === 'status') return;

    // The meat. claude wraps each Anthropic SSE event in a
    // {type:"stream_event", event:{...}} envelope. Inside `event` is
    // the literal Anthropic shape — same shape qlaud-client.ts
    // parses for the legacy path. We translate to AgentEvent.
    if (ev.type === 'stream_event' && ev.event) {
      handleAnthropicEvent(ev.event);
      return;
    }

    // Tool result returned to claude after it dispatched (Read,
    // Write, Bash, etc.). Claude wraps these as "user" events with
    // content blocks of type tool_result, each carrying the
    // tool_use_id back-reference. We unwrap and emit `tool_done`
    // events so the UI's running tool cards flip to done/error
    // with their actual output. Without this, cards stay "running"
    // forever in Engine Mode.
    if (ev.type === 'user' && ev.message) {
      const msg = ev.message as {
        content?: Array<{
          type?: string;
          tool_use_id?: string;
          content?: unknown;
          is_error?: boolean;
        }>;
      };
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (const block of blocks) {
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') {
          continue;
        }
        opts.onEvent({
          type: 'tool_done',
          id: block.tool_use_id,
          content: stringifyToolResult(block.content),
          isError: !!block.is_error,
        });
      }
      return;
    }

    // Final message — emit `finished`. claude's `result` event
    // carries usage + cost so we can render the usage pill.
    if (ev.type === 'result') {
      const usage = ev.usage ?? {};
      opts.onEvent({
        type: 'finished',
        stopReason: ev.subtype === 'success' ? 'end_turn' : ev.subtype,
        turns: ev.num_turns ?? 1,
        usage: {
          inputTokens: totalInput || (usage.input_tokens ?? 0),
          outputTokens: totalOutput || (usage.output_tokens ?? 0),
        },
        // qlaud surfaces cost via /v1/usage; the dashboard will pull
        // it. The stream-json event also has total_cost_usd locally.
        costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null,
        seq: null,
      });
      return;
    }

    // assistant final message — already streamed via deltas, ignore.
    if (ev.type === 'assistant') return;
  };

  const handleAnthropicEvent = (av: AnthropicSseEvent) => {
    switch (av.type) {
      case 'message_start': {
        const it = av.message?.usage?.input_tokens;
        if (typeof it === 'number') totalInput += it;
        return;
      }
      case 'content_block_start': {
        const cb = av.content_block as
          | { type: 'tool_use'; id: string; name: string }
          | { type: string; [k: string]: unknown }
          | undefined;
        if (cb?.type === 'tool_use' && typeof av.index === 'number') {
          // Narrowed: the tool_use variant guarantees id + name are strings.
          const tu = cb as { type: 'tool_use'; id: string; name: string };
          toolAccum.set(av.index, {
            id: tu.id,
            name: tu.name,
            jsonText: '',
          });
        }
        return;
      }
      case 'content_block_delta': {
        if (!av.delta) return;
        if (av.delta.type === 'text_delta' && typeof av.delta.text === 'string') {
          opts.onEvent({ type: 'text', text: av.delta.text });
        } else if (
          av.delta.type === 'input_json_delta' &&
          typeof av.index === 'number' &&
          typeof av.delta.partial_json === 'string'
        ) {
          const acc = toolAccum.get(av.index);
          if (acc) acc.jsonText += av.delta.partial_json;
        }
        // thinking_delta is interesting but the legacy AgentEvent
        // doesn't have a slot for it. Punt — ChatSurface will see
        // the tool_use blocks fire as the model finishes thinking.
        return;
      }
      case 'content_block_stop': {
        if (typeof av.index !== 'number') return;
        const acc = toolAccum.get(av.index);
        if (!acc) return;
        let input: unknown = {};
        try {
          input = acc.jsonText ? JSON.parse(acc.jsonText) : {};
        } catch {
          input = { _raw: acc.jsonText };
        }
        // Synthesize a tool_call event the same way the legacy path
        // does. The matching tool_done comes from claude's `user`
        // event (tool_result block) — we don't have a tool_use_id
        // → result mapping mid-stream the way the legacy path
        // does because claude dispatches the tool internally. We
        // synthesize a tool_done immediately on stop so the UI
        // doesn't show a perpetually-spinning card; the actual
        // result lands in claude's next message via more deltas.
        opts.onEvent({
          type: 'tool_call',
          id: acc.id,
          name: acc.name,
          input,
          status: 'running',
        });
        // tool_done fires later when claude returns the matching
        // tool_result inside a `user` event envelope (see the
        // `ev.type === 'user'` branch above). Mapping back to this
        // running card uses tool_use_id as the join key.
        toolAccum.delete(av.index);
        return;
      }
      case 'message_delta': {
        const ot = av.usage?.output_tokens;
        if (typeof ot === 'number') totalOutput += ot;
        return;
      }
      default:
        return;
    }
  };

  cmd.stdout.on('data', (chunk: string) => {
    stdoutBuf += chunk;
    let nl: number;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line) handleClaudeLine(line);
    }
  });

  cmd.stderr.on('data', (chunk: string) => {
    // claude writes setup info / warnings to stderr. We collect for
    // surfacing on non-zero exit; otherwise it's just noise.
    if (stderrBuf.length < 16_000) stderrBuf += chunk;
  });

  // Abort wiring. ChatSurface's stop() aborts the signal — kill the
  // child so claude's loop unwinds cleanly. claude handles SIGTERM
  // by saving the session and exiting.
  let killed = false;
  const onAbort = async () => {
    if (killed) return;
    killed = true;
    try {
      await child.kill();
    } catch {
      // already dead, ignore
    }
  };
  if (opts.signal) {
    if (opts.signal.aborted) {
      onAbort();
    } else {
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  let child: Awaited<ReturnType<typeof cmd.spawn>>;
  try {
    child = await cmd.spawn();
  } catch (e) {
    opts.onEvent({
      type: 'error',
      message:
        e instanceof Error && e.message.includes('not allowed')
          ? `Tauri capability rejected the spawn — make sure 'claude' is in capabilities/default.json. (${e.message})`
          : `Failed to spawn claude: ${e instanceof Error ? e.message : String(e)}. Is Claude Code installed? Run \`claude --version\` from your terminal.`,
    });
    return;
  }

  // Wait for the child to exit. Tauri's Command emits 'close' with
  // the code; we resolve the run when that fires. handleClaudeLine
  // has already fired the `finished` event by this point if claude
  // exited cleanly with a `result` line.
  await new Promise<void>((resolve) => {
    cmd.on('close', (data) => {
      // Drain any trailing buffered line that didn't end with \n.
      if (stdoutBuf.trim()) handleClaudeLine(stdoutBuf.trim());
      stdoutBuf = '';

      // Non-zero exit when claude crashed before emitting a `result`
      // line. Surface stderr (truncated) so the user has a clue.
      if (data.code !== null && data.code !== 0 && !sessionIdEmitted) {
        opts.onEvent({
          type: 'error',
          message: `claude exited ${data.code}${stderrBuf ? `: ${stderrBuf.slice(0, 800)}` : ''}`,
        });
      }
      resolve();
    });
  });
}

// ─── Settings + persistence helpers ──────────────────────────────

/** Per-thread Claude Code session id, stored in qcode settings as a
 *  map keyed by qcode threadId. ChatSurface calls these to chain
 *  --resume across turns. */
export function getClaudeSessionId(threadId: string): string | null {
  const map = getSettings().claudeSessionByThread;
  return map?.[threadId] ?? null;
}

export function setClaudeSessionId(threadId: string, sessionId: string): void {
  const prev = getSettings().claudeSessionByThread ?? {};
  patchSettings({
    claudeSessionByThread: { ...prev, [threadId]: sessionId },
  });
}

/** Map qcode's autoApprove tri-state to Claude Code's permission
 *  flags. v1 is coarse — three preset buckets — because Claude
 *  Code's --print mode can't surface interactive prompts to the
 *  qcode UI directly. Per-call ApprovalCard routing requires a
 *  bundled MCP server invoked via --permission-prompt-tool that
 *  forwards each request to the qcode webview over an IPC channel
 *  and waits for the click; that's a meaningful sidecar binary +
 *  Tauri command project. v2.
 *
 *  YOLO   — --dangerously-skip-permissions: bypass every check.
 *           Same posture as the legacy "yolo" auto-approve mode.
 *  Smart  — bypass-permissions PLUS a denylist of obviously
 *           destructive bash patterns. The deny-list is belt-and-
 *           suspenders; Anthropic's own model safety covers the
 *           catastrophic stuff already, but explicit deny rules
 *           give us a hard guarantee for the common foot-guns.
 *  Strict — --permission-mode plan: read-only tools only. The
 *           agent CAN investigate but can't write, edit, or run
 *           shell. User flips to YOLO/Smart when ready to act. */
function permissionFlags(mode: 'yolo' | 'smart' | 'strict'): string[] {
  // Patterns claude code understands. Glob-style on the bash command
  // itself; passes through to claude's own pattern matcher. The
  // --disallowedTools flag is variadic per claude's argv parser
  // (`<tools...>`), so we MUST use the `--flag=val` form with a
  // comma-joined list — otherwise claude's parser greedily eats the
  // prompt that follows.
  const dangerousBashPatterns = [
    'Bash(rm -rf *)',
    'Bash(rm -fr *)',
    'Bash(sudo *)',
    'Bash(:(){ :|:& };:)',
  ];
  switch (mode) {
    case 'yolo':
      return ['--dangerously-skip-permissions'];
    case 'smart':
      return [
        '--dangerously-skip-permissions',
        `--disallowedTools=${dangerousBashPatterns.join(',')}`,
      ];
    case 'strict':
      return ['--permission-mode', 'plan'];
    default:
      return ['--dangerously-skip-permissions'];
  }
}

/** Anthropic tool_result blocks carry `content` as either a plain
 *  string OR an array of content blocks (text + image). The qcode
 *  UI's tool cards expect a string for rendering. We coerce here:
 *  string passes through; arrays get the text fields concatenated;
 *  unknown shapes fall back to a JSON dump so nothing's lost. */
function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((b) => {
        if (b && typeof b === 'object') {
          const block = b as { type?: string; text?: unknown };
          if (block.type === 'text' && typeof block.text === 'string') {
            return block.text;
          }
        }
        return null;
      })
      .filter((s): s is string => s !== null);
    if (parts.length > 0) return parts.join('\n');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

// ─── Wire-shape of claude's --output-format stream-json ──────────

type ClaudeStreamLine =
  | {
      type: 'system';
      subtype: 'init';
      session_id?: string;
      tools?: string[];
      mcp_servers?: unknown[];
      model?: string;
      apiKeySource?: string;
    }
  | {
      type: 'system';
      subtype: 'status';
      status?: string;
    }
  | {
      type: 'stream_event';
      event: AnthropicSseEvent;
      session_id?: string;
    }
  | {
      type: 'assistant';
      message?: { content?: unknown[]; usage?: unknown };
    }
  | {
      type: 'user';
      message?: unknown;
    }
  | {
      type: 'result';
      subtype?: string;
      num_turns?: number;
      usage?: { input_tokens?: number; output_tokens?: number };
      total_cost_usd?: number;
      result?: string;
    };

type AnthropicSseEvent =
  | {
      type: 'message_start';
      message?: { usage?: { input_tokens?: number } };
    }
  | {
      type: 'content_block_start';
      index?: number;
      content_block?:
        | { type: 'text'; text?: string }
        | { type: 'tool_use'; id: string; name: string; input?: unknown }
        | { type: 'thinking'; thinking?: string }
        | { type: string; [k: string]: unknown };
    }
  | {
      type: 'content_block_delta';
      index?: number;
      delta?:
        | { type: 'text_delta'; text?: string }
        | { type: 'input_json_delta'; partial_json?: string }
        | { type: 'thinking_delta'; thinking?: string }
        | { type: 'signature_delta'; signature?: string }
        | { type: string; [k: string]: unknown };
    }
  | {
      type: 'content_block_stop';
      index?: number;
    }
  | {
      type: 'message_delta';
      delta?: { stop_reason?: string };
      usage?: { output_tokens?: number };
    }
  | {
      type: 'message_stop';
    };
