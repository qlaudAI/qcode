// qcode's agent loop.
//
// Sends the user's turn over /v1/threads/:id/messages, streams the
// model + server-side tool loop, dispatches client_dispatch tool
// calls (the 7 local tools — file ops, bash, browser) when qlaud
// parks on the per-thread Durable Object, POSTs the result, and
// keeps consuming SSE until qlaud emits qlaud.done.
//
// Approval flow for write_file / edit_file / bash:
//   1. Tool executor builds an ApprovalRequest (diff, command, etc.)
//   2. Calls back into onApproval
//   3. ChatSurface renders an approval card and resolves the promise
//      when the user clicks Allow or Reject
//   4. Executor runs (or skips) based on the decision

import { envSystemSection, probeEnv } from './env-probe';
import { getProjectMemory, memorySystemSection } from './memory';
import {
  streamThreadMessage,
  type ClientToolDef,
  type ContentBlock,
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
      /** Aggregated usage across every model call in this run. */
      usage: { inputTokens: number; outputTokens: number };
      /** USD cost from qlaud's authoritative count (cost_micros /
       *  1e6). Includes markup. null when running against a legacy
       *  qlaud worker that didn't ship cost_micros yet. */
      costUsd: number | null;
      /** Seq of the assistant turn just persisted by qlaud. Used
       *  by the in-flight resume detector + future jump-to-turn. */
      seq: number | null;
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
    }
  // Auto-commit checkpoint event. Fires once per turn when autoCommit
  // is on and the agent wrote any files. The UI renders a small chip
  // ("commit a1b2c3d4 — 3 files") that links to the diff. On skip
  // (already-dirty tree, special git state, etc.) we still emit so
  // the UI can show "skipped: <reason>" the first time it happens
  // — silent skip would be more confusing than a one-line surface.
  | {
      type: 'checkpoint';
      result:
        | { kind: 'committed'; sha: string; message: string; filesChanged: number }
        | { kind: 'skipped'; reason: string };
    };

