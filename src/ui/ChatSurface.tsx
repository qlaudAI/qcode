import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowUp,
  BookOpen,
  Download,
  FileText,
  FolderOpen,
  Paperclip,
  RotateCcw,
  Sparkles,
  Square,
  X,
} from 'lucide-react';

import { isTauri } from '../lib/tauri';
import { posthog } from '../lib/analytics';

import { runThreadAgent, type AgentEvent } from '../lib/agent';
import { buildAttachmentContext } from '../lib/attachments';
import { fetchBalance } from '../lib/billing';
import { cn } from '../lib/cn';
import { type AttachedImage } from '../lib/images';
import {
  filesFromDrop,
  filesFromPaste,
  readUploadedFile,
  type AttachedDocument,
  type AttachedFile,
  type AttachedText,
} from '../lib/uploads';
import { getProjectMemory, type ProjectMemory } from '../lib/memory';
import { MODELS } from '../lib/models';
import { planToAgentHandoff, setLastMode } from '../lib/mode-tracking';
import { getSettings } from '../lib/settings';
import type { ContentBlock, Message } from '../lib/qlaud-client';
import {
  getRemoteThreadMessages,
  type CompactionInfo,
} from '../lib/threads';
import { QlaudMark } from './QlaudMark';
import type { ApprovalDecision, ApprovalRequest } from '../lib/tools';
import {
  getCurrentWorkspace,
  listAllFiles,
} from '../lib/workspace';
import { ApprovalCard } from './ApprovalCard';
import { Markdown } from './Markdown';
import { MentionMenu, getMentionResults } from './MentionMenu';
import { ToolCallCard, type ToolCallView } from './ToolCallCard';

// Each "block" rendered in the chat is the smallest UI unit. The
// agent loop emits a stream of events that `handleEvent` translates
// into block mutations.
type RenderBlock =
  | {
      type: 'user_text';
      text: string;
      images?: AttachedImage[];
      documents?: AttachedDocument[];
      textFiles?: AttachedText[];
    }
  | { type: 'assistant_text'; text: string; skill?: { slug: string; role: string } | null; resolvedModel?: string }
  | { type: 'tool'; call: ToolCallView }
  | {
      type: 'approval';
      id: string;
      request: ApprovalRequest;
      resolved?: 'allow' | 'reject';
    }
  | {
      type: 'usage';
      inputTokens: number;
      outputTokens: number;
      /** USD charged for the turn. Computed from balance delta after
       *  the turn ends; null when we couldn't read balance (offline,
       *  rate-limited, etc.). */
      costUsd: number | null;
      model: string;
      durationMs: number;
    }
  | {
      type: 'error';
      /** Structured presentation — title + body + optional action.
       *  See mapError() for the catalog of mapped codes; unmapped
       *  errors fall through to a generic "something went wrong"
       *  with the raw code so support can decode it. */
      presentation: ErrorPresentation;
      /** Original send arguments so the retry button can re-invoke
       *  send() with the exact same input + attachments. Set null
       *  once the user has retried (or sent a new turn) so we don't
       *  show a stale Retry. */
      retry: {
        text: string;
        images: AttachedImage[];
        documents: AttachedDocument[];
        textFiles: AttachedText[];
        attached: string[];
      } | null;
    }
  | {
      type: 'subagent';
      /** Tool-use id of the parent's `task` call that spawned this. */
      parentToolUseId: string;
      /** User-facing description from the parent's task input. */
      description: string;
      status: 'running' | 'done' | 'error';
      /** Final text the subagent returned. Populated on subagent_done. */
      summary: string | null;
    };

// Pending approval resolvers, keyed by tool_use id. The agent loop
// awaits one of these promises; the UI fulfills it on click.
type PendingResolver = (decision: ApprovalDecision) => void;

// Sample prompts for the empty-state. Each one is calibrated to
// secretly invoke a specific engineer on the team — the user
// describes a goal in their own words, the server-side classifier
// auto-routes to the right specialist (Staff for plans, Reviewer
// for bugs, etc.), and the green-checkmark UX makes the team feel
// alive. The user never has to learn a slash command.
const SAMPLE_PROMPTS = [
  'Plan a refactor of the auth flow',          // → Staff Engineer
  'Review my recent changes for bugs',         // → Code Reviewer
  'Audit this for OWASP issues',               // → Security
  'Build a 30-second launch video with Remotion', // → Marketing
];

// Web build has no workspace + no tools — the engineers can't
// actually grep / run tests / deploy. Frame prompts that play to
// chat-only strengths: paste-in code review, conceptual questions,
// architecture discussions.
const WEB_SAMPLE_PROMPTS = [
  'Review this code for bugs (paste it after)',
  'Plan how I should structure my next API',
  'Audit this snippet for OWASP issues (paste it after)',
  'Explain the tradeoffs of App Router vs Pages Router',
];

