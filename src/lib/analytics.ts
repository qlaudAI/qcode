// PostHog init for qcode (web + desktop). Same project as the qlaud
// dashboard — events from dashboard.qlaud.ai, qcode.qlaud.ai, and
// the desktop binary all aggregate.
//
// Almost everything PostHog needs is already a sensible default
// (autocapture on, pageviews on, etc.) — we only override the two
// things we actually care about: the proxy host (so analytics is
// first-party + ad-blocker-resistant) and a couple super-properties
// for cross-surface filtering.
//
// Privacy: NEVER capture chat content, file paths, or workspace data.
// We only call posthog.capture() at the handful of sites where the
// PROPERTIES are valuable for analysis (model picked, tokens used,
// subagent dispatched). See main.tsx, App.tsx, ChatSurface.tsx,
// agent.ts.
//
// Env vars (Vite — set at build time):
//   VITE_POSTHOG_PROJECT_TOKEN  phc_… token (same as the dashboard)
//   VITE_POSTHOG_HOST           defaults to https://p.qlaud.ai
//                               (first-party reverse proxy → PostHog)

import posthog from 'posthog-js';

import { isTauri } from './tauri';

export function initAnalytics(): void {
  const key = import.meta.env.VITE_POSTHOG_PROJECT_TOKEN as string | undefined;
  if (!key) return; // unset = no-op (local dev, missing config)
  const host =
    (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ??
    'https://p.qlaud.ai';

  // Tauri's WebView serves the app from `tauri://localhost` and has a
  // tight CSP. PostHog's defaults monkey-patch fetch / XMLHttpRequest
  // for autocapture + session recording — and that patching breaks the
  // streaming SSE response coming back from `/v1/messages`, leaving
  // the UI showing the user's message but never rendering claude's
  // reply. (Reproduced: alpha.89 CI build had token set → broken;
  // alpha.89 local build had token unset → worked. Same source.)
  //
  // We still want explicit `posthog.capture('turn_sent', ...)` calls
  // to fire, so we initialize — just turn off the features that wrap
  // the network layer. Web keeps full autocapture.
  const desktop = isTauri();
  posthog.init(key, {
    api_host: host,
    // ui_host so PostHog UI deep-links from event tooltips work —
    // they should target PostHog, not our proxy.
    ui_host: 'https://us.posthog.com',
    // The three settings that matter for the SSE-interference bug:
    autocapture: !desktop,
    capture_pageview: !desktop,
    disable_session_recording: desktop,
  });

  // Super-properties — ride every event for cross-surface slicing.
  posthog.register({
    surface: isTauri() ? 'desktop' : 'web',
    qcode_version: import.meta.env.VITE_APP_VERSION ?? 'dev',
  });
}

export { posthog };
