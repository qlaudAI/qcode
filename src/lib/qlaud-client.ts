// Thin qlaud client used by the chat surface. Phase 1 surface only:
// non-agentic streaming chat against /v1/messages. The full agentic
// loop (tools, file edits, sub-agents) lands when we embed opencode's
// core in Phase 1 wrap-up.
//
// All requests use the user's qlaud key from auth.ts. We default to
// https://api.qlaud.ai but the env var lets a dev point at a local
// edge worker.

import { getKey } from './auth';

const BASE = (import.meta.env.VITE_QLAUD_BASE as string | undefined) ?? 'https://api.qlaud.ai';

export type StreamMessageOpts = {
  model: string;
  history: Array<{ role: 'user' | 'assistant'; text: string }>;
  /** Called with each new chunk of assistant text as it arrives. */
  onDelta: (chunk: string) => void;
  /** Called once with final usage info (input/output tokens, cost). */
  onComplete?: (info: {
    inputTokens?: number;
    outputTokens?: number;
    costMicros?: number;
  }) => void;
  /** Aborts an in-flight request. */
  signal?: AbortSignal;
};

export async function streamMessage(opts: StreamMessageOpts): Promise<void> {
  const key = getKey();
  if (!key) throw new Error('not_authed');

  // Convert internal history to Anthropic-shape messages. The last
  // entry is always the new user turn.
  const messages = opts.history.map((m) => ({
    role: m.role,
    content: [{ type: 'text', text: m.text }],
  }));

  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: 4096,
      stream: true,
      messages,
    }),
    signal: opts.signal,
  });

  if (res.status === 401) throw new Error('unauthorized');
  if (res.status === 402) throw new Error('cap_hit');
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    throw new Error(`upstream_${res.status}:${body.slice(0, 200)}`);
  }

  // Anthropic-shape SSE. Events look like:
  //   data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}
  //   data: {"type":"message_delta","usage":{"output_tokens":7}}
  //   data: {"type":"message_stop"}
  // We only care about text_delta + message_delta usage.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6);
      if (payload === '[DONE]') continue;
      try {
        const ev = JSON.parse(payload) as {
          type?: string;
          delta?: { type?: string; text?: string };
          message?: { usage?: { input_tokens?: number; output_tokens?: number } };
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          opts.onDelta(ev.delta.text);
        } else if (ev.type === 'message_start' && ev.message?.usage) {
          inputTokens = ev.message.usage.input_tokens;
        } else if (ev.type === 'message_delta' && ev.usage?.output_tokens != null) {
          outputTokens = ev.usage.output_tokens;
        }
      } catch {
        // Skip malformed lines silently — Anthropic occasionally sends
        // ping events with non-JSON shapes, and we shouldn't blow up.
      }
    }
  }

  opts.onComplete?.({ inputTokens, outputTokens });
}