export function ChatSurface({
  model,
  mode = 'agent',
  threadId,
  ensureThreadId,
  onTurnLanded,
  hasWorkspace,
  onOpenFolder,
}: {
  model: string;
  mode?: 'agent' | 'plan';
  /** Active qlaud thread id, or null when the user hasn't opened one
   *  yet. The first send creates a thread on demand via
   *  ensureThreadId so the user doesn't pay a new-chat round-trip
   *  unless they actually type something. */
  threadId: string | null;
  /** Lazily provision a thread id. ChatSurface calls this before
   *  every send; App.tsx returns the active id or creates a new
   *  remote thread + updates the sidebar. */
  ensureThreadId: () => Promise<string>;
  /** Fired after a turn completes so App.tsx can refresh the
   *  cached summary's title (first turn) and updatedAt. The user's
   *  prompt text is passed as `userText` for title derivation. */
  onTurnLanded?: (info: { userText: string | null; threadId: string }) => void;
  /** Drives the empty-state onboarding branch — when false the
   *  EmptyState pushes the user to open a folder before sending. */
  hasWorkspace: boolean;
  /** Triggered by the EmptyState's primary CTA on first launch.
   *  App.tsx owns the picker + workspace state. */
  onOpenFolder: () => void | Promise<void>;
}) {
  const m = MODELS.find((x) => x.slug === model);
  const [blocks, setBlocks] = useState<RenderBlock[]>([]);
  const [compaction, setCompaction] = useState<CompactionInfo | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attached, setAttached] = useState<string[]>([]);
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [documents, setDocuments] = useState<AttachedDocument[]>([]);
  const [textFiles, setTextFiles] = useState<AttachedText[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [memory, setMemory] = useState<ProjectMemory | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const approvalsRef = useRef<Map<string, PendingResolver>>(new Map());

  // Lazy-load the workspace file index on first focus into the
  // composer. Cheaper than indexing on mount when the user might
  // never @-mention; still fast enough that the first '@' has the
  // list ready.
  const loadFiles = useMemo(
    () => () => {
      if (files.length > 0) return;
      const ws = getCurrentWorkspace();
      if (!ws) return;
      void listAllFiles(ws.path).then(setFiles);
    },
    [files.length],
  );

  // Auto-scroll to bottom on any block change.
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [blocks]);

  // Load project memory (qcode.md / CLAUDE.md) once per workspace so
  // the empty state can show what context the model will pick up.
  useEffect(() => {
    const ws = getCurrentWorkspace();
    if (!ws) {
      setMemory(null);
      return;
    }
    let cancelled = false;
    void getProjectMemory(ws.path).then((m) => {
      if (!cancelled) setMemory(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Rehydrate when the active thread changes. qlaud owns the
  // canonical history — we GET the message list and convert back
  // into render blocks.
  //
  // Busy guard: when the user sends a turn against a brand-new
  // session, ensureThreadId provisions a remote thread mid-send and
  // bumps threadId from null to a real id. We don't want to fetch
  // (and overwrite the just-pushed user_text block) in that race —
  // the new thread is empty server-side anyway. Skip the load while
  // a send is in flight; the next thread-switch covers it.
  //
  // Also skip if we've already loaded this exact id this session
  // (covers re-renders that aren't thread-switches, like model
  // changes propagating through props).
  const lastLoadedRef = useRef<string | null>(null);
  useEffect(() => {
    // Order matters: check busy FIRST. When the user sends from a
    // brand-new thread, the sequence is setBlocks([user]) →
    // setBusy(true) → ensureThreadId() → setCurrentId(t.id). The
    // setCurrentId triggers a prop change here. Without the busy
    // gate first, the (!threadId) wipe path was racing against
    // ensureThreadId returning — wiping the user's just-sent bubble
    // a few ms before threadId arrived. Symptom: "I keep sending hi
    // and after sending it disappears."
    if (busy) return;
    if (!threadId) {
      setBlocks([]);
      lastLoadedRef.current = null;
      return;
    }
    if (lastLoadedRef.current === threadId) return;
    lastLoadedRef.current = threadId;
    let cancelled = false;
    void getRemoteThreadMessages(threadId)
      .then((history) => {
        if (cancelled) return;
        setBlocks(historyToBlocks(history.messages));
        setCompaction(history.compaction);
      })
      .catch(() => {
        // 404 (deleted from another device) / network — leave blocks
        // empty; the user can still send a fresh turn.
        if (cancelled) return;
        setBlocks([]);
        setCompaction(null);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, busy]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      // Resolve any in-flight approvals as 'reject' so the loop can
      // unwind cleanly when the user navigates away.
      for (const resolve of approvalsRef.current.values()) resolve('reject');
      approvalsRef.current.clear();
    },
    [],
  );

  function retry(retryInputs: {
    text: string;
    images: AttachedImage[];
    documents: AttachedDocument[];
    textFiles: AttachedText[];
    attached: string[];
  }) {
    // Mark every still-retryable error block as resolved so we don't
    // show a stale Retry; the new turn either succeeds or pushes its
    // own fresh error block.
    setBlocks((bs) =>
      bs.map((b) =>
        b.type === 'error' && b.retry ? { ...b, retry: null } : b,
      ),
    );
    setInput(retryInputs.text);
    setImages(retryInputs.images);
    setDocuments(retryInputs.documents);
    setTextFiles(retryInputs.textFiles);
    setAttached(retryInputs.attached);
    // Defer one tick so the state setters land before send() reads
    // them. send() reads from the latest closure (`text` arg + the
    // current state snapshot for images/attached), so we pass text
    // explicitly and trust the state to be settled by the next paint.
    queueMicrotask(() => {
      void send(retryInputs.text);
    });
  }

  function decide(id: string, decision: ApprovalDecision) {
    const resolve = approvalsRef.current.get(id);
    if (!resolve) return;
    approvalsRef.current.delete(id);
    setBlocks((bs) =>
      bs.map((b) =>
        b.type === 'approval' && b.id === id ? { ...b, resolved: decision } : b,
      ),
    );
    resolve(decision);
  }

  async function send(text: string) {
    const userMsg = text.trim();
    // Allow send when there are attachments even with empty text
    // (e.g. dropping a screenshot with the implicit "what's wrong
    // here?" intent). Block when nothing at all is queued.
    if (
      !userMsg &&
      images.length === 0 &&
      documents.length === 0 &&
      textFiles.length === 0 &&
      attached.length === 0
    )
      return;
    if (busy) return;
    setInput('');
    setError(null);

    // Snapshot exactly what the user is sending so the inline error
    // block (if the turn fails) can offer a one-click retry with the
    // identical inputs. Captured before any of the state-clearing
    // setX([])s below.
    const retryInputs = {
      text: userMsg,
      images: [...images],
      documents: [...documents],
      textFiles: [...textFiles],
      attached: [...attached],
    };

    const workspace = getCurrentWorkspace();
    // Plan → Agent handoff: if the user just flipped the mode toggle
    // from plan to agent on this thread, inject a context note so
    // the model knows it should EXECUTE the plan it produced earlier
    // (rather than starting a fresh investigation). No-op for first
    // turn / agent-only threads / agent → plan transitions.
    const handoff = planToAgentHandoff(threadId, mode);
    let modelText = userMsg || 'Please look at the attached.';
    let displayText = userMsg;
    if (handoff) {
      modelText = handoff + modelText;
    }
    if (workspace && attached.length > 0) {
      const ctx = await buildAttachmentContext(workspace.path, attached);
      if (ctx.contextBlock) {
        modelText = `${ctx.contextBlock}\n\n${modelText}`;
        const files = ctx.loaded.map((l) => l.path).join(', ');
        displayText =
          ctx.loaded.length > 0
            ? `${userMsg}\n\n_with ${ctx.loaded.length} file${ctx.loaded.length === 1 ? '' : 's'}: ${files}_`
            : userMsg;
      }
      setAttached([]);
    }

    // Inline any attached text/code files into the user message.
    // Cheap, works on every routed model, no special block type.
    // Format: fenced with the filename so the model can cite it back.
    if (textFiles.length > 0) {
      const fences = textFiles
        .map(
          (t) =>
            `--- file: ${t.name} ---\n${t.text}\n--- end of ${t.name} ---`,
        )
        .join('\n\n');
      modelText = `${fences}\n\n${modelText}`;
    }

    // Build the model-side content blocks: image + document blocks
    // first (Anthropic best practice — vision content before the
    // text referring to it), then the text. Display-side bubble gets
    // chip rows for each kind + the user's prose underneath.
    const userContent: ContentBlock[] = [];
    for (const img of images) {
      userContent.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mediaType,
          data: img.base64,
        },
      });
    }
    for (const doc of documents) {
      userContent.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: doc.mediaType,
          data: doc.base64,
        },
        title: doc.name,
      });
    }
    userContent.push({ type: 'text', text: modelText });

    const sentImages = images.length > 0 ? images : undefined;
    const sentDocuments = documents.length > 0 ? documents : undefined;
    const sentTextFiles = textFiles.length > 0 ? textFiles : undefined;
    setImages([]);
    setDocuments([]);
    setTextFiles([]);

    setBlocks((b) => [
      ...b,
      {
        type: 'user_text',
        text: displayText,
        images: sentImages,
        documents: sentDocuments,
        textFiles: sentTextFiles,
      },
    ]);
    // Telemetry — metadata only, no chat content. Lets us see model
    // mix, attachment usage, and where in the funnel users drop off.
    posthog.capture('turn_sent', {
      model,
      mode,
      has_workspace: !!workspace,
      image_count: sentImages?.length ?? 0,
      document_count: sentDocuments?.length ?? 0,
      text_file_count: sentTextFiles?.length ?? 0,
      attached_workspace_files: retryInputs.attached.length,
      message_chars: userMsg.length,
    });
    setBusy(true);
    abortRef.current = new AbortController();

    // Snapshot wallet balance + start time for the cost-from-delta
    // calc on the usage pill. qlaud doesn't ship cost on the SSE
    // stream yet — the balance delta is the source of truth.
    const startMs = Date.now();
    const preBalance = (await fetchBalance())?.balanceUsd ?? null;
    let lastUsage: { inputTokens: number; outputTokens: number } | null = null;

    try {
      // Lazily provision the thread on first send. App.tsx returns
      // the active id when there is one, otherwise creates a remote
      // thread and updates the sidebar before resolving.
      const id = await ensureThreadId();

      await runThreadAgent({
        threadId: id,
        model,
        mode,
        workspace: workspace?.path ?? null,
        content: userContent,
        // Read at send time so toggling the setting takes effect on
        // the very next turn without a remount.
        enableConnectors: getSettings().enableConnectors,
        signal: abortRef.current.signal,
        onEvent: (e) => {
          if (e.type === 'finished') lastUsage = e.usage;
          handleEvent(e, setBlocks);
        },
        onApproval: (toolUseId, _request) =>
          new Promise<ApprovalDecision>((resolve) => {
            approvalsRef.current.set(toolUseId, resolve);
          }),
      });

      onTurnLanded?.({ userText: userMsg || null, threadId: id });
      // Remember which mode this turn ran in so the next send can
      // detect a plan → agent transition.
      setLastMode(id, mode);

      // After the turn ends, fetch the new balance and append a
      // usage block. Balance delta is the authoritative cost (qlaud's
      // markup included); token counts come from the SSE stream.
      if (lastUsage) {
        const postBalance = (await fetchBalance())?.balanceUsd ?? null;
        const usage: { inputTokens: number; outputTokens: number } = lastUsage;
        const cost =
          preBalance != null && postBalance != null
            ? Math.max(0, preBalance - postBalance)
            : null;
        setBlocks((b) => [
          ...b,
          {
            type: 'usage',
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            costUsd: cost,
            model,
            durationMs: Date.now() - startMs,
          },
        ]);
        posthog.capture('turn_completed', {
          model,
          mode,
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cost_usd: cost,
          duration_ms: Date.now() - startMs,
        });
      }
    } catch (e) {
      const code = e instanceof Error ? e.message : 'unknown';
      posthog.capture('turn_failed', { model, mode, code });
      // Inline error block with retry context. Image-error / network
      // banner state stays for transient toasts that don't make sense
      // to "retry" (image too big, etc.).
      setBlocks((b) => [
        ...b,
        {
          type: 'error',
          presentation: mapError(code),
          retry: retryInputs,
        },
      ]);
    } finally {
      setBusy(false);
      abortRef.current = null;
      // Drop any leftover resolvers — covers the case where streaming
      // bails before the loop reaches the awaiting Promise.
      for (const resolve of approvalsRef.current.values()) resolve('reject');
      approvalsRef.current.clear();
    }
  }

  function stop() {
    abortRef.current?.abort();
    for (const resolve of approvalsRef.current.values()) resolve('reject');
    approvalsRef.current.clear();
  }

  const empty = blocks.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-8">
          {empty ? (
            <EmptyState
              modelLabel={m?.label ?? model}
              provider={m?.provider}
              memory={memory}
              hasWorkspace={hasWorkspace}
              onOpenFolder={onOpenFolder}
              onPick={(s) => setInput(s)}
            />
          ) : (
            <div className="flex flex-col gap-5">
              {compaction && (
                <CompactionIndicator
                  summary={compaction.summary}
                  summarizedThroughSeq={compaction.summarizedThroughSeq}
                />
              )}
              {blocks.map((b, i) => (
                <BlockRow
                  key={i}
                  block={b}
                  busy={busy && i === blocks.length - 1}
                  onAllow={() =>
                    b.type === 'approval' ? decide(b.id, 'allow') : undefined
                  }
                  onReject={() =>
                    b.type === 'approval' ? decide(b.id, 'reject') : undefined
                  }
                  onRetry={() => {
                    if (b.type === 'error' && b.retry) retry(b.retry);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="border-t border-primary/30 bg-primary/5 px-4 py-2 text-center text-xs text-primary">
          {error}
        </div>
      )}

      <Composer
        value={input}
        onChange={setInput}
        modelLabel={m?.label ?? model}
        onSend={send}
        onStop={stop}
        busy={busy}
        attached={attached}
        images={images}
        files={files}
        onLoadFiles={loadFiles}
        onAttach={(p) =>
          setAttached((prev) => (prev.includes(p) ? prev : [...prev, p]))
        }
        onDetach={(p) => setAttached((prev) => prev.filter((x) => x !== p))}
        documents={documents}
        textFiles={textFiles}
        onAttachUpload={(f) => {
          if (f.kind === 'image') setImages((prev) => [...prev, f]);
          else if (f.kind === 'document') setDocuments((prev) => [...prev, f]);
          else setTextFiles((prev) => [...prev, f]);
        }}
        onDetachUpload={(id) => {
          setImages((prev) => prev.filter((x) => x.id !== id));
          setDocuments((prev) => prev.filter((x) => x.id !== id));
          setTextFiles((prev) => prev.filter((x) => x.id !== id));
        }}
        onImageError={(msg) => setError(msg)}
      />
    </div>
  );
}

// ─── Event router (mutates render blocks as the agent loop runs) ───

function handleEvent(
  e: AgentEvent,
  setBlocks: React.Dispatch<React.SetStateAction<RenderBlock[]>>,
): void {
  setBlocks((blocks) => {
    switch (e.type) {
      case 'turn_start':
        // Each new model turn opens with an empty assistant_text
        // block. The first text delta fills it; if the model goes
        // straight to a tool call we don't render the empty block.
        return [...blocks, { type: 'assistant_text', text: '' }];

      case 'skill_resolved': {
        // Stamp the active engineer onto the most-recent assistant
        // block so the attribution renders above their answer. No-op
        // when no assistant block exists yet (skill_resolved comes
        // BEFORE turn_start for the first turn — we'll buffer it
        // by lazy-attaching at next turn_start, but for the common
        // case the empty assistant_text is already there).
        const out = [...blocks];
        const lastIdx = out.length - 1;
        const last = out[lastIdx];
        if (last?.type === 'assistant_text') {
          out[lastIdx] = {
            ...last,
            skill: e.skill,
            resolvedModel: e.resolvedModel,
          };
        } else {
          out.push({
            type: 'assistant_text',
            text: '',
            skill: e.skill,
            resolvedModel: e.resolvedModel,
          });
        }
        return out;
      }

      case 'text': {
        const out = [...blocks];
        const last = out[out.length - 1];
        if (last?.type === 'assistant_text') {
          out[out.length - 1] = { ...last, text: last.text + e.text };
        } else {
          out.push({ type: 'assistant_text', text: e.text });
        }
        return out;
      }

      case 'tool_call':
        return [
          ...blocks,
          {
            type: 'tool',
            call: {
              id: e.id,
              name: e.name,
              input: e.input,
              status: 'running',
            },
          },
        ];

      case 'tool_done':
        return blocks.map((b) => {
          if (b.type !== 'tool' || b.call.id !== e.id) return b;
          return {
            type: 'tool',
            call: {
              ...b.call,
              status: e.isError ? 'error' : 'done',
              output: e.content,
            },
          };
        });

      case 'tool_progress':
        // Live update: replace the tool block's output mid-flight.
        // Status stays 'running' until tool_done fires.
        return blocks.map((b) => {
          if (b.type !== 'tool' || b.call.id !== e.id) return b;
          return {
            type: 'tool',
            call: { ...b.call, output: e.partial },
          };
        });

      case 'approval_pending':
        return [
          ...blocks,
          { type: 'approval', id: e.id, request: e.request },
        ];

      case 'approval_resolved':
        return blocks.map((b) =>
          b.type === 'approval' && b.id === e.id
            ? { ...b, resolved: e.decision }
            : b,
        );

      case 'subagent_start':
        return [
          ...blocks,
          {
            type: 'subagent',
            parentToolUseId: e.parentToolUseId,
            description: e.description,
            status: 'running',
            summary: null,
          },
        ];

      case 'subagent_done':
        return blocks.map((b) =>
          b.type === 'subagent' && b.parentToolUseId === e.parentToolUseId
            ? {
                ...b,
                status: e.isError ? 'error' : 'done',
                summary: e.summary,
              }
            : b,
        );

      case 'finished':
      case 'error':
      default:
        return blocks;
    }
  });

  // subagent_event lives outside the setBlocks closure: it recurses
  // by calling handleEvent again on the inner event, which fires its
  // own setBlocks. Done this way (rather than inside the switch) so
  // each inner event is its own state transition — feels exactly like
  // the parent's event handling, just with a Subagent header above.
  if (e.type === 'subagent_event') {
    handleEvent(e.inner, setBlocks);
  }
}

// Convert a persisted Anthropic-shape conversation back into the
// chat surface's render blocks. Used when the user clicks a thread
// in the sidebar — we need to recreate the visible state without
// re-streaming. Tool calls get reconstructed from the assistant's
// tool_use blocks paired with the next user message's tool_result
// blocks (Anthropic protocol pairs them by tool_use_id).
function historyToBlocks(history: Message[]): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  // Index tool_results by id so we can attach output to its tool_use.
  const resultById = new Map<
    string,
    { content: string; isError: boolean }
  >();
  for (const msg of history) {
    if (msg.role !== 'user') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_result') {
        resultById.set(block.tool_use_id, {
          content: block.content,
          isError: !!block.is_error,
        });
      }
    }
  }
  for (const msg of history) {
    if (msg.role === 'user') {
      const text = msg.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      // Reconstruct attached images from the persisted content
      // blocks. Synthesize a fresh in-memory id (the original
      // session's id wasn't persisted) and rebuild the data URL
      // from media_type + base64.
      const imgs: AttachedImage[] = [];
      for (const block of msg.content) {
        if (block.type !== 'image') continue;
        const id =
          'img_replay_' +
          Math.random().toString(36).slice(2, 10) +
          Date.now().toString(36);
        imgs.push({
          id,
          name: 'attachment',
          mediaType: block.source.media_type,
          base64: block.source.data,
          thumbUrl: `data:${block.source.media_type};base64,${block.source.data}`,
          bytes: 0,
        });
      }
      if (text || imgs.length > 0) {
        blocks.push({
          type: 'user_text',
          text,
          images: imgs.length > 0 ? imgs : undefined,
        });
      }
    } else {
      for (const block of msg.content) {
        if (block.type === 'text') {
          blocks.push({ type: 'assistant_text', text: block.text });
        } else if (block.type === 'tool_use') {
          const r = resultById.get(block.id);
          blocks.push({
            type: 'tool',
            call: {
              id: block.id,
              name: block.name,
              input: block.input,
              status: r ? (r.isError ? 'error' : 'done') : 'done',
              output: r?.content,
            },
          });
        }
      }
    }
  }
  return blocks;
}

