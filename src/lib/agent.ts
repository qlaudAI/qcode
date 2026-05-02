// qcode's agent loop.
//
// Sends the user's turn, streams the model's response, executes any
// tool calls in qcode (read or write, depending on tier), feeds
// tool_results back, and repeats until the model returns a non-tool
// stop_reason or we hit the safety cap (MAX_LOOPS).
//
// Approval flow for write_file / edit_file / bash:
//   1. Tool executor builds an ApprovalRequest (diff, command, etc.)
//   2. Calls back into runAgent's `onApproval` handler
//   3. ChatSurface renders an approval card and resolves the promise
//      when the user clicks Allow or Reject
//   4. Executor runs (or skips) based on the decision

import { envSystemSection, probeEnv } from './env-probe';
import { getProjectMemory, memorySystemSection } from './memory';
import {
  streamMessage,
  streamThreadMessage,
  type ClientToolDef,
  type ContentBlock,
  type Message,
} from './qlaud-client';
import {
  ALL_TOOLS,
  READ_TOOLS,
  SUBAGENT_READ_TOOLS,
  SUBAGENT_TOOLS,
  executeTool,
  type ApprovalDecision,
  type ApprovalRequest,
  type ToolCall,
  type ToolResult,
} from './tools';
import { submitToolResult } from './tool-results';
import { createRemoteThread } from './threads';
import { getSettings } from './settings';
import { posthog } from './analytics';

const SYSTEM_PROMPT_AGENT = `You are qcode, a multi-model coding agent running on the user's desktop.

Style:
- Be direct. Show, don't tell. Match the user's terseness.
- Investigate before changing: list_files / glob to discover, grep / read_file to confirm, then act.
- Never invent file paths or function names. If you're unsure, look first.

Tools:
- list_files / read_file / glob / grep run without asking — use them freely.
- write_file / edit_file / bash require user approval each time. The user sees a diff (for writes/edits) or the full command (for bash) before approving. Don't ask the user to approve in chat — qcode shows the prompt automatically.
- Prefer edit_file over write_file when modifying an existing file. Make old_string unique by including surrounding context.

Safety:
- Stay inside the user's open workspace. Tool calls outside it will fail.
- Don't run destructive commands without good reason. The bash tool has a deny-list, but it isn't exhaustive.
- If the user rejects an approval, don't immediately retry the same change — propose a different approach or ask what they'd prefer.`;

const SYSTEM_PROMPT_PLAN = `You are qcode in PLAN MODE. The user has explicitly asked you to investigate and propose, not to change anything.

Style:
- Use list_files / glob to map the project, then read_file / grep to confirm specifics.
- Produce a concrete, file-by-file plan. Reference exact paths and function names. When proposing edits, quote the existing code you'd change and the replacement.
- Be specific about ordering: which file first, which test to run after, what the rollback is.
- If the user's request is ambiguous, surface the choice points before recommending one.

Tools available to you:
- list_files / read_file / glob / grep — use them freely.
- write_file / edit_file / bash are NOT available in plan mode by design. Don't claim you'll run them; don't ask to use them. Describe the change in prose.

When the user is satisfied with the plan they'll switch out of plan mode and ask you to execute.`;

const MAX_LOOPS = 16; // hard ceiling; with write tools, real tasks need more turns

