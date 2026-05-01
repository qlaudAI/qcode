# Attribution

`qcode` is a derivative work that builds on top of several open-source projects. The licenses of all upstream dependencies are preserved.

## Primary upstream

**[sst/opencode](https://github.com/sst/opencode)** — MIT licensed.
qcode wraps opencode's agent core in a Tauri desktop shell, replaces the provider configuration to hard-wire the qlaud gateway, and adds the qlaud-specific UI surface (live spend bar, multi-model picker, "Sign in with qlaud" flow). The opencode upstream remains the source of truth for the agent loop, tool dispatch, and MCP integration — qcode periodically merges from `main` and contributes fixes upstream where they apply broadly.

## Tauri runtime

[Tauri](https://tauri.app) — MIT / Apache 2.0 dual-licensed.
The desktop chrome, packaging, auto-updater, deep-link handling, and OS integrations come from Tauri 2.x.

## Other dependencies

See `package.json` and `src-tauri/Cargo.toml` for the full transitive dependency tree. All runtime dependencies are MIT, Apache 2.0, or BSD-2/3.

## License compatibility

qcode is shipped as **MIT** — same as opencode, same as Tauri's public-facing license. Forks and downstream uses are unrestricted within the MIT terms.
