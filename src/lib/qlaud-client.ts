// Streaming client for qlaud's /v1/messages endpoint (Anthropic shape).
//
// Two layers:
//   - streamMessage()    parses SSE → callbacks for text, tool_use,
//                        message_start (with usage), and message_stop.
//                        Used by the agent loop. Stateful per-call.
//   - The agent loop (lib/agent.ts) sits on top, executing tool calls
//     and re-invoking streamMessage() until stop_reason !== 'tool_use'.
//
// We intentionally don't depend on the @anthropic-ai/sdk — it bundles
// node polyfills and adds 200KB+ to the desktop binary. Our needs are
// narrow: stream parsing + a strict subset of the message shape.

import { getKey } from './auth';
import type { ToolDef } from './tools';

const BASE = (import.meta.env.VITE_QLAUD_BASE as string | undefined) ?? 'https://api.qlaud.ai';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | {
      type: 'image';
      source: {
        type: 'base64';
        /** image/png, image/jpeg, image/gif, image/webp. qlaud
         *  passes this through to Claude/GPT/Gemini which all
         *  speak the same multimodal shape via the gateway. */
        media_type: string;
        data: string;
      };
    };

export type Message = {
  role: 'user' | 'assistant';
  content: ContentBlock[];
};

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';

export type StreamHandlers = {
  /** Fires once per output chunk that's part of a text block. */
  onTextDelta: (chunk: string) => void;
  /** Fires once when the model decides to call a tool (input fully arrived). */
  onToolUse: (block: { id: string; name: string; input: unknown }) => void;
  /** Fires once at the start of the response with input-token count. */
  onMessageStart?: (info: { inputTokens?: number }) => void;
  /** Fires once at message_stop with stop reason + final usage. */
  onMessageStop: (info: {
    stopReason?: StopReason;
    outputTokens?: number;
  }) => void;
};

export type StreamOpts = StreamHandlers & {
  model: string;
  messages: Message[];
  tools?: ToolDef[];
  /** Optional system prompt. The agent loop injects qcode's persona. */
  system?: string;
  signal?: AbortSignal;
  maxTokens?: number;
};

export async function streamMessage(opts: StreamOpts): Promise<void> {
  const key = getKey();
  if (!key) throw new Error('not_authed');

  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4096,
    stream: true,
    messages: opts.messages,
  };
  if (opts.system) body.system = opts.system;
  if (opts.tools && opts.tools.length > 0) body.tools = opts.tools;

  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (res.status === 401) throw new Error('unauthorized');
  if (res.status === 402) throw new Error('cap_hit');
  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => '');
    throw new Error(`upstream_${res.status}:${txt.slice(0, 200)}`);
  }

  // Per-block accumulator: a tool_use block streams its `input` JSON
  // across multiple input_json_delta events. We concatenate by index
  // and parse once content_block_stop arrives.
  type ToolUseAccum = { id: string; name: string; jsonText: string };
  const toolAccum = new Map<number, ToolUseAccum>();

  let stopReason: StopReason | undefined;
  let finalOutputTokens: number | undefined;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

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

      let ev: AnthropicStreamEvent;
      try {
        ev = JSON.parse(payload) as AnthropicStreamEvent;
      } catch {
        continue; // ping events, malformed lines — skip silently
      }

      switch (ev.type) {
        case 'message_start':
          opts.onMessageStart?.({ inputTokens: ev.message?.usage?.input_tokens });
          break;

        case 'content_block_start':
          if (ev.content_block?.type === 'tool_use' && ev.index != null) {
            toolAccum.set(ev.index, {
              id: ev.content_block.id,
              name: ev.content_block.name,
              jsonText: '',
            });
          }
          break;

        case 'content_block_delta': {
          if (!ev.delta) break;
          if (ev.delta.type === 'text_delta' && ev.delta.text) {
            opts.onTextDelta(ev.delta.text);
          } else if (
            ev.delta.type === 'input_json_delta' &&
            ev.index != null &&
            typeof ev.delta.partial_json === 'string'
          ) {
            const acc = toolAccum.get(ev.index);
            if (acc) acc.jsonText += ev.delta.partial_json;
          }
          break;
        }

        case 'content_block_stop': {
          if (ev.index == null) break;
          const acc = toolAccum.get(ev.index);
          if (acc) {
            let input: unknown = {};
            try {
              input = acc.jsonText ? JSON.parse(acc.jsonText) : {};
            } catch {
              input = { _raw: acc.jsonText };
            }
            opts.onToolUse({ id: acc.id, name: acc.name, input });
            toolAccum.delete(ev.index);
          }
          break;
        }

        case 'message_delta':
          if (ev.delta?.stop_reason) {
            stopReason = ev.delta.stop_reason as StopReason;
          }
          if (ev.usage?.output_tokens != null) {
            finalOutputTokens = ev.usage.output_tokens;
          }
          break;

        case 'message_stop':
          opts.onMessageStop({
            stopReason,
            outputTokens: finalOutputTokens,
          });
          break;

        default:
          // ping, error, unknown — ignore
          break;
      }
    }
  }
}

// ─── Anthropic streaming-event shapes (the subset we care about) ───

type AnthropicStreamEvent =
  | { type: 'message_start'; message?: { usage?: { input_tokens?: number } } }
  | {
      type: 'content_block_start';
      index?: number;
      content_block?:
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input?: unknown };
    }
  | {
      type: 'content_block_delta';
      index?: number;
      delta?:
        | { type: 'text_delta'; text?: string }
        | { type: 'input_json_delta'; partial_json?: string };
    }
  | { type: 'content_block_stop'; index?: number }
  | {
      type: 'message_delta';
      delta?: { stop_reason?: string; stop_sequence?: string | null };
      usage?: { output_tokens?: number };
    }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error?: { type?: string; message?: string } };