export type AgentEvent =
  | { type: 'turn_start'; turn: number }
  | {
      type: 'skill_resolved';
      /** null = no specialist; default qcode prompt ran. */
      skill: { slug: string; role: string } | null;
      /** Actual upstream model that ran (may differ from picked
       *  when a skill forced a swap). */
      resolvedModel: string;
    }
  | { type: 'text'; text: string }
  | {
      type: 'tool_call';
      id: string;
      name: string;
      input: unknown;
      status: 'running';
    }
  | {
      type: 'approval_pending';
      id: string;
      request: ApprovalRequest;
    }
  | {
      type: 'approval_resolved';
      id: string;
      decision: ApprovalDecision;
    }
  | {
      type: 'tool_progress';
      id: string;
      /** Full accumulated output text — replaces what was rendered
       *  before, doesn't append. Lets the UI re-format from scratch
       *  on each chunk without having to track per-stream offsets. */
      partial: string;
    }
  | {
      type: 'tool_done';
      id: string;
      content: string;
      isError: boolean;
    }
  | {
      type: 'finished';
      stopReason?: string;
      turns: number;
      /** Aggregated usage across every model call in this run. Used
       *  by the UI to show a per-turn cost/token pill. */
      usage: { inputTokens: number; outputTokens: number };
    }
  | { type: 'error'; message: string }
  // ─── Subagent (`task` tool) events ──────────────────────────────
  // Fired by the parent runThreadAgent when a `task` tool dispatch
  // is intercepted. The UI uses these to render a single "Subagent:
  // <description>" card with collapsed inner events; subagent_event
  // wraps every event the child emits so the UI can attribute them
  // back to the parent task call instead of mixing them inline.
  | {
      type: 'subagent_start';
      parentToolUseId: string;
      description: string;
    }
  | {
      type: 'subagent_event';
      parentToolUseId: string;
      /** Underlying agent event the child produced. The same shape
       *  the parent uses; consumers can choose to render or ignore
       *  per-tool. */
      inner: AgentEvent;
    }
  | {
      type: 'subagent_done';
      parentToolUseId: string;
      isError: boolean;
      summary: string;
    };

export type RunAgentOpts = {
  model: string;
  workspace: string | null;
  /** Prior conversation. Includes the just-sent user turn at the end. */
  history: Message[];
  /** 'agent' (default) — full toolkit. 'plan' — read-only tools +
   *  proposal-style system prompt. */
  mode?: 'agent' | 'plan';
  signal?: AbortSignal;
  onEvent: (e: AgentEvent) => void;
  /** Resolves to allow/reject for a write/edit/bash tool. The UI
   *  surfaces the request via the `approval_pending` event and
   *  fulfills this promise when the user clicks. */
  onApproval: (
    toolUseId: string,
    request: ApprovalRequest,
  ) => Promise<ApprovalDecision>;
};

