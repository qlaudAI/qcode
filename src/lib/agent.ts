// qcode's agent loop.
//
// Sends the user's turn, streams the model's response, executes any
// tool calls in qcode (read_file, list_files), feeds tool_results
// back, and repeats until the model returns a non-tool stop_reason
// or we hit the safety cap (MAX_LOOPS).
//
// The chat surface drives this via runAgent(); each callback fires
// during streaming so the UI updates token-by-token, tool-by-tool.
//
// Approval-gated tools (write_file, bash, run_command) are NOT
// included in v0. They land next sprint behind a confirm UI.

import {
  streamMessage,
  type ContentBlock,
  type Message,
} from './qlaud-client';
import {
  executeTool,
  READ_TOOLS,
  type ToolCall,
  type ToolResult,
} from './tools';

const SYSTEM_PROMPT = `You are qcode, a multi-model coding agent running on the user's desktop.

Style:
- Be direct. Show, don't tell. Match the user's terseness.
- When the user asks about their code, use list_files first to understand the structure, then read_file to examine specifics. Don't guess at file contents.
- When proposing changes, describe them in plain prose with concrete file paths and approximate line ranges. (File-write tools aren't available yet — that's the next release.)
- Never invent file paths or function names. If you need to know something, use the read tools.

Safety:
- You can only READ the user's filesystem. Writes, edits, and shell commands are not yet supported in this version.
- If the user asks for something that requires writing, explain what you would do and offer to dictate the edits for them to apply manually.`;

const MAX_LOOPS = 8; // hard ceiling; protects against pathological agent behavior

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
};

/** Run a full agent turn. Streams events until stop_reason !== "tool_use". */
export async function runAgent(opts: RunAgentOpts): Promise<Message[]> {
  // The conversation grows as tools are executed; we mutate `messages`
  // and return the final list to the caller.
  const messages: Message[] = [...opts.history];
  // Without a workspace, tools can't resolve paths — degrade
  // gracefully to a tools-disabled chat.
  const tools = opts.workspace ? READ_TOOLS : undefined;

  for (let turn = 0; turn < MAX_LOOPS; turn++) {
    opts.onEvent({ type: 'turn_start', turn });

    // Buffer this turn's assistant content blocks so we can append
    // a single, well-formed assistant message to history at the end
    // of the turn (Anthropic requires assistant message be one entry).
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
          // The text block (if any) ends here logically; finalize it.
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

    // If the model didn't request a tool call, we're done.
    if (stopReason !== 'tool_use') {
      opts.onEvent({ type: 'finished', stopReason, turns: turn + 1 });
      return messages;
    }

    // Execute every tool_use block from this turn, in order.
    const toolUseBlocks = assistantBlocks.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_use' }> =>
        b.type === 'tool_use',
    );
    const toolResults: ContentBlock[] = [];
    for (const tu of toolUseBlocks) {
      // Enforce the workspace invariant — without one, every read
      // tool will fail. Surface an explicit error result so the
      // model can adjust rather than retry the same call.
      if (!opts.workspace) {
        const result: ToolResult = {
          tool_use_id: tu.id,
          content:
            'No workspace is open. The user must open a folder before file tools work. Tell them to use ⌘O / "Open Folder".',
          is_error: true,
        };
        opts.onEvent({
          type: 'tool_done',
          id: tu.id,
          content: result.content,
          isError: true,
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: result.content,
          is_error: true,
        });
        continue;
      }
      const call: ToolCall = { id: tu.id, name: tu.name, input: tu.input };
      const result = await executeTool(call, { workspace: opts.workspace });
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
    // Loop continues — model gets the tool results and decides what to
    // say next.
  }

  opts.onEvent({
    type: 'error',
    message: `Agent hit the ${MAX_LOOPS}-turn safety limit. Try a more focused question, or break the task into smaller steps.`,
  });
  return messages;
}
