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

// ─── Thread streaming (server-side tool loop) ─────────────────────
//
// /v1/threads/:id/messages — qlaud runs the model + tool-loop
// server-side and streams progress back. The customer (qcode) sends
// ONE turn of content + a list of `client_tools` it can dispatch
// locally; qlaud emits standard Anthropic SSE for the model output
// AND qlaud-namespaced events around every tool dispatch:
//
//   qlaud.iteration_start  — new model turn (iteration 2+)
//   qlaud.tool_dispatch_start — about to dispatch a tool
//   qlaud.tool_dispatch_done  — dispatch result available
//   qlaud.error            — fatal mid-stream error
//   qlaud.done             — entire tool-loop finished
//
// For client-dispatch tools (the 7 local tools qcode runs locally),
// qlaud parks on a Durable Object after emitting tool_dispatch_start.
// qcode listens for that event, runs the tool, and POSTs the result
// to /v1/threads/:id/tool-results/:tool_use_id (see tool-results.ts).
// qlaud unparks, fires tool_dispatch_done, and continues the loop.

export type ClientToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type ThreadStreamHandlers = {
  /** Standard Anthropic events (text, tool_use, etc.) — same shape as
   *  streamMessage's callbacks. The thread version flips between
   *  iterations transparently; consumers can ignore the boundary
   *  unless they want a per-turn divider in the UI. */
  onTextDelta: (chunk: string) => void;
  onToolUse: (block: { id: string; name: string; input: unknown }) => void;
  /** Fires at every model turn's message_start. inputTokens is the
   *  prompt-token count for THAT iteration. */
  onMessageStart?: (info: { inputTokens?: number }) => void;
  /** Fires at every model turn's message_stop. outputTokens is the
   *  completion-token count for THAT iteration. */
  onMessageStop?: (info: { stopReason?: StopReason; outputTokens?: number }) => void;
  /** qlaud-namespaced events. Optional — if omitted, the lifecycle
   *  is invisible (still works, just no progress indicators). */
  onIterationStart?: (info: { iteration: number }) => void;
  onToolDispatchStart?: (info: {
    toolUseId: string;
    name: string;
    iteration: number;
  }) => void;
  onToolDispatchDone?: (info: {
    toolUseId: string;
    name: string;
    iteration: number;
    isError: boolean;
    output: unknown;
  }) => void;
  /** Fired once when the entire tool-loop finishes (or hits the cap).
   *  Means: no further events will arrive on this stream. */
  onDone?: (info: { iterations: number; hitMaxIterations: boolean }) => void;
  /** Mid-stream qlaud.error (after we've already written 200). The
   *  HTTP-level errors still throw from streamThreadMessage's caller;
   *  this handler is for tool-loop or upstream-mid-stream issues. */
  onQlaudError?: (info: { message: string; status?: number; iteration?: number }) => void;
};

export type ThreadStreamOpts = ThreadStreamHandlers & {
  threadId: string;
  model: string;
  /** New user turn — string or content-block array (for multimodal). */
  content: string | ContentBlock[];
  /** Tools qcode dispatches locally (file ops, bash, etc.). Sent
   *  inline; qlaud synthesizes ephemeral ResolvedTools and routes
   *  them back to qcode via the SSE events above. */
  clientTools?: ClientToolDef[];
  /** When true, qlaud also injects the 4 meta-tools so the model can
   *  discover MCP servers + connectors registered on the dashboard.
   *  Coexists with clientTools — the model sees both lists. */
  toolsMode?: 'dynamic' | 'tenant' | 'explicit';
  system?: string;
  signal?: AbortSignal;
  maxTokens?: number;
  /** Server-built system-prompt opt-in. When present, qlaud assembles
   *  the persona + plan-mode + memory + env sections itself and uses
   *  THAT as the system prompt — overriding whatever string we send
   *  in `system`. The point: prompt tweaks ride a `wrangler deploy`
   *  rather than requiring a qcode binary release. We still send
   *  `system` for backward compat — if qlaud is ever rolled back to
   *  a version that doesn't know about qlaud_runtime, the legacy
   *  client-built prompt still works. */
  qlaudRuntime?: {
    plan_mode?: boolean;
    is_subagent?: boolean;
    memory?: { source: string; text: string };
    env?: {
      platform: 'macos' | 'linux' | 'windows' | 'unknown';
      arch?: string;
      os_version?: string;
      workspace: string;
      tools?: Record<string, string | null>;
      rg?: 'sidecar' | 'system' | null;
    };
  };
};

