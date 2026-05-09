import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';

import { App } from './App';
import { PlayPage } from './ui/PlayPage';
import { initAnalytics, posthog } from './lib/analytics';
import { consumeAuthCallback, hydrateAuth } from './lib/auth';
import { hydrateThreadsFromCache, queryClient } from './lib/queries';
import { applyTheme, getSettings } from './lib/settings';
import { isTauri, preloadWindowDrag } from './lib/tauri';
import './styles.css';

// Mark the Tauri-host vs vite-dev distinction on <html> so CSS can
// branch on it (the body background swaps between vibrancy-ready
// translucent and a plain opaque white in browser-mode).
if (isTauri()) {
  document.documentElement.dataset.tauri = '1';
  // Eagerly load the Tauri window API so handleTitleBarMouseDown()
  // can call startDragging() synchronously inside the user gesture.
  // Without this, the `await import('@tauri-apps/api/window')` in
  // the click handler breaks macOS's user-gesture requirement and
  // drag silently no-ops.
  preloadWindowDrag();
}

// Boot sequence:
//   1. consumeAuthCallback() — browser-only; if we just got
//      redirected from qlaud.ai/cli-auth with `?k=`, capture and
//      store the key BEFORE hydrateAuth so the cached key is right
//      on first render. No-op in Tauri (deep-link plugin handles it).
//   2. hydrateAuth() — block on the keychain (Tauri) / localStorage
//      (browser) read so React's first render decides authed vs
//      sign-in gate accurately.
async function boot() {
  // Init analytics first so we capture the auth-callback path (the
  // user just came back from qlaud.ai/cli-auth) and the boot itself.
  initAnalytics();
  posthog.capture('app_boot');
  await consumeAuthCallback();
  await hydrateAuth();
  // Apply theme BEFORE first React render so the user never sees a
  // light flash before the dark class lands. Reads from settings,
  // falls back to system preference for fresh installs.
  applyTheme(getSettings().theme);
  // Seed the threads query from localStorage so the sidebar paints
  // instantly on cold start while the remote refetch runs in the bg.
  hydrateThreadsFromCache();
  // /play — Cloudflare Sandbox SDK-backed playground. Routes here
  // intentionally bypass the regular qcode chat surface (no thread,
  // no workspace folder, no engine-spawning sidecar). The PlayPage
  // owns its own lifecycle: mint sandbox → run hardcoded scaffold
  // pipeline → show preview iframe. Detected via plain pathname
  // check rather than wiring a router — the rest of the app uses
  // window.location for thread-id parsing, keeping that pattern
  // consistent here means one less abstraction to learn.
  const isPlay =
    typeof window !== 'undefined' &&
    window.location.pathname.replace(/\/+$/, '') === '/play';
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        {isPlay ? <PlayPage /> : <App />}
      </QueryClientProvider>
    </React.StrictMode>,
  );
}
void boot();
