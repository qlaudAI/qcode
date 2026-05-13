// Workspace registry sync — bridges qcode's localStorage-backed
// registry (lib/workspace.ts) with the server-side
// /v1/workspaces endpoints added in alpha-N.
//
// Architecture:
//   - localStorage stays the in-flight read source (fast, offline)
//   - Server is the cross-device source of truth
//   - On boot (after auth lands) we pull the server list and merge
//     into local. Server wins on conflicts via remote_id mapping.
//   - On every local mutation (register / rename / delete / touch)
//     we fire-and-forget the matching server PATCH/POST/DELETE so
//     the registry stays in sync.
//
// Why a separate module rather than wiring sync into workspace.ts:
// keeps the local module side-effect-free for tests + lets us
// degrade gracefully when offline. workspace-sync.ts is the
// network shim; if the gateway 404s on /v1/workspaces (older
// version), every helper here becomes a no-op and qcode keeps
// working purely off localStorage.
//
// Mapping localStorage workspace id ↔ server workspace id:
// initially they are the SAME — we use the server id when present.
// For pre-existing local-only workspaces, the server-side row
// gets created on first sync and we update local with the new id
// (rare path; most local workspaces will have been created via
// this module after the migration).

import { getKey } from './auth';
import {
  listWorkspaces as listLocalWorkspaces,
  registerWorkspace as registerLocalWorkspace,
  removeWorkspace as removeLocalWorkspace,
  touchWorkspace as touchLocalWorkspace,
  type Workspace,
} from './workspace';

const BASE = (import.meta.env.VITE_QLAUD_BASE as string | undefined) ?? 'https://api.qlaud.ai';

/** Server-canonical workspace shape (v2 — post migration 0030).
 *  `kind` is the discriminator: 'chat' (per-user singleton, no
 *  backing path), 'local' (desktop folder, local_path required), or
 *  'sandbox' (web auto-provisioned container, gitlab_project_path
 *  populated lazily). `path` is kept on the wire by the server for
 *  one-release back-compat — new readers should use local_path /
 *  gitlab_project_path explicitly. */
export type RemoteWorkspace = {
  id: string;
  kind: 'chat' | 'local' | 'sandbox';
  name: string;
  local_path: string | null;
  gitlab_project_id: number | null;
  gitlab_project_path: string | null;
  default_branch: string | null;
  /** Legacy field — populated from local_path when set, else the
   *  pre-0030 path column. Drops once every reader migrates. */
  path: string | null;
  created_at: number;
  last_used_at: number;
};

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = getKey();
  if (!key) throw new Error('not_authed');
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'x-api-key': key,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`workspaces_${res.status}:${txt.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

// ─── Reads ────────────────────────────────────────────────────────

export async function listRemoteWorkspaces(): Promise<RemoteWorkspace[]> {
  const data = await api<{ data: RemoteWorkspace[] }>('/v1/workspaces');
  return data.data;
}

// ─── Mutations (fire-and-forget) ──────────────────────────────────

export async function syncRegisterWorkspace(input: {
  path: string;
  name: string;
}): Promise<RemoteWorkspace | null> {
  try {
    // v2 contract: send {kind:'local', name, local_path}. Server-side
    // upsertLocal is idempotent on (userId, local_path) — reactivates
    // soft-deleted rows and bumps last_used_at on dups. Older
    // workers (pre-0030 deploy) infer kind='local' from the presence
    // of `path` in the body, so this body works on both versions.
    return await api<RemoteWorkspace>('/v1/workspaces', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'local',
        name: input.name,
        local_path: input.path,
        // legacy alias retained for one-release server tolerance
        path: input.path,
      }),
    });
  } catch (e) {
    console.warn('[workspace-sync] register failed:', e);
    return null;
  }
}

/** POST /v1/workspaces {kind:'chat'} — find-or-create the user's
 *  singleton chat workspace. Idempotent: subsequent calls return
 *  the same row. Used on app boot so the client always has a
 *  resolved chat workspace id without waiting for the first
 *  POST /v1/threads (which would auto-resolve to the same row but
 *  costs a round-trip per thread create). */
export async function ensureRemoteChatWorkspace(): Promise<RemoteWorkspace | null> {
  try {
    return await api<RemoteWorkspace>('/v1/workspaces', {
      method: 'POST',
      body: JSON.stringify({ kind: 'chat' }),
    });
  } catch (e) {
    console.warn('[workspace-sync] ensure chat workspace failed:', e);
    return null;
  }
}

export async function syncRenameWorkspace(
  id: string,
  name: string,
): Promise<void> {
  try {
    await api<unknown>(`/v1/workspaces/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
  } catch (e) {
    console.warn('[workspace-sync] rename failed:', e);
  }
}

