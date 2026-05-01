// Runtime detection + thin wrappers over Tauri APIs the rest of the
// app needs. Importing tauri APIs in pure-browser mode (vite dev,
// without the host) blows up at module load — these helpers handle
// that with dynamic imports + null fallbacks so the same React code
// runs in both contexts.

export function isTauri(): boolean {
  return (
    typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  );
}

/** invoke a Tauri command. Returns null when not in the host. */
export async function invoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  if (!isTauri()) return null;
  const { invoke: realInvoke } = await import('@tauri-apps/api/core');
  return (await realInvoke(cmd, args)) as T;
}

/** Open a native folder picker. Returns the selected path or null. */
export async function pickFolder(title?: string): Promise<string | null> {
  if (!isTauri()) {
    // Browser-mode fallback — there's no native picker, so we let the
    // user paste a path in. Keeps vite-dev workflow alive without
    // requiring the Tauri host.
    const v = window.prompt('Folder path:', '');
    return v?.trim() || null;
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const result = await open({ directory: true, multiple: false, title });
  return typeof result === 'string' ? result : null;
}

/** Subscribe to a Tauri event. Returns an unlisten function. */
export async function listen<T>(
  event: string,
  cb: (payload: T) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen: realListen } = await import('@tauri-apps/api/event');
  return await realListen<T>(event, (e) => cb(e.payload));
}

/** Open an external URL in the OS browser. */
export async function openExternal(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  const { open } = await import('@tauri-apps/plugin-shell');
  await open(url);
}

/** OS family for branching install hints / env probes. Cached for
 *  the session because it doesn't change. Returns 'unknown' outside
 *  Tauri so the UI just hides platform-specific hints. */
let cachedPlatform: 'macos' | 'linux' | 'windows' | 'unknown' | null = null;
export async function getPlatform(): Promise<
  'macos' | 'linux' | 'windows' | 'unknown'
> {
  if (cachedPlatform) return cachedPlatform;
  if (!isTauri()) {
    cachedPlatform = 'unknown';
    return cachedPlatform;
  }
  try {
    const { type } = await import('@tauri-apps/plugin-os');
    const t = type();
    if (t === 'macos') cachedPlatform = 'macos';
    else if (t === 'windows') cachedPlatform = 'windows';
    else if (t === 'linux') cachedPlatform = 'linux';
    else cachedPlatform = 'unknown';
  } catch {
    cachedPlatform = 'unknown';
  }
  return cachedPlatform;
}
