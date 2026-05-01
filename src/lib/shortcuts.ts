// Cross-platform keyboard shortcut hook + native-menu event bridge.
//
// We listen for two things at the App level:
//   1. The browser's `keydown` event (for shortcuts that fire while
//      the webview is focused — works in vite-dev too).
//   2. The Tauri "qcode://menu" event (for clicks coming from the
//      OS-native menu bar items, dispatched from src-tauri/menu.rs).
//
// Both routes converge on the same `MenuId` type so the App's
// switch-statement is the single place wiring action → handler.

import { useEffect } from 'react';
import { listen } from './tauri';

export type MenuId =
  | 'new_chat'
  | 'open_folder'
  | 'preferences'
  | 'sign_out'
  | 'command_palette'
  | 'model_picker';

const KB_BINDINGS: Array<{ id: MenuId; mod: boolean; key: string }> = [
  { id: 'new_chat', mod: true, key: 'n' },
  { id: 'open_folder', mod: true, key: 'o' },
  { id: 'preferences', mod: true, key: ',' },
  { id: 'command_palette', mod: true, key: 'k' },
  { id: 'model_picker', mod: true, key: 'm' },
];

export function useShortcuts(handler: (id: MenuId) => void) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // The native menu also catches these on macOS — this listener
      // is the source of truth in browser-mode and a fallback for
      // any platform where the menu binding doesn't propagate.
      const mod = e.metaKey || e.ctrlKey;
      // Don't intercept inside text inputs unless it's clearly a
      // command (cmd/ctrl held). Lets the user type "n" in the
      // composer without firing "new chat".
      const target = e.target as HTMLElement | null;
      const inField =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;
      if (inField && !mod) return;

      for (const b of KB_BINDINGS) {
        if (b.mod && !mod) continue;
        if (e.key.toLowerCase() === b.key) {
          e.preventDefault();
          handler(b.id);
          return;
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handler]);

  // Native menu bridge.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<string>('qcode://menu', (id) => {
      handler(id as MenuId);
    }).then((u) => {
      unlisten = u;
    });
    return () => unlisten?.();
  }, [handler]);
}
