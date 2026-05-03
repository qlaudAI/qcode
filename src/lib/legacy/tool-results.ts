// Client-dispatch counterpart: when qcode receives qlaud.tool_dispatch_start
// over SSE on a thread message, it executes the tool locally (file ops,
// bash, etc.) and POSTs the result here. qlaud-edge forwards to the
// per-thread Durable Object that's parked the upstream model loop;
// the loop unparks with the result and continues.
//
// See packages/tool-dispatch-do for the coordinator and
// apps/edge/src/routes/threads.ts handleSubmitToolResult for the
// receiving side.

import { getKey } from '../auth';

const BASE =
  (import.meta.env.VITE_QLAUD_BASE as string | undefined) ??
  'https://api.qlaud.ai';

export type ToolResultPayload = {
  /** Tool output. Strings are passed through; everything else is
   *  JSON-stringified server-side for inclusion in the
   *  tool_result content block. Anthropic accepts a string here. */
  output: unknown;
  /** True when the tool failed — surfaces is_error: true on the
   *  resulting tool_result block so the model can react accordingly. */
  isError: boolean;
};

export async function submitToolResult(
  threadId: string,
  toolUseId: string,
  payload: ToolResultPayload,
  signal?: AbortSignal,
): Promise<void> {
  const key = getKey();
  if (!key) throw new Error('not_authed');

  const url = `${BASE}/v1/threads/${encodeURIComponent(threadId)}/tool-results/${encodeURIComponent(toolUseId)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      output: payload.output,
      is_error: payload.isError,
    }),
    signal,
  });

  if (res.status === 401) throw new Error('unauthorized');
  if (res.status === 404) {
    // 404 here means the tool_use_id timed out (60s) or the thread
    // doesn't exist. Either way the model loop has already moved on
    // (or is about to) — surface as a soft error so the agent loop
    // can decide whether to keep going.
    throw new Error('tool_result_not_accepted');
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`upstream_${res.status}:${txt.slice(0, 200)}`);
  }
}
