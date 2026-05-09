// Sandbox-agent engine — the qcode-web counterpart to claude-code.ts.
//
// Same wire-format-out: emits AgentEvent shapes the existing
// ChatSurface render pipeline already understands. The DIFFERENCE is
// the spawn site:
//   - claude-code.ts (Tauri desktop) spawns claude as a sidecar via
//     Command.sidecar('binaries/bun', [...]).
//   - sandbox-agent.ts (web build) POSTs the prompt to the qlaud-edge
//     /v1/sandbox/sessions/:id/agent endpoint, which runs claude
//     inside a Cloudflare Sandbox container and streams the JSON-line
//     events back over HTTP.
//
// The reducer (handleClaudeLine + handleAnthropicEvent) is duplicated
// from claude-code.ts on purpose — for v1 the goal is "ship chat on
// web without touching the desktop path." Once the web path is stable
// the reducer extracts to a shared module and both engines call it.
//
// Scope omissions vs desktop:
//   - No qcode skill markdown management (skills were a Tauri-fs
//     primitive; web cycles each session through the sandbox FS).
//     The agent gets bare claude defaults.
//   - No two-model config (settings.subagentModel ignored on web).
//   - No --resume across turns yet (each turn starts a fresh claude
//     invocation; multi-turn would require server-side session
//     persistence in /v1/sandbox/sessions/:id/agent — landing later).
//   - No --append-system-prompt yet — the qcode-engine-hint and
//     qlaud-media skill pointers are desktop-shaped (file paths).
// All of these are additive deltas in the agent endpoint, not
// breaking changes to this engine.

import type { AgentEvent } from '../legacy/agent';
import type { ContentBlock } from '../qlaud-client';
import { getKey } from '../auth';

const BASE =
  (import.meta.env.VITE_QLAUD_BASE as string | undefined) ??
  'https://api.qlaud.ai';

/** Same shape as RunEngineClaudeCodeOpts so ChatSurface can route to
 *  either engine with a single dispatcher line. Fields the sandbox
 *  doesn't honor (workspace, sessionId for --resume) are accepted
 *  and ignored — keeping the call sites uniform is more important
 *  than catching unused fields here. */
export type RunSandboxAgentOpts = {
  /** Ignored for v1 — sandbox sessions don't yet persist claude
   *  conversation state across turns. The qcode thread id below is
   *  what stitches turns together server-side. */
  sessionId: string | null;
  /** Fired with the sandbox session id (NOT claude's session id) so
   *  the caller can persist for the next turn — same callback name
   *  ChatSurface already wires up; we co-opt it for the sandbox id. */
  onSessionId?: (id: string) => void;
  model: string;
  qcodeThreadId?: string | null;
  /** 'agent' (default) → claude with --dangerously-skip-permissions
   *  for full toolkit. 'plan' → claude with --permission-mode plan
   *  (read-only tools, model proposes, user flips to agent to
   *  execute). Mirrors desktop's settings.autoApprove dispatch. */
  mode?: 'agent' | 'plan';
  /** Ignored on web — sandbox container's cwd is /workspace. The
   *  field stays in the contract so the dispatcher can pass through
   *  whatever ChatSurface has without branching. */
  workspace: string;
  content: ContentBlock[];
  signal?: AbortSignal;
  onEvent: (e: AgentEvent) => void;
};

