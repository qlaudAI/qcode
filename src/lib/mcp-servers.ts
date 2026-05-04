// qlaud MCP servers — read-only client.
//
// qcode doesn't manage MCP servers (browse catalog, register, configure
// auth, etc.) — that's qlaud.ai/tools' job. We just want to show the
// user which connectors they've already registered, so when they
// toggle "Use qlaud connectors" they know what's about to be loaded
// into the agent's tool surface.
//
// One endpoint, one shape. Cached per-tab via React Query (60s
// staleTime — registrations don't change often).

import { getKey } from './auth';

const BASE =
  (import.meta.env.VITE_QLAUD_BASE as string | undefined) ??
  'https://api.qlaud.ai';

export type RegisteredMcpServer = {
  id: string;
  name: string;
  server_url: string;
  /** Number of tools cached server-side from the last refresh. */
  tools_cached: number;
  /** Wall-clock ms of the last refresh, or null if never refreshed. */
  tools_cache_at: number | null;
  has_auth_headers: boolean;
  created_at: number;
};

/** GET /v1/mcp-servers — newest-first list of the caller's
 *  registered MCPs (excluding revoked rows). Up to 100. */
export async function listMcpServers(
  signal?: AbortSignal,
): Promise<RegisteredMcpServer[]> {
  const key = getKey();
  if (!key) throw new Error('not_authed');
  const res = await fetch(`${BASE}/v1/mcp-servers`, {
    headers: { 'x-api-key': key },
    signal,
  });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`mcp_${res.status}:${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { data: RegisteredMcpServer[] };
  return data.data;
}
