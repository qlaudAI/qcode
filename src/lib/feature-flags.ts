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
 *    - Web (browser):   FALSE — sandbox-agent engine works but
 *      hits a long tail of edge cases (cold-start latency, GitLab
 *      persistence chain, model-specific tool-call reliability).
 *      Gated off until we close the invariants and operationalize
 *      the sandbox properly.
 *
 *  When this flag is FALSE on a surface:
 *    - Mode toggle hides Agent + Plan (Chat is the only option)
 *    - ChatSurface engineMode resolves to qcode-legacy regardless
 *      of mode setting
 *    - Sandbox-specific UI (FileTree, Preview iframe, Media tab,
 *      "Sandbox ready" pill) hides on web; desktop keeps all
 *
 *  To re-enable on web for testing: set
 *  `localStorage.qcode.flags.sandboxAgent = '1'` in the browser
 *  devtools and reload. Read-once at module load so refresh is
 *  required after toggling.
 */
export const SANDBOX_AGENT_ENABLED: boolean = (() => {
  if (isTauri()) return true; // desktop never gated
  // Web: check for an explicit override before defaulting to off.
  if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
    try {
      if (localStorage.getItem('qcode.flags.sandboxAgent') === '1') {
        return true;
      }
    } catch {
      /* localStorage blocked (private browsing) — treat as default */
    }
  }
  return false;
})();
