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
import { ensureSkillsOnDisk, buildSkillPointer } from '../skill-bundle';
import { QLAUD_MEDIA_SKILL } from '../skills/qlaud-media';
import { QLAUD_VIDEO_CREATOR_SKILL } from '../skills/video-creator';

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
  # qcode bundles bun as a Tauri sidecar AND drops a symlink at
  # ~/.qcode/runtime/bun on first launch — that runtime dir is at
  # the front of PATH, so \`command -v bun\` should always succeed
  # in this script. The curl install + npm fallbacks below are
  # belt-and-suspenders for the rare cases where the symlink
  # didn't get created (Windows w/o dev-mode, locked FS, etc).
  if [ ! -d "$HOME/.qcode/runtime/node_modules/playwright" ]; then
    if ! command -v bun >/dev/null 2>&1; then
      # Fallback path: shim wasn't created, install bun system-wide.
      # ~10s one-time, persists at ~/.bun/bin for every future tool.
      curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || true
      export PATH="$HOME/.bun/bin:$PATH"
    fi
    cd "$HOME/.qcode/runtime"
    if command -v bun >/dev/null 2>&1; then
      bun init -y >/dev/null 2>&1 || true
      bun add playwright >/dev/null
      # bun x runs npx-equivalent via bun's own runner — ~3x faster
      # than npx + no per-call npm cache hits.
      bun x playwright install chrome-headless-shell >/dev/null
    else
      # Last-resort fallback if bun install + ~/.bun/bin both failed
      # (offline machine, no curl, locked-down env). npm always
      # exists alongside Node, which Playwright needs anyway.
      npm init -y >/dev/null
      npm i playwright >/dev/null
      npx playwright install chrome-headless-shell >/dev/null
    fi
    cd - >/dev/null
  fi

  # ─── verify a running app
  # Use dynamic await import — Node's static \`import\` requires a
  # plain string literal, not a template literal. Dynamic import
  # accepts a runtime expression so we can resolve \$HOME cleanly.
  # Default chromium.launch() (no channel pin) avoids the
  # "Unsupported chromium channel chrome-headless-shell" error on
  # Playwright versions <1.49.
  cat > /tmp/verify.mjs <<'EOF'
  const { chromium } = await import(\`\${process.env.HOME}/.qcode/runtime/node_modules/playwright\`);
  const b = await chromium.launch();
  const p = await b.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  const r = await p.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  console.log('status', r.status());
  console.log('title', await p.title());
  console.log('h1', await p.\$eval('h1', e => e.innerText).catch(() => '(none)'));
  await p.screenshot({ path: '/tmp/preview.png' });
  console.log('errors', errors.length ? errors : 'none');
  await b.close();
  EOF
  # Prefer bun (we just installed it above; faster cold-start than
  # node + handles ESM dynamic imports natively). Fall back to node
  # only if bun ended up unavailable AND node is on PATH.
  if command -v bun >/dev/null 2>&1; then
    bun /tmp/verify.mjs
  else
    node /tmp/verify.mjs
  fi

The bootstrap step takes ~30s the FIRST time the user uses qcode (one-time across their machine, not per project). Every subsequent run is instant — \`~/.qcode/runtime\` persists between projects, restarts, even qcode upgrades. Same approach works for clicking buttons, filling forms, e2e flows — extend the script with page.click / page.fill / page.waitForSelector.

Localhost / dev-server access — ports change between runs (Vite picks 5174 if 5173 is busy; Next picks 3001 if 3000 is taken). NEVER hardcode a port from package.json scripts. Before any \`curl\`, \`fetch\`, or playwright \`page.goto\` to a localhost URL, verify the LIVE port two ways:
  1. Scan recent bash output for "Local:" / "ready on" / "Listening on" / "started server" banners — Vite, Next, Astro, Storybook, Remix, Nuxt, SvelteKit, Tauri's vite, Express, Fastify, NestJS, Django, Flask, Rails all print one of those.
  2. If no recent banner, run: \`lsof -i -P -n -sTCP:LISTEN | grep LISTEN\` (or \`netstat -tnlp | grep LISTEN\` on Linux when lsof isn't available). Pick the port matching the project's dev framework (3000 for Next, 5173 for Vite, 4321 for Astro, 6006 for Storybook, etc.).
The user is on a desktop app, so localhost is THEIR machine. Treat dev servers as state-you-can-inspect, not state-you-can-guess.

GIT REPO BOUNDARY — qcode's right-rail Diff tab and several builtin tools assume the workspace IS its own git repo (a workspace-scoped \`.git\` at the root). When the user opens a workspace that ISN'T a repo of its own — common for fresh project folders, or for subfolders inside a larger personal monorepo — silent fallthrough to a parent repo's diff causes confusing bleed (Diff tab shows files outside the workspace, etc.).

If you're about to do anything commit-shaped (write_file, edit_file, multi-step refactor, scaffold a new project) AND \`git rev-parse --show-toplevel\` differs from the workspace path, run \`git init\` once at the workspace root before the changes. One-time setup, gives the user undo + history + qcode's diff tab works correctly. Skip when the workspace already has its own \`.git\` (the toplevel matches), or when the user is doing pure read-only / chat work where git isn't relevant.`;

/** Delegation + context-hygiene hint. Always-on, ~250 tokens. The
 *  best lever we have for keeping main-thread context lean across a
 *  long agentic session: push exploratory work into subagents whose
 *  output is a SUMMARY, not a transcript. Without this hint the
 *  default behavior is "do everything inline" and the parent
 *  context balloons with grep dumps, file reads, log scans the user
 *  doesn't actually need to see — and worse, those bloat every
 *  subsequent turn's input cost.
 *
 *  Subagent → context win: child runs in its own window, returns
 *  ≤200-word summary. The grep / read / log-scan tokens NEVER hit
 *  the parent. On a 30-turn session this is 5-10× compounding. */
const QCODE_DELEGATION_HINT = `DELEGATING TO SUBAGENTS — when work is "search, then summarize" (not "edit this file"), spawn a subagent. The subagent runs in its own context window and reports back a concise summary; the exploration tokens (grep dumps, file reads, command output) never enter THIS conversation's context, keeping every later turn cheaper and faster.

Use a subagent for:
  • Exploring how a system works ("how does authentication work in this codebase?")
  • Running long-output commands and summarizing ("run the test suite and report only the failures")
  • Scanning logs / large outputs ("scan /var/log/app and summarize errors from the last hour")
  • Multi-target research IN PARALLEL ("research how each of these 3 services handles retries" → 3 subagents in one turn)
  • Auditing for a specific pattern across many files ("find every place we still call the old API")

Don't subagent for:
  • Single-file edits, single grep — just do it inline.
  • Tasks needing this conversation's full context to make decisions.
  • Anything you'd finish in <2 tool calls.

Tell the subagent what you want and the OUTPUT FORMAT — "report under 200 words", "list paths only", "punch list of done vs missing". Vague prompts produce verbose reports. Run independent subagents IN PARALLEL (one message, multiple Task tool calls) when their work doesn't depend on each other.

CONTEXT MANAGEMENT — if THIS conversation gets long and you're noticing slow turns or autocompact warnings, the user can compact early via qcode's Compact button (or by sending "/compact" as a message). You can suggest it when work transitions to a new phase ("we just finished the auth refactor; compact before we move to billing?"). Don't compact mid-task — only at natural boundaries.`;

/** Where the gateway lives. Claude Code reads ANTHROPIC_BASE_URL and
 *  appends /v1/messages. We use the standard URL — no path prefix,
 *  no custom headers, nothing that breaks api.qlaud.ai's "drop-in
 *  Anthropic-compat" promise. Per-thread session attribution flows
 *  via Anthropic's standard body.metadata.user_id (which Claude
 *  Code populates with its session id) → qlaud edge captures and
 *  forwards as cf-aig-metadata.client_session_id. */
const QLAUD_BASE_URL = 'https://api.qlaud.ai';

/** Cached user login PATH (resolved on first claude spawn).
 *
 *  When qcode.app launches from Finder/Spotlight/Dock, it inherits
 *  macOS's tiny launchd PATH — just /usr/bin:/bin:/usr/sbin:/sbin.
 *  Anything the user installed via Homebrew (/opt/homebrew/bin),
 *  bun (~/.bun/bin), nvm (~/.nvm/...), npm-global (~/.npm-global/bin),
 *  or pnpm (~/Library/pnpm) is invisible — including `claude` itself
 *  if it was installed via npm/pnpm/bun. Result: spawn fails with
 *  "No such file or directory (os error 2)" even though the user
 *  has claude on PATH in their actual terminal.
 *
 *  Workaround: spawn `bash -lc 'echo $PATH'` once on first need.
 *  bash/sh always live at /bin so we can run them without our own
 *  PATH being correct. -lc tells bash to source the user's login
 *  files (~/.zshrc / ~/.bash_profile / etc) so PATH is whatever the
 *  user has in their real terminal. Cache the result for the rest
 *  of this qcode session — login PATH doesn't change between
 *  spawns. */
let cachedLoginPath: string | null = null;
const FALLBACK_PATH =
  '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

async function getHome(): Promise<string> {
  try {
    const { homeDir } = await import('@tauri-apps/api/path');
    return (await homeDir()).replace(/\/+$/, '');
  } catch {
    return '';
  }
}

async function getLoginPath(): Promise<string> {
  if (cachedLoginPath) return cachedLoginPath;
  try {
    // -l = login shell (sources ~/.zprofile / ~/.bash_profile)
    // -c = run a single command and exit
    const out = await Command.create('bash', ['-lc', 'echo $PATH']).execute();
    const path = (out.stdout || '').trim();
    if (out.code === 0 && path) {
      cachedLoginPath = path;
      return path;
    }
  } catch {
    // bash isn't even findable — extremely rare, but the fallback
    // below covers the most-common Homebrew + npm-global locations.
  }
  cachedLoginPath = FALLBACK_PATH;
  return FALLBACK_PATH;
}

/** Cached qcode-runtime dir (with the bun shim in place). Resolved
 *  on first claude-code spawn; idempotent thereafter. */
let cachedRuntimeDir: string | null = null;

/** Make qcode's bundled bun visible to bash subshells.
 *
 *  Why this exists: Tauri sidecar binaries ship at platform-specific
 *  paths with target-triple suffixes (e.g.
 *  `Contents/MacOS/binaries/bun-aarch64-apple-darwin` on macOS). The
 *  Tauri JS API (`Command.sidecar('binaries/bun', ...)`) knows how
 *  to find them, but a bash subshell looking for `bun` on PATH does
 *  NOT — neither the directory nor the suffixed name is visible to
 *  any shell. So when an agent runs `bunx playwright install` from
 *  a bash tool call, it fails with "bun: command not found" even
 *  though qcode is shipping a perfectly good bun binary.
 *
 *  Fix: ask the bundled bun where it lives (via `process.execPath`
 *  inside a one-liner), then drop a symlink at
 *  `~/.qcode/runtime/bun` pointing at it. claude-code's spawn env
 *  prepends `~/.qcode/runtime` to PATH so bash finds the symlink as
 *  plain `bun`. Zero downloads, zero waiting — the binary is already
 *  on disk, we just make it discoverable.
 *
 *  Idempotent: skips if the symlink already exists. Falls back
 *  gracefully if the symlink can't be created (older Windows
 *  without dev mode, locked FS, etc.) — the bootstrap script's
 *  curl-install fallback still runs.
 *
 *  Returns the runtime dir to prepend to PATH, or null when we're
 *  not in Tauri (web build) or the prep failed. */
export async function prepareBunRuntime(): Promise<string | null> {
  if (cachedRuntimeDir) return cachedRuntimeDir;
  try {
    const home = await getHome();
    if (!home) return null;
    const runtimeDir = `${home}/.qcode/runtime`;
    const shimPath = `${runtimeDir}/bun`;

    const { exists, mkdir } = await import('@tauri-apps/plugin-fs');
    if (!(await exists(runtimeDir))) {
      await mkdir(runtimeDir, { recursive: true });
    }
    if (await exists(shimPath)) {
      // Already prepared in a previous session.
      cachedRuntimeDir = runtimeDir;
      return runtimeDir;
    }

    // Ask bundled bun for its own absolute path, then symlink.
    // process.execPath is the binary that's currently running — for
    // a Tauri sidecar that's the resolved per-platform path under
    // Contents/MacOS/ (or wherever the OS unpacked it). Doing this
    // via bun itself is platform-agnostic; we don't have to know
    // the target triple or the bundle layout.
    //
    // The one-liner does the symlink in-process so we only spawn
    // bun once: print path, create symlink to itself. Errors are
    // swallowed — JSON.stringify(false) on failure tells the JS
    // caller to fall back. fs.symlinkSync is the bun built-in.
    const setupScript = [
      'const fs = require("fs");',
      'const path = require("path");',
      'try {',
      '  const dst = process.argv[2];',
      '  const dir = path.dirname(dst);',
      '  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });',
      '  if (!fs.existsSync(dst)) fs.symlinkSync(process.execPath, dst);',
      '  console.log("ok:" + process.execPath);',
      '} catch (e) { console.log("err:" + (e && e.message || e)); }',
    ].join(' ');
    const out = await Command.sidecar('binaries/bun', [
      '-e', setupScript, '--', shimPath,
    ]).execute();
    const stdout = (out.stdout || '').trim();
    if (out.code !== 0 || !stdout.startsWith('ok:')) {
      // Symlink failed (Windows w/o dev mode, locked FS, etc).
      // Caller will skip the PATH prepend and the bootstrap script
      // will fall back to curl-installing bun system-wide.
      return null;
    }
    cachedRuntimeDir = runtimeDir;
    return runtimeDir;
  } catch {
    return null;
  }
}

/** Resolve the bundled claude CLI — bun sidecar + claude package
 *  shipped with qcode, no user install required.
 *
 *  Architecture:
 *
 *  - `binaries/bun` — Tauri sidecar, downloaded per-platform during
 *    CI build. Bun is a single self-contained JS runtime + package
 *    manager (~50-58MB per platform). Acts as the JS engine that
 *    runs claude's CLI wrapper script.
 *
 *  - `resources/runtime/node_modules/@anthropic-ai/claude-code/
 *    cli-wrapper.cjs` — bundled in qcode's resources directory.
 *    Installed once at CI build time via the bundled bun, so the
 *    matching per-platform claude native binary
 *    (claude-code-darwin-arm64 / -x64 / linux-x64 / win32-x64) is
 *    fetched into node_modules during the CI install.
 *
 *  Spawn shape:
 *
 *      Command.sidecar('binaries/bun',
 *        [<resourceDir>/runtime/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs,
 *         ...claude-args])
 *
 *  Tauri's resourceDir() resolves to wherever the OS unpacks the
 *  bundled resources (Contents/Resources on macOS, AppDir/usr/lib
 *  on Linux AppImage, etc) — same path on every platform from JS's
 *  perspective even though it differs on disk.
 *
 *  Why this beats the previous "find user's claude or bootstrap"
 *  strategy: zero prereqs. Users with no Node, no Bun, no npm at
 *  all on their machine still get a working claude. The bundled
 *  binary is self-contained. Updates ride along with qcode releases. */
type ClaudeSpawnSpec = { argsPrefix: string[] };
let cachedClaudeSpec: ClaudeSpawnSpec | null = null;

async function resolveClaude(): Promise<ClaudeSpawnSpec> {
  if (cachedClaudeSpec) return cachedClaudeSpec;

  // Resolve bundled cli-wrapper path. Tauri's resourceDir() returns
  // the OS-specific resources dir; the same relative subpath works
  // on every platform because we control how the runtime/ directory
  // is laid out at build time.
  const { resolveResource } = await import('@tauri-apps/api/path');
  const wrapperPath = await resolveResource(
    'resources/runtime/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs',
  );
  cachedClaudeSpec = { argsPrefix: [wrapperPath] };
  return cachedClaudeSpec;
}

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
  /** Qcode thread id (the qlaud-side UUID, not claude-code's session
   *  id which lives in opts.sessionId). When set + the user has
   *  media cloud sync on, the spawn passes this via QCODE_THREAD_ID
   *  so the qlaud-media skill can tag uploaded artifacts with the
   *  current conversation. Decoupled from sessionId because they
   *  refer to different things — sessionId resumes claude-code's
   *  local state, threadId scopes qlaud-side artifact metadata. */
  qcodeThreadId?: string | null;
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
  // Hoist settings to the top of the spawn block — used by both
  // the system-prompt skill assembly below AND the env block
  // further down (two-model config + cloud sync flag). Reads from
  // localStorage, cheap.
  const settings = getSettings();
  // Drop skill markdown files to ~/.qcode/skills/ idempotently
  // before spawn. The pointer below references these paths so the
  // agent can Read them on demand. Failure here is non-fatal —
  // pointer falls back to a graceful explanation.
  await ensureSkillsOnDisk();
  const homeForPointer = await getHome();
  // System-prompt addition: qcode dev hints + qlaud media skill +
  // skill-on-disk pointer (~150 tokens, always-on). The full
  // video-creator skill (7-8k tokens) lives at ~/.qcode/skills/
  // video-creator.md and the agent reads it via the Read tool only
  // when a user request matches. ~95% token-cost reduction for
  // users who don't ask for video, near-zero overhead for users
  // who do (single read, cached for rest of session). Replaces
  // the previous Settings-gated always-inline pattern.
  const sections = [
    QCODE_ENGINE_HINT,
    // Always-on. Teaches the agent to push exploratory / scanning /
    // multi-target research into subagents (clean child context,
    // ≤200-word summary back), and points at the Compact button for
    // long-thread hygiene. The biggest single context-conservation
    // lever in the long-session steady state — keeps the parent
    // turn's input flat across 30+ tool roundtrips that would
    // otherwise grow with every grep dump and log scan.
    QCODE_DELEGATION_HINT,
    QLAUD_MEDIA_SKILL,
    buildSkillPointer(homeForPointer),
  ];
  // Power-user override: settings.videoCreatorSkill, when true,
  // ALSO inlines the full skill in the system prompt. Useful when
  // a user knows they're going to ask for video on every turn and
  // wants to skip the one-time Read tool roundtrip on the first
  // ask. Default false (pointer-only) since the Read pattern is
  // strictly cheaper for typical usage.
  if (settings.videoCreatorSkill) sections.push(QLAUD_VIDEO_CREATOR_SKILL);
  const appendedSystemPrompt = sections.join(
    '\n\n────────────────────────────────────────\n\n',
  );
  const args: string[] = [
    '--bare',
    '--print',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    ...permissionFlags(settings.autoApprove),
    '--model', opts.model,
    '--append-system-prompt', appendedSystemPrompt,
  ];
  if (opts.sessionId) {
    args.push('--resume', opts.sessionId);
  }
  args.push(promptText);

  // Validate workspace before spawning. ENOENT during spawn could
  // come from EITHER a missing claude binary OR a missing cwd, and
  // the macOS error message is identical. Pre-check the cwd so we
  // can surface a clear "workspace folder doesn't exist" instead of
  // the misleading "Is Claude Code installed?" message when the
  // user's actual problem is a deleted/renamed workspace.
  try {
    const { stat } = await import('@tauri-apps/plugin-fs');
    const info = await stat(opts.workspace);
    if (!info.isDirectory) {
      opts.onEvent({
        type: 'error',
        message: `Workspace path is not a directory: ${opts.workspace}. Pick a different workspace folder (⌘O).`,
      });
      return;
    }
  } catch {
    opts.onEvent({
      type: 'error',
      message: `Workspace folder no longer exists: ${opts.workspace}. It may have been deleted, moved, or unmounted. Pick a workspace (⌘O) and resend.`,
    });
    return;
  }

  // Resolve the user's real login PATH so spawn can find `claude`
  // (and any node/npm tools claude itself may shell out to). Cached
  // after first call. See getLoginPath() comment for why this is
  // necessary on macOS apps launched from Finder.
  const loginPath = await getLoginPath();

  // Make qcode's bundled bun visible to bash. Returns the runtime
  // dir to prepend to PATH, or null if prep failed (Windows w/o
  // dev-mode symlinks, locked FS, etc) — in which case the agent's
  // bootstrap script falls back to curl-installing bun. First call
  // does the symlink (~5ms one-time); subsequent calls hit the
  // module-level cache and return instantly.
  const runtimeDir = await prepareBunRuntime();
  // Prepend the runtime dir if we have one — putting it BEFORE
  // loginPath ensures our bundled bun wins over any older
  // user-installed bun on the user's system PATH.
  const spawnPath = runtimeDir ? `${runtimeDir}:${loginPath}` : loginPath;

  // Resolve the bundled claude wrapper path. No user install needed —
  // qcode ships its own bun sidecar + claude code package.
  let claudeSpec: ClaudeSpawnSpec;
  try {
    claudeSpec = await resolveClaude();
  } catch (e) {
    opts.onEvent({
      type: 'error',
      message: `Couldn't locate the bundled Claude Code (${e instanceof Error ? e.message : String(e)}). Try reinstalling qcode.`,
    });
    return;
  }

  // Spawn via the Tauri-bundled `bun` sidecar, passing the bundled
  // claude wrapper script as the first arg. Bun runs the .cjs
  // wrapper which in turn execs the platform-specific claude
  // native binary that came in the same install.
  // Two-model config. The user's main pick drives every heavy turn
  // (--model also sets it, but ANTHROPIC_MODEL belt-and-suspenders
  // covers the rare path where claude reads from env). The
  // background pick — settings.subagentModel — drives Claude Code's
  // auxiliary calls (title gen, summarization, internal planning
  // helpers) via ANTHROPIC_SMALL_FAST_MODEL. Picking
  // Sonnet+Haiku, GPT-5.4+5.4-mini, or any flagship+cheap pair
  // here saves ~3-5x on those background tokens with no quality
  // hit on the main agent. Null = let claude-code use its built-in
  // default (currently haiku-4-5) — safe choice for new users.
  // (settings already hoisted above the system-prompt assembly.)
  const backgroundModel = settings.subagentModel;
  // Media cloud sync — when the user opted in, pass the flag and
  // current thread id to the spawn so the skill's optional cloud
  // section knows to fire. Off by default; the skill no-ops the
  // sync section when QCODE_MEDIA_CLOUD_SYNC isn't '1'.
  const cloudSync = settings.mediaCloudSync;
  const cmd = Command.sidecar('binaries/bun', [...claudeSpec.argsPrefix, ...args], {
    cwd: opts.workspace,
    env: {
      ANTHROPIC_BASE_URL: QLAUD_BASE_URL,
      ANTHROPIC_API_KEY: apiKey,
      // Main model — also passed via --model flag in args. Setting
      // both is intentional: --model is the primary signal, the
      // env var is a fallback if any sub-process inside claude
      // reads from env.
      ANTHROPIC_MODEL: opts.model,
      // Background / small-task model. Routed through qlaud just
      // like the main one (catalog handles routing per slug).
      // Skipped when null so claude-code falls back to its own
      // default rather than us pinning a value the user didn't
      // explicitly opt into.
      ...(backgroundModel ? { ANTHROPIC_SMALL_FAST_MODEL: backgroundModel } : {}),
      // Media cloud sync — turns on the optional "upload to qlaud
      // cloud after local save" path in the qlaud-media skill. The
      // thread id is needed so artifacts get tagged with the
      // current conversation; the skill curls /v1/artifacts/init
      // with this value.
      ...(cloudSync
        ? {
            QCODE_MEDIA_CLOUD_SYNC: '1',
            ...(opts.qcodeThreadId
              ? { QCODE_THREAD_ID: opts.qcodeThreadId }
              : {}),
          }
        : {}),
      // PATH is the headline reason this env block exists at all.
      // Without it, Tauri's spawn inherits macOS launchd's minimal
      // PATH and `claude` (Homebrew / npm-global / bun-global) isn't
      // findable. We pass the user's full login PATH, prefixed with
      // ~/.qcode/runtime when available so the bundled bun shim
      // wins over anything else.
      PATH: spawnPath,
      // Pass through HOME so claude's own config dir resolution
      // works (claude reads ~/.claude/ for credentials/sessions).
      // We resolve via Tauri's path API rather than process.env
      // because process isn't defined in the webview context.
      HOME: await getHome(),
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
    const msg = e instanceof Error ? e.message : String(e);
    let userMessage: string;
    if (msg.includes('not allowed')) {
      userMessage = `Tauri capability rejected the spawn — make sure 'claude' is in capabilities/default.json. (${msg})`;
    } else if (msg.includes('os error 2') || msg.toLowerCase().includes('no such file')) {
      // ENOENT — by far the most common failure on a fresh macOS
      // install. We've already prepended the user's full login PATH
      // to the spawn env (see getLoginPath above), so reaching here
      // means claude genuinely isn't on their PATH. Give actionable
      // install instructions that match what the user would do at
      // their terminal.
      userMessage = `Couldn't find the \`claude\` CLI on your PATH. Install it with one of:\n  • npm i -g @anthropic-ai/claude-code\n  • bun add -g @anthropic-ai/claude-code\n  • brew install anthropic/anthropic/claude-code\n\nThen restart qcode so the new PATH is picked up. (\`claude --version\` from your terminal should print a version when this is fixed.)`;
    } else {
      userMessage = `Failed to spawn claude: ${msg}.`;
    }
    opts.onEvent({ type: 'error', message: userMessage });
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
  // Skip both the localStorage write AND the server-side metadata
  // PATCH when the mapping is unchanged — common case when a thread
  // is resumed across multiple turns (same session_id reported on
  // every spawn).
  if (prev[threadId] === sessionId) return;
  patchSettings({
    claudeSessionByThread: { ...prev, [threadId]: sessionId },
  });
  // Server-side: append the session_id to the canonical thread's
  // metadata.claude_session_ids array so OTHER devices (qcode-web,
  // a fresh desktop install with no localStorage) can resolve
  // thread → session_ids → message rows on read.
  //
  // Threads can accumulate N session_ids over their lifetime —
  // every fresh Claude spawn (resumed or otherwise) gets its own
  // ephemeral id. The list captures the full history so the
  // server's GET /v1/threads/:id/messages can union across all of
  // them. Idempotent append — re-running this with a session_id
  // that's already in the list is a no-op server-side.
  //
  // Fire-and-forget. Failure here just means cross-device sync
  // for THIS session is delayed until the next setClaudeSessionId
  // call (or until a separate sync job catches it). The desktop
  // session keeps working regardless because localStorage already
  // has the mapping.
  void appendClaudeSessionIdToThreadMetadata(threadId, sessionId);
}

/** PATCH thread metadata to append the session_id. Read-modify-
 *  write to preserve other metadata fields (workspace_path,
 *  title, etc.) and to avoid duplicate entries. */
async function appendClaudeSessionIdToThreadMetadata(
  threadId: string,
  sessionId: string,
): Promise<void> {
  try {
    const { getRemoteThread, updateThreadMetadata } = await import('../threads');
    const thread = await getRemoteThread(threadId);
    const meta = (thread.metadata ?? {}) as Record<string, unknown>;
    const existing = Array.isArray(meta.claude_session_ids)
      ? (meta.claude_session_ids as unknown[]).filter(
          (x): x is string => typeof x === 'string' && x.length > 0,
        )
      : [];
    if (existing.includes(sessionId)) return; // already linked
    await updateThreadMetadata(threadId, {
      claude_session_ids: [...existing, sessionId],
    });
  } catch {
    // Non-fatal — desktop keeps working with localStorage; cross-
    // device sync just lags one cycle. We log nothing because this
    // can fire on EVERY turn for an unauthenticated/offline user
    // and the warnings would drown the console.
  }
}

/** Drop the threadId → session_id mapping. Called when the user
 *  deletes a thread so we don't leak settings entries forever AND
 *  any future rehydrate attempt for this id falls back to the
 *  threadId-keyed lookup (which won't find anything either, since
 *  the thread is server-side soft-deleted). */
export function clearClaudeSessionId(threadId: string): void {
  const prev = getSettings().claudeSessionByThread ?? {};
  if (!(threadId in prev)) return;
  const next = { ...prev };
  delete next[threadId];
  patchSettings({ claudeSessionByThread: next });
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
