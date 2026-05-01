# qcode — contributor guide

Read this first if you're picking up qcode where the last commit left off.
The README is the marketing-facing pitch; this file is the engineering one.

## What's actually shipped (`v0.1.0-alpha.3`)

- **Tauri 2.x desktop shell** — Mac/Win/Linux targets, `qcode://` URL scheme
- **Native chrome** — macOS HudWindow vibrancy, Windows acrylic, native menu bar (File / Edit / View / Window / Help) with platform shortcuts, transparent-with-blur title bar
- **OS-native credential storage** — Apple Keychain / Windows Credential Manager / libsecret via `keyring` crate; localStorage fallback only in vite-dev
- **Workspace + file tree** — native folder picker, MRU recent list, lazy-expanding file tree with sensible hidden-folder filter
- **End-to-end auth** — app → browser → qlaud.ai/cli-auth → Clerk → mints CLI key → deep-links back to `qcode://auth?k=…` → React captures + persists to keychain
- **Full agentic loop** — multi-turn tool execution, abortable mid-stream
- **Read-only tools** — `list_files`, `read_file`, `glob`, `grep` (run without approval)
- **Approval-gated tools** — `write_file`, `edit_file`, `bash`. Each shows the user a card with a unified diff (writes/edits) or full command (bash) and Allow/Reject buttons before any side-effect runs. Path-jail to the workspace, deny-list on bash (`rm -rf /`, `sudo`, `curl|sh`, fork bombs, etc.), 60s bash timeout
- **Cross-platform release CI** — scaffolded; signing secrets not yet provisioned

```
src/
├── App.tsx               app shell — title bar, sidebar, chat
├── main.tsx              react root + auth hydration
├── styles.css            tailwind + tauri drag/transparent helpers
├── lib/
│   ├── auth.ts           keychain (Tauri) / localStorage (browser-mode)
│   ├── deep-link.ts      qcode://auth callback handler
│   ├── tauri.ts          runtime detection + dynamic-import wrappers
│   ├── workspace.ts      open folder, MRU, readDir
│   ├── shortcuts.ts      ⌘N/⌘O/⌘,/⌘K/⌘M cross-platform + native menu bridge
│   ├── tools.ts          tool defs + read-only executors (read_file, list_files)
│   ├── qlaud-client.ts   /v1/messages streamer with full tool_use protocol
│   ├── agent.ts          send → receive tool_use → execute → repeat
│   ├── models.ts         curated model list (snapshot of /v1/catalog)
│   └── cn.ts             twMerge helper
└── ui/
    ├── ChatSurface.tsx   composer, bubbles, agent event router, stop button
    ├── ToolCallCard.tsx  per-tool inline card with collapsible output
    ├── FileTree.tsx      lazy-expanding tree
    ├── ModelPicker.tsx   provider-grouped dropdown
    └── SignInGate.tsx    first-launch onboarding card

src-tauri/
├── Cargo.toml            tauri + plugins + keyring + window-vibrancy
├── src/main.rs           windows-subsystem entry
├── src/lib.rs            plugin wiring, deep-link handler, native effects
├── src/menu.rs           File/Edit/View/Window/Help menu + dispatcher
├── src/secret.rs         secret_set / secret_get / secret_del commands
└── tauri.conf.json       transparent + macOSPrivateApi window config
```

## What's NOT done — pick up here

### Phase 1 wrap-up (priority order)

1. **Approval-gated write tools.** The agent currently can only READ. To match Claude Code we need:
   - `write_file` — create/overwrite a file. UI: show full text in a diff viewer, "Apply" / "Reject" buttons.
   - `edit_file` — string-replacement edit. UI: unified diff with hunk-by-hunk approval. Suggest CodeMirror's `@codemirror/merge` or Monaco's diff editor; prefer CodeMirror (smaller bundle, native feel).
   - `bash` — execute a shell command. UI: show command + working directory + "Run" / "Skip" buttons. Pipe stdout/stderr live into the tool card. Use `tauri-plugin-shell::Command::new` with explicit `current_dir(workspace)` and a deny-list (`rm -rf /`, `:(){:|:&};:`, etc.).
   - `glob` — pattern match. Read-only, can ship without approval.
   - `grep` — content search. Read-only. Use ripgrep via Tauri's shell plugin if available, fallback to JS-side iteration.
   
   Architecture: extend `agent.ts` to emit `tool_call_pending_approval` events; `ChatSurface` halts the loop and shows the approval UI; user clicks → agent loop continues with the result. The protocol is the same, just an interstitial state.

2. **Auto-updater backend Worker.** `tauri.conf.json` references `https://qlaud.ai/qcode/release-channels/{{target}}/{{arch}}/{{current_version}}` — this endpoint doesn't exist yet. Build a Cloudflare Worker that reads from the GitHub releases API and returns the Tauri update manifest format. ~50 lines.

3. **Code signing + notarization.**
   - Mac: Apple Developer cert, `productbuild`, notarize via `xcrun notarytool`
   - Win: Authenticode cert + `signtool`
   - Linux: skip (most users tolerate unsigned)
   - Wire all 3 into `.github/workflows/release.yml` — secrets list at the bottom of the file

### Phase 2 — polished GUI (~4 weeks)

- Diff preview pane (likely CodeMirror's merge view) — needed for write_file/edit_file approval
- Multi-thread switcher (sidebar list, ⌘N for new, persist to disk per-workspace)
- Live spend bar in title bar (poll `api.qlaud.ai/v1/billing/balance` every 15s)
- Per-task model defaults (e.g. Claude for plan, DeepSeek for code)
- Settings UI: tools, permissions, working directory, telemetry opt-out
- First-launch onboarding tour
- Command palette (⌘K) — fuzzy-find files, switch model, run common actions

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
- **Comments explain WHY, not WHAT** — the code already says what it does
- **2-space indent**, single quotes, trailing commas on multi-line
- **lucide-react** for icons; if it's not there, draw inline SVG
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

Sign in via the in-app button — opens `qlaud.ai/cli-auth` in your browser, you sign into qlaud, browser deep-links back to the app, key gets written to your OS keychain.

For UI iteration without the Tauri shell:

```bash
pnpm dev
# open http://localhost:1420
```

Browser-mode bypasses Tauri features:
- Auth: localStorage instead of keychain
- Folder picker: prompts for a path string
- File tree: shows a stub
- Tool execution: returns "[browser-mode stub: would …]" instead of touching disk

## qlaud-side dependencies

The desktop app talks to two qlaud surfaces:

- **`https://qlaud.ai/cli-auth?cb=qcode://auth&app=qcode`** — Clerk-gated, mints CLI key. Source: `apps/dashboard-next/src/app/cli-auth/page.tsx` in the qlaud-router monorepo.
- **`https://api.qlaud.ai/v1/messages`** — streaming chat endpoint (Anthropic shape, with full tool_use protocol). Source: `apps/edge/src/routes/messages.ts`.

If you're working on qcode + qlaud together, clone both repos.