// Friendly, actionable error presentation. Beats "Upstream 503"
// every time — the goal is the user knows WHY it failed and WHAT
// to do next, not just that something broke. Ordered roughly by
// frequency in the wild.
type ErrorPresentation = {
  title: string;
  body?: string;
  /** Optional secondary action when a retry button isn't the right
   *  fix (e.g. "Top up your wallet" for cap_hit). Rendered next to
   *  the retry button. */
  action?: { label: string; href: string };
  severity: 'warning' | 'error';
};

function mapError(code: string): ErrorPresentation {
  // Cap reached — wallet top-up is the right action, not retry.
  if (code === 'cap_hit') {
    return {
      severity: 'warning',
      title: 'You hit your spend cap',
      body: 'qlaud stopped this turn before going over your set limit. Top up your wallet or raise the cap to keep going.',
      action: { label: 'Top up wallet', href: 'https://qlaud.ai/dashboard' },
    };
  }
  // Auth expired / revoked.
  if (code === 'unauthorized') {
    return {
      severity: 'error',
      title: 'Sign-in expired',
      body: 'Your qlaud session lost track of you. Sign out and back in — your conversations stay where they are.',
    };
  }
  if (code === 'not_authed') {
    return {
      severity: 'error',
      title: 'Not signed in',
      body: 'Sign in with qlaud to keep going.',
    };
  }
  // Thread vanished (deleted on another device, retention policy).
  if (code === 'thread_not_found') {
    return {
      severity: 'warning',
      title: 'This conversation is gone',
      body: 'Looks like it was deleted from another device. Hit ⌘N to start a fresh one — your other chats are still here.',
    };
  }
  // Upstream model errors — be specific about which model + what code.
  // Format: upstream_<status>:<truncated body>
  if (code.startsWith('upstream_')) {
    const rest = code.slice('upstream_'.length);
    const status = parseInt(rest.split(':')[0] ?? '', 10);
    if (status === 429) {
      return {
        severity: 'warning',
        title: 'The model is rate-limited',
        body: 'Too many requests in a short window. Wait a few seconds and try again, or switch model from the title bar.',
      };
    }
    if (status === 503 || status === 502) {
      return {
        severity: 'warning',
        title: 'The model is taking a breather',
        body: 'Upstream is unavailable right now. Try again, or pick a different model from the title bar — qlaud routes to whichever provider you choose.',
      };
    }
    if (status === 400) {
      return {
        severity: 'error',
        title: 'Model rejected the request',
        body: 'Sometimes a turn ends up too long for the model\u2019s context window, or the attachment isn\u2019t supported. Try sending less, or switch to a model with a larger context.',
      };
    }
    return {
      severity: 'error',
      title: `Upstream error · ${status || 'unknown'}`,
      body: 'qlaud forwarded the request but the model\u2019s host returned an error. Retry or switch model.',
    };
  }
  // Aborts (user cancelled).
  if (code.toLowerCase().includes('abort')) {
    return {
      severity: 'warning',
      title: 'Cancelled',
      body: 'You stopped the turn. Send again to continue.',
    };
  }
  // Network / DNS / offline.
  if (
    code.toLowerCase().includes('fetch') ||
    code.toLowerCase().includes('network') ||
    code.toLowerCase().includes('failed to fetch')
  ) {
    return {
      severity: 'warning',
      title: 'Looks like you\u2019re offline',
      body: 'Couldn\u2019t reach qlaud. Check your connection and try again.',
    };
  }
  // Default — surface the raw code so the user can paste it to support
  // without us needing to add a case for every esoteric failure.
  return {
    severity: 'error',
    title: 'Something went wrong',
    body: `Error code: ${code}. Try again, or copy this and ping support if it keeps happening.`,
  };
}

