import React from 'react';
import ReactDOM from 'react-dom/client';

import { App } from './App';
import { initAnalytics, posthog } from './lib/analytics';
import { consumeAuthCallback, hydrateAuth } from './lib/auth';
import { isTauri } from './lib/tauri';
import './styles.css';

// Mark the Tauri-host vs vite-dev distinction on <html> so CSS can
// branch on it (the body background swaps between vibrancy-ready
// translucent and a plain opaque white in browser-mode).
if (isTauri()) {
  document.documentElement.dataset.tauri = '1';
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
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
void boot();