export async function syncTouchWorkspace(id: string): Promise<void> {
  try {
    await api<unknown>(`/v1/workspaces/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ touch: true }),
    });
  } catch (e) {
    console.warn('[workspace-sync] touch failed:', e);
  }
}

export async function syncDeleteWorkspace(id: string): Promise<void> {
  try {
    await api<unknown>(`/v1/workspaces/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  } catch (e) {
    console.warn('[workspace-sync] delete failed:', e);
  }
}

// ─── Boot hydrate ─────────────────────────────────────────────────

/** Pull the server registry and merge into local. Run once after
 *  auth lands. Strategy:
 *    - For each remote workspace not in local: register locally
 *      with the server's id. Server wins.
 *    - For each local workspace not on the server: POST to create
 *      a remote row + adopt the server's id locally (rare — only
 *      happens for local-only entries from before this sync layer).
 *    - For matching pairs (by path): trust the server's last_used_at
 *      and name (most recently-used device wins).
 *
 *  Failure mode: if the server endpoint 404s (older gateway), we
 *  bail silently and qcode keeps using local-only registry. The
 *  next sync attempt picks up from where we left off.
 *
 *  Returns the merged local list so the caller can update React
 *  state immediately without an extra read. */
export async function hydrateWorkspacesFromServer(): Promise<Workspace[]> {
  let remote: RemoteWorkspace[];
  try {
    remote = await listRemoteWorkspaces();
  } catch (e) {
    // Worst case: no sync, but local registry still works.
    console.warn('[workspace-sync] hydrate failed (offline / older gateway):', e);
    return listLocalWorkspaces();
  }

  const local = listLocalWorkspaces();
  const localByPath = new Map(local.map((w) => [w.path, w]));
  // Local-registry hydration only cares about folder-backed
  // workspaces. Chat / sandbox workspaces don't have a meaningful
  // filesystem path — they're surfaced through useWorkspacesQuery
  // instead of this localStorage registry.
  const folderRemote = remote.filter(
    (r) => r.kind === 'local' && typeof (r.local_path ?? r.path) === 'string',
  );
  const remoteByPath = new Map(
    folderRemote.map((w) => [(w.local_path ?? w.path) as string, w]),
  );

  // Apply server rows to local. Newer last_used_at wins on the row;
  // for paths only present on one side we copy them across. Crucially:
  // pass the server's id through so the local registry adopts it,
  // not a freshly-minted local id. Without this, a fresh client
  // (qcode-web with empty localStorage, fresh desktop install) sees
  // server-tagged threads as orphans because their `workspace_id`
  // points at the SERVER's id while the local workspace has a NEW
  // id — sidebar's id-match path silently misses them and they fall
  // back to path-matching (slower / fragile when paths differ
  // across devices).
  for (const r of folderRemote) {
    const rPath = (r.local_path ?? r.path) as string;
    const localMatch = localByPath.get(rPath);
    if (!localMatch) {
      registerLocalWorkspace({ id: r.id, path: rPath, name: r.name });
      continue;
    }
    // Both sides have the row. Adopt the server id if the local
    // entry has a fresh local-only id (so cross-device threads
    // start matching by id). Bump lastUsedAt to whichever is newer
    // and adopt the server name on rename (server is canonical).
    if (r.id && localMatch.id !== r.id) {
      registerLocalWorkspace({ id: r.id, path: rPath, name: r.name });
    }
    if (r.last_used_at > (localMatch.lastUsedAt ?? 0)) {
      touchLocalWorkspace(r.id || localMatch.id || '');
    }
  }

  // Push any local-only entries to the server. These are workspaces
  // the user created before this sync layer existed (or while
  // offline). One-shot per entry; failures are fine, the next sync
  // catches up.
  const localOnly = local.filter((w) => !remoteByPath.has(w.path));
  for (const w of localOnly) {
    void syncRegisterWorkspace({ path: w.path, name: w.name });
  }

  return listLocalWorkspaces();
}

// ─── Soft-delete on revoke ────────────────────────────────────────
//
// When the user manually deletes a workspace (sidebar context menu
// → Remove), call this in addition to removeLocalWorkspace so the
// row gets soft-deleted server-side. Idempotent: if the local id
// doesn't exist remotely, the server returns ok:true anyway.

export async function deleteWorkspaceAndSync(id: string): Promise<void> {
  removeLocalWorkspace(id);
  void syncDeleteWorkspace(id);
}
