// Deep-link plumbing. The Tauri host emits `qcode://deep-link` events
// when macOS / Windows hands a `qcode://...` URL to our app (e.g. the
// browser redirects from qlaud.ai/cli-auth). We parse the URL,
// extract `?k=<key>`, and persist via auth.ts.
//
// This module is safe to import in browser-mode (vite dev) — the
// Tauri-only call is dynamic and falls through silently.

import { setKey } from './auth';

type DeepLinkPayload = string[];

let started = false;

export async function startDeepLinkListener(
  onAuth: () => void,
): Promise<() => void> {
  if (started) return () => {};
  started = true;

  // Browser-mode (vite dev) — no Tauri host. Skip.
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return () => {};
  }

  const { listen } = await import('@tauri-apps/api/event');

  const unlisten = await listen<DeepLinkPayload>('qcode://deep-link', async (event) => {
    for (const url of event.payload ?? []) {
      const handled = await handleAuthUrl(url);
      if (handled) onAuth();
    }
  });

  // Cold-start: macOS hands the launch URL to the app at boot.
  // Tauri's deep-link plugin exposes it via getCurrent().
  try {
    const dl = await import('@tauri-apps/plugin-deep-link');
    const initial = await dl.getCurrent();
    if (initial) {
      for (const url of initial) {
        const handled = await handleAuthUrl(url.toString());
        if (handled) onAuth();
      }
    }
  } catch {
    // Plugin not available in this build — ignore.
  }

  return unlisten;
}

async function handleAuthUrl(rawUrl: string): Promise<boolean> {
  if (!rawUrl.startsWith('qcode://auth')) return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const k = url.searchParams.get('k');
  if (!k) return false;
  // The qlaud /cli-auth page URL-encodes the key; decode it before
  // persisting so it matches the format every other consumer expects.
  await setKey(decodeURIComponent(k));
  return true;
}