export async function runEngineSandboxAgent(
  opts: RunSandboxAgentOpts,
): Promise<void> {
  const apiKey = getKey();
  if (!apiKey) {
    opts.onEvent({
      type: 'error',
      message: 'Not signed in to qlaud — open Settings and add your API key first.',
    });
    return;
  }

  // Flatten content blocks to plain text. Same v1 simplification as
  // the desktop engine — multimodal needs the agent endpoint to
  // forward attachments, which lands later.
  const promptText = opts.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
  if (!promptText) {
    opts.onEvent({
      type: 'error',
      message:
        'Web sandbox agent only supports text prompts for v1. Multimodal coming after the long-lived process refactor.',
    });
    return;
  }

  // First render before any output arrives — gives the user
  // immediate feedback that the engine started. Same event the
  // desktop engine fires; ChatSurface already listens.
  opts.onEvent({ type: 'turn_start', turn: 0 });

  // 1. Mint or reuse a sandbox session. Lazy import so the web build
  //    can tree-shake the runtime layer if /play isn't loaded.
  const { ensureSandboxSession } = await import('../runtime/sandbox-session');
  let sessionId: string;
  try {
    sessionId = await ensureSandboxSession();
  } catch (e) {
    opts.onEvent({
      type: 'error',
      message:
        'Could not provision sandbox: ' +
        (e instanceof Error ? e.message : String(e)),
    });
    return;
  }
  opts.onSessionId?.(sessionId);

  // 2. POST to the agent endpoint. Streaming response — body is a
  //    newline-delimited JSON stream same as claude --output-format
  //    stream-json on desktop.
  let res: Response;
  try {
    res = await fetch(
      `${BASE}/v1/sandbox/sessions/${encodeURIComponent(sessionId)}/agent`,
      {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'content-type': 'application/json',
        },
        // thread_id triggers the server-side GitLab persistence
        // path: clone-or-init the per-thread repo before running
        // claude, push after. When the server's GITLAB_TOKEN_
        // QCODE_USERS secret is unset (or thread_id is omitted),
        // the server runs the agent without persistence — same
        // behavior as before this commit. Sending thread_id
        // unconditionally makes the migration to persistence a
        // server-side flag flip with zero client coordination.
        body: JSON.stringify({
          prompt: promptText,
          model: opts.model,
          thread_id: opts.qcodeThreadId ?? null,
          // 'agent' or 'plan' — server flips the permission flag
          // ('--dangerously-skip-permissions' vs '--permission-mode
          // plan') accordingly. Defaults to 'agent' on the server
          // when omitted, matching today's behavior.
          mode: opts.mode ?? 'agent',
        }),
        signal: opts.signal,
      },
    );
  } catch (e) {
    opts.onEvent({
      type: 'error',
      message:
        'Network error reaching sandbox agent: ' +
        (e instanceof Error ? e.message : 'fetch failed'),
    });
    return;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    opts.onEvent({
      type: 'error',
      message: `Sandbox agent HTTP ${res.status}: ${text.slice(0, 200)}`,
    });
    return;
  }
  if (!res.body) {
    opts.onEvent({
      type: 'error',
      message: 'Sandbox agent returned an empty body — server bug.',
    });
    return;
  }

  // 3. Reduce the stream. Same logic as claude-code.ts; copied for
  //    v1 to avoid touching the working desktop path.
  type ToolUseAccum = { id: string; name: string; jsonText: string };
  const toolAccum = new Map<number, ToolUseAccum>();
  let totalInput = 0;
  let totalOutput = 0;

  const handleAnthropicEvent = (av: AnthropicSseEvent) => {
    switch (av.type) {
      case 'message_start': {
        const it = av.message?.usage?.input_tokens;
        if (typeof it === 'number') totalInput += it;
        return;
      }
      case 'content_block_start': {
        const cb = av.content_block as
          | { type: 'tool_use'; id: string; name: string }
          | { type: string; [k: string]: unknown }
          | undefined;
        if (cb?.type === 'tool_use' && typeof av.index === 'number') {
          const tu = cb as { type: 'tool_use'; id: string; name: string };
          toolAccum.set(av.index, { id: tu.id, name: tu.name, jsonText: '' });
        }
        return;
      }
      case 'content_block_delta': {
        if (!av.delta) return;
        if (
          av.delta.type === 'text_delta' &&
          typeof av.delta.text === 'string'
        ) {
          opts.onEvent({ type: 'text', text: av.delta.text });
        } else if (
          av.delta.type === 'input_json_delta' &&
          typeof av.index === 'number' &&
          typeof av.delta.partial_json === 'string'
        ) {
          const acc = toolAccum.get(av.index);
          if (acc) acc.jsonText += av.delta.partial_json;
        }
        return;
      }
      case 'content_block_stop': {
        if (typeof av.index !== 'number') return;
        const acc = toolAccum.get(av.index);
        if (!acc) return;
        let input: unknown = {};
        try {
          input = acc.jsonText ? JSON.parse(acc.jsonText) : {};
        } catch {
          input = { _raw: acc.jsonText };
        }
        opts.onEvent({
          type: 'tool_call',
          id: acc.id,
          name: acc.name,
          input,
          status: 'running',
        });
        toolAccum.delete(av.index);
        return;
      }
      case 'message_delta': {
        const ot = av.usage?.output_tokens;
        if (typeof ot === 'number') totalOutput += ot;
        return;
      }
      default:
        return;
    }
  };

  const handleClaudeLine = (raw: string) => {
    let ev: ClaudeStreamLine;
    try {
      ev = JSON.parse(raw) as ClaudeStreamLine;
    } catch {
      return;
    }

    // qcode wrapper events (bootstrap progress, errors) — surface as
    // simple system messages so the user sees the install spinner.
    if (
      typeof (ev as Record<string, unknown>).type === 'string' &&
      String((ev as Record<string, unknown>).type).startsWith('qcode_')
    ) {
      const w = ev as unknown as {
        type: string;
        subtype?: string;
        message?: string;
        stderr?: string;
      };
      if (w.type === 'qcode_bootstrap') {
        // Honest copy: the 25s install pays per COLD container, not
        // one-time globally. After 10 min idle the container sleeps;
        // the next turn from a stale tab pays this again. Will go
        // to ~0s once the qcode-engine prebuilt image ships with
        // claude baked in.
        const text =
          w.subtype === 'install_start'
            ? 'Spinning up your sandbox (~25s)…'
            : w.subtype === 'install_done'
              ? 'Sandbox ready.'
              : w.subtype === 'install_failed'
                ? `Sandbox setup failed: ${w.stderr ?? 'unknown'}`
                : `Sandbox: ${w.subtype ?? 'progress'}`;
        opts.onEvent({ type: 'text', text: text + '\n' });
        return;
      }
      if (w.type === 'qcode_error') {
        opts.onEvent({
          type: 'error',
          message: w.message ?? w.stderr ?? 'sandbox agent error',
        });
        return;
      }
      // GitLab persistence lifecycle events. Surfacing them in the
      // chat is the diagnostic difference between "we silently lost
      // your work" and "the platform reported a clean retry path".
      // These events are emitted by apps/edge/src/routes/sandbox.ts
      // around the clone (resume_*), end-of-turn push (push_*), and
      // mid-turn checkpoint timer (checkpoint_*). The chat surface
      // already tolerates `text` events at any position, so they
      // appear as system-style status lines under the assistant
      // turn without bloating the message history.
      if (w.type === 'qcode_persist') {
        const sub = w.subtype ?? '';
        const wp = w as unknown as {
          subtype?: string;
          project_path?: string;
          message?: string;
          slug?: string;
        };
        const path = wp.project_path ?? wp.slug ?? '';
        const text =
          sub === 'resume_start'
            ? `↻ Restoring workspace from gitlab.com/${path}…`
            : sub === 'resume_done'
              ? `✓ Workspace restored from gitlab.com/${path}`
              : sub === 'resume_failed'
                ? `⚠ Restore failed: ${wp.message ?? 'unknown'} — starting with empty workspace`
                : sub === 'create_start'
                  ? `+ Creating new gitlab repo: ${wp.slug ?? ''}`
                  : sub === 'create_done'
                    ? `✓ Workspace tracking initialized at gitlab.com/${path}`
                    : sub === 'checkpoint_ok'
                      ? `✓ Checkpoint pushed`
                      : sub === 'push_failed'
                        ? `⚠ Push failed at end-of-turn: ${wp.message ?? 'unknown'} — work may be lost`
                        : sub === 'push_done'
                          ? `✓ Final push to gitlab.com/${path}`
                          : `Sandbox persist: ${sub}`;
        opts.onEvent({ type: 'text', text: text + '\n' });
        return;
      }
      // Resume decision — emitted right after we decide whether to
      // pass --resume to claude. Tells us if claude SHOULD have
      // memory of the prior conversation or is starting fresh.
      if (w.type === 'qcode_resume') {
        const wr = w as unknown as {
          subtype?: string;
          session_id?: string;
          reason?: string;
        };
        const text =
          wr.subtype === 'resumed'
            ? `↻ Resuming claude session ${wr.session_id ?? '(unknown)'}`
            : wr.subtype === 'fresh'
              ? `+ Starting fresh claude session (${wr.reason ?? 'no prior sid'})`
              : `Resume: ${wr.subtype ?? 'unknown'}`;
        opts.onEvent({ type: 'text', text: text + '\n' });
        return;
      }
      // Egress probe results — already shipped on worker side.
      // Surface for diagnosis even though we expect ok in steady
      // state; harmless to show.
      if (w.type === 'qcode_egress_ok') {
        // Quiet on success — no chat noise unless something fails.
        return;
      }
      if (w.type === 'qcode_keepalive') {
        // Internal connection-keepalive — never user-visible.
        return;
      }
    }

    if (ev.type === 'system' && ev.subtype === 'init') {
      // claude's own session id — we don't persist it for v1 (no
      // --resume yet), but log if useful for debugging.
      return;
    }
    if (ev.type === 'system' && ev.subtype === 'status') return;

    if (ev.type === 'stream_event' && ev.event) {
      handleAnthropicEvent(ev.event);
      return;
    }

    if (ev.type === 'user' && ev.message) {
      const msg = ev.message as {
        content?: Array<{
          type?: string;
          tool_use_id?: string;
          content?: unknown;
          is_error?: boolean;
        }>;
      };
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (const block of blocks) {
        if (
          block?.type !== 'tool_result' ||
          typeof block.tool_use_id !== 'string'
        ) {
          continue;
        }
        opts.onEvent({
          type: 'tool_done',
          id: block.tool_use_id,
          content: stringifyToolResult(block.content),
          isError: !!block.is_error,
        });
      }
      return;
    }

    if (ev.type === 'result') {
      const usage = ev.usage ?? {};
      opts.onEvent({
        type: 'finished',
        stopReason: ev.subtype === 'success' ? 'end_turn' : ev.subtype,
        turns: ev.num_turns ?? 1,
        usage: {
          inputTokens: totalInput || (usage.input_tokens ?? 0),
          outputTokens: totalOutput || (usage.output_tokens ?? 0),
        },
        costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null,
        seq: null,
      });
      return;
    }
    if (ev.type === 'assistant') return;
  };

  // 4. Pump the response body through the line buffer + reducer.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) handleClaudeLine(line);
      }
    }
    if (buf.trim()) handleClaudeLine(buf.trim());
  } catch (e) {
    if ((e as { name?: string })?.name !== 'AbortError') {
      opts.onEvent({
        type: 'error',
        message:
          'Stream broke mid-flight: ' +
          (e instanceof Error ? e.message : String(e)),
      });
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((b) => {
        if (b && typeof b === 'object') {
          const block = b as { type?: string; text?: unknown };
          if (block.type === 'text' && typeof block.text === 'string') {
            return block.text;
          }
        }
        return null;
      })
      .filter((s): s is string => s !== null);
    if (parts.length > 0) return parts.join('\n');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

// Wire shapes copied from claude-code.ts. Stable enough that the
// duplication is fine for v1; eventual extraction to a shared file
// happens once both engines stabilize.

type ClaudeStreamLine =
  | { type: 'system'; subtype: 'init'; session_id?: string }
  | { type: 'system'; subtype: 'status'; status?: string }
  | { type: 'stream_event'; event: AnthropicSseEvent; session_id?: string }
  | { type: 'assistant'; message?: { content?: unknown[]; usage?: unknown } }
  | { type: 'user'; message?: unknown }
  | {
      type: 'result';
      subtype?: string;
      num_turns?: number;
      usage?: { input_tokens?: number; output_tokens?: number };
      total_cost_usd?: number;
      result?: string;
    };

type AnthropicSseEvent =
  | {
      type: 'message_start';
      message?: { usage?: { input_tokens?: number } };
    }
  | {
      type: 'content_block_start';
      index?: number;
      content_block?:
        | { type: 'text'; text?: string }
        | { type: 'tool_use'; id: string; name: string; input?: unknown }
        | { type: 'thinking'; thinking?: string }
        | { type: string; [k: string]: unknown };
    }
  | {
      type: 'content_block_delta';
      index?: number;
      delta?:
        | { type: 'text_delta'; text?: string }
        | { type: 'input_json_delta'; partial_json?: string }
        | { type: 'thinking_delta'; thinking?: string }
        | { type: 'signature_delta'; signature?: string }
        | { type: string; [k: string]: unknown };
    }
  | { type: 'content_block_stop'; index?: number }
  | {
      type: 'message_delta';
      delta?: { stop_reason?: string };
      usage?: { output_tokens?: number };
    }
  | { type: 'message_stop' };