// ─── Thread agent: server-side tool loop, client_dispatch tools ───
//
// qlaud-edge runs the model + tool-loop server-side; qcode dispatches
// the 7 local tools (file ops, bash, browser) when qlaud parks on the
// per-thread Durable Object. One streamThreadMessage call streams the
// entire multi-iteration response — no client-side history rebuild.
//
// Parallelism: the edge dispatches every tool_use in an iteration via
// Promise.all (apps/edge/src/lib/exec-messages-streaming-with-tools.ts).
// On the client, qlaud-client.ts intentionally does NOT await the
// onToolDispatchStart handler, so concurrent tool_use blocks run their
// executeTool + safeSubmit in parallel. The system prompt explicitly
// tells the model to batch independent reads in one assistant message
// — the infrastructure rewards that pattern.

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
  /** Auto-approve mode forwarded to executeTool. Subagents inherit
   *  the parent's mode unless overridden. See lib/settings.ts for
   *  the yolo/smart/strict semantics. */
  autoApprove?: import('./settings').AutoApproveMode;
  /** When true, snapshot working-tree state at turn start and commit
   *  the agent's writes when the turn ends. Skipped on non-git folders,
   *  pre-existing dirty trees, and special git states (merge/rebase/
   *  detached). Subagents inherit. */
  autoCommit?: boolean;
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

  // Doom-loop guard. Sliding window of the last DOOM_WINDOW dispatches
  // (name + JSON-keyed input). If the next dispatch makes all three
  // identical, surface an approval prompt instead of running it again.
  // Pattern from opencode's session/processor.ts — saves the user
  // from infinite-bash situations when a stream gets wedged or the
  // model loops on a failing tool. Per-run scoped: a fresh window for
  // every user turn, since "stuck" only makes sense within one run.
  const DOOM_WINDOW = 3;
  type DispatchKey = { name: string; inputKey: string };
  const recentDispatches: DispatchKey[] = [];

  let totalInput = 0;
  let totalOutput = 0;
  let currentIteration = 1;

  // Auto-commit checkpoint: snapshot the working-tree state at run
  // start so we know whether it was clean before any agent action.
  // We only commit if cleanAtStart was true (don't mix WIP with the
  // agent's edits). Subagents skip — the parent run owns the
  // checkpoint surface; otherwise nested subagent commits would
  // produce a noisy log.
  const wantsCheckpoint = !!opts.autoCommit && !!opts.workspace && !opts.isSubagent;
  let preTurnSnapshot: import('./git-checkpoint').Snapshot | null = null;
  let userTurnSummary = ''; // first text-block of the user turn — feeds the commit subject
  // Track whether the agent successfully wrote/edited any file this
  // run. Pure-read turns (read_file / grep / browser) skip the
  // commit so we don't pollute the log with empty-diff entries.
  let didWriteFiles = false;
  if (wantsCheckpoint) {
    const { snapshot } = await import('./git-checkpoint');
    preTurnSnapshot = await snapshot(opts.workspace as string);
    // Pull the user's text from the content blocks; first text wins.
    for (const b of opts.content) {
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        userTurnSummary = b.text;
        break;
      }
    }
  }

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
          git: env.git
            ? {
                branch: env.git.branch,
                dirty: env.git.dirty,
                recent_commits: env.git.recentCommits,
                remote: env.git.remote,
              }
            : null,
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
            autoApprove: opts.autoApprove,
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
        // SSE events should arrive in order (onToolUse before
        // onToolDispatchStart for the same tool_use_id), but on a
        // congested network the bytes can split across packets and
        // the dispatch event lands first. Poll briefly before
        // surfacing "lost the tool input" — saves the user from
        // false errors on flaky wifi / mobile radio handoffs.
        const stash = await waitForPending(pending, info.toolUseId, 500);
        if (!stash) {
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

        // Doom-loop check: would this make DOOM_WINDOW identical
        // dispatches in a row? Ask the user before running. On reject,
        // POST a tool_result that tells the model the loop was halted
        // so it replans instead of re-emitting the same call.
        const inputKey = stableInputKey(stash.input);
        const dispatchKey: DispatchKey = { name: stash.name, inputKey };
        const wouldDoomLoop =
          recentDispatches.length >= DOOM_WINDOW - 1 &&
          recentDispatches
            .slice(-(DOOM_WINDOW - 1))
            .every(
              (d) => d.name === dispatchKey.name && d.inputKey === dispatchKey.inputKey,
            );
        if (wouldDoomLoop) {
          const req: ApprovalRequest = {
            kind: 'doom_loop',
            toolName: stash.name,
            inputPreview: previewInput(stash.input),
            repeats: DOOM_WINDOW,
          };
          opts.onEvent({ type: 'approval_pending', id: info.toolUseId, request: req });
          const decision = await opts.onApproval(info.toolUseId, req);
          opts.onEvent({ type: 'approval_resolved', id: info.toolUseId, decision });
          if (decision === 'reject') {
            recentDispatches.length = 0;
            await safeSubmit(opts.threadId, info.toolUseId, {
              output:
                'Halted by user: the agent was about to repeat this exact tool call for the third time in a row. Stop and try a different approach — the previous attempts did not change the situation.',
              isError: true,
            });
            return;
          }
          // User chose to continue; clear the window so a single
          // approved repeat doesn't immediately re-trigger on the next
          // dispatch. The model gets one fresh shot before we ask again.
          recentDispatches.length = 0;
        }
        recentDispatches.push(dispatchKey);
        if (recentDispatches.length > DOOM_WINDOW) recentDispatches.shift();

        try {
          const result: ToolResult = await executeTool(call, {
            workspace: opts.workspace,
            autoApprove: opts.autoApprove,
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
        // Note: bash also mutates files (compiles, generates, scaffolds)
        // but auto-commit only triggers on tracked-by-the-agent writes
        // because counting bash here would commit on every `pnpm install`
        // (mutates node_modules, lockfile etc.). git-checkpoint's own
        // `git status --porcelain` post-check is the truth source — if
        // bash wrote anything tracked, the porcelain output picks it up.
        if (
          !info.isError &&
          (info.name === 'write_file' || info.name === 'edit_file')
        ) {
          didWriteFiles = true;
        }
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
          costUsd: info.costUsd,
          seq: info.seq,
        });
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    opts.onEvent({ type: 'error', message: msg });
  }

  // Auto-commit after the run wrapped. Always uses `git status
  // --porcelain` as the truth — `didWriteFiles` is just an early
  // bail to skip the shell calls when nothing wrote, but bash-mutated
  // files (formatters, codegen) still count if porcelain sees them.
  if (wantsCheckpoint && preTurnSnapshot && didWriteFiles) {
    try {
      const { commitTurn } = await import('./git-checkpoint');
      const result = await commitTurn({
        workspace: opts.workspace as string,
        snapshot: preTurnSnapshot,
        summary: userTurnSummary,
        body: `Thread: ${opts.threadId}\nModel: ${opts.model}`,
      });
      opts.onEvent({ type: 'checkpoint', result });
    } catch (e) {
      // Don't fail the whole turn over a checkpoint issue. Surface
      // as a skip event so the user sees something happened.
      opts.onEvent({
        type: 'checkpoint',
        result: {
          kind: 'skipped',
          reason: e instanceof Error ? e.message : 'checkpoint failed',
        },
      });
    }
  }

  // Drop any leftover approval handles — covers abort mid-tool.
  void currentIteration; // currently informational; UI may use later
}

