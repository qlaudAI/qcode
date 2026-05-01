# qcode — contributor guide

Read this first if you're picking up qcode where the last commit left off.
The README is the marketing-facing pitch; this file is the engineering one.

## What's actually shipped (`v0.1.0-alpha.1`)

- **Tauri 2.x desktop shell** — Mac/Win/Linux targets, `qcode://` URL scheme, deep-link plugin wired
- **React + Vite + Tailwind UI** — sign-in gate, title bar with model picker + spend bar, sidebar stub, chat surface
- **Real streaming chat** against `https://api.qlaud.ai/v1/messages` — Anthropic-shape SSE parser, abort signal, error mapping (`cap_hit`, `unauthorized`, etc.)
- **End-to-end auth flow**: app → browser → `qlaud.ai/cli-auth` → Clerk → mints `qlk_live_…` → deep-links back via `qcode://auth?k=…` → React captures + persists
- **Cross-platform release CI** — scaffolded; signing secrets not yet provisioned (alpha ships unsigned)

```
src/
├── App.tsx              app shell — title bar, sidebar, chat
├── main.tsx             react root
├── styles.css           tailwind + tauri-specific drag rules
├── lib/
│   ├── auth.ts          localStorage v0 (keychain comes next)
│   ├── deep-link.ts     tauri event listener for qcode://auth
│   ├── qlaud-client.ts  /v1/messages streamer
│   ├── models.ts        curated model list (snapshot of /v1/catalog)
│   └── cn.ts            twMerge helper
└── ui/
    ├── ChatSurface.tsx  composer, bubbles, typing dots, sample prompts
    ├── ModelPicker.tsx  provider-grouped dropdown
    └── SignInGate.tsx   first-launch onboarding card

src-tauri/
├── Cargo.toml           tauri + plugins (deep-link, fs, dialog, os, shell, updater)
├── src/main.rs          windows-subsystem entry
├── src/lib.rs           plugin wiring + deep-link → "qcode://deep-link" event
└── tauri.conf.json      window config, csp, qcode:// scheme, updater endpoint
```

## What's NOT done — pick up here

### Phase 1 wrap-up (priority order)

1. **OS-keychain credential storage.** `lib/auth.ts` uses `localStorage` today; that's fine for vite-dev but bad for the packaged app (any other web content the webview loads could read it). Swap to [`tauri-plugin-keyring`](https://crates.io/crates/tauri-plugin-keyring) or `keytar`-equivalent.

2. **Embed the opencode core.** This is the big one. `sst/opencode` is the reference; we need to:
   - Either bundle `bun` + opencode in the Tauri sidecar dir and spawn it as a subprocess (`tauri-plugin-shell::Command`) on app launch
   - Or compile opencode's agent loop into a Rust crate (probably weeks of work; not recommended for v0)
   - Bridge via stdin/stdout JSON-lines or opencode's WebSocket server mode (preferred — opencode 0.x exposes `--server` flag)
   - Forward UI events to the agent: tool approvals, model selection, abort
   - Forward agent events to UI: tool calls, file diffs, sub-agent spawns
   - Replace `lib/qlaud-client.ts` direct calls with opencode-as-the-router; opencode itself talks to qlaud

3. **File workspace.** Today the app has no concept of "open folder". Add:
   - `tauri-plugin-dialog` `open()` for the folder picker (already imported in Cargo.toml; not wired in UI)
   - Workspace state in localStorage: most-recently-opened folders
   - File-tree sidebar component (replace the "Recent" stub)
   - Basic file operations through Tauri's fs plugin

4. **Code-signing + notarization.**
   - Mac: Apple Developer cert, `productbuild`, notarize via `xcrun notarytool`
   - Win: Authenticode cert + `signtool`
   - Linux: skip (most users tolerate unsigned)
   - Wire all 3 into `.github/workflows/release.yml` — secrets list at the bottom of the file

5. **Auto-updater backend.** `tauri.conf.json` references `https://qlaud.ai/qcode/release-channels/{{target}}/{{arch}}/{{current_version}}` — this endpoint doesn't exist yet. Build a Cloudflare Worker that reads from the GitHub releases API and returns the Tauri update manifest format. ~50 lines.

### Phase 2 — polished GUI (~4 weeks)

- Diff preview pane (CodeMirror or Monaco)
- File tree sidebar with workspace persistence
- Multi-thread switcher (sidebar list, ⌘N for new)
- Live spend bar in title bar (poll `api.qlaud.ai/v1/billing/balance` every 15s)
- Per-task model defaults (e.g. Claude for plan, DeepSeek for code)
- Settings UI: tools, permissions, working directory, telemetry opt-out
- First-launch onboarding tour

### Phase 3 — power features (open-ended)

- Sub-agents UI (spawn, monitor, branch off)
- Hooks UI (pre-edit, post-edit, on-error)
- MCP server marketplace integrated with qlaud's catalog
- VS Code extension (handoff between qcode and editor)
- JetBrains plugin
- Team mode (shared qlaud account, per-user spend caps)
- CLI companion (`qcode --headless` for CI integration)

## Conventions

- **TypeScript strict** — no `any` without a comment explaining why
- **No JSDoc on small one-liners** — name the function clearly instead
- **Comments explain WHY, not WHAT** — the code already says what it does
- **2-space indent**, single quotes, trailing commas on multi-line
- **lucide-react** for icons; if the icon doesn't exist there, draw inline SVG
- **Tailwind only** for styles — no styled-components, no CSS modules
- **Don't add libraries casually** — bundle size matters for desktop apps
- **Commits**: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `perf:`. No emojis in commits.

## Local dev

```bash
git clone https://github.com/qlaudAI/qcode
cd qcode
pnpm install
pnpm tauri:dev
```

Sign in via the in-app button — it'll open `qlaud.ai/cli-auth` in your browser, you sign into qlaud, browser deep-links back to the app.

For UI iteration without the Tauri shell:

```bash
pnpm dev
# open http://localhost:1420
# Note: deep-link won't work in browser-mode; use ?k=qlk_live_xxx
# in localStorage to bypass auth for visual review
```

## qlaud-side dependencies

The desktop app talks to two qlaud surfaces:

- **`https://qlaud.ai/cli-auth?cb=qcode://auth&app=qcode`** — Clerk-gated, mints CLI key. Source: `apps/dashboard-next/src/app/cli-auth/page.tsx` in the qlaud-router monorepo.
- **`https://api.qlaud.ai/v1/messages`** — streaming chat endpoint (Anthropic shape). Source: `apps/edge/src/routes/messages.ts`.

If you're working on qcode + qlaud together, clone both repos.
