// Server-state hooks built on TanStack Query.
//
// Why this exists: we used to drive every server fetch from a useEffect
// (threads list, thread messages, account info, billing balance). Each
// one was hand-rolled — manual abort, manual cache reconciliation,
// manual race-guard against concurrent renders, manual refetch-on-focus.
// One bug per useEffect, four useEffects.
//
// Now: one cache (QueryClient), one source of truth per query key,
// stale-while-revalidate built in. Components subscribe via hooks;
// mutations invalidate the keys they touched. The localStorage
// summary cache stays as a hydration seed (instant first paint on
// cold start) but Query owns runtime freshness.

import {
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { fetchAccount, type AccountInfo } from './account';
import { fetchBalance, type BalanceInfo } from './billing';
import {
  clearInFlight,
  hasLanded,
  isInFlight,
} from './in-flight';
import {
  createRemoteThread,
  deleteRemoteThread,
  getRemoteThreadMessages,
  listRemoteThreads,
  loadCachedSummaries,
  purgeEmptyRemoteThreads,
  saveCachedSummaries,
  type RemoteThreadHistory,
  type ThreadSummary,
} from './threads';
import type { Workspace } from './workspace';

// ─── Client ────────────────────────────────────────────────────────

/** Single QueryClient for the app. Defaults are tuned for a desktop
 *  agent: long staleTime so flipping between threads feels instant
 *  (cached), retry only once on transient failure, no retry on 401
 *  (auth churn — we want the failure to surface so the sign-in gate
 *  can re-engage). Refetch-on-focus is on so when the user comes
 *  back to qcode after running their build elsewhere, the sidebar
 *  catches up automatically. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 10 * 60_000,
      retry: (failureCount, error) => {
        if (error instanceof Error && /unauthorized|not_authed/.test(error.message))
          return false;
        return failureCount < 1;
      },
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
    mutations: { retry: false },
  },
});

// ─── Query keys ────────────────────────────────────────────────────
// Centralized so refactors are find-and-replace, not greps.

export const qk = {
  threads: ['threads'] as const,
  threadMessages: (id: string) => ['threads', id, 'messages'] as const,
  account: ['account'] as const,
  balance: ['balance'] as const,
};

// ─── Threads list ──────────────────────────────────────────────────

/** Hydrate the cache from localStorage at boot so the sidebar paints
 *  instantly on cold start while Query refetches in the background.
 *  Call this once during QueryClient setup. */
export function hydrateThreadsFromCache(): void {
  const cached = loadCachedSummaries();
  if (cached.length > 0) {
    queryClient.setQueryData<ThreadSummary[]>(qk.threads, cached);
  }
}

/** Threads list with cache hydration + remote reconcile. The boot
 *  cleanup (purgeEmptyRemoteThreads) is folded into the query fn so
 *  it runs on every refetch, not just first mount — covers focus
 *  refetch and post-mutation invalidation. */
export function useThreadsQuery(opts: {
  authed: boolean;
  workspace: Workspace | null;
  fallbackModel: string;
}) {
  return useQuery({
    queryKey: qk.threads,
    enabled: opts.authed,
    queryFn: async () => {
      // Best-effort orphan cleanup — never blocks the list. If it
      // fails, the list still returns; the next reconcile will retry.
      void purgeEmptyRemoteThreads();
      const remote = await listRemoteThreads();
      const cache = loadCachedSummaries();
      const cacheById = new Map(cache.map((s) => [s.id, s]));
      const merged: ThreadSummary[] = remote.map((r) => {
        const cached = cacheById.get(r.id);
        const meta = (r.metadata ?? {}) as Record<string, unknown>;
        const wsPath =
          typeof meta.workspace_path === 'string'
            ? meta.workspace_path
            : cached?.workspacePath;
        const wsName =
          typeof meta.workspace_name === 'string'
            ? meta.workspace_name
            : cached?.workspaceName;
        return {
          id: r.id,
          title: cached?.title ?? 'New chat',
          model: cached?.model ?? opts.fallbackModel,
          createdAt: r.created_at,
          updatedAt: r.last_active_at,
          ...(wsPath ? { workspacePath: wsPath } : {}),
          ...(wsName ? { workspaceName: wsName } : {}),
        };
      });
      saveCachedSummaries(merged);
      return merged;
    },
    // Localstorage is the seed; query refetches in the background.
    initialData: () => {
      const cached = loadCachedSummaries();
      return cached.length > 0 ? cached : undefined;
    },
  });
}

// ─── Thread messages ───────────────────────────────────────────────

/** Per-thread history. The cache lives in Query (not localStorage):
 *  threads can be long, blobs are large, and messages compact server-
 *  side anyway. staleTime is high — once we've loaded a thread, we
 *  trust it for the session unless explicitly invalidated.
 *
 *  refetchInterval kicks in when the thread is in-flight (a send
 *  was started + then abandoned by the user navigating away). The
 *  qlaud edge worker keeps the upstream call alive via waitUntil
 *  and persists the assistant turn server-side; we poll the
 *  messages endpoint every 2s until that turn lands, at which
 *  point hasLanded() returns true and clearInFlight() stops the
 *  polling. From the user's perspective: come back to a thread
 *  where you abandoned a slow turn, see the finished answer
 *  appear within a few seconds. */
export function useThreadMessagesQuery(threadId: string | null) {
  return useQuery({
    queryKey: threadId ? qk.threadMessages(threadId) : ['threads', '_none_'],
    enabled: !!threadId,
    queryFn: () => getRemoteThreadMessages(threadId as string),
    staleTime: Infinity, // server-side compaction owns freshness
    refetchInterval: (query) => {
      if (!threadId || !isInFlight(threadId)) return false;
      const data = query.state.data;
      // hasLanded reads the server's seq directly off each
      // message — no synthetic indices, no parallel counter to
      // keep in sync.
      if (data && hasLanded(threadId, data.messages)) {
        clearInFlight(threadId);
        return false;
      }
      return 2_000;
    },
  });
}

/** Prefetch a thread's messages — wire to sidebar onMouseEnter so the
 *  click is rendered from cache (≤1 frame). Idempotent and cheap;
 *  Query dedupes concurrent prefetches. */
export function prefetchThreadMessages(threadId: string): Promise<void> {
  return queryClient.prefetchQuery({
    queryKey: qk.threadMessages(threadId),
    queryFn: () => getRemoteThreadMessages(threadId),
    staleTime: 30_000,
  });
}

/** Direct setter for after a turn lands — replaces the in-flight
 *  history with the canonical server view without a round-trip. */
export function setThreadMessages(
  threadId: string,
  history: RemoteThreadHistory,
): void {
  queryClient.setQueryData<RemoteThreadHistory>(
    qk.threadMessages(threadId),
    history,
  );
}

/** Load the next-older page of messages for a thread and prepend
 *  to the cached history. Used by the "Load earlier turns" button
 *  the chat surface renders when hasMore is true. The cursor
 *  threading (oldestSeq → before_seq) means we can paginate back
 *  through 1000-turn threads without re-fetching what we already
 *  have — incremental, no client-side de-dup needed. */
export async function loadEarlierMessages(threadId: string): Promise<void> {
  const cached = queryClient.getQueryData<RemoteThreadHistory>(
    qk.threadMessages(threadId),
  );
  if (!cached || !cached.hasMore || cached.oldestSeq == null) return;
  const older = await getRemoteThreadMessages(threadId, {
    beforeSeq: cached.oldestSeq,
  });
  queryClient.setQueryData<RemoteThreadHistory>(
    qk.threadMessages(threadId),
    {
      // Prepend older turns; keep the latest cached compaction
      // (compaction state is thread-wide, not page-scoped).
      messages: [...older.messages, ...cached.messages],
      compaction: cached.compaction ?? older.compaction,
      oldestSeq: older.oldestSeq,
      hasMore: older.hasMore,
    },
  );
}

/** Invalidate so the next consumer refetches — used after a turn
 *  lands when we want fresh canonical history (instead of the
 *  client-side reconstructed buffer). */
export function invalidateThreadMessages(threadId: string): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: qk.threadMessages(threadId),
  });
}