/** Cheap key for a tool input, used by the doom-loop detector to
 *  decide whether two dispatches are "the same call." A doom-loop is
 *  the model emitting the same call verbatim, so plain JSON.stringify
 *  (preserving key order) catches it; we don't need full canonical
 *  ordering. Falls back to String(input) on serialization failure
 *  (cyclic refs shouldn't happen for tool inputs but the detector
 *  must not crash the agent if they do). */
function stableInputKey(input: unknown): string {
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

/** Compact one-line-ish preview of a tool input for the doom-loop
 *  approval card. Truncates to keep the card scannable. */
function previewInput(input: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(input, null, 2);
  } catch {
    s = String(input);
  }
  if (s.length > 400) s = s.slice(0, 400) + '\n…';
  return s;
}

/** Poll the pending-tool-use Map for a short window before giving
 *  up. Covers the (rare) case where the SSE byte stream splits the
 *  tool_use block's bytes across a packet boundary so onToolUse
 *  fires AFTER onToolDispatchStart for the same id. Returns the
 *  stashed input if found within the timeout, undefined otherwise. */
async function waitForPending<T>(
  map: Map<string, T>,
  id: string,
  timeoutMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = map.get(id);
    if (v) return v;
    await new Promise<void>((r) => setTimeout(r, 25));
  }
  return undefined;
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
  } catch (e) {
    // We DO swallow — the parked dispatcher times out server-side
    // after 60s and the model sees an upstream timeout. But we used
    // to swallow silently, which made it impossible to tell the
    // difference between "all good" and "every tool result is
    // failing to post" (CORS, auth churn, network down). Log loud
    // so devtools / PostHog has a trail; ship to analytics so we
    // can spot patterns across users.
    const reason = e instanceof Error ? e.message : 'unknown';
    console.warn(
      `[agent] submitToolResult failed for tool_use_id=${toolUseId}: ${reason}`,
    );
    void import('./analytics').then((a) =>
      a.posthog.capture('tool_result_post_failed', {
        thread_id: threadId,
        tool_use_id: toolUseId,
        reason,
      }),
    );
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
  autoApprove?: import('./settings').AutoApproveMode;
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
      autoApprove: args.autoApprove,
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
