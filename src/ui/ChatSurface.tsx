import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  FolderOpen,
  GitBranch,
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
import { MODELS, contextWindowFor } from '../lib/models';
import { planToAgentHandoff, setLastMode } from '../lib/mode-tracking';
import { getSettings } from '../lib/settings';
import type { ContentBlock, Message } from '../lib/qlaud-client';
import { type CompactionInfo } from '../lib/threads';
import { useThreadMessagesQuery } from '../lib/queries';
import { QlaudMark } from './QlaudMark';
import type { ApprovalDecision, ApprovalRequest } from '../lib/tools';
import {
  registerApproval,
  rejectAllApprovals,
  resolveApproval,
} from '../lib/approvals';
import {
  getCurrentWorkspace,
  listAllFiles,
} from '../lib/workspace';
import { readGitInfo } from '../lib/git-info';
import { ApprovalCard } from './ApprovalCard';
import { Markdown } from './Markdown';
import { MentionMenu, getMentionResults } from './MentionMenu';
import {
  ToolCallCard,
  aggregateDiffStats,
  type ToolCallView,
} from './ToolCallCard';
import { RightRail, type RightRailView } from './RightRail';
import { invalidateThreadMessages, loadEarlierMessages } from '../lib/queries';
import {
  clearInFlight,
  isInFlight,
  markInFlight,
} from '../lib/in-flight';

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

