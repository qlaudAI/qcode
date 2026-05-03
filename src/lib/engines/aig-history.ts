// Engine Mode v0 — restore conversation history from qlaud's AI Gateway
// logs.
//
// Why this exists: when engine === 'claude-code', qcode never writes to
// qlaud's threads table — Claude Code itself owns the conversation
// state on disk. Switching threads in qcode and coming back used to
// blank the chat because ChatSurface refetched from `/v1/threads/:id`
// (which is empty for Engine Mode threads). The fix: read from the
// AI Gateway logs Cloudflare already stores for every request that
// flows through api.qlaud.ai.
//
// How it works:
//   1. Every claude API call (POST /v1/messages) goes:
//      claude → qlaud edge → Cloudflare AI Gateway → upstream Anthropic
//      CF AIG stores the full request body + response body, indexed
//      by metadata.user_id.
//   2. qlaud's /v1/aig/recent + /v1/aig/log/:id endpoints proxy CF API
//      with api-key auth + tenant filtering.
//   3. To rebuild a thread's chat, we ask for the LATEST log for the
//      user, parse its request_body.messages — Anthropic API is
//      stateless so the most recent request body contains the full
//      conversation history up to that point. No reassembly across
//      multiple events needed.
//
// Limitation in v0: we fetch the user's most recent log regardless of
// thread. If you have two qcode threads with different claude sessions
// active in the same window, switching to the older one will show the
// newer one's history (because the newer one wrote a more recent log).
// Fix in v1: qlaud edge extracts request.metadata.user_id (which
// claude code sets to its own session id) and forwards as
// cf-aig-metadata.claude_session_id; qcode filters by that. For now,
// use one thread at a time.

import { getKey } from '../auth';

const BASE = (import.meta.env.VITE_QLAUD_BASE as string | undefined) ?? 'https://api.qlaud.ai';

export type AigLogMetaItem = {
  id: string;
  created_at: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  duration_ms: number;
  status: number;
  metadata: Record<string, unknown>;
};

export type AigLogDetail = AigLogMetaItem & {
  request_body: string | null;
  response_body: string | null;
};

/** List recent AI Gateway events for a specific client session.
 *  Filtered server-side by both tenant + cf-aig-metadata.client_session_id
 *  — the latter is stamped by the qlaud edge from the request body's
 *  Anthropic-standard `metadata.user_id` field (which Claude Code
 *  populates with its session id). No URL-prefix gymnastics, no
 *  custom headers — just the standard /v1/messages spec field that
 *  Anthropic already defined for end-user identification.
 *
 *  Returns newest-first; events[0] is the latest call so it carries
 *  the most up-to-date conversation history (Anthropic API is
 *  stateless — every request body has the full prior conversation
 *  inlined in messages[]). */
export async function fetchAigRecent(opts: {
  /** Claude Code session id. Required so we don't see other
   *  threads/devices' logs. Get it from settings.claudeSessionByThread. */
  sessionId: string;
  limit?: number;
  sinceMs?: number;
  cursor?: string;
}): Promise<{ events: AigLogMetaItem[]; nextCursor: string | null } | null> {
  const key = getKey();
  if (!key) return null;
  if (!opts.sessionId) return null;
  const params = new URLSearchParams();
  params.set('session_id', opts.sessionId);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.sinceMs) params.set('since_ms', String(opts.sinceMs));
  if (opts.cursor) params.set('cursor', opts.cursor);
  const url = `${BASE}/v1/aig/recent?${params}`;

  const res = await fetch(url, { headers: { 'x-api-key': key } });
  if (!res.ok) {
    // 503 = CF_API_TOKEN not set on edge yet; treat as "no history
    // available" rather than crashing the chat. The user has to set
    // the secret via `wrangler secret put CF_API_TOKEN`.
    return null;
  }
  const json = (await res.json()) as {
    events?: AigLogMetaItem[];
    next_cursor?: string | null;
  };
  return {
    events: json.events ?? [],
    nextCursor: json.next_cursor ?? null,
  };
}

/** Fetch a single log including the full request_body + response_body.
 *  Bodies are unparsed JSON strings; caller decodes. */
