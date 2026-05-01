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

import {
  streamMessage,
  type ContentBlock,
  type Message,
} from './qlaud-client';
import {
  ALL_TOOLS,
  executeTool,
  type ApprovalDecision,
  type ApprovalRequest,
  type ToolCall,
  type ToolResult,
} from './tools';

const SYSTEM_PROMPT = `You are qcode, a multi-model coding agent running on the user's desktop.

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

const MAX_LOOPS = 16; // hard ceiling; with write tools, real tasks need more turns

export type AgentEvent =
  | { type: 'turn_start'; turn: number }
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
      type: 'tool_done';
      id: string;
      content: string;
      isError: boolean;
    }
  | {
      type: 'finished';
      stopReason?: string;
      turns: number;
    }
  | { type: 'error'; message: string };

export type RunAgentOpts = {
  model: string;
  workspace: string | null;
  /** Prior conversation. Includes the just-sent user turn at the end. */
  history: Message[];
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
  const tools = opts.workspace ? ALL_TOOLS : undefined;

  for (let turn = 0; turn < MAX_LOOPS; turn++) {
    opts.onEvent({ type: 'turn_start', turn });

    const assistantBlocks: ContentBlock[] = [];
    let currentText = '';
    let stopReason: string | undefined;

    try {
      await streamMessage({
        model: opts.model,
        system: SYSTEM_PROMPT,
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
        onMessageStop: (info) => {
          if (currentText) {
            assistantBlocks.push({ type: 'text', text: currentText });
            currentText = '';
          }
          stopReason = info.stopReason;
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown';
      opts.onEvent({ type: 'error', message: msg });
      return messages;
    }

    messages.push({ role: 'assistant', content: assistantBlocks });

    if (stopReason !== 'tool_use') {
      opts.onEvent({ type: 'finished', stopReason, turns: turn + 1 });
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
