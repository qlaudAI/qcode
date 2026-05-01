# qcode

> The multi-model coding agent. Bring any model — Claude, GPT, Llama, DeepSeek — to your codebase.

`qcode` is an open-source desktop coding agent for Mac, Windows, and Linux, powered by [qlaud](https://qlaud.ai). It pairs the agent loop and tool ecosystem of [opencode](https://github.com/sst/opencode) with qlaud's multi-provider gateway, so you can ship the same workflow against whatever model fits the task — and pay 5–10× less for the privilege.

```
┌──────────────────────────────────────────────────────────────────┐
│ qcode                                                            │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│   anthropic  Claude Sonnet 4.6   ⌄        $4.21       ⚙          │
│                                                                  │
├─────────────┬────────────────────────────────────────────────────┤
│ + New chat  │                                                    │
│             │             What should we build?                  │
│ Recent      │                                                    │
│ — refactor  │   ▢ Open the qcode repo and explain the agent loop │
│ — fix tests │   ▢ Refactor the auth flow into a hook             │
│ — doc tour  │   ▢ Find and fix any flaky tests                   │
│             │   ▢ Run the test suite and triage failures         │
│             │                                                    │
│             │   ┌──────────────────────────────────────────────┐ │
│             │   │ Describe what you want to build…            ↑│ │
│             │   └──────────────────────────────────────────────┘ │
└─────────────┴────────────────────────────────────────────────────┘
```

## Why qcode

| | Other coding agents | **qcode** |
|---|---|---|
| Model choice | Locked to one vendor | Switch Claude → GPT → DeepSeek with one click |
| Cost | $20/mo flat fills fast | Pay-per-use, route to open-source for 5–10× savings |
| Per-user billing | One shared key | Hard spend caps enforced at the qlaud gateway |
| Tool ecosystem | Vendor-locked | qlaud's catalog (web search, email, SMS, custom HTTP) + MCP |
| Desktop UX | Terminal only | Native Mac / Win / Linux app, signed + auto-updating |
| Source code | Closed or partial | MIT, public, fork-friendly |

## Status — `v0.1.0-alpha`

This is the foundation, not the finish line. The repo is public from day one so you can watch progress, file issues, and contribute.

| Phase | What | Status |
|---|---|---|
| **Phase 1** | Tauri shell · model picker · sign-in flow · cross-platform builds | 🚧 in progress |
| **Phase 2** | Agent loop integration (opencode core) · diff preview · file tree · live spend bar · multi-thread switcher | 🟦 planned |
| **Phase 3** | Sub-agents UI · hooks UI · MCP marketplace · IDE plugins | 🟦 planned |

See [Roadmap](#roadmap) for the unpacked list.

## Install

> **Heads up** — alpha builds are not signed yet. Mac users will need to right-click → Open the first time. Signing + notarization land in Phase 1.

### One-line installer

```bash
curl -fsSL https://qlaud.ai/qcode/install.sh | sh
```

### Manual

- **macOS** — [download .dmg](https://github.com/qlaudAI/qcode/releases/latest)
- **Windows** — [download .msi](https://github.com/qlaudAI/qcode/releases/latest)
- **Linux** — [.AppImage / .deb](https://github.com/qlaudAI/qcode/releases/latest)

### Build from source

```bash
git clone https://github.com/qlaudAI/qcode
cd qcode
pnpm install
pnpm tauri:dev
```

## Get started

1. Launch qcode.
2. Click **Sign in with qlaud**. Your browser opens, you sign in, and qcode is ready.
3. Pick a model from the title-bar dropdown — Claude for thinking, DeepSeek for cheap iteration, Kimi for long context.
4. Open a folder, ask it to do something, watch it work.

New qlaud accounts get a **$1 starter credit** automatically — enough to try every model end-to-end before connecting Stripe.

## Architecture

```
   ┌──────────────────────────────────────────────┐
   │  qcode (Tauri shell)                         │
   │                                              │
   │   React UI ──┐                               │
   │              │                               │
   │              ▼                               │
   │   opencode agent core (embedded)             │
   │              │                               │
   │              ▼                               │
   │   ┌─────────────────────────┐                │
   │   │ qlaud gateway (HTTPS)   │                │
   │   └─────────────────────────┘                │
   └──────────────┬───────────────────────────────┘
                  │
                  ▼
        ┌──────────────────────────────────┐
        │ Anthropic · OpenAI · DeepSeek    │
        │ Google · Moonshot · Alibaba      │
        │ + open-source via Together/etc.  │
        └──────────────────────────────────┘
```

- **UI**: React + Tailwind, rendered inside Tauri's native webview.
- **Agent**: opencode's agent loop runs as an embedded subprocess (Phase 2).
- **Routing**: every model call goes through `https://api.qlaud.ai`, which dispatches to the right provider, enforces your spend cap, and writes the usage event to your account.
- **Auth**: qcode never sees a provider key. It holds a single qlaud key (`qlk_live_…`) in your OS keychain.

## Roadmap

### Phase 1 — Foundation (~2 weeks)

- [x] Tauri shell, React UI, Tailwind design system
- [x] Model picker with all major providers
- [x] Sign-in with qlaud (deep-link callback)
- [ ] Embed opencode core (subprocess, IPC bridge)
- [ ] Cross-platform release builds (Mac / Win / Linux)
- [ ] Code-signing + notarization (Mac), Authenticode (Win)
- [ ] Auto-updater wired to GitHub releases

### Phase 2 — Polished GUI (~4 weeks)

- [ ] Native diff preview (CodeMirror or Monaco)
- [ ] File tree sidebar with workspace persistence
- [ ] Multi-thread switcher (sidebar list, ⌘N for new)
- [ ] Live spend bar in title bar (real-time gateway pull)
- [ ] Per-task model defaults (e.g. Claude for plan, DeepSeek for code)
- [ ] Settings UI: tools, permissions, working directory, telemetry opt-out
- [ ] Onboarding tour for first launch

### Phase 3 — Power features (open-ended)

- [ ] Sub-agents UI (spawn, monitor, branch off)
- [ ] Hooks UI (pre-edit, post-edit, on-error)
- [ ] MCP server marketplace integrated with qlaud's catalog
- [ ] VS Code extension (handoff between qcode and editor)
- [ ] JetBrains plugin
- [ ] Team mode (shared qlaud account, per-user spend caps)
- [ ] CLI companion (`qcode --headless` for CI integration)

Issues are tagged `phase-1`, `phase-2`, `phase-3` so you can scope contributions.

## Contributing

PRs welcome — especially:
- Bug reports with reproducible steps
- Model picker entries (new providers qlaud added but qcode doesn't surface yet)
- Onboarding polish (the first 60 seconds matter most)
- Linux distro packaging (Arch, Fedora — community contributions especially valued)

Conventions: 2-space indent, TypeScript strict, no emojis in commits, `feat:` / `fix:` / `chore:` prefix.

## License

MIT. See [LICENSE](LICENSE) and [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md).

## Sister projects

- **[qlaud](https://qlaud.ai)** — the multi-provider gateway powering qcode
- **[ai-chat-saas-starter](https://github.com/qlaudAI/ai-chat-saas-starter)** — Next.js SaaS template on the same stack
- **[discord-ai-bot-template](https://github.com/qlaudAI/discord-ai-bot-template)** — Discord bot template
- **[ai-support-widget](https://github.com/qlaudAI/ai-support-widget)** — embeddable chat widget