export async function fetchAigLog(logId: string): Promise<AigLogDetail | null> {
  const key = getKey();
  if (!key) return null;
  const url = `${BASE}/v1/aig/log/${encodeURIComponent(logId)}`;
  const res = await fetch(url, { headers: { 'x-api-key': key } });
  if (!res.ok) return null;
  return (await res.json()) as AigLogDetail;
}

/** Anthropic /v1/messages request body shape — the relevant subset.
 *  We only need messages[] and (optionally) system to reconstruct the
 *  visible conversation. */
type AnthropicMessageBody = {
  model?: string;
  system?: string | Array<{ type?: string; text?: string }>;
  messages?: Array<{
    role: 'user' | 'assistant';
    content:
      | string
      | Array<
          | { type: 'text'; text: string }
          | { type: 'tool_use'; id: string; name: string; input: unknown }
          | {
              type: 'tool_result';
              tool_use_id: string;
              content: string | unknown;
              is_error?: boolean;
            }
          | { type: 'thinking'; thinking?: string }
          | { type: 'image'; source?: unknown }
          | { type: string; [k: string]: unknown }
        >;
  }>;
};

/** Anthropic /v1/messages response body shape — also a subset.
 *  After the user's last user message lands in messages[], the
 *  response body's content array represents the assistant's reply
 *  for THAT user turn. We append it to the reconstructed history. */
type AnthropicResponseBody = {
  role?: 'assistant';
  content?: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'thinking'; thinking?: string }
    | { type: string; [k: string]: unknown }
  >;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
};

/** Fetch the latest log for this user and reconstruct the visible
 *  conversation as Anthropic-shape Message[] (the same shape
 *  ChatSurface's historyToBlocks already consumes for the legacy
 *  qlaud-thread path).
 *
 *  Returns null when:
 *    - No logs exist yet (fresh thread, no claude turns yet)
 *    - CF_API_TOKEN not set on edge (503 from /v1/aig/recent)
 *    - User isn't signed in
 *
 *  In the null case, ChatSurface should leave blocks empty rather
 *  than blanking what's already on screen. */
export async function reconstructEngineHistory(opts: {
  /** Claude Code session id for the qcode thread being rehydrated.
   *  When null, returns null (rehydrate is impossible without the
   *  attribution key — fresh thread with no claude turns yet). */
  sessionId: string | null;
  /** When set, only fetch logs created after this epoch ms. */
  sinceMs?: number;
}): Promise<Array<{
  role: 'user' | 'assistant';
  content: Array<Record<string, unknown>>;
}> | null> {
  if (!opts.sessionId) return null;
  const recent = await fetchAigRecent({
    sessionId: opts.sessionId,
    limit: 5,
    sinceMs: opts.sinceMs,
  });
  if (!recent || recent.events.length === 0) return null;

  // Latest log is at [0]. Its request_body has the full conversation
  // history up to (but not including) the assistant's response that
  // THIS log represents. We append the response_body's content as
  // the final assistant turn.
  const latest = recent.events[0];
  if (!latest) return null;
  const detail = await fetchAigLog(latest.id);
  if (!detail) return null;

  let req: AnthropicMessageBody;
  try {
    req = JSON.parse(detail.request_body ?? '{}') as AnthropicMessageBody;
  } catch {
    return null;
  }
  let resp: AnthropicResponseBody | null = null;
  try {
    resp = JSON.parse(detail.response_body ?? 'null') as AnthropicResponseBody;
  } catch {
    resp = null;
  }

  const history: Array<{
    role: 'user' | 'assistant';
    content: Array<Record<string, unknown>>;
  }> = [];

  for (const msg of req.messages ?? []) {
    history.push({
      role: msg.role,
      content: normalizeContent(msg.content),
    });
  }
  if (resp?.content && Array.isArray(resp.content)) {
    history.push({
      role: 'assistant',
      content: resp.content as Array<Record<string, unknown>>,
    });
  }

  return history;
}

/** Normalize Anthropic's union content shape (string | block[]) into
 *  the block[] shape qcode's render layer expects. Strings become
 *  one text block. */
function normalizeContent(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (Array.isArray(content)) {
    return content as Array<Record<string, unknown>>;
  }
  return [];
}