export async function runAgent(opts: RunAgentOpts): Promise<Message[]> {
  const messages: Message[] = [...opts.history];
  const planMode = opts.mode === 'plan';
  const basePrompt = planMode ? SYSTEM_PROMPT_PLAN : SYSTEM_PROMPT_AGENT;
  // Project memory (qcode.md / CLAUDE.md) is appended to the base
  // persona so the model picks up project conventions on every turn.
  // Cached per workspace inside getProjectMemory — only one fs read
  // per session unless the user clears the cache via /init.
  const memory = opts.workspace
    ? await getProjectMemory(opts.workspace)
    : null;
  const systemPrompt = basePrompt + memorySystemSection(memory);
  const tools = opts.workspace
    ? planMode
      ? READ_TOOLS
      : ALL_TOOLS
    : undefined;
  // Aggregate per-turn usage across the whole runAgent call. Each
  // streamMessage iteration adds its own input/output token count;
  // the final 'finished' event ships the cumulative number.
  let totalInput = 0;
  let totalOutput = 0;

  for (let turn = 0; turn < MAX_LOOPS; turn++) {
    opts.onEvent({ type: 'turn_start', turn });

    const assistantBlocks: ContentBlock[] = [];
    let currentText = '';
    let stopReason: string | undefined;

    try {
      await streamMessage({
        model: opts.model,
        system: systemPrompt,
        tools,
        messages,
        signal: opts.signal,
        onTextDelta: (chunk) => {
          currentText += chunk;
          opts.onEvent({ type: 'text', text: chunk });
        },
        onToolUse: (block) => {
          if (currentText) {
            assistantBlocks.push({ type: 'text', text: currentText });
            currentText = '';
          }
          assistantBlocks.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          });
          opts.onEvent({
            type: 'tool_call',
            id: block.id,
            name: block.name,
            input: block.input,
            status: 'running',
          });
        },
        onMessageStart: (info) => {
          if (info.inputTokens != null) totalInput += info.inputTokens;
        },
        onMessageStop: (info) => {
          if (currentText) {
            assistantBlocks.push({ type: 'text', text: currentText });
            currentText = '';
          }
          stopReason = info.stopReason;
          if (info.outputTokens != null) totalOutput += info.outputTokens;
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown';
      opts.onEvent({ type: 'error', message: msg });
      return messages;
    }

    messages.push({ role: 'assistant', content: assistantBlocks });

    if (stopReason !== 'tool_use') {
      opts.onEvent({
        type: 'finished',
        stopReason,
        turns: turn + 1,
        usage: { inputTokens: totalInput, outputTokens: totalOutput },
      });
      return messages;
    }

    const toolUseBlocks = assistantBlocks.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_use' }> =>
        b.type === 'tool_use',
    );
    const toolResults: ContentBlock[] = [];

    for (const tu of toolUseBlocks) {
      if (!opts.workspace) {
        const content =
          'No workspace is open. The user must open a folder (⌘O) before file tools work. Tell them to do that.';
        opts.onEvent({
          type: 'tool_done',
          id: tu.id,
          content,
          isError: true,
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content,
          is_error: true,
        });
        continue;
      }

      const call: ToolCall = { id: tu.id, name: tu.name, input: tu.input };
      const result: ToolResult = await executeTool(call, {
        workspace: opts.workspace,
        requestApproval: async (req) => {
          opts.onEvent({ type: 'approval_pending', id: tu.id, request: req });
          const decision = await opts.onApproval(tu.id, req);
          opts.onEvent({ type: 'approval_resolved', id: tu.id, decision });
          return decision;
        },
        onPartial: (partial) => {
          opts.onEvent({ type: 'tool_progress', id: tu.id, partial });
        },
      });
      opts.onEvent({
        type: 'tool_done',
        id: tu.id,
        content: result.content,
        isError: !!result.is_error,
      });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: result.tool_use_id,
        content: result.content,
        is_error: result.is_error,
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  opts.onEvent({
    type: 'error',
    message: `Agent hit the ${MAX_LOOPS}-turn safety limit. Break the task into smaller steps.`,
  });
  return messages;
}

// ─── Thread agent: server-side tool loop, client_dispatch tools ───
//
// Sprint C entrypoint. Replaces the multi-iteration runAgent loop
// with a single streamThreadMessage call. qlaud-edge runs the
// model + tool-loop server-side; qcode just dispatches tool calls
// for our 7 local tools (file ops, bash) when qlaud parks on the
// per-thread Durable Object.
//
// Why split from runAgent instead of refactoring it: the two have
// fundamentally different shapes — runAgent maintains history
// client-side and re-sends it every turn; runThreadAgent sends
// one turn and streams the entire multi-iteration response. Trying
// to share the loop body makes both worse. App.tsx + ChatSurface
// pick which one to use; the legacy runAgent stays around in
// Sprint C-1 so we can flip the switch in C-2 without bleeding
// regressions across the same commit.

export type RunThreadAgentOpts = {
  threadId: string;
  model: string;
  workspace: string | null;
  /** New user turn — Anthropic content blocks (text, image, etc.). */
  content: ContentBlock[];
  mode?: 'agent' | 'plan';
  /** When true, also pass tools_mode='dynamic' so qlaud injects the
   *  4 meta-tools (qlaud_search_tools, etc.) for connector access. */
  enableConnectors?: boolean;
  /** When true, this is a subagent run spawned by the `task` tool.
   *  We strip `task` from the client_tools list (no recursive
   *  spawning) and skip the parent's onIterationStart pulse so the
   *  subagent's iterations don't pollute the parent UI's turn
   *  divider. Approvals and tool cards still bubble up — the user
   *  needs to see + approve every write the subagent attempts. */
  isSubagent?: boolean;
  signal?: AbortSignal;
  onEvent: (e: AgentEvent) => void;
  onApproval: (
    toolUseId: string,
    request: ApprovalRequest,
  ) => Promise<ApprovalDecision>;
};

/** Anthropic-shape tool defs → the inline ClientToolDef the qlaud
 *  /v1/threads/:id/messages endpoint expects in `client_tools`. */
function toClientTools(tools: typeof ALL_TOOLS): ClientToolDef[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Record<string, unknown>,
  }));
}

