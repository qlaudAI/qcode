// Compile-time + platform-driven feature flags.
//
// Why this exists rather than a dynamic flag service: qcode has two
// distinct surfaces (Tauri desktop, qcode-web) with materially
// different reliability profiles for the same feature. We need a
// way to hide a feature on one surface without breaking the other,
// without round-tripping to a flag service the user might be
// offline from. Compile-time per-platform is the right shape.
//
// Add a new flag here, reference it from the relevant UI / engine
// branch, and document WHY the gate exists. Don't sprinkle
// `if (isTauri())` checks throughout — that's how we ended up
// shipping web's coding sandbox half-broken in the first place.

import { isTauri } from './tauri';

/** Whether the in-browser Cloudflare Sandbox-backed Agent + Plan
 *  modes are exposed to the user.
 *
 *  Currently:
 *    - Desktop (Tauri): TRUE — Agent + Plan run via the local
 *      bundled claude-code engine. No sandbox container needed.
 *      Battle-tested.
 *    - Web (browser):   TRUE — enabled after the robustness pass
 *      closed the failure-mode tail (workspace lock prevents
 *      concurrent-turn corruption, tool_result truncation caps
 *      per-turn cost, GitLab persistence invariants 1–3, retry +
 *      fast-fail on probes). If a regression surfaces, set
 *      `localStorage.qcode.flags.sandboxAgent = '0'` in devtools
 *      and reload to hard-disable on this browser.
 *
 *  When this flag is FALSE on a surface:
 *    - Mode toggle hides Agent + Plan (Chat is the only option)
 *    - ChatSurface engineMode resolves to qcode-legacy regardless
 *      of mode setting
 *    - Sandbox-specific UI (FileTree, Preview iframe, Media tab,
 *      "Sandbox ready" pill) hides on web; desktop keeps all
 *
 *  Read-once at module load — refresh required after toggling the
 *  localStorage override.
 */
export const SANDBOX_AGENT_ENABLED: boolean = (() => {
  if (isTauri()) return true; // desktop never gated
  // Web: emergency kill-switch via localStorage. Lets us tell a
  // user "set this to '0' and reload" if their browser hits a
  // pathological state without us having to ship a code rollback.
  if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
    try {
      if (localStorage.getItem('qcode.flags.sandboxAgent') === '0') {
        return false;
      }
    } catch {
      /* localStorage blocked (private browsing) — treat as default */
    }
  }
  return true;
})();
