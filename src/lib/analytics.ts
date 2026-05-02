// PostHog init for qcode (web + desktop). Same project as the qlaud
// dashboard — events from dashboard.qlaud.ai, qcode.qlaud.ai, and
// the desktop binary all aggregate, so funnel + cohort reports work
// across surfaces.
//
// The rest of this file is intentionally thin: PostHog's autocapture
// already records clicks, form submits, page views, and errors with
// no instrumentation. We only call posthog.capture() directly at
// the handful of sites where we need PROPERTIES the DOM doesn't
// expose — model picked, tokens used, subagent dispatched, etc.
// See call sites in main.tsx, App.tsx, ChatSurface.tsx, agent.ts.
//
// Privacy: NEVER capture chat content, file paths, or workspace data.
// Only metadata.
//
// Env vars (Vite — set at build time):
//   VITE_POSTHOG_PROJECT_TOKEN  phc_… token (same as the dashboard)
//   VITE_POSTHOG_HOST           defaults to https://p.qlaud.ai
//                               (our first-party reverse proxy in
//                                apps/edge/src/index.ts → us.i.posthog.com).
//                               Bypasses ad-blockers that filter
//                               *.posthog.com and keeps analytics
//                               first-party from the user's POV.

import posthog from 'posthog-js';

import { isTauri } from './tauri';

export function initAnalytics(): void {
  const key = import.meta.env.VITE_POSTHOG_PROJECT_TOKEN as string | undefined;
  if (!key) return; // unset = no-op (local dev, missing config)
  const host =
    (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ??
    'https://p.qlaud.ai';

  posthog.init(key, {
    api_host: host,
    // Even though `api_host` is our proxy, link-outs from PostHog UI
    // tooltips (e.g. "view this user in PostHog") should target
    // PostHog's actual UI host, not our proxy.
    ui_host: 'https://us.posthog.com',
    person_profiles: 'identified_only',
    capture_pageview: true,
    capture_pageleave: true,
    autocapture: true, // clicks + form submits + input changes for free
    disable_session_recording: true, // re-enable later w/ masking
  });

  // Super-properties — ride every autocaptured + manual event.
  posthog.register({
    surface: isTauri() ? 'desktop' : 'web',
    qcode_version: import.meta.env.VITE_APP_VERSION ?? 'dev',
  });
}

export { posthog };