export async function runThreadAgent(opts: RunThreadAgentOpts): Promise<void> {
  const planMode = opts.mode === 'plan';
  const basePrompt = planMode ? SYSTEM_PROMPT_PLAN : SYSTEM_PROMPT_AGENT;
  // Memory + env probe pulled in parallel — they're both cached so
  // hot turns pay nothing here, and on a cold workspace the two
  // round-trips happen at the same time instead of sequentially.
  const [memory, env] = opts.workspace
    ? await Promise.all([
        getProjectMemory(opts.workspace),
        probeEnv(opts.workspace),
      ])
    : [null, null];
  const systemPrompt =
    basePrompt + memorySystemSection(memory) + envSystemSection(env);
  // Subagent runs strip `task` from the tool list (depth-1 cap)
  // and stick to read-only tools when the parent is in plan mode
  // — the subagent inherits the parent's safety posture.
  const baseTools = opts.isSubagent
    ? planMode
      ? SUBAGENT_READ_TOOLS
      : SUBAGENT_TOOLS
    : planMode
      ? READ_TOOLS
      : ALL_TOOLS;
  const clientTools = opts.workspace ? toClientTools(baseTools) : [];

  // Stash tool inputs as they stream in (onToolUse) so we have them
  // when qlaud asks us to dispatch (onToolDispatchStart). Cleared on
  // dispatch_done. tool_use_id is the join key — emitted on the
  // tool_use content block AND the qlaud.tool_dispatch_* events.
  type PendingToolUse = { name: string; input: unknown };
  const pending = new Map<string, PendingToolUse>();

  let totalInput = 0;
  let totalOutput = 0;
  let currentIteration = 1;

  // The first turn always exists; iteration_start fires for #2+.
  opts.onEvent({ type: 'turn_start', turn: 0 });

  // Server-built prompt opt-in: send the same memory + env data the
  // local assembler used, plus plan_mode flag, so qlaud can build the
  // canonical system prompt server-side. We still pass the locally-
  // built `systemPrompt` as a fallback for the (rare) case where a
  // qlaud worker rollback lands us on a version that doesn't know
  // about qlaud_runtime — old worker reads `system`, new worker
  // overrides it with the server-built one.
  const qlaudRuntime = {
    plan_mode: planMode,
    is_subagent: !!opts.isSubagent,
    memory: memory ? { source: memory.source, text: memory.text } : undefined,
    env: env
      ? {
          platform: env.platform,
          arch: env.arch || undefined,
          os_version: env.osVersion || undefined,
          workspace: env.workspace,
          tools: env.tools,
          rg: env.rg,
        }
      : undefined,
  };

  try {
    await streamThreadMessage({
      threadId: opts.threadId,
      model: opts.model,
      content: opts.content,
      system: systemPrompt,
      qlaudRuntime,
      // Server-side tool resolution: send the names, qlaud expands +
      // applies plan-mode / subagent subset rules. We still send the
      // full `clientTools` defs as the legacy fallback so a worker
      // rollback to a pre-this-PR version keeps qcode functional.
      clientToolNames: baseTools.map((t) => t.name),
      clientTools,
      toolsMode: opts.enableConnectors ? 'dynamic' : undefined,
      signal: opts.signal,
      onSkillResolved: (info) =>
        opts.onEvent({
          type: 'skill_resolved',
          skill: info.skill,
          resolvedModel: info.resolvedModel,
        }),
      onTextDelta: (chunk) => opts.onEvent({ type: 'text', text: chunk }),
      onToolUse: (block) => {
        pending.set(block.id, { name: block.name, input: block.input });
        opts.onEvent({
          type: 'tool_call',
          id: block.id,
          name: block.name,
          input: block.input,
          status: 'running',
        });
      },
      onMessageStart: (info) => {
        if (info.inputTokens != null) totalInput += info.inputTokens;
      },
      onMessageStop: (info) => {
        if (info.outputTokens != null) totalOutput += info.outputTokens;
      },
      onIterationStart: (info) => {
        currentIteration = info.iteration;
        opts.onEvent({ type: 'turn_start', turn: info.iteration - 1 });
      },
      onToolDispatchStart: async (info) => {
        // `task` short-circuits: instead of executing locally, we
        // spawn a subagent in a fresh remote thread and treat its
        // final text as the tool result. Same approval/dispatch
        // path is reused for the child's own tool calls (read_file,
        // bash, etc.) — those bubble up to the same UI via opts.onEvent.
        if (info.name === 'task' && !opts.isSubagent) {
          const stash = pending.get(info.toolUseId);
          const inputObj =
            (stash?.input as { description?: string; prompt?: string }) ?? {};
          // Subagent runs default to a cheap model — bounded scout
          // work doesn't need flagship pricing. Falls back to the
          // parent's model when the user has explicitly set
          // subagentModel:null in settings (old behavior). Read on
          // dispatch so toggling the setting takes effect on the
          // very next subagent.
          const subagentModel =
            getSettings().subagentModel ?? opts.model;
          posthog.capture('subagent_spawned', {
            parent_model: opts.model,
            subagent_model: subagentModel,
            description_chars: (inputObj.description ?? '').length,
            prompt_chars: (inputObj.prompt ?? '').length,
          });
          await runSubagentForTask({
            parentThreadId: opts.threadId,
            parentToolUseId: info.toolUseId,
            description: inputObj.description ?? '',
            prompt: inputObj.prompt ?? '',
            model: subagentModel,
            mode: opts.mode,
            workspace: opts.workspace,
            enableConnectors: opts.enableConnectors,
            signal: opts.signal,
            onEvent: opts.onEvent,
            onApproval: opts.onApproval,
          });
          return;
        }

        // Run the tool locally, then POST the result. Failures here
        // (workspace missing, executor crash, network) get surfaced
        // back to the parked dispatcher as is_error=true so the
        // model can decide how to react.
        if (!opts.workspace) {
          await safeSubmit(opts.threadId, info.toolUseId, {
            output:
              'No workspace is open. The user must open a folder (⌘O) before file tools work.',
            isError: true,
          });
          return;
        }
        const stash = pending.get(info.toolUseId);
        if (!stash) {
          // tool_use block came through but we lost it somehow — shouldn't
          // happen given the SSE ordering, but better to surface than hang.
          await safeSubmit(opts.threadId, info.toolUseId, {
            output: `qcode lost the tool input for ${info.name}. Internal error; retry.`,
            isError: true,
          });
          return;
        }
        const call: ToolCall = {
          id: info.toolUseId,
          name: stash.name,
          input: stash.input,
        };
        try {
          const result: ToolResult = await executeTool(call, {
            workspace: opts.workspace,
            requestApproval: async (req) => {
              opts.onEvent({
                type: 'approval_pending',
                id: info.toolUseId,
                request: req,
              });
              const decision = await opts.onApproval(info.toolUseId, req);
              opts.onEvent({
                type: 'approval_resolved',
                id: info.toolUseId,
                decision,
              });
              return decision;
            },
            onPartial: (partial) => {
              opts.onEvent({
                type: 'tool_progress',
                id: info.toolUseId,
                partial,
              });
            },
          });
          await safeSubmit(opts.threadId, info.toolUseId, {
            output: result.content,
            isError: !!result.is_error,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'tool execution failed';
          await safeSubmit(opts.threadId, info.toolUseId, {
            output: msg,
            isError: true,
          });
        }
      },
      onToolDispatchDone: (info) => {
        pending.delete(info.toolUseId);
        opts.onEvent({
          type: 'tool_done',
          id: info.toolUseId,
          content:
            typeof info.output === 'string'
              ? info.output
              : JSON.stringify(info.output),
          isError: info.isError,
        });
      },
      onQlaudError: (info) => {
        opts.onEvent({ type: 'error', message: info.message });
      },
      onDone: (info) => {
        opts.onEvent({
          type: 'finished',
          stopReason: info.hitMaxIterations ? 'max_loops' : 'end_turn',
          turns: info.iterations,
          usage: { inputTokens: totalInput, outputTokens: totalOutput },
        });
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    opts.onEvent({ type: 'error', message: msg });
  }

  // Drop any leftover approval handles — covers abort mid-tool.
  void currentIteration; // currently informational; UI may use later
}

/** Wrap submitToolResult so a network blip on the result-POST never
 *  throws into the SSE event handler. The dispatcher times out at
 *  60s on the qlaud side anyway — if we couldn't deliver, the
 *  model will see a timeout error from qlaud's side, which is the
 *  cleanest failure mode. */
async function safeSubmit(
  threadId: string,
  toolUseId: string,
  payload: { output: unknown; isError: boolean },
): Promise<void> {
  try {
    await submitToolResult(threadId, toolUseId, payload);
  } catch {
    // Swallowed deliberately — see comment above.
  }
}

/** Run a subagent in service of a parent's `task` tool call.
 *
 *  Architecture:
 *  - Mint a fresh remote thread tagged with parent_thread_id +
 *    parent_tool_use_id metadata so the subagent's history is
 *    inspectable later (and qlaud-side analytics can follow the
 *    parent→child relationship).
 *  - Run runThreadAgent against that thread with isSubagent=true,
 *    which strips `task` from client_tools (no recursion).
 *  - Capture every text delta into a buffer; the final buffer is
 *    what we POST as the parent's tool_result.
 *  - Tool calls inside the subagent (read_file, bash, etc.) flow
 *    through the same parent.onEvent handler so the user sees +
 *    approves them in the same UI as the rest of the conversation.
 *    They're tagged with a "subagent" marker via a wrapper event so
 *    the UI can visually nest them under the parent task card.
 */
async function runSubagentForTask(args: {
  parentThreadId: string;
  parentToolUseId: string;
  description: string;
  prompt: string;
  model: string;
  mode?: 'agent' | 'plan';
  workspace: string | null;
  enableConnectors?: boolean;
  signal?: AbortSignal;
  onEvent: (e: AgentEvent) => void;
  onApproval: (
    toolUseId: string,
    request: ApprovalRequest,
  ) => Promise<ApprovalDecision>;
}): Promise<void> {
  // Tell the parent UI a subagent is starting so it can render a
  // "Subagent: <description>" card. The corresponding subagent_done
  // event fires below.
  args.onEvent({
    type: 'subagent_start',
    parentToolUseId: args.parentToolUseId,
    description: args.description,
  });

  let childThreadId: string;
  try {
    const child = await createRemoteThread({
      metadata: {
        parent_thread_id: args.parentThreadId,
        parent_tool_use_id: args.parentToolUseId,
        kind: 'subagent',
        description: args.description,
      },
    });
    childThreadId = child.id;
  } catch (e) {
    const msg =
      e instanceof Error ? e.message : 'failed to create subagent thread';
    args.onEvent({
      type: 'subagent_done',
      parentToolUseId: args.parentToolUseId,
      isError: true,
      summary: msg,
    });
    await safeSubmit(args.parentThreadId, args.parentToolUseId, {
      output: `Subagent failed to start: ${msg}`,
      isError: true,
    });
    return;
  }

  let buffer = '';
  let childIsError = false;

  try {
    await runThreadAgent({
      threadId: childThreadId,
      model: args.model,
      workspace: args.workspace,
      content: [{ type: 'text', text: args.prompt }],
      mode: args.mode,
      enableConnectors: args.enableConnectors,
      isSubagent: true,
      signal: args.signal,
      onApproval: args.onApproval,
      onEvent: (e) => {
        // Stream the child's events into the parent UI, tagged so
        // the chat surface can render them nested under the parent's
        // task card. Text deltas also feed into the result buffer
        // we'll send back to the parent loop.
        if (e.type === 'text') {
          buffer += e.text;
        }
        if (e.type === 'error') {
          childIsError = true;
        }
        args.onEvent({
          type: 'subagent_event',
          parentToolUseId: args.parentToolUseId,
          inner: e,
        });
      },
    });
  } catch (e) {
    childIsError = true;
    buffer +=
      '\n\n[subagent crashed: ' +
      (e instanceof Error ? e.message : 'unknown') +
      ']';
  }

  const summary = buffer.trim() || '(subagent produced no text)';
  args.onEvent({
    type: 'subagent_done',
    parentToolUseId: args.parentToolUseId,
    isError: childIsError,
    summary,
  });

  await safeSubmit(args.parentThreadId, args.parentToolUseId, {
    output: summary,
    isError: childIsError,
  });
}