// ─── Account ───────────────────────────────────────────────────────

export function useAccountQuery(authed: boolean) {
  return useQuery<AccountInfo | null>({
    queryKey: qk.account,
    enabled: authed,
    queryFn: () => fetchAccount(),
    // Account info changes only on sign-in / email update; cache for
    // 5 min and let focus-refetch + manual invalidation handle the rest.
    staleTime: 5 * 60_000,
  });
}

// ─── Balance ───────────────────────────────────────────────────────

export function useBalanceQuery(authed: boolean) {
  return useQuery<BalanceInfo | null>({
    queryKey: qk.balance,
    enabled: authed,
    queryFn: () => fetchBalance(),
    // Balance ticks every turn; let consumers invalidate on
    // turn-completion. 30s staleTime covers manual refresh clicks.
    staleTime: 30_000,
  });
}

/** Trigger a balance refetch — call from onTurnLanded so the
 *  title-bar spend bar updates without manual polling. */
export function invalidateBalance(): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: qk.balance });
}

// ─── Mutations ─────────────────────────────────────────────────────

/** Optimistic delete — disappears from the sidebar immediately;
 *  rolled back if the server rejects (which is rare — we tolerate
 *  404 server-side). */
export function useDeleteThreadMutation(opts?: {
  onSuccess?: (id: string) => void;
}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteRemoteThread(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: qk.threads });
      const prev = qc.getQueryData<ThreadSummary[]>(qk.threads) ?? [];
      const next = prev.filter((t) => t.id !== id);
      qc.setQueryData<ThreadSummary[]>(qk.threads, next);
      saveCachedSummaries(next);
      return { prev };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prev) {
        qc.setQueryData(qk.threads, ctx.prev);
        saveCachedSummaries(ctx.prev);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.threads });
    },
    onSuccess: (_data, id) => opts?.onSuccess?.(id),
  });
}

