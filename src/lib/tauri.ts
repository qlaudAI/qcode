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

/** Marker error so the UI can branch on "user is on the web build,
 *  there is no folder picker because browsers can't read arbitrary
 *  local paths" without string-matching error messages. */
export class WebNotSupportedError extends Error {
  constructor(feature: string) {
    super(`${feature} requires the qcode desktop app.`);
    this.name = 'WebNotSupportedError';
  }
}

/** Open a native folder picker. Returns the selected path or null
 *  when the user cancels. Throws WebNotSupportedError on the web
 *  build — browsers can't expose arbitrary local filesystem paths,
 *  and the previous window.prompt fallback was misleading (the user
 *  could paste a path, but the agent couldn't actually read those
 *  files because there's no Tauri shell to forward fs calls to). */
export async function pickFolder(title?: string): Promise<string | null> {
  if (!isTauri()) {
    throw new WebNotSupportedError('Opening a folder');
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

// ─── Window dragging ─────────────────────────────────────────────
//
// macOS WKWebView with `transparent: true` + `titleBarStyle: Overlay`
// silently no-ops the CSS `-webkit-app-region: drag` path because
// the OS title bar's hit-test region collides with the transparent
// window's chrome. Tauri's own `data-tauri-drag-region` attribute
// is an internal handler that reads the attribute at mousedown — but
// in some Tauri 2 + Vite combos the IPC bootstrap script doesn't
// install the listener before the first user click, so the attribute
// silently does nothing in dev.
//
// Belt-and-suspenders: eager-load the window API at boot, expose a
// sync `startWindowDrag()` that callers wire to `onMouseDown`. The
// preload finishes long before the user can click anything, so the
// startDragging() call happens inside the user-gesture window
// (the dynamic-import-on-click path that the React tree used to take
// failed exactly because the await broke that gesture chain).

type TauriAppWindow = { startDragging: () => Promise<void> };
let cachedAppWindow: TauriAppWindow | null = null;

/** Idempotent. Call once near app boot when isTauri() is true. */
export function preloadWindowDrag(): void {
  if (!isTauri() || cachedAppWindow) return;
  // Fire-and-forget. Failures are non-fatal — the worst case is the
  // CSS path (which works on most platforms) is still in play.
  void import('@tauri-apps/api/window').then((mod) => {
    try {
      cachedAppWindow = mod.getCurrentWindow() as TauriAppWindow;
    } catch {
      cachedAppWindow = null;
    }
  });
}

/** mousedown handler factory for the title bar. Skips the call when
 *  the click landed on (or inside) an element opted out via the
 *  `.no-drag` class or `data-tauri-drag-region="false"`. Returns
 *  void synchronously — the actual startDragging() promise is
 *  fire-and-forget so the caller doesn't have to await. */
export function handleTitleBarMouseDown(e: React.MouseEvent): void {
  if (!cachedAppWindow) return;
  // Only react to primary button. Right-click + middle-click should
  // surface their normal menus.
  if (e.button !== 0) return;
  const target = e.target as HTMLElement | null;
  if (!target) return;
  // Climb up to header looking for an opt-out marker. Also bail if
  // we land on a real interactive element — buttons, inputs, links
  // need their click to fire normally, and startDragging() steals
  // the mouseup that would otherwise complete the click.
  const optOut = target.closest(
    '[data-tauri-drag-region="false"], .no-drag, button, a, input, textarea, select, [role="button"], [contenteditable="true"]',
  );
  if (optOut) return;
  // No await — the user gesture is preserved by calling startDragging
  // synchronously on the cached handle.
  void cachedAppWindow.startDragging();
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