// ─── Render rows ───────────────────────────────────────────────────

function BlockRow({
  block,
  busy,
  onAllow,
  onReject,
  onRetry,
}: {
  block: RenderBlock;
  busy: boolean;
  onAllow?: () => void;
  onReject?: () => void;
  onRetry?: () => void;
}) {
  if (block.type === 'user_text') {
    const hasFiles =
      (block.documents && block.documents.length > 0) ||
      (block.textFiles && block.textFiles.length > 0);
    return (
      <div className="flex justify-end">
        <div className="flex max-w-[80%] flex-col items-end gap-2">
          {block.images && block.images.length > 0 && (
            <div className="flex flex-wrap justify-end gap-1.5">
              {block.images.map((img) => (
                <img
                  key={img.id}
                  src={img.thumbUrl}
                  alt={img.name}
                  className="max-h-48 max-w-[180px] rounded-xl border border-border/40 object-cover shadow-sm"
                />
              ))}
            </div>
          )}
          {hasFiles && (
            <div className="flex flex-wrap justify-end gap-1.5">
              {block.documents?.map((doc) => (
                <span
                  key={doc.id}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 py-1 text-[11px]"
                >
                  <FileText className="h-3 w-3 text-primary" />
                  <span className="font-mono text-foreground/85">{doc.name}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {(doc.bytes / 1024).toFixed(0)}k
                  </span>
                </span>
              ))}
              {block.textFiles?.map((t) => (
                <span
                  key={t.id}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 py-1 text-[11px]"
                >
                  <FileText className="h-3 w-3 text-muted-foreground" />
                  <span className="font-mono text-foreground/85">{t.name}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {(t.bytes / 1024).toFixed(0)}k
                  </span>
                </span>
              ))}
            </div>
          )}
          {block.text && (
            <div className="rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm leading-relaxed text-primary-foreground shadow-sm">
              <p className="whitespace-pre-wrap">{block.text}</p>
            </div>
          )}
        </div>
      </div>
    );
  }
  if (block.type === 'tool') {
    return (
      <div className="flex pl-10">
        <div className="flex-1">
          <ToolCallCard call={block.call} />
        </div>
      </div>
    );
  }
  if (block.type === 'approval') {
    return (
      <div className="flex pl-10">
        <div className="flex-1">
          <ApprovalCard
            request={block.request}
            resolved={block.resolved}
            onAllow={() => onAllow?.()}
            onReject={() => onReject?.()}
          />
        </div>
      </div>
    );
  }
  if (block.type === 'usage') {
    return (
      <div className="flex pl-10">
        <UsagePill
          inputTokens={block.inputTokens}
          outputTokens={block.outputTokens}
          costUsd={block.costUsd}
          model={block.model}
          durationMs={block.durationMs}
        />
      </div>
    );
  }
  if (block.type === 'error') {
    const p = block.presentation;
    // Warning-level errors (cap, rate limit, network) get a softer
    // amber palette; hard errors (auth, 4xx) keep the destructive red.
    const isWarning = p.severity === 'warning';
    const ringClass = isWarning
      ? 'border-amber-500/30 bg-amber-500/5'
      : 'border-destructive/30 bg-destructive/5';
    const iconClass = isWarning ? 'text-amber-600' : 'text-destructive';
    return (
      <div className="flex pl-10">
        <div
          className={`flex flex-1 flex-col gap-2 rounded-xl border px-3.5 py-2.5 ${ringClass}`}
        >
          <div className="flex items-start gap-3">
            <AlertCircle className={`mt-0.5 h-4 w-4 shrink-0 ${iconClass}`} />
            <div className="flex-1">
              <div className="text-sm font-medium text-foreground">
                {p.title}
              </div>
              {p.body && (
                <div className="mt-1 text-[13px] leading-relaxed text-foreground/75">
                  {p.body}
                </div>
              )}
            </div>
          </div>
          {(block.retry || p.action) && (
            <div className="flex items-center justify-end gap-2 pt-1">
              {p.action && (
                <a
                  href={p.action.href}
                  target="_blank"
                  rel="noopener"
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  {p.action.label} →
                </a>
              )}
              {block.retry && (
                <button
                  onClick={() => onRetry?.()}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground/80 transition-colors hover:border-foreground/30 hover:text-foreground"
                >
                  <RotateCcw className="h-3 w-3" />
                  Retry
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }
  if (block.type === 'subagent') {
    return <SubagentBlock block={block} />;
  }
  // assistant_text
  if (!block.text && busy) {
    return (
      <div className="flex gap-3">
        <Avatar />
        <div className="flex-1 pt-0.5">
          {block.skill && <SkillAttribution skill={block.skill} model={block.resolvedModel} />}
          <TypingDots />
        </div>
      </div>
    );
  }
  if (!block.text) return null;
  return (
    <div className="flex gap-3">
      <Avatar />
      <div className="flex-1 pt-0.5">
        {block.skill && <SkillAttribution skill={block.skill} model={block.resolvedModel} />}
        <Markdown source={block.text} />
      </div>
    </div>
  );
}

// Small "Reviewed by Code Reviewer · Claude Sonnet 4.6" header that
// appears above an assistant response when a specialist took the turn.
// Subtle on purpose — informative, not loud. Click-through to settings
// for "always pin this engineer for the conversation" comes later.
function SkillAttribution({
  skill,
  model,
}: {
  skill: { slug: string; role: string };
  model?: string;
}) {
  return (
    <div className="mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 font-medium text-foreground/85">
        <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
        {skill.role}
      </span>
      {model && (
        <span className="font-mono opacity-70">
          · {prettyModelName(model)}
        </span>
      )}
    </div>
  );
}

function prettyModelName(slug: string): string {
  // Best-effort cosmetic shortening so "claude-opus-4-7" reads as
  // "Claude Opus 4.7". Falls through to the slug when we can't
  // decompose it cleanly.
  const m = slug.match(/^claude-([a-z]+)-(\d+)-(\d+)$/);
  if (m) return `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
  return slug;
}

function Avatar() {
  return (
    <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
      <Sparkles className="h-3.5 w-3.5" />
    </div>
  );
}

function TypingDots() {
  return (
    <div className="flex h-5 items-center gap-1">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/60 [animation-delay:0ms]" />
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/60 [animation-delay:200ms]" />
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/60 [animation-delay:400ms]" />
    </div>
  );
}

// Inline pill summarizing a turn's usage. Tokens come from the SSE
// stream (Anthropic message_start + message_delta usage); cost
// comes from balance delta against /v1/billing/balance — the
// authoritative dollars-charged number, qlaud's markup included.
function UsagePill({
  inputTokens,
  outputTokens,
  costUsd,
  model,
  durationMs,
}: {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  model: string;
  durationMs: number;
}) {
  const m = MODELS.find((x) => x.slug === model);
  const cost =
    costUsd == null
      ? null
      : costUsd < 0.01
        ? `${(costUsd * 100).toFixed(2)}¢`
        : `$${costUsd.toFixed(4)}`;
  return (
    <div
      className="flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-2.5 py-0.5 text-[10.5px] tabular-nums text-muted-foreground"
      title={`${inputTokens.toLocaleString()} input · ${outputTokens.toLocaleString()} output · ${(durationMs / 1000).toFixed(1)}s · ${m?.label ?? model}`}
    >
      <span>{formatTokens(inputTokens)} in</span>
      <span className="opacity-50">·</span>
      <span>{formatTokens(outputTokens)} out</span>
      {cost && (
        <>
          <span className="opacity-50">·</span>
          <span className="text-foreground/70">{cost}</span>
        </>
      )}
      <span className="opacity-50">·</span>
      <span>{(durationMs / 1000).toFixed(1)}s</span>
    </div>
  );
}

// Visible bracket around a subagent's run. The card itself shows the
// task description + final status; the subagent's tool calls and
// approval cards render INLINE below as if they were the parent's
// — handleEvent unwraps subagent_event so the user can see + approve
// every action the child takes. The done-state card displays the
// child's final text summary (which is also what the parent model
// sees as its tool_result).
function SubagentBlock({
  block,
}: {
  block: Extract<RenderBlock, { type: 'subagent' }>;
}) {
  const [open, setOpen] = useState(false);
  const isRunning = block.status === 'running';
  const isError = block.status === 'error';
  const summaryText = block.summary ?? '';
  return (
    <div className="flex pl-10">
      <div
        className={cn(
          'flex-1 rounded-lg border px-3 py-2',
          isError
            ? 'border-primary/30 bg-primary/5'
            : 'border-border/60 bg-muted/30',
        )}
      >
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'inline-block h-1.5 w-1.5 shrink-0 rounded-full',
              isRunning
                ? 'animate-pulse bg-primary'
                : isError
                  ? 'bg-primary'
                  : 'bg-emerald-500',
            )}
          />
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Subagent
          </span>
          <span className="text-[12px] font-medium text-foreground">
            {block.description || '(no description)'}
          </span>
          {isRunning && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
              running
            </span>
          )}
          {!isRunning && summaryText && (
            <button
              onClick={() => setOpen((o) => !o)}
              className="ml-auto text-[10.5px] text-muted-foreground hover:text-foreground"
            >
              {open ? 'hide summary' : 'view summary'}
            </button>
          )}
        </div>
        {open && summaryText && (
          <div className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border/40 bg-background/60 p-2 text-[11px] leading-relaxed text-foreground/85">
            {summaryText}
          </div>
        )}
      </div>
    </div>
  );
}

function CompactionIndicator({
  summary,
  summarizedThroughSeq,
}: {
  summary: string;
  summarizedThroughSeq: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="self-start rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-[11.5px] text-muted-foreground">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 hover:text-foreground"
      >
        <BookOpen className="h-3 w-3" />
        <span>
          {summarizedThroughSeq.toLocaleString()} earlier turns auto-summarized
        </span>
        <span className="text-muted-foreground/60">
          {open ? '· hide' : '· view'}
        </span>
      </button>
      {open && (
        <div className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border/40 bg-background/60 p-2 text-[11px] leading-relaxed text-foreground/85">
          {summary}
        </div>
      )}
    </div>
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function EmptyState({
  modelLabel,
  provider,
  memory,
  hasWorkspace,
  onOpenFolder,
  onPick,
}: {
  modelLabel: string;
  provider?: string;
  memory: ProjectMemory | null;
  hasWorkspace: boolean;
  onOpenFolder: () => void | Promise<void>;
  onPick: (s: string) => void;
}) {
  // First-launch branch: no workspace yet → push the user to open
  // one before showing sample prompts. The 7 file/edit/bash tools
  // need a workspace; without one the model can't do anything
  // useful, so demanding the choice up front is better than letting
  // the user discover that mid-prompt.
  if (!hasWorkspace) {
    // Web build can't open a folder — browsers don't get raw fs
    // access. Show a chat-only welcome with sample prompts and a
    // download CTA, instead of an "Open folder" button that leads
    // to a confusing modal.
    if (!isTauri()) {
      return (
        <div className="flex flex-col items-center pt-12 text-center">
          <QlaudMark className="h-12 w-12 rounded-2xl shadow-sm" />
          <h2 className="mt-6 text-2xl font-semibold tracking-tight">
            Welcome to qcode chat
          </h2>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
            You&rsquo;re on the web build — chat-only. Ask anything you can
            answer with text: code review on snippets you paste, design
            questions, debugging help. To run shell commands, edit files,
            or open a folder, get the desktop app.
          </p>
          <a
            href="https://qlaud.ai/qcode"
            target="_blank"
            rel="noopener"
            className="mt-6 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-all hover:bg-primary/90"
          >
            <Download className="h-4 w-4" />
            Download qcode for desktop
          </a>
          <div className="mt-10 grid w-full max-w-2xl gap-2 text-left">
            {WEB_SAMPLE_PROMPTS.map((s) => (
              <button
                key={s}
                onClick={() => onPick(s)}
                className="rounded-lg border border-border bg-background/70 px-4 py-3 text-sm text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center pt-12 text-center">
        <QlaudMark className="h-12 w-12 rounded-2xl shadow-sm" />
        <h2 className="mt-6 text-2xl font-semibold tracking-tight">
          Welcome to qcode
        </h2>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
          Open a folder to give qcode something to work on. It only reads
          what you point it at — your filesystem stays private otherwise.
        </p>
        <button
          onClick={() => void onOpenFolder()}
          className="mt-6 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-all hover:bg-primary/90 active:scale-[0.98]"
        >
          <FolderOpen className="h-4 w-4" />
          Open folder
          <Kbd className="ml-1 border-primary-foreground/30 text-primary-foreground/70">
            ⌘O
          </Kbd>
        </button>
        <div className="mt-10 grid w-full max-w-2xl gap-3 text-left sm:grid-cols-3">
          <OnboardingTip
            title="Edits with diff approval"
            body="Every write or edit shows a diff before applying. Bash commands too. You stay in control."
          />
          <OnboardingTip
            title="Multi-model"
            body={`Connected to ${modelLabel}${provider ? ` · ${provider}` : ''}. Switch in the title bar — Claude, GPT, DeepSeek, more.`}
          />
          <OnboardingTip
            title="qcode.md or CLAUDE.md"
            body="Drop one in your repo to teach qcode your conventions. Loaded automatically every turn."
          />
        </div>
      </div>
    );
  }

  // Returning user with a workspace open — the existing canvas.
  return (
    <div className="flex flex-col items-center pt-12 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-2xl bg-primary/10 text-primary">
        <Sparkles className="h-5 w-5" />
      </div>
      <h2 className="mt-6 text-2xl font-semibold tracking-tight">
        What can the team build?
      </h2>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
        Just describe it. We&rsquo;ll route to the right specialist —
        Staff, Reviewer, QA, DevOps, Security, Designer, Frontend,
        Backend, or Marketing — and tell you who&rsquo;s on it.
      </p>
      {memory && (
        <div
          className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/70 px-2.5 py-0.5 text-[11px] text-muted-foreground"
          title={`Loaded ${memory.text.length.toLocaleString()} chars of project context from ${memory.source}`}
        >
          <BookOpen className="h-3 w-3" />
          <span>
            Using{' '}
            <span className="font-mono text-foreground/80">
              {memory.source}
            </span>{' '}
            as project context
          </span>
        </div>
      )}
      <div className="mt-10 grid w-full max-w-2xl gap-2 text-left">
        {SAMPLE_PROMPTS.map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="rounded-lg border border-border bg-background/70 px-4 py-3 text-sm text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function OnboardingTip({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/70 px-3 py-2.5">
      <div className="text-[12px] font-medium text-foreground">{title}</div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
        {body}
      </p>
    </div>
  );
}

function Kbd({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <kbd
      className={cn(
        'rounded border border-border/60 bg-background/40 px-1.5 py-0.5 font-sans text-[10px] tabular-nums',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

// ─── Composer ──────────────────────────────────────────────────────

function Composer({
  value,
  onChange,
  modelLabel,
  onSend,
  onStop,
  busy,
  attached,
  images,
  documents,
  textFiles,
  files,
  onLoadFiles,
  onAttach,
  onDetach,
  onAttachUpload,
  onDetachUpload,
  onImageError,
}: {
  value: string;
  onChange: (v: string) => void;
  modelLabel: string;
  onSend: (v: string) => void;
  onStop: () => void;
  busy: boolean;
  attached: string[];
  images: AttachedImage[];
  documents: AttachedDocument[];
  textFiles: AttachedText[];
  files: string[];
  onLoadFiles: () => void;
  onAttach: (path: string) => void;
  onDetach: (path: string) => void;
  onAttachUpload: (f: AttachedFile) => void;
  onDetachUpload: (id: string) => void;
  onImageError: (message: string) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function ingestUploadedFiles(list: File[]) {
    for (const f of list) {
      const result = await readUploadedFile(f);
      if ('reason' in result) {
        onImageError(result.message); // shared error channel
        continue;
      }
      onAttachUpload(result);
    }
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const list = filesFromPaste(e.nativeEvent);
    if (list.length === 0) return;
    e.preventDefault();
    void ingestUploadedFiles(list);
  }

  function onDrop(e: React.DragEvent) {
    setDragging(false);
    const list = filesFromDrop(e.nativeEvent);
    if (list.length === 0) return;
    e.preventDefault();
    void ingestUploadedFiles(list);
  }

  function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files ? Array.from(e.target.files) : [];
    if (list.length === 0) return;
    void ingestUploadedFiles(list);
    // Reset so picking the same file twice in a row still triggers
    // change.
    e.target.value = '';
  }
  // The mention-token at-or-before the cursor, or null when there's
  // no active @-mention. Tracked on every change.
  const [mention, setMention] = useState<{
    query: string;
    /** Char index of the leading '@' so we can replace it on pick. */
    start: number;
  } | null>(null);
  const [mentionActive, setMentionActive] = useState(0);

  function findMention(text: string, caret: number): typeof mention {
    // Walk backwards from the caret looking for the most recent '@'.
    // Bail if we cross whitespace (mentions don't span words) or hit
    // 32 chars without finding one.
    let i = caret - 1;
    let bound = Math.max(0, caret - 64);
    while (i >= bound) {
      const ch = text[i] ?? '';
      if (ch === '@') {
        const before = text[i - 1] ?? ' ';
        // '@' must be at start-of-string or after whitespace.
        if (before === ' ' || before === '\n' || before === '' || i === 0) {
          return { query: text.slice(i + 1, caret), start: i };
        }
        return null;
      }
      if (ch === ' ' || ch === '\n') return null;
      i--;
    }
    return null;
  }

  function onTextChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value;
    onChange(next);
    const caret = e.target.selectionStart ?? next.length;
    const m = findMention(next, caret);
    setMention(m);
    setMentionActive(0);
    if (m) onLoadFiles();
  }

  function pickMention(path: string) {
    if (!mention) return;
    const before = value.slice(0, mention.start);
    const after = value.slice(mention.start + 1 + mention.query.length);
    // Replace `@query` with `` (empty) — the file goes in the chip
    // tray instead of the input. Less visual noise.
    const next = before + after;
    onChange(next);
    setMention(null);
    onAttach(path);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Mention nav: arrows + Enter consumed if menu is showing.
    if (mention) {
      const results = getMentionResults(files, mention.query);
      if (e.key === 'Escape') {
        e.preventDefault();
        setMention(null);
        return;
      }
      if (results.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setMentionActive((a) => Math.min(results.length - 1, a + 1));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setMentionActive((a) => Math.max(0, a - 1));
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const pick = results[mentionActive] ?? results[0];
          if (pick) pickMention(pick);
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          const pick = results[mentionActive] ?? results[0];
          if (pick) pickMention(pick);
          return;
        }
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend(value);
    }
  }

  return (
    <div className="border-t border-border/40 bg-background/70 px-4 py-4 backdrop-blur-md">
      <div className="mx-auto max-w-3xl">
        <div className="relative">
          {mention && (
            <MentionMenu
              files={files}
              query={mention.query}
              active={mentionActive}
              onPick={pickMention}
              onHover={setMentionActive}
            />
          )}
          <div
            onDragEnter={(e) => {
              e.preventDefault();
              if (e.dataTransfer?.types?.includes('Files')) setDragging(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            }}
            onDragLeave={(e) => {
              if (e.currentTarget === e.target) setDragging(false);
            }}
            onDrop={onDrop}
            className={cn(
              'rounded-2xl border bg-background shadow-sm transition-shadow',
              'focus-within:shadow-md',
              dragging
                ? 'border-primary/40 ring-2 ring-primary/20'
                : 'border-border focus-within:border-foreground/20',
            )}
          >
            {(attached.length > 0 ||
              images.length > 0 ||
              documents.length > 0 ||
              textFiles.length > 0) && (
              <div className="flex flex-wrap items-center gap-1.5 border-b border-border/40 px-3 py-2">
                {images.map((img) => (
                  <span
                    key={img.id}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/60 p-0.5 pr-1 text-[11px]"
                  >
                    <img
                      src={img.thumbUrl}
                      alt={img.name}
                      className="h-6 w-6 rounded-sm border border-border/40 object-cover"
                    />
                    <span className="max-w-[140px] truncate font-mono text-foreground/85">
                      {img.name}
                    </span>
                    <button
                      onClick={() => onDetachUpload(img.id)}
                      className="grid h-4 w-4 place-items-center rounded text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                      aria-label={`Remove ${img.name}`}
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))}
                {documents.map((doc) => (
                  <span
                    key={doc.id}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/60 py-0.5 pl-1.5 pr-1 text-[11px]"
                  >
                    <FileText className="h-3 w-3 text-primary" />
                    <span className="max-w-[180px] truncate font-mono text-foreground/85">
                      {doc.name}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {(doc.bytes / 1024).toFixed(0)}k
                    </span>
                    <button
                      onClick={() => onDetachUpload(doc.id)}
                      className="grid h-4 w-4 place-items-center rounded text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                      aria-label={`Remove ${doc.name}`}
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))}
                {textFiles.map((t) => (
                  <span
                    key={t.id}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/60 py-0.5 pl-1.5 pr-1 text-[11px]"
                  >
                    <FileText className="h-3 w-3 text-muted-foreground" />
                    <span className="max-w-[180px] truncate font-mono text-foreground/85">
                      {t.name}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {(t.bytes / 1024).toFixed(0)}k
                    </span>
                    <button
                      onClick={() => onDetachUpload(t.id)}
                      className="grid h-4 w-4 place-items-center rounded text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                      aria-label={`Remove ${t.name}`}
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))}
                {attached.map((p) => (
                  <span
                    key={p}
                    className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/60 py-0.5 pl-1.5 pr-1 text-[11px]"
                  >
                    <FileText className="h-3 w-3 text-muted-foreground" />
                    <span className="font-mono text-foreground/85">{p}</span>
                    <button
                      onClick={() => onDetach(p)}
                      className="grid h-4 w-4 place-items-center rounded text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                      aria-label={`Remove ${p}`}
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              value={value}
              onChange={onTextChange}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onFocus={onLoadFiles}
              placeholder="Ask qcode about your code… type @ to attach a file"
              rows={2}
              disabled={busy}
              className="block w-full resize-none rounded-2xl bg-transparent px-4 py-3 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
            />
            <div className="flex items-center justify-between border-t border-border/40 px-3 py-2">
              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,.md,.markdown,.json,.jsonl,.yaml,.yml,.toml,.csv,.tsv,.xml,.html,.css,.scss,.js,.jsx,.mjs,.cjs,.ts,.tsx,.py,.rb,.go,.rs,.java,.kt,.swift,.c,.cc,.cpp,.h,.hpp,.sh,.bash,.zsh,.fish,.ps1,.bat,.sql,.graphql,.proto,.env,.ini,.conf,.cfg,.lock,.log"
                  className="hidden"
                  onChange={onPickFiles}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="grid h-7 w-7 place-items-center rounded-md border border-border/60 bg-background text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
                  aria-label="Attach files"
                  title="Attach images, PDFs, or text files"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                </button>
                <span className="text-[11px] text-muted-foreground">
                  {dragging
                    ? 'Drop to attach'
                    : `${modelLabel} · ⏎ to send · @ files · paste/drop · images, PDFs, text`}
                </span>
              </div>
              {busy ? (
                <button
                  onClick={onStop}
                  className="grid h-7 w-7 place-items-center rounded-md border border-border bg-background text-foreground/70 transition-colors hover:border-foreground/30 hover:text-foreground"
                  aria-label="Stop"
                  title="Stop"
                >
                  <Square className="h-3 w-3 fill-current" />
                </button>
              ) : (
                <button
                  onClick={() => onSend(value)}
                  disabled={
                    !value.trim() &&
                    attached.length === 0 &&
                    images.length === 0 &&
                    documents.length === 0 &&
                    textFiles.length === 0
                  }
                  className="grid h-7 w-7 place-items-center rounded-md bg-primary text-primary-foreground transition-all hover:bg-primary/90 active:scale-95 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
                  aria-label="Send"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
