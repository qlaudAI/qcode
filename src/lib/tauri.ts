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