/** Create a new thread — used lazily by ChatSurface on first send.
 *  Adds the row to the threads cache optimistically with the
 *  user's prompt as a derived title; reconciles when the server
 *  responds with the canonical id + timestamps. */
export function useCreateThreadMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      workspace: Workspace | null;
      model: string;
    }) => {
      const meta = args.workspace
        ? {
            workspace_path: args.workspace.path,
            workspace_name: args.workspace.name,
          }
        : undefined;
      return createRemoteThread(meta ? { metadata: meta } : undefined).then(
        (t) => ({
          remote: t,
          summary: {
            id: t.id,
            title: 'New chat',
            model: args.model,
            createdAt: t.created_at,
            updatedAt: t.last_active_at,
            ...(args.workspace
              ? {
                  workspacePath: args.workspace.path,
                  workspaceName: args.workspace.name,
                }
              : {}),
          } as ThreadSummary,
        }),
      );
    },
    onSuccess: ({ summary }) => {
      const prev = qc.getQueryData<ThreadSummary[]>(qk.threads) ?? [];
      const next = [summary, ...prev.filter((t) => t.id !== summary.id)];
      qc.setQueryData<ThreadSummary[]>(qk.threads, next);
      saveCachedSummaries(next);
    },
  });
}

/** Patch one thread row (title update after first send, updatedAt
 *  bump on each turn). Mirror to localStorage for boot hydration. */
export function patchThread(id: string, patch: Partial<ThreadSummary>): void {
  const prev = queryClient.getQueryData<ThreadSummary[]>(qk.threads) ?? [];
  const idx = prev.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const updated = { ...prev[idx]!, ...patch };
  const next = [updated, ...prev.filter((t) => t.id !== id)];
  queryClient.setQueryData<ThreadSummary[]>(qk.threads, next);
  saveCachedSummaries(next);
}

/** Wipe all server-state on sign-out. Clears the in-memory cache so
 *  no stale data leaks if a different account signs in next. */
export function clearAllQueries(): void {
  queryClient.clear();
}