export async function streamThreadMessage(opts: ThreadStreamOpts): Promise<void> {
  const key = getKey();
  if (!key) throw new Error('not_authed');

  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4096,
    stream: true,
    content: opts.content,
  };
  if (opts.system) body.system = opts.system;
  if (opts.toolsMode) body.tools_mode = opts.toolsMode;
  if (opts.clientTools && opts.clientTools.length > 0) {
    body.client_tools = opts.clientTools;
  }
  if (opts.qlaudRuntime) body.qlaud_runtime = opts.qlaudRuntime;

  const res = await fetch(`${BASE}/v1/threads/${encodeURIComponent(opts.threadId)}/messages`, {
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
  if (res.status === 404) throw new Error('thread_not_found');
  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => '');
    throw new Error(`upstream_${res.status}:${txt.slice(0, 200)}`);
  }

  type ToolUseAccum = { id: string; name: string; jsonText: string };
  const toolAccum = new Map<number, ToolUseAccum>();
  // Per-iteration state: stop_reason and outputTokens for the current
  // model turn. Reset on every message_start so each iteration's
  // onMessageStop gets the right values.
  let stopReason: StopReason | undefined;
  let outputTokens: number | undefined;

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

      let ev: ThreadStreamEvent;
      try {
        ev = JSON.parse(payload) as ThreadStreamEvent;
      } catch {
        continue;
      }

      switch (ev.type) {
        case 'message_start':
          stopReason = undefined;
          outputTokens = undefined;
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
          if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason as StopReason;
          if (ev.usage?.output_tokens != null) outputTokens = ev.usage.output_tokens;
          break;
        case 'message_stop':
          opts.onMessageStop?.({ stopReason, outputTokens });
          break;
        case 'qlaud.iteration_start':
          opts.onIterationStart?.({ iteration: ev.iteration ?? 0 });
          break;
        case 'qlaud.tool_dispatch_start':
          opts.onToolDispatchStart?.({
            toolUseId: ev.tool_use_id ?? '',
            name: ev.name ?? '',
            iteration: ev.iteration ?? 0,
          });
          break;
        case 'qlaud.tool_dispatch_done':
          opts.onToolDispatchDone?.({
            toolUseId: ev.tool_use_id ?? '',
            name: ev.name ?? '',
            iteration: ev.iteration ?? 0,
            isError: !!ev.is_error,
            output: ev.output,
          });
          break;
        case 'qlaud.error':
          opts.onQlaudError?.({
            message: ev.message ?? 'unknown qlaud error',
            status: ev.status,
            iteration: ev.iteration,
          });
          break;
        case 'qlaud.done':
          opts.onDone?.({
            iterations: ev.iterations ?? 0,
            hitMaxIterations: !!ev.hit_max_iterations,
          });
          break;
        default:
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

// Thread streams add the qlaud-namespaced events on top of the
// Anthropic ones. Schema mirrors what exec-messages-streaming-with-tools
// emits in qlaud-edge.
type ThreadStreamEvent =
  | AnthropicStreamEvent
  | { type: 'qlaud.iteration_start'; iteration?: number }
  | {
      type: 'qlaud.tool_dispatch_start';
      tool_use_id?: string;
      name?: string;
      iteration?: number;
    }
  | {
      type: 'qlaud.tool_dispatch_done';
      tool_use_id?: string;
      name?: string;
      iteration?: number;
      is_error?: boolean;
      output?: unknown;
    }
  | {
      type: 'qlaud.error';
      message?: string;
      status?: number;
      iteration?: number;
    }
  | {
      type: 'qlaud.done';
      iterations?: number;
      hit_max_iterations?: boolean;
    };
