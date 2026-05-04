// React hook for the workspace registry.
//
// Reads listWorkspaces() / getCurrentWorkspace() and re-renders on
// every registry mutation. Subscribes to two signals:
//   1. WORKSPACE_REGISTRY_EVENT — fired by writeRegistry() inside
//      this tab, so register/activate/remove all wake the sidebar
//      without callback wiring.
//   2. 'storage' — fires cross-tab when localStorage mutates from
//      another window; keeps multiple qcode windows in sync.
//
// Lightweight on purpose: the registry is small (≤8 entries
// typically), reads are localStorage parses, and the event fan-out
// is rare (~once per folder pick / sign-out / thread switch).

import { useEffect, useState } from 'react';

import {
  getCurrentWorkspace,
  listWorkspaces,
  WORKSPACE_REGISTRY_EVENT,
  type Workspace,
} from './workspace';

export function useWorkspaces(): Workspace[] {
  const [list, setList] = useState<Workspace[]>(() => listWorkspaces());
  useEffect(() => {
    const onChange = () => setList(listWorkspaces());
    window.addEventListener(WORKSPACE_REGISTRY_EVENT, onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(WORKSPACE_REGISTRY_EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);
  return list;
}

/** Reactive view of the active workspace. Same subscription pattern
 *  as useWorkspaces — a sign-out, folder-pick, or thread switch
 *  re-resolves to the current entry. Returns null in pure-chat
 *  mode. */
export function useActiveWorkspace(): Workspace | null {
  const [active, setActive] = useState<Workspace | null>(() =>
    getCurrentWorkspace(),
  );
  useEffect(() => {
    const onChange = () => setActive(getCurrentWorkspace());
    window.addEventListener(WORKSPACE_REGISTRY_EVENT, onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(WORKSPACE_REGISTRY_EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);
  return active;
}