// Sample prompts for the empty-state. Each one is calibrated to
// secretly invoke a specific engineer on the team — the user
// describes a goal in their own words, the server-side classifier
// auto-routes to the right specialist (Staff for plans, Reviewer
// for bugs, etc.), and the green-checkmark UX makes the team feel
// alive. The user never has to learn a slash command.
const SAMPLE_PROMPTS = [
  'Plan a refactor of the auth flow',          // → Staff Engineer
  'Review my recent changes for bugs',         // → Code Reviewer
  'Build a 30-second launch video with Remotion', // → Marketing
  'Draft cold emails to 20 founders building AI dev tools', // → Sales
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
  workspaceName,
  workspacePath,
  onOpenFolder,
  rightRailView,
  onCloseRightRail,
}: {
  model: string;
  mode?: 'agent' | 'plan';
  threadId: string | null;
  ensureThreadId: () => Promise<string>;
  onTurnLanded?: (info: {
    userText: string | null;
    threadId: string;
    /** Seq of the assistant turn just persisted by qlaud. App.tsx
     *  uses this for cheap turn-counting (assistant seqs are even:
     *  2, 4, 6 → turn 1, 2, 3) without re-fetching the message
     *  list. Null when the qlaud worker didn't ship cost_micros
     *  yet (legacy version). */
    assistantSeq: number | null;
  }) => void;
  workspaceName?: string;
  workspacePath?: string;
  hasWorkspace: boolean;
  onOpenFolder: () => void | Promise<void>;
  /** Active right-rail view, or null when hidden. ChatSurface owns
   *  the `blocks` state so it renders the rail as a sibling. */
  rightRailView?: RightRailView | null;
  /** Close handler for the rail's X button. */
  onCloseRightRail?: () => void;
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
  const [branch, setBranch] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Monotonic run id. Bumped on every send + on every thread switch.
  // Each onEvent callback closes over the run id it was created
  // with; if the live ref drifts past it (because the user aborted,
  // switched thread, or sent a new turn before the old stream
  // unwound), the callback bails. Without this guard, a late SSE
  // event from an aborted thread can stomp the active thread's
  // blocks state — symptom is messages bleeding across threads
  // when the user clicks Stop and switches fast.
  const activeRunIdRef = useRef(0);
  // Capture-at-send-time threadId. setBlocks calls in send() check
  // it against the live `threadId` prop; mismatch = thread changed
  // while a request was in flight, drop the result.
  const lastSendThreadRef = useRef<string | null>(null);

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
  // Also pulls the git branch (if any) so the composer chip surface
  // can show "main" / "feat/foo" without spawning a child process.
  useEffect(() => {
    const ws = getCurrentWorkspace();
    if (!ws) {
      setMemory(null);
      setBranch(null);
      return;
    }
    let cancelled = false;
    void getProjectMemory(ws.path).then((m) => {
      if (!cancelled) setMemory(m);
    });
    void readGitInfo(ws.path).then((g) => {
      if (!cancelled) setBranch(g.branch);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Rehydrate when the active thread changes. Query owns the network
  // dance (caching, dedupe, abort, retry); we just project its data
  // into the render-block state once per thread switch.
  //
  // Busy guard: when the user sends a turn against a brand-new
  // session, ensureThreadId provisions a remote thread mid-send and
  // bumps threadId from null to a real id. We don't want to overwrite
  // the just-pushed user_text block in that race — the new thread is
  // empty server-side anyway. Skip the load while a send is in flight;
  // the next thread-switch covers it.
  const messagesQuery = useThreadMessagesQuery(busy ? null : threadId);
  const lastLoadedRef = useRef<string | null>(null);
  // Thread-switch invalidator. CRITICAL: we do NOT abort the
  // network here. For text-only turns, qlaud's tee+waitUntil
  // finishes server-side regardless. For tool-using turns (read_
  // file, bash, etc.), qlaud is parked waiting for the client to
  // POST tool results — aborting the SSE connection means the
  // client never sees the qlaud.tool_dispatch_start event,
  // never dispatches the tool, never POSTs the result, and the
  // qlaud-side loop dies at the 60s tool-result timeout. By
  // letting the network stay alive, the agent.ts onToolDispatch
  // handlers keep firing even though the user is on a different
  // thread — file reads / writes / bash all continue, results
  // post back, model loop completes, qlaud persists the final
  // assistant turn.
  //
  // What we DO on switch:
  //  - Bump activeRunIdRef → ChatSurface's onEvent guard filters
  //    out UI updates from the abandoned run (so its blocks state
  //    doesn't bleed into the now-active thread).
  //  - rejectAllApprovals → write_file/edit_file/bash that were
  //    waiting on user click cleanly fail (treated as rejected).
  //    Read-only tools (no approval) keep running.
  //  - setBusy(false) → the user can send on the new thread.
  //  - invalidateThreadMessages(prev) → so a return visit pulls
  //    fresh canonical history (with whatever the still-running
  //    or just-completed loop persisted).
  //
  // Explicit Stop (the stop button) DOES abort — that's the only
  // path that kills the in-flight loop. See stop() below.
  const lastThreadIdRef = useRef(threadId);
  useEffect(() => {
    const prev = lastThreadIdRef.current;
    lastThreadIdRef.current = threadId;
    // CRITICAL: guard on `prev` truthiness. The first send on a
    // brand-new chat starts with threadId=null, then ensureThreadId
    // creates the remote thread and the prop transitions null →
    // real-id mid-stream. That's NOT a thread switch — it's the
    // initial id assignment. Without this guard the invalidator
    // bumps runId, every subsequent SSE event gets filtered by the
    // onEvent runId guard, and the live stream silently disappears
    // (user has to refresh to see the canonical history).
    if (prev && prev !== threadId && busy) {
      activeRunIdRef.current += 1;
      rejectAllApprovals();
      setBusy(false);
      void invalidateThreadMessages(prev);
      if (lastLoadedRef.current === prev) lastLoadedRef.current = null;
    }
  }, [threadId, busy]);

  useEffect(() => {
    if (busy) return;
    if (!threadId) {
      setBlocks([]);
      lastLoadedRef.current = null;
      return;
    }
    if (!messagesQuery.data) return;
    // Normal navigation: skip if we've already rendered this thread
    // once (avoids the post-send overwrite that strips usage pills).
    // Resume case: when the thread is in-flight (we're polling for
    // a server-side-finishing turn), bypass the gate — every poll
    // refetch needs to land in the UI the moment qlaud persists the
    // new assistant turn, otherwise the user sees the canonical
    // history frozen at switch-away time.
    const polling = isInFlight(threadId);
    if (!polling && lastLoadedRef.current === threadId) return;
    lastLoadedRef.current = threadId;
    setBlocks(historyToBlocks(messagesQuery.data.messages));
    setCompaction(messagesQuery.data.compaction);
  }, [threadId, busy, messagesQuery.data]);

  useEffect(
    () => () => {
      // Cancel network on unmount, but DO NOT clear the module-
      // scoped approval registry — a parent re-render that
      // remounts ChatSurface (e.g. layout swap) would drop the
      // user's pending approval card otherwise. Approvals only
      // get rejected on explicit stop(), thread-switch, or
      // sign-out; remounts are transparent.
      abortRef.current?.abort();
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
    setBlocks((bs) =>
      bs.map((b) =>
        b.type === 'approval' && b.id === id ? { ...b, resolved: decision } : b,
      ),
    );
    resolveApproval(id, decision);
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
    // Bump run id and capture for this send. Every callback below
    // checks `runId === activeRunIdRef.current` before touching
    // state — if the user aborts, switches threads, or sends a new
    // turn, the ref bumps and stale callbacks become no-ops.
    activeRunIdRef.current += 1;
    const runId = activeRunIdRef.current;

    // qlaud's qlaud.done event ships cost_micros — its authoritative
    // count, markup included. We capture it on the finished event
    // alongside token counts. No more pre/post balance fetch math.
    const startMs = Date.now();
    let finished: {
      usage: { inputTokens: number; outputTokens: number };
      costUsd: number | null;
      seq: number | null;
    } | null = null;

    try {
      // Lazily provision the thread on first send. App.tsx returns
      // the active id when there is one, otherwise creates a remote
      // thread and updates the sidebar before resolving.
      const id = await ensureThreadId();
      lastSendThreadRef.current = id;
      // Mark this thread as already-loaded so the post-send message
      // re-fetch effect bails. Without this, the moment busy flips
      // back to false the messagesQuery for this thread enables,
      // fetches the canonical server history, and setBlocks
      // overwrites every tool card / approval / usage pill we
      // streamed live (historyToBlocks only knows user_text +
      // assistant_text). Symptom: "streaming message briefly,
      // disappeared." The streamed blocks ARE canonical; we don't
      // need to round-trip the server to learn what we just rendered.
      lastLoadedRef.current = id;
      // Track this send as in-flight so if the user navigates away
      // mid-stream, switching back triggers a poll until qlaud's
      // server-side persisted assistant turn shows up. The seq
      // floor is the highest seq currently in the cached history;
      // hasLanded() looks for an assistant turn past that seq to
      // detect "the new turn arrived." Cleared on success in the
      // finally block; left in place if the user abandons (server
      // keeps running via waitUntil).
      const cachedHistory = messagesQuery.data;
      const seqFloor =
        cachedHistory?.messages.reduce(
          (max, m) => Math.max(max, m.seq ?? 0),
          0,
        ) ?? 0;
      markInFlight(id, seqFloor);
      // Thread changed (user navigated) between send press and the
      // thread-id resolution. Don't keep going — the user's looking
      // at a different conversation.
      if (runId !== activeRunIdRef.current) return;

      const settingsAtSend = getSettings();
      await runThreadAgent({
        threadId: id,
        model,
        mode,
        workspace: workspace?.path ?? null,
        content: userContent,
        // Read at send time so toggling the setting takes effect on
        // the very next turn without a remount.
        enableConnectors: settingsAtSend.enableConnectors,
        autoApprove: settingsAtSend.autoApprove,
        signal: abortRef.current.signal,
        onEvent: (e) => {
          // Stale-run guard: drop events from any run that's been
          // superseded (user switched threads, aborted, re-sent).
          // Without this, a late tool_done from an aborted thread
          // mutates the active thread's blocks.
          if (runId !== activeRunIdRef.current) return;
          if (e.type === 'finished') {
            finished = {
              usage: e.usage,
              costUsd: e.costUsd,
              seq: e.seq,
            };
          }
          handleEvent(e, setBlocks);
        },
        onApproval: (toolUseId, _request) =>
          new Promise<ApprovalDecision>((resolve) => {
            // If this run is no longer active by the time the model
            // asks for approval, auto-reject so the executor can
            // unwind. Otherwise the user would see an approval card
            // for a turn they already abandoned.
            if (runId !== activeRunIdRef.current) {
              resolve('reject');
              return;
            }
            registerApproval(toolUseId, resolve);
          }),
      });

      // Per-thread state updates fire regardless of which thread
      // the UI is currently showing — the title/mode/balance belong
      // to the thread that finished, not to the active one.
      // Without this, abandoning a turn mid-stream meant the
      // sidebar row stayed stuck at "New chat" forever even though
      // the canonical assistant turn had landed server-side.
      // TS's control-flow analysis narrows `finished` to `never`
      // here because it's only assigned inside the onEvent callback
      // (which TS treats as opaque from outer-scope POV). Cast
      // through the explicit type so the type is preserved.
      const finalSeq =
        (finished as null | { seq: number | null })?.seq ?? null;
      onTurnLanded?.({
        userText: userMsg || null,
        threadId: id,
        assistantSeq: finalSeq,
      });
      setLastMode(id, mode);

      // UI updates (the usage pill in the chat surface) — gated on
      // the runId because the pill belongs to the chat the user is
      // looking at; rendering it into the wrong thread would be
      // worse than dropping it.
      if (runId !== activeRunIdRef.current) return;

      if (finished) {
        const f: {
          usage: { inputTokens: number; outputTokens: number };
          costUsd: number | null;
        } = finished;
        setBlocks((b) => [
          ...b,
          {
            type: 'usage',
            inputTokens: f.usage.inputTokens,
            outputTokens: f.usage.outputTokens,
            costUsd: f.costUsd,
            model,
            durationMs: Date.now() - startMs,
          },
        ]);
        posthog.capture('turn_completed', {
          model,
          mode,
          input_tokens: f.usage.inputTokens,
          output_tokens: f.usage.outputTokens,
          cost_usd: f.costUsd,
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
      // If this run was superseded (user switched threads or sent a
      // new turn), the server is still working on the abandoned
      // thread. Leave it in the in-flight set so a return visit
      // polls until the assistant turn lands. If the run completed
      // normally, clear it.
      if (runId === activeRunIdRef.current && lastSendThreadRef.current) {
        clearInFlight(lastSendThreadRef.current);
      }
      setBusy(false);
      abortRef.current = null;
      // Drop any leftover resolvers — covers the case where streaming
      // bails before the loop reaches the awaiting Promise.
      rejectAllApprovals();
    }
  }

  function stop() {
    // Bumping the run id is what actually makes "Stop" definitive.
    // abort() asks the network to give up, but late events from the
    // server side can still arrive (SSE buffering); the run-id
    // check in onEvent ensures they're discarded instead of
    // mutating blocks the user is now reading fresh.
    activeRunIdRef.current += 1;
    abortRef.current?.abort();
    rejectAllApprovals();
    setBusy(false);
  }

  const empty = blocks.length === 0;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-3 py-6 sm:px-4 sm:py-8">
          {empty ? (
            <EmptyState
              modelLabel={m?.label ?? model}
              provider={m?.provider}
              memory={memory}
              hasWorkspace={hasWorkspace}
              workspaceName={workspaceName}
              onOpenFolder={onOpenFolder}
              onPick={(s) => setInput(s)}
            />
          ) : (
            <div className="flex flex-col gap-5">
              {messagesQuery.data?.hasMore && threadId && (
                <LoadEarlierButton threadId={threadId} />
              )}
              {threadId && !busy && isInFlight(threadId) && (
                <ResumeIndicator />
              )}
              {compaction && (
                <CompactionIndicator
                  summary={compaction.summary}
                  summarizedThroughSeq={compaction.summarizedThroughSeq}
                />
              )}
              <TodoListPanel blocks={blocks} />
              {groupBlocks(blocks).map((group, gi) => {
                if (group.type === 'tool-bundle') {
                  return (
                    <ToolBundle
                      key={`bundle-${gi}`}
                      tools={group.tools}
                      workspace={workspacePath ?? null}
                    />
                  );
                }
                const b = group.block;
                const i = group.index;
                return (
                  <BlockRow
                    key={i}
                    block={b}
                    workspace={workspacePath ?? null}
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
                );
              })}
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
        workspaceName={workspaceName}
        branch={branch}
        mode={mode}
        // Latest usage block's inputTokens is the closest proxy for
        // "current conversation size" — it's what the model just
        // received (history + system + this turn). Show against the
        // model's context window so the user sees headroom shrink
        // and knows when to /compact or start a new chat.
        contextUsed={latestInputTokens(blocks)}
        contextMax={contextWindowFor(model)}
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
      {rightRailView && (
        <RightRail
          view={rightRailView}
          blocks={blocks}
          workspacePath={workspacePath}
          onClose={onCloseRightRail}
        />
      )}
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
  // SSE stream idle-timeout — fired by the 90s watchdog in
  // qlaud-client when the upstream goes silent mid-response.
  // Distinct from "offline" because the connection was working
  // and then stopped sending data; common cause is mobile radio
  // sleeping or a server-side hang.
  if (code.includes('sse_idle_timeout')) {
    return {
      severity: 'warning',
      title: 'The model went quiet',
      body: 'The stream stopped sending data for 90 seconds, so qcode gave up waiting. The model may have hit a long-tail latency — retry, or switch model from the title bar.',
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

// Group consecutive tool blocks for the bundled-actions UI
// (Codex pattern). Walks the blocks list once; tool blocks that
// are NOT todo_write (its own sticky panel) collect into a
// bundle until any non-tool block breaks the run. Returns a
// flat list of either {block, index} singles or {tools} bundles
// — the outer render maps over this so single-tool bundles
// still render as one chip (consistent UX) and multi-tool runs
// collapse into "Ran 2 commands, read 4 files, edited 3 files."
type BlockGroup =
  | { type: 'single'; block: RenderBlock; index: number }
  | { type: 'tool-bundle'; tools: Array<Extract<RenderBlock, { type: 'tool' }>> };

function groupBlocks(blocks: RenderBlock[]): BlockGroup[] {
  const out: BlockGroup[] = [];
  let bundle: Array<Extract<RenderBlock, { type: 'tool' }>> = [];
  const flushBundle = () => {
    if (bundle.length === 0) return;
    out.push({ type: 'tool-bundle', tools: bundle });
    bundle = [];
  };
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b) continue;
    if (b.type === 'tool' && b.call.name !== 'todo_write') {
      bundle.push(b);
      continue;
    }
    flushBundle();
    out.push({ type: 'single', block: b, index: i });
  }
  flushBundle();
  return out;
}

// Bundle of consecutive tool calls — Codex's pattern. Renders
// as one collapsible chip with a category-bucketed summary
// ("Ran 2 commands, read 4 files, edited 3 files"). Click the
// header to reveal individual tool cards inline. Single-tool
// bundles render as just the card itself (no chip wrapper) so
// the UX stays clean — bundling kicks in when there's actually
// something to bundle.
function ToolBundle({
  tools,
  workspace,
}: {
  tools: Array<Extract<RenderBlock, { type: 'tool' }>>;
  workspace: string | null;
}) {
  const [open, setOpen] = useState(true);
  // One-tool bundles: skip the wrapper. Same look as before.
  if (tools.length === 1) {
    return (
      <div className="flex pl-10">
        <div className="flex-1">
          <ToolCallCard call={tools[0]!.call} workspace={workspace} />
        </div>
      </div>
    );
  }
  const summary = bundleSummary(tools);
  const anyRunning = tools.some((t) => t.call.status === 'running');
  const anyError = tools.some((t) => t.call.status === 'error');
  return (
    <div className="flex pl-10">
      <div className="flex-1">
        <div
          className={cn(
            'overflow-hidden rounded-lg border bg-background/70 backdrop-blur-sm transition-colors',
            anyError ? 'border-primary/30 bg-primary/5' : 'border-border/60',
          )}
        >
          <button
            onClick={() => setOpen((v) => !v)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/40"
          >
            <ChevronRight
              className={cn(
                'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                open && 'rotate-90',
              )}
            />
            <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/85">
              {summary}
            </span>
            {anyRunning && (
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                running
              </span>
            )}
            <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground">
              {tools.length}
            </span>
          </button>
          {open && (
            <div className="border-t border-border/40 bg-muted/10 p-2">
              <div className="flex flex-col gap-1">
                {tools.map((t) => (
                  <ToolCallCard
                    key={t.call.id}
                    call={t.call}
                    workspace={workspace}
                    embedded
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Codex-style bucket summary: "Ran 2 commands, read 4 files,
// edited 3 files". Categories are picked so the user gets a
// scan-friendly read of what the agent did in this stretch.
function bundleSummary(
  tools: Array<Extract<RenderBlock, { type: 'tool' }>>,
): string {
  const counts: Record<string, number> = {};
  const bump = (k: string) => {
    counts[k] = (counts[k] ?? 0) + 1;
  };
  for (const t of tools) {
    const name = t.call.name;
    if (name === 'bash' || name === 'bash_status') bump('commands');
    else if (
      name === 'read_file' ||
      name === 'list_files' ||
      name === 'glob' ||
      name === 'grep'
    )
      bump('reads');
    else if (name === 'write_file' || name === 'edit_file') bump('edits');
    else if (name.startsWith('browser_')) bump('browser');
    else if (name === 'task') bump('subagents');
    else if (name === 'verify') bump('verifies');
    else bump('other');
  }
  const parts: string[] = [];
  if (counts.commands)
    parts.push(`Ran ${counts.commands} ${counts.commands === 1 ? 'command' : 'commands'}`);
  if (counts.reads)
    parts.push(`read ${counts.reads} ${counts.reads === 1 ? 'file' : 'files'}`);
  if (counts.edits) {
    // Total +N −M across all edit/write outputs in this bundle, so
    // the user sees the full impact at a glance — same surface
    // area Codex shows on a multi-file edit run.
    const stats = aggregateDiffStats(tools.map((t) => t.call.output));
    const tail = stats ? ` +${stats.added} −${stats.removed}` : '';
    parts.push(
      `edited ${counts.edits} ${counts.edits === 1 ? 'file' : 'files'}${tail}`,
    );
  }
  if (counts.browser)
    parts.push(`${counts.browser} browser ${counts.browser === 1 ? 'action' : 'actions'}`);
  if (counts.verifies)
    parts.push(
      `${counts.verifies === 1 ? 'verified' : `verified ${counts.verifies}×`}`,
    );
  if (counts.subagents)
    parts.push(`${counts.subagents} ${counts.subagents === 1 ? 'subagent' : 'subagents'}`);
  if (counts.other)
    parts.push(`${counts.other} other ${counts.other === 1 ? 'tool' : 'tools'}`);
  if (parts.length === 0) return `${tools.length} actions`;
  const joined = parts.join(', ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

function BlockRow({
  block,
  busy,
  workspace,
  onAllow,
  onReject,
  onRetry,
}: {
  block: RenderBlock;
  busy: boolean;
  workspace: string | null;
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
    // todo_write is rendered by the sticky TodoListPanel above the
    // message stream — no per-block card. Hide it here so the user
    // sees one canonical source of truth, not a tool log + a panel.
    if (block.call.name === 'todo_write') return null;
    return (
      <div id={`tool-${block.call.id}`} className="flex scroll-mt-4 pl-10">
        <div className="flex-1">
          <ToolCallCard call={block.call} workspace={workspace} />
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

// Curated programmer one-liners. Tasteful, single-line, dev-tone.
// No vendor jokes, no cruelty, no inside-baseball that requires a
// CS degree. Order is shuffled per session so the same joke doesn't
// always greet the user first.
const THINKING_QUIPS = [
  'Compiling neurons…',
  'Asking the rubber duck for a second opinion.',
  '99 little bugs in the code, take one down, patch it around — 117 little bugs in the code.',
  'Counting semicolons. There are too many.',
  'Doing tabs vs. spaces in my head. It\u2019s tabs.',
  'Looking up "is it Friday yet?" — no.',
  'Reading the docs. (For real this time.)',
  '`git blame`-ing past me.',
  'Pretending I read the spec.',
  'Reticulating splines.',
  'Pair-programming with my doubts.',
  'It\u2019s probably a cache issue. It\u2019s always a cache issue.',
  'Convincing the linter we\u2019re friends.',
  'Negotiating with the type system.',
  'Searching Stack Overflow archives like it\u2019s 2014.',
  'There are only two hard things — naming things, and naming things.',
  'Yes, it works on my machine.',
];

function shuffled<T>(arr: readonly T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// Animated typing-dots, plus a light one-liner that fades in only
// after 6s of silence (so fast turns never see it). Rotates every
// 5s for as long as the agent is still thinking. Jokes are ambient
// — they're the side-character, not the headliner. Cap visible
// length so a long quip doesn't reflow the bubble.
function TypingDots() {
  const [phase, setPhase] = useState(0);
  const [showQuip, setShowQuip] = useState(false);
  const quipsRef = useRef<string[]>(shuffled(THINKING_QUIPS));

  useEffect(() => {
    const startTimer = setTimeout(() => setShowQuip(true), 6_000);
    const rotateTimer = setInterval(
      () => setPhase((p) => (p + 1) % quipsRef.current.length),
      5_000,
    );
    return () => {
      clearTimeout(startTimer);
      clearInterval(rotateTimer);
    };
  }, []);

  const quip = quipsRef.current[phase] ?? '';
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex h-5 items-center gap-1">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/60 [animation-delay:0ms]" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/60 [animation-delay:200ms]" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/60 [animation-delay:400ms]" />
      </div>
      {showQuip && (
        <span
          key={phase}
          className="qcode-quip max-w-md text-[11.5px] italic leading-snug text-muted-foreground/70"
        >
          {quip}
        </span>
      )}
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

// Indicator shown when the user lands on a thread that has an
// in-flight send running server-side. qlaud's edge worker is still
// processing the upstream call (waitUntil keeps it alive even
// though we disconnected); the messages query is polling every
// 2s and will swap this for the canonical assistant turn the
// moment it lands.
function ResumeIndicator() {
  return (
    <div className="mx-auto inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-1.5 text-[11px] text-muted-foreground">
      <span className="inline-flex h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
      Still working on the previous turn — the response will appear
      here when it lands.
    </div>
  );
}

// "Load earlier turns" affordance — rendered above the chat list
// when the thread has more history than the latest page we
// fetched. Click → calls loadEarlierMessages() which fetches the
// next-older page via the before_seq cursor + prepends to the
// cached query data. No re-render flicker since we mutate the
// cache directly; the query subscriber sees the new data and
// historyToBlocks projects it.
function LoadEarlierButton({ threadId }: { threadId: string }) {
  const [loading, setLoading] = useState(false);
  return (
    <button
      onClick={async () => {
        setLoading(true);
        try {
          await loadEarlierMessages(threadId);
        } finally {
          setLoading(false);
        }
      }}
      disabled={loading}
      className="mx-auto inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/70 px-3 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-50"
    >
      {loading ? 'Loading…' : '↑ Load earlier turns'}
    </button>
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

// Latest input-token count across the blocks list — represents the
// most recent "what the model just received" snapshot, which is the
// best proxy for current conversation size given that we don't get
// a separate "context length" signal from the upstream API.
function latestInputTokens(blocks: RenderBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b?.type === 'usage' && b.inputTokens > 0) return b.inputTokens;
  }
  return 0;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

// Compact context-usage indicator. Shows token count vs the model's
// context window, with a 4-segment progress bar that escalates from
// muted → primary → amber → destructive as the conversation fills.
// At 80%+ we surface "compact" hint copy so the user knows what to
// say to qcode to free up room.
function ContextUsageChip({ used, max }: { used: number; max: number }) {
  const pct = Math.min(100, Math.round((used / max) * 100));
  const tone =
    pct >= 90
      ? 'text-destructive border-destructive/30 bg-destructive/5'
      : pct >= 75
        ? 'text-amber-700 dark:text-amber-400 border-amber-500/30 bg-amber-500/10'
        : 'text-foreground/80 border-border/60 bg-background/60';
  const barTone =
    pct >= 90 ? 'bg-destructive' : pct >= 75 ? 'bg-amber-500' : 'bg-primary';
  return (
    <span
      className={cn(
        'hidden items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium tabular-nums sm:inline-flex',
        tone,
      )}
      title={`Conversation context: ${used.toLocaleString()} / ${max.toLocaleString()} tokens (${pct}%)${pct >= 75 ? ' — say "compact this" to summarize older turns' : ''}`}
    >
      <span className="inline-flex h-1 w-10 overflow-hidden rounded-full bg-muted">
        <span
          className={cn('h-full transition-all duration-300', barTone)}
          style={{ width: `${pct}%` }}
        />
      </span>
      {formatTokens(used)} / {formatTokens(max)}
    </span>
  );
}

// Sticky checklist panel rendered above the chat blocks. The latest
// `todo_write` tool call's input is the canonical state — we walk
// the rendered blocks in reverse, find the most recent one, and
// project it. No separate store; the message history IS the truth.
//
// The panel auto-collapses when every item is `completed` so a
// finished checklist doesn't permanently eat vertical space; the
// summary stays visible (e.g. "5/5 done") so the user knows they
// landed on a clean slate.
type TodoItem = {
  content: string;
  activeForm: string;
  status: 'pending' | 'in_progress' | 'completed';
};

function TodoListPanel({ blocks }: { blocks: RenderBlock[] }) {
  const [collapsedManually, setCollapsedManually] = useState<boolean | null>(
    null,
  );

  // Walk blocks in reverse; first todo_write tool call wins.
  let latest: TodoItem[] | null = null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b?.type !== 'tool' || b.call.name !== 'todo_write') continue;
    const input = b.call.input as { todos?: unknown };
    if (Array.isArray(input?.todos)) {
      latest = input.todos.filter(
        (t): t is TodoItem =>
          !!t &&
          typeof t === 'object' &&
          typeof (t as TodoItem).content === 'string',
      );
      break;
    }
  }
  if (!latest || latest.length === 0) return null;

  const done = latest.filter((t) => t.status === 'completed').length;
  const total = latest.length;
  const allDone = done === total;
  const inProgress = latest.find((t) => t.status === 'in_progress');
  // Auto-collapse on completion, expand on first non-completed item.
  // User toggle (manual) overrides until the next list change resets it.
  const autoCollapsed = allDone;
  const collapsed = collapsedManually ?? autoCollapsed;

  return (
    <div className="rounded-xl border border-border/60 bg-background/70 px-4 py-3 backdrop-blur-sm">
      <button
        type="button"
        onClick={() => setCollapsedManually(!collapsed)}
        className="flex w-full items-center gap-2 text-left"
      >
        <span
          className={cn(
            'inline-flex h-1.5 w-1.5 shrink-0 rounded-full',
            allDone
              ? 'bg-emerald-500'
              : inProgress
                ? 'bg-primary animate-pulse'
                : 'bg-muted-foreground/40',
          )}
          aria-hidden
        />
        <span className="text-[12px] font-medium text-foreground">
          {allDone
            ? 'All done'
            : inProgress
              ? inProgress.activeForm
              : 'Plan'}
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {done}/{total}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {/* Compact progress bar — total width tracks completion %. */}
          <div className="hidden h-1 w-24 overflow-hidden rounded-full bg-muted sm:block">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-300',
                allDone ? 'bg-emerald-500' : 'bg-primary',
              )}
              style={{ width: `${(done / total) * 100}%` }}
            />
          </div>
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 text-muted-foreground transition-transform',
              collapsed && '-rotate-90',
            )}
          />
        </div>
      </button>
      {!collapsed && (
        <ul className="mt-3 space-y-1.5">
          {latest.map((t, i) => (
            <li key={i} className="flex items-start gap-2 text-[12.5px]">
              <TodoStatusIcon status={t.status} />
              <span
                className={cn(
                  'flex-1 leading-snug transition-colors',
                  t.status === 'completed'
                    ? 'text-muted-foreground line-through decoration-muted-foreground/40'
                    : t.status === 'in_progress'
                      ? 'text-foreground font-medium'
                      : 'text-foreground/85',
                )}
              >
                {t.status === 'in_progress' ? t.activeForm : t.content}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TodoStatusIcon({ status }: { status: TodoItem['status'] }) {
  if (status === 'completed') {
    return (
      <span
        className="mt-1 grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
        aria-hidden
      >
        <Check className="h-2.5 w-2.5" />
      </span>
    );
  }
  if (status === 'in_progress') {
    return (
      <span
        className="mt-1 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center"
        aria-hidden
      >
        <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
      </span>
    );
  }
  return (
    <span
      className="mt-1 h-3.5 w-3.5 shrink-0 rounded-full border border-muted-foreground/30"
      aria-hidden
    />
  );
}

function EmptyState({
  modelLabel,
  provider,
  memory,
  hasWorkspace,
  workspaceName,
  onOpenFolder,
  onPick,
}: {
  modelLabel: string;
  provider?: string;
  memory: ProjectMemory | null;
  hasWorkspace: boolean;
  workspaceName?: string;
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
        <div className="flex flex-col items-center pt-6 text-center sm:pt-12">
          <QlaudMark className="h-12 w-12 rounded-2xl shadow-sm" />
          <h2 className="mt-5 text-xl font-semibold tracking-tight sm:mt-6 sm:text-2xl">
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
      <div className="flex flex-col items-center pt-6 text-center sm:pt-12">
        <QlaudMark className="h-12 w-12 rounded-2xl shadow-sm" />
        <h2 className="mt-5 text-xl font-semibold tracking-tight sm:mt-6 sm:text-2xl">
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
  // Heading personalizes to the open folder so it feels like the
  // agent is opening *this* repo, not a generic "team": "What should
  // we build in qlaud-router?" reads like a coworker, not a tool.
  const heading = workspaceName
    ? `What should we build in ${workspaceName}?`
    : 'What can the team build?';
  return (
    <div className="flex flex-col items-center pt-12 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-2xl bg-primary/10 text-primary">
        <Sparkles className="h-5 w-5" />
      </div>
      <h2 className="mt-5 px-2 text-xl font-semibold tracking-tight sm:mt-6 sm:text-2xl">
        {heading}
      </h2>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
        Just describe it. We&rsquo;ll route to the right specialist —
        Staff, Backend, Frontend, Design, Reviewer, QA, DevOps,
        Security, Marketing, or Sales — and tell you who&rsquo;s on it.
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
      <div className="mt-8 grid w-full max-w-2xl gap-2 text-left sm:mt-10">
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
      {/* Secondary actions — Codex has a similar quiet row below the
       *  prompt list ("Connect to GitHub", "Connect your favorite
       *  apps"). We keep it project-relevant: switch folder for when
       *  the user wants to point qcode somewhere else, and a soft
       *  link to qlaud's connector marketplace for app integrations
       *  the agent can call (Slack, Linear, Notion, etc.). */}
      <div className="mt-3 flex w-full max-w-2xl flex-wrap items-center justify-center gap-3 text-[11.5px] text-muted-foreground">
        <button
          onClick={() => void onOpenFolder()}
          className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
        >
          <FolderOpen className="h-3 w-3" />
          Switch folder
        </button>
        <span className="text-border" aria-hidden>
          ·
        </span>
        <a
          href="https://qlaud.ai/connectors"
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
        >
          <Sparkles className="h-3 w-3" />
          Connect apps to your team
        </a>
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
  workspaceName,
  branch,
  mode,
  contextUsed,
  contextMax,
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
  /** Last segment of the workspace path. Renders as a pill on the
   *  composer footer so the user always sees what folder qcode is
   *  about to act on — no "wait, which repo?" surprises. */
  workspaceName?: string;
  /** Current git branch (or short SHA if detached) — null when the
   *  workspace isn't a git repo. Adds the third pill in the footer
   *  so the user catches "I'm on main, not feat/X" before sending. */
  branch?: string | null;
  /** Active mode — drives the secondary pill ("Plan" / "Agent"). */
  mode?: 'agent' | 'plan';
  /** Latest input-token count from the usage stream. Drives the
   *  context-usage chip ("32k / 200k · 16%") so users see how much
   *  headroom remains before auto-compaction kicks in. */
  contextUsed?: number;
  /** Active model's context window in tokens. */
  contextMax?: number;
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
    <div className="border-t border-border/40 bg-background/70 px-3 py-3 backdrop-blur-md sm:px-4 sm:py-4">
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
              // text-base (16px) on mobile prevents iOS Safari from
              // auto-zooming the page on focus — Safari only zooms
              // when the input's font-size is < 16px. text-sm
              // (14px) returns at sm: where we're not on touch.
              className="block w-full resize-none rounded-2xl bg-transparent px-4 py-3 text-base leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60 sm:text-sm sm:leading-6"
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
                  className="grid h-7 w-7 place-items-center rounded-md border border-border/60 bg-background text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground active:scale-95"
                  aria-label="Attach files"
                  title="Attach images, PDFs, or text files"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                </button>
                {dragging ? (
                  <span className="text-[11px] font-medium text-primary">
                    Drop to attach
                  </span>
                ) : (
                  <div className="flex items-center gap-1.5">
                    {workspaceName && (
                      <span
                        className="inline-flex max-w-[140px] items-center gap-1 truncate rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-[10.5px] font-medium text-foreground/80"
                        title={`Workspace: ${workspaceName}`}
                      >
                        <FolderOpen className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{workspaceName}</span>
                      </span>
                    )}
                    {branch && (
                      <span
                        className="hidden max-w-[120px] items-center gap-1 truncate rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-[10.5px] font-medium text-foreground/80 sm:inline-flex"
                        title={`Git branch: ${branch}`}
                      >
                        <GitBranch className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                        <span className="truncate font-mono">{branch}</span>
                      </span>
                    )}
                    {mode && (
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium',
                          mode === 'plan'
                            ? 'border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400'
                            : 'border border-border/60 bg-background/60 text-foreground/80',
                        )}
                        title={
                          mode === 'plan'
                            ? 'Plan mode — read-only, proposes changes'
                            : 'Agent mode — full toolkit'
                        }
                      >
                        {mode === 'plan' ? 'Plan' : 'Agent'}
                      </span>
                    )}
                    <span
                      className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-[10.5px] font-medium text-foreground/80"
                      title="Active model — switch in the title bar"
                    >
                      {modelLabel}
                    </span>
                    {contextUsed != null &&
                      contextMax != null &&
                      contextUsed > 0 && (
                        <ContextUsageChip
                          used={contextUsed}
                          max={contextMax}
                        />
                      )}
                    <span className="hidden text-[10.5px] text-muted-foreground sm:inline">
                      ⏎ to send · @ files
                    </span>
                  </div>
                )}
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
