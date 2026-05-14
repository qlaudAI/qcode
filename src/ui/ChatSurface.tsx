import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  FolderOpen,
  GitBranch,
  Paperclip,
  RotateCcw,
  Square,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';

import { isTauri, openExternal } from '../lib/tauri';
import { SANDBOX_AGENT_ENABLED } from '../lib/feature-flags';
import { posthog } from '../lib/analytics';

import { runThreadAgent, type AgentEvent } from '../lib/legacy/agent';
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
import { getProjectMemory, type ProjectMemory } from '../lib/legacy/memory';
import { useTextModels } from '../lib/queries';
import { planToAgentHandoff, setLastMode } from '../lib/mode-tracking';
import { getSettings } from '../lib/settings';
import type { ContentBlock, Message } from '../lib/qlaud-client';
import { type CompactionInfo } from '../lib/threads';
import { useThreadMessagesQuery } from '../lib/queries';
import { useThreadEvents } from '../lib/use-thread-events';
import { QlaudMark } from './QlaudMark';
// Spotlight was removed in alpha.196 — AionUi-side comparison
// showed the pink radial gradient was loud against the clean white
// canvas it was meant to enhance. Apple-restraint principle won:
// no ambient flourish on the empty state. Component file kept in
// components/ui/spotlight.tsx for future reuse on landing pages.
// BorderBeam unused as of alpha.195 — its interior mask blocked
// the textarea. Replaced with a non-overlaying border-color +
// ambient ring busy signal applied directly to the composer card.
// Kept as a file in components/ui/ for potential reuse on
// non-input elements (badges, cards) where the mask trick is safe.
import type { ApprovalDecision, ApprovalRequest } from '../lib/legacy/tools';
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
import { ApprovalCard } from './legacy/ApprovalCard';
import { Markdown } from './Markdown';
import { MentionMenu, getMentionResults } from './MentionMenu';
import {
  ToolCallCard,
  aggregateDiffStats,
  type ToolCallView,
} from './legacy/ToolCallCard';
import { RightRail, type RightRailView } from './RightRail';
import { loadEarlierMessages, seedLocalTitle } from '../lib/queries';
import { titleFromPrompt } from '../lib/threads';
import {
  clearInFlight,
  isInFlight,
  markInFlight,
} from '../lib/in-flight';
import {
  bumpStopGen,
  decBusy,
  incBusy,
  readRunState,
  setQueued as setQueuedInStore,
  updateBlocks,
  useThreadRunState,
} from '../lib/run-state';
import { bumpWorkspaceRevision } from '../lib/workspace-revision';

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
      /** Which named agent the orchestrator dispatched. Drives the
       *  card label + role icon. Optional for back-compat when
       *  loading old persisted threads that pre-date the registry. */
      agentType?: string;
      agentLabel?: string;
      status: 'running' | 'done' | 'error';
      /** Final text the subagent returned. Populated on subagent_done. */
      summary: string | null;
      /** Child agent's events rendered nested under this card —
       *  tool calls, text deltas, approvals, etc. produced by the
       *  subagent's runThreadAgent flow into this list so the user
       *  sees progress live instead of an opaque "running" pill. */
      innerBlocks: RenderBlock[];
    }
  | {
      type: 'checkpoint';
      result:
        | { kind: 'committed'; sha: string; message: string; filesChanged: number }
        | { kind: 'skipped'; reason: string };
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

// Web build now has a real agent (Cloudflare Sandbox under the
// hood — see engines/sandbox-agent.ts). Same toolkit as desktop:
// shell, file ops, port-expose. Sample prompts lean toward
// "build something" to showcase the wedge — these are the prompts
// that produce a live URL within ~90 seconds and convert visitors
// into installs / signups.
const WEB_SAMPLE_PROMPTS = [
  'Build me a SaaS landing page with email capture',
  'Scaffold a Vite + React app and start the dev server',
  'Make a one-page portfolio site for a designer named Maya',
  'Set up a simple API with Hono, expose it on a live URL',
];

export function ChatSurface({
  model,
  onModelChange,
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
  /** Optional callback to swap the active model. Used by retry()
   *  when an error block carries retryWithModel — the user one-
   *  clicks "Retry with Sonnet" on a plan_limit_exceeded error
   *  and we both switch the picker AND re-trigger the send. */
  onModelChange?: (slug: string) => void;
  mode?: 'chat' | 'agent' | 'plan';
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
  const models = useTextModels();
  const m = models.find((x) => x.slug === model);

  // Per-thread run state (blocks, busy, queued, runId) lives in
  // lib/run-state.ts so an off-screen send() can keep writing to
  // its slot when the user navigates to a different thread. This
  // surface is just a reactive view of "whatever's happening on
  // the thread currently displayed." Switching threadId rewires
  // the subscription; the writer for the other thread keeps going
  // and lights up the moment the user switches back.
  const runState = useThreadRunState(threadId);
  const blocks = runState.blocks as RenderBlock[];
  // "busy" = at least one send is mid-flight on this thread. With
  // Phase 2's parallel-send support (Cmd+Enter), busyCount can
  // climb above 1; the composer still shows the busy UI in that
  // case (just with the visual "N running" hint).
  const busy = runState.busyCount > 0;
  const busyCount = runState.busyCount;
  const queued = runState.queued;

  const [compaction, setCompaction] = useState<CompactionInfo | null>(null);
  const [input, setInput] = useState('');
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
  // Per-thread blocks updater factory. Bound to a specific thread
  // id at send-start; survives thread switches because it writes
  // to the run-state store, not React state. Compatibility shim
  // for the existing setState-shaped call sites — accepts either
  // a plain array (replace) or an updater function (transform).
  const setBlocksFor = useCallback(
    (id: string | null) =>
      (
        next: RenderBlock[] | ((b: RenderBlock[]) => RenderBlock[]),
      ) => {
        if (!id) return;
        if (typeof next === 'function') {
          updateBlocks(id, (b) => next(b as RenderBlock[]));
        } else {
          updateBlocks(id, () => next);
        }
      },
    [],
  );
  // setBlocks bound to the CURRENT visible thread — for hydration
  // paths and other "this surface is updating its own view" calls.
  const setBlocks = useMemo(
    () => setBlocksFor(threadId),
    [setBlocksFor, threadId],
  );
  // setBusy / setQueued bound to the active thread. Inside send(),
  // we use the store directly with the captured myThread id so
  // off-screen runs keep flipping their own thread's busy/queued
  // state without touching whatever thread the user is currently
  // viewing.
  const setQueued = useCallback(
    (q: string | null) => {
      if (!threadId) return;
      setQueuedInStore(threadId, q);
    },
    [threadId],
  );
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

  // Live cross-device sync for this thread. Opens an SSE
  // subscription against GET /v1/threads/:id/events; the hook
  // invalidates / patches react-query caches as the server emits
  // message / thread / workspace frames. Hook is a no-op when
  // threadId is null (no active thread).
  useThreadEvents(threadId);
  const lastLoadedRef = useRef<string | null>(null);
  // Thread-switch is now a NO-OP from this surface's POV — every
  // piece of per-thread state (blocks, busy, queued, runId) lives
  // in lib/run-state.ts, keyed by thread id. An off-screen run
  // keeps writing to ITS thread's slot. When the user comes back,
  // useThreadRunState's subscription rewires and the live state
  // is already there, no rehydration needed.
  //
  // The network is also unchanged: we never abort on thread-switch
  // (qlaud's tee+waitUntil finishes server-side regardless; tool-
  // using turns can't be aborted client-side without losing
  // the loop entirely). Approvals stay alive too — the approval
  // card lives in the off-screen thread's blocks; when the user
  // comes back they can click it and the resolveApproval module
  // routes the answer back to the still-running loop. Only an
  // explicit Stop (see stop() below) bumps the runId and kills.
  const lastThreadIdRef = useRef(threadId);
  useEffect(() => {
    lastThreadIdRef.current = threadId;
  }, [threadId]);

  useEffect(() => {
    if (busy) return;
    if (!threadId) {
      setBlocks([]);
      lastLoadedRef.current = null;
      return;
    }

    // If the run-state store already has live blocks for this
    // thread (off-screen run wrote to it while we were away, OR a
    // run on this surface just populated it) — trust the store and
    // skip server hydration. Subscription via useThreadRunState
    // already wired the live updates into `blocks` above; clobbering
    // with stale server history would replace tool cards / partial
    // text with the persisted-only final assistant message.
    if (lastLoadedRef.current !== threadId && blocks.length > 0) {
      lastLoadedRef.current = threadId;
      return;
    }

    // Engine Mode rehydrate. When engine === 'claude-code' the
    // qcode-legacy path's messagesQuery returns nothing because the
    // conversation never went through `/v1/threads/:id/messages`.
    // But qlaud edge mirrors Engine Mode requests into the SAME
    // `thread_messages` table (keyed by Claude's session id), so we
    // can read the conversation back via the standard
    // `GET /v1/threads/:sid/messages` endpoint with full seq pagination
    // and ownership checks. Same data shape ChatSurface already
    // renders for the legacy path → historyToBlocks works unchanged.
    const engine = getSettings().engine;
    if (engine === 'claude-code') {
      if (lastLoadedRef.current === threadId) return;
      lastLoadedRef.current = threadId;
      let cancelled = false;
      void (async () => {
        const [{ getClaudeSessionId }, { getRemoteThreadMessages }] =
          await Promise.all([
            import('../lib/engines/claude-code'),
            import('../lib/threads'),
          ]);
        const sessionId = getClaudeSessionId(threadId);
        // Two cases land in this branch when engine === 'claude-code':
        //   1. Engine-mode thread that already had a turn → sessionId
        //      maps to claude's session id (messages persisted under
        //      that key in thread_messages).
        //   2. A thread NOT yet associated with a claude session —
        //      either (a) fresh, never sent, or (b) created via web /
        //      qcode-legacy where messages were persisted under the
        //      qcode threadId itself. Case (b) is by far the more
        //      common one: any thread the user created in the browser
        //      has no claudeSessionByThread mapping on this device.
        // Falling back to threadId as the fetch key handles both: the
        // edge's GET /v1/threads/:id/messages is keyed by the row id,
        // which is whatever was used when the thread was created.
        // Without this fallback, opening a web-created thread on
        // desktop while engine=claude-code renders an empty welcome
        // state.
        const fetchKey = sessionId || threadId;
        try {
          const result = await getRemoteThreadMessages(fetchKey, {
            limit: 200,
          });
          if (cancelled) return;
          if (result.messages.length > 0) {
            setBlocks(historyToBlocks(result.messages));
          } else {
            setBlocks([]);
          }
        } catch {
          // 404 = nothing persisted yet under either key (first turn
          // in flight or a brand-new chat), network errors = transient.
          // Leave blocks empty rather than blanking what's on screen.
        }
      })();
      return () => {
        cancelled = true;
      };
    }

    // Legacy path — qlaud-thread fetch.
    if (!messagesQuery.data) return;
    // Normal navigation: skip if we've already rendered this thread
    // once (avoids the post-send overwrite that strips usage pills).
    // Resume case: when the thread is in-flight, bypass the gate so
    // every poll refetch lands in the UI the moment qlaud persists
    // the new assistant turn. Two ways a thread can be in-flight:
    //   1. LOCAL — markInFlight() was called in this tab at
    //      send-start.
    //   2. SERVER-DERIVED — the latest persisted message is
    //      role='user' with no following assistant. Means the
    //      worker is still writing the turn (this tab just
    //      reloaded mid-turn, or another tab kicked it off).
    // Without the server-derived branch, a mid-turn reload reads
    // the half-written history once and never refetches, so the
    // user-visible conversation appears to freeze / disappear.
    const lastMsg =
      messagesQuery.data.messages[messagesQuery.data.messages.length - 1];
    const serverInFlight = lastMsg?.role === 'user';
    const polling = isInFlight(threadId) || serverInFlight;
    if (!polling && lastLoadedRef.current === threadId) return;
    lastLoadedRef.current = threadId;
    setBlocks(historyToBlocks(messagesQuery.data.messages));
    setCompaction(messagesQuery.data.compaction);
  }, [threadId, busy, messagesQuery.data]);

  // Background-fill: after the first 15 messages render, silently
  // pull the next page so "Load earlier" is instant when the user
  // scrolls up. Bounded — one fire per thread mount, only when the
  // first fetch revealed there's more to load. Costs one extra
  // round-trip per thread visit (~300ms server time) in exchange
  // for zero-latency scroll-back.
  const backgroundFillFiredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!threadId) return;
    if (busy) return;
    if (!messagesQuery.data?.hasMore) return;
    if (backgroundFillFiredRef.current === threadId) return;
    backgroundFillFiredRef.current = threadId;
    // Fire-and-forget — failures are silent (the "Load earlier"
    // button still works on demand).
    void loadEarlierMessages(threadId).catch(() => {
      backgroundFillFiredRef.current = null; // allow retry on next mount
    });
  }, [threadId, busy, messagesQuery.data?.hasMore]);

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

  function retry(
    retryInputs: {
      text: string;
      images: AttachedImage[];
      documents: AttachedDocument[];
      textFiles: AttachedText[];
      attached: string[];
    },
    /** Optional model swap before re-sending. Used by the
     *  retryWithModel button on plan-tier 402 errors so the user
     *  one-clicks past a cap without re-typing or fiddling with
     *  the model picker. The model state lives in the parent and
     *  feeds back via onModelChange; we update it BEFORE the
     *  microtask so send() reads the new value from props. */
    modelOverride?: string,
  ) {
    // Mark every still-retryable error block as resolved so we don't
    // show a stale Retry; the new turn either succeeds or pushes its
    // own fresh error block.
    setBlocks((bs) =>
      bs.map((b) =>
        b.type === 'error' && b.retry ? { ...b, retry: null } : b,
      ),
    );
    if (modelOverride && modelOverride !== model) {
      onModelChange?.(modelOverride);
    }
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

  async function send(text: string, opts: { parallel?: boolean } = {}) {
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
    // Default Enter path bails if busy — the user's intent is "wait
    // for current to finish, then run mine" (handled by sendOrQueue
    // below). The parallel path (Cmd/Ctrl+Enter) explicitly opts
    // into firing alongside whatever's running.
    if (busy && !opts.parallel) return;
    // Clear input only when this is the live-typed path (text ===
    // current input). The queued-fire path (busy lifted, queued
    // dispatch) passes a snapshot from `queued`; meanwhile the user
    // may have already started typing the NEXT message into the
    // textarea — wiping it would destroy what they're composing.
    if (input === text) setInput('');
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

    // Resolve the target thread NOW. Every per-thread state update
    // below — busy, queued, blocks (the user_text bubble, tool
    // cards, error blocks, usage pills), runId — targets THIS
    // thread, not whatever thread happens to be visible at update
    // time. That decoupling is what enables off-screen runs: when
    // the user navigates to a different thread mid-stream, this
    // send() keeps writing to its captured myThread slot, and
    // useThreadRunState in any later ChatSurface mount picks it
    // up live the moment the user comes back.
    //
    // Most sends pay zero latency here (existing thread →
    // ensureThreadId returns instantly with the prop value);
    // a fresh-chat first send pays one ~200ms POST /v1/threads.
    let myThread: string;
    try {
      myThread = await ensureThreadId();
    } catch (e) {
      // Pre-alpha.181 this was a silent return — the send vanished
      // and the user saw nothing. Now surface the failure so they
      // know to retry / switch workspace / sign in. Most common
      // cause: workspace_id in the local registry doesn't exist
      // server-side (id mismatch between alpha.176 local registry
      // and alpha.177+ server registry). The server fallback in
      // qlaud_router routes/threads.ts handles the easy case;
      // anything else (auth lapse, network blip) bubbles here.
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[ChatSurface] ensureThreadId failed:', msg);
      setError(`Couldn't start the chat: ${msg}. Try again, or click + New chat.`);
      return;
    }
    if (!myThread) return;
    lastSendThreadRef.current = myThread;

    // Seed an optimistic sidebar title from the user's first prompt
    // SO that a mid-turn reload shows a real label instead of the
    // "New chat" placeholder. seedLocalTitle is a no-op when the
    // thread already has a server-issued title — protects against
    // wiping a real LLM-generated title on a 2nd, 3rd, ... message.
    // The LLM-regen at onTurnLanded still fires and replaces this
    // placeholder with a content-aware title once the turn lands;
    // server is still the only PATCH writer.
    if (userMsg && userMsg.trim().length > 0) {
      seedLocalTitle(myThread, titleFromPrompt(userMsg));
    }
    // Pre-mark the thread as already-loaded so the rehydrate
    // effect doesn't refetch + clobber the live blocks the moment
    // busy flips back to false on this thread.
    lastLoadedRef.current = myThread;

    // Per-thread setter bound to the captured myThread. Survives
    // any thread switch the user does mid-stream.
    const myUpdateBlocks = (
      next: RenderBlock[] | ((b: RenderBlock[]) => RenderBlock[]),
    ): void => {
      if (typeof next === 'function') {
        updateBlocks(myThread, (b) => next(b as RenderBlock[]));
      } else {
        updateBlocks(myThread, () => next);
      }
    };

    myUpdateBlocks((b) => [
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
    incBusy(myThread);
    abortRef.current = new AbortController();
    // Per-thread stopGen capture. Bumped ONLY by stop() — a
    // follow-up send on the same thread (parallel run via Cmd+
    // Enter) does NOT bump it, so multiple sends share the same
    // stopGen until the user explicitly stops them all. Each
    // send's events check the captured value against the live
    // store value before mutating; mismatch = stopped, bail.
    const stopGen = readRunState(myThread).stopGen;

    // qlaud's qlaud.done event ships cost_micros — its authoritative
    // count, markup included. We capture it on the finished event
    // alongside token counts. No more pre/post balance fetch math.
    const startMs = Date.now();
    let finished: {
      usage: { inputTokens: number; outputTokens: number };
      costUsd: number | null;
      seq: number | null;
    } | null = null;
    // Tracks whether ANY event arrived during the run. Detects the
    // silent-failure mode where the SSE stream returns 200 + closes
    // immediately with no body (server crash, thread in bad state).
    // Without this, the user sees nothing happen on send and has no
    // signal that anything went wrong.
    let eventsSeen = 0;
    let seenContent = false;

    try {
      // Track this send as in-flight so the sidebar shows a
      // running indicator on this thread when the user navigates
      // away. The seq floor is the highest seq currently in the
      // cached history; hasLanded() looks for an assistant turn
      // past that seq to detect "the new turn arrived." Cleared
      // on success in the finally block; left in place if the
      // user abandons (server keeps running via waitUntil).
      const cachedHistory = messagesQuery.data;
      const seqFloor =
        cachedHistory?.messages.reduce(
          (max, m) => Math.max(max, m.seq ?? 0),
          0,
        ) ?? 0;
      markInFlight(myThread, seqFloor);
      // Stale-run check — if stop() bumped the runId between
      // send-start and this point, bail. Note: thread-switch does
      // NOT bump the runId anymore (off-screen runs keep going),
      // only stop() and re-send-on-same-thread invalidate.
      if (stopGen !== readRunState(myThread).stopGen) return;

      const settingsAtSend = getSettings();

      // Engine Mode branch. With settings.engine === 'claude-code'
      // we spawn the official Claude Code CLI inside the user's
      // workspace, with ANTHROPIC_BASE_URL pointing at qlaud, and
      // surface its stream-json output via the same AgentEvent
      // pipeline. Anthropic owns the agent loop; qlaud is the
      // transport. See src/lib/engines/claude-code.ts.
      //
      // Critical: the legacy path requires a thread persisted on the
      // qlaud edge. The Claude Code path persists nothing server-side
      // for the conversation state — claude stores it on disk via
      // its session_id. Both still need a workspace open (claude
      // can't usefully run without one).
      const sharedOnEvent = (e: AgentEvent) => {
        // Stale-run guard: drop events from a run that's been
        // superseded by an explicit Stop (or, in Phase 2, a
        // follow-up send on the same thread). Note: thread-switch
        // does NOT bump the runId — off-screen runs SHOULD keep
        // mutating their own thread's slot.
        if (stopGen !== readRunState(myThread).stopGen) return;
        // Track that *something* arrived so we can detect "stream
        // returned 200 but produced zero events" — a silent failure
        // mode where the user sees nothing happen on send.
        eventsSeen += 1;
        // Track content-bearing events specifically. If the stream
        // ends with 'finished' but seenContent stayed false, the
        // model returned nothing useful (rate limit, over-aggressive
        // server-side compaction sent an empty prompt, etc.) and we
        // should surface a real error instead of a silent 0/0/0 pill.
        if (
          e.type === 'text' ||
          e.type === 'tool_progress' ||
          e.type === 'tool_done'
        ) {
          seenContent = true;
        }
        if (e.type === 'finished') {
          finished = {
            usage: e.usage,
            costUsd: e.costUsd,
            seq: e.seq,
          };
        }
        // Workspace-revision tick: when the agent finishes a tool
        // call, bump the global workspace-revision counter so the
        // Media / Files / Diff right-rail tabs re-scan and pick
        // up any newly-created or modified files. We bump on
        // EVERY tool_done — overly broad (read-only tools like
        // Read also bump) but cheap, and it guarantees the user
        // never sees stale right-rail state after agent activity.
        if (e.type === 'tool_done') {
          bumpWorkspaceRevision();
        }
        // Critical: route through myUpdateBlocks (bound to the
        // captured myThread), NOT the surface-bound setBlocks. If
        // the user navigated to a different thread, setBlocks
        // would write events into the WRONG thread's slot. The
        // store decouples writer thread from active view.
        handleEvent(e, myUpdateBlocks);
      };

      // Engine Mode requires Tauri's shell plugin to spawn the
      // local `claude` binary. On web (qcode-web), Tauri isn't
      // available — force-fallback to the legacy path even if
      // settings.engine carried over from a desktop session.
      // (The settings drawer also hides the Claude Code option
      // on web, but defensive at send time is cheap.)
      //
      // Additional fallback: claude-code engine spawns a subprocess
      // in the workspace folder. If the user is on desktop but
      // hasn't opened a folder yet, route through qcode-legacy
      // (the same chat-only path qcode-web uses) instead of
      // erroring. The user gets pure conversation; once they open
      // a folder, the claude-code engine takes over for tool-using
      // turns. Mirrors the web experience for chat-only usage.
      // Three engine paths picked from (mode × platform):
      //   - claude-code   → Tauri sidecar (desktop only; needs workspace
      //                     folder; the original Engine Mode v0 path).
      //   - sandbox-agent → Cloudflare Sandbox SDK over HTTP (web build,
      //                     agent or plan mode; container's /workspace
      //                     replaces the local folder; lazy-bootstraps
      //                     claude on first session turn). Same
      //                     JSON-line wire format as desktop, so the
      //                     reducer in this file doesn't change.
      //   - qcode-legacy  → cheap chat-only path (mode='chat' anywhere,
      //                     OR desktop without a folder). Just streams
      //                     /v1/messages; no tools, no sandbox cost.
      //
      // Intent classifier (alpha.183): even if the user (or saved
      // settings) has mode='agent', a one-word "hi" or "thanks"
      // doesn't need the full sandbox container + GitLab restore.
      // Downshift the effective mode based on prompt content so
      // chat-style prompts always land on the cheap chat path.
      //
      // Bias rules (see lib/intent-classifier.ts):
      //   * prompt <6 chars → always chat (greetings)
      //   * "what / why / explain" without an agent verb → chat
      //   * agent verbs ("build", "fix", "run", "commit") → agent
      //   * 'plan' mode is preserved (user-explicit read-only intent)
      //
      // threadIsAgentic is true when the active workspace is the
      // sandbox-backed kind (we already have GitLab state attached);
      // ambiguous follow-ups in an agentic thread stay on agent.
      const { classifyIntent } = await import('../lib/intent-classifier');
      const intentResult = classifyIntent({
        prompt: userMsg,
        // Active workspace has a GitLab repo attached → thread is
        // already agentic; ambiguous follow-ups stay on agent.
        threadIsAgentic: !!workspace?.gitlabProjectPath,
      });
      let effectiveMode: typeof mode = mode;
      if (mode === 'agent' && intentResult.intent === 'chat') {
        effectiveMode = 'chat';
        // Telemetry hook — useful when tuning the classifier; safe
        // to leave on in prod since it's once per send.
        console.log(
          '[intent-classifier] downshifted agent→chat:',
          intentResult.reason,
        );
      } else if (mode === 'chat' && intentResult.intent === 'agent') {
        effectiveMode = 'agent';
        console.log(
          '[intent-classifier] upshifted chat→agent:',
          intentResult.reason,
        );
      }

      // Mode gating: 'chat' NEVER provisions a sandbox or spawns a
      // sidecar — the user explicitly opted into 'agent'/'plan' for
      // those. Keeps default-mode usage cheap and matches user
      // intent ("I'm just having a conversation" vs "build me X").
      const wantsRealAgent = effectiveMode === 'agent' || effectiveMode === 'plan';
      // Gate the sandbox path. When SANDBOX_AGENT_ENABLED is false
      // (web build, current default), Agent + Plan from any source
      // (saved settings, deep link) fall through to qcode-legacy
      // instead of trying to spin up a container that's gated off.
      // The mode toggle in App.tsx already coerces user-facing
      // selections to 'chat'; this is the safety net for
      // programmatic paths.
      const engineMode = !wantsRealAgent
        ? 'qcode-legacy'
        : isTauri() && !!workspace?.path
          ? 'claude-code'
          : !isTauri() && SANDBOX_AGENT_ENABLED
            ? 'sandbox-agent'
            : 'qcode-legacy';

      if (engineMode === 'claude-code') {
        const { runEngineClaudeCode, getClaudeSessionId, setClaudeSessionId } =
          await import('../lib/engines/claude-code');
        await runEngineClaudeCode({
          sessionId: getClaudeSessionId(myThread),
          onSessionId: (sid) => setClaudeSessionId(myThread, sid),
          model,
          qcodeThreadId: myThread,
          // workspace is non-null here — engineMode === 'claude-code'
          // gates on !!workspace?.path above.
          workspace: workspace!.path,
          content: userContent,
          signal: abortRef.current.signal,
          onEvent: sharedOnEvent,
        });
      } else if (engineMode === 'sandbox-agent') {
        const { runEngineSandboxAgent } = await import(
          '../lib/engines/sandbox-agent'
        );
        await runEngineSandboxAgent({
          // No claude --resume on the sandbox engine yet; sessionId
          // is repurposed for the sandbox container id (set inside
          // the engine via onSessionId callback). Pass null so the
          // engine mints a fresh one if needed.
          sessionId: null,
          onSessionId: () => {
            // Sandbox session id isn't useful to ChatSurface state
            // for v1 — it lives in the runtime/sandbox-session
            // module. Persisting it would require a separate
            // ledger; punt until the multi-turn refactor.
          },
          model,
          qcodeThreadId: myThread,
          // Per-workspace container isolation (alpha.179): pin the
          // mint to this workspace's id so the engine targets the
          // right Sandbox DO. Null on chat threads pre-promotion;
          // the engine falls back to the thread id as a cache key
          // and the server's qcode_session_rebound event updates
          // the cache once the implicit promotion lands.
          workspaceId: workspace?.id ?? null,
          // mode is 'agent' or 'plan' here (engineMode==='sandbox-agent'
          // is gated on effectiveMode!=='chat' in the dispatcher above).
          // Type narrowing is fine; cast through the union to satisfy TS.
          mode: effectiveMode === 'plan' ? 'plan' : 'agent',
          // workspace passed for contract uniformity; the sandbox
          // engine ignores it (cwd is /workspace inside the
          // container).
          workspace: workspace?.path ?? '/workspace',
          content: userContent,
          signal: abortRef.current.signal,
          onEvent: sharedOnEvent,
        });
      } else {
        await runThreadAgent({
          threadId: myThread,
          model,
          // Legacy agent only knows 'agent' | 'plan' — our new 'chat'
          // mode is a SUPER-mode that means "don't provision a
          // sandbox/sidecar; just stream /v1/messages." For the
          // legacy path's own internal switches (read-only tool
          // gating etc.) it maps cleanly to 'agent'. The dispatcher
          // above already routed us here BECAUSE effectiveMode==='chat',
          // so passing 'agent' is benign — there are no tools in this
          // path either way.
          mode: effectiveMode === 'chat' ? 'agent' : effectiveMode,
          workspace: workspace?.path ?? null,
          content: userContent,
          // Read at send time so toggling the setting takes effect on
          // the very next turn without a remount.
          enableConnectors: settingsAtSend.enableConnectors,
          autoApprove: settingsAtSend.autoApprove,
          autoCommit: settingsAtSend.autoCommit,
          signal: abortRef.current.signal,
          onEvent: sharedOnEvent,
          onApproval: (toolUseId, _request) =>
            new Promise<ApprovalDecision>((resolve) => {
              // Auto-reject if the run was explicitly stopped (runId
              // bumped). Off-screen runs keep waiting for approval
              // — the user can come back and click; the approval
              // card lives in the thread's blocks until resolved.
              if (stopGen !== readRunState(myThread).stopGen) {
                resolve('reject');
                return;
              }
              registerApproval(toolUseId, resolve);
            }),
        });
      }

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
        threadId: myThread,
        assistantSeq: finalSeq,
      });
      setLastMode(myThread, mode);

      // Stop-bumped runId guard. Off-screen runs proceed normally
      // here; only an explicit Stop or follow-up send on this same
      // thread bumps the runId and short-circuits this final UI
      // update phase.
      if (stopGen !== readRunState(myThread).stopGen) return;

      // Silent-failure detection: stream completed (no throw) but no
      // events arrived AND no `finished` event landed. Most common
      // cause is the edge worker crashing mid-stream after returning
      // headers. Without this surface, the user sees their message
      // bubble + nothing else and has no idea why. Show an explicit
      // error block so they can retry or report.
      if (eventsSeen === 0 && !finished) {
        myUpdateBlocks((b) => [
          ...b,
          {
            type: 'error',
            presentation: mapError('empty_stream'),
            retry: retryInputs,
          },
        ]);
        posthog.capture('turn_failed', { model, mode, code: 'empty_stream' });
      }

      if (finished) {
        const f: {
          usage: { inputTokens: number; outputTokens: number };
          costUsd: number | null;
        } = finished;
        // Empty-turn detection. A turn that "finished" without
        // emitting ANY content events (text / tool_call / tool_result
        // / thinking) means the model returned nothing useful —
        // most often because qlaud's pre-emptive compaction sent a
        // near-empty prompt, the model rate-limited, or the upstream
        // silently truncated. Surface this as a real error instead
        // of just showing the 0/0/0/Xs pill the user can't diagnose.
        // Falls through to the normal usage pill so cost telemetry
        // stays attached.
        if (!seenContent) {
          myUpdateBlocks((b) => [
            ...b,
            {
              type: 'error',
              presentation: mapError('empty_stream'),
              retry: retryInputs,
            },
          ]);
          posthog.capture('turn_failed', { model, mode, code: 'empty_stream_zero_tokens' });
        }
        myUpdateBlocks((b) => [
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
      // PaymentRequiredError carries the qcode plan_context payload —
      // pull it through so the upgrade card shows real numbers
      // ("47/200 mid messages today") instead of a generic message.
      const planCtx =
        e instanceof Error && 'planContext' in e
          ? (e as { planContext?: ErrorContext['plan'] }).planContext
          : undefined;
      posthog.capture('turn_failed', { model, mode, code });
      // Inline error block with retry context. Image-error / network
      // banner state stays for transient toasts that don't make sense
      // to "retry" (image too big, etc.).
      myUpdateBlocks((b) => [
        ...b,
        {
          type: 'error',
          presentation: mapError(code, planCtx ? { plan: planCtx } : undefined),
          retry: retryInputs,
        },
      ]);
    } finally {
      // If this run was explicitly stopped, leave the in-flight
      // marker around so the polling loop doesn't claim "the
      // turn must've landed" prematurely. Normal completions
      // clear it. The run-state store keeps the blocks for the
      // visible thread regardless — those are canonical now.
      // Decrement busy regardless of stop status — the slot is
      // free, the counter should reflect that. Floored at 0 inside
      // decBusy, so a stop() that already reset state can't push
      // us into negative-busy weirdness.
      decBusy(myThread);
      if (
        stopGen === readRunState(myThread).stopGen &&
        lastSendThreadRef.current
      ) {
        clearInFlight(lastSendThreadRef.current);
      }
      abortRef.current = null;
      // Drop any leftover resolvers — covers the case where streaming
      // bails before the loop reaches the awaiting Promise.
      rejectAllApprovals();
    }
  }

  function stop() {
    // Stop applies to the CURRENTLY VISIBLE thread. Bumping
    // stopGen on this thread invalidates ALL active runs on this
    // thread (Phase 2 introduced parallel sends — Stop kills them
    // all in one click). Each running send sees its captured
    // stopGen no longer matches the live value and starts dropping
    // its events. Off-screen runs on OTHER threads are unaffected.
    if (threadId) {
      bumpStopGen(threadId);
    }
    abortRef.current?.abort();
    rejectAllApprovals();
    // Stop is also "abandon what I had planned" — drop any queued
    // follow-up so the busy-flip effect doesn't auto-fire it.
    setQueued(null);
    if (threadId) {
      clearInFlight(threadId);
    }
  }

  /** Composer entry point. While busy, stashes the message into
   *  `queued` instead of bailing — the busy-flip effect below picks
   *  it up the moment the current turn lands. Drops empty/no-attach
   *  sends so a stray Enter doesn't queue an empty turn. */
  function sendOrQueue(text: string, opts: { parallel?: boolean } = {}) {
    const trimmed = text.trim();
    // Parallel path (Cmd+Enter) — fire alongside whatever's
    // running. Skip the queue, both runs operate concurrently on
    // the same thread. Each run captures its own threadId + stopGen
    // and writes to the run-state store independently; events from
    // both interleave naturally in the blocks list.
    if (opts.parallel) {
      setInput('');
      void send(text, { parallel: true });
      return;
    }
    if (busy) {
      // Nothing to queue if there's no actual content. Attachments
      // are intentionally NOT carried into the queue snapshot — they
      // travel with the active textarea state and will be picked up
      // by send() when the queued fire happens (any attachments the
      // user added while busy are still in `attached/images/...`).
      if (!trimmed) return;
      setQueued(trimmed);
      setInput('');
      return;
    }
    void send(text);
  }

  // Busy-flip dispatcher. When the current turn lands (busy true →
  // false) and there's a queued message, fire it. Wrapped in a
  // microtask via the dependency-driven effect — React has already
  // flushed state by the time this runs.
  useEffect(() => {
    if (busy) return;
    if (!queued) return;
    const text = queued;
    setQueued(null);
    void send(text);
    // We deliberately don't depend on `send` (it captures fresh
    // state on every render and we'd loop). Reading the latest send
    // via closure is the standard React pattern for this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queued]);

  const empty = blocks.length === 0;

  // Top-of-chat activity pill: when the agent is mid-turn and a
  // tool is running, show a sticky pill at the top of the scroll
  // viewport so the user knows what's happening even after they
  // scroll up to read earlier turns. Mirrors the inline TypingDots
  // activity but with always-visible affordance.
  const stickyActivity = busy ? deriveCurrentActivity(blocks) : null;
  // Derive the latest detected dev-server URL from bash outputs in
  // this thread. When set, surface a "Browse →" chip near the
  // activity pill so the user can click straight to the running
  // server (Vite/Next/Astro/etc. — port-agnostic).
  const detectedDevUrl = useMemo(() => deriveDevServerUrl(blocks), [blocks]);

  // Workspace-wide drag-and-drop. Drop files anywhere in the chat
  // surface (messages area, header strip, anywhere) and they get
  // ingested into the composer's attachment slots. The composer
  // itself still has its own onDrop handler for backwards-compat
  // and tighter visual feedback inside the textarea — both paths
  // fan into the same setImages/setDocuments/setTextFiles state.
  const [surfaceDragging, setSurfaceDragging] = useState(false);
  async function ingestDroppedFiles(list: File[]) {
    const { readUploadedFile } = await import('../lib/uploads');
    for (const f of list) {
      const result = await readUploadedFile(f);
      if ('reason' in result) {
        setError(result.message);
        continue;
      }
      if (result.kind === 'image') setImages((prev) => [...prev, result]);
      else if (result.kind === 'document')
        setDocuments((prev) => [...prev, result]);
      else setTextFiles((prev) => [...prev, result]);
    }
  }
  function onSurfaceDragEnter(e: React.DragEvent) {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    setSurfaceDragging(true);
  }
  function onSurfaceDragOver(e: React.DragEvent) {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }
  function onSurfaceDragLeave(e: React.DragEvent) {
    // Only clear when the drag leaves the OUTER container (not when
    // it crosses a child boundary). The relatedTarget is null when
    // the drag exits the window entirely; otherwise it's the next
    // element under the cursor — if that's still inside us, ignore.
    if (
      e.relatedTarget &&
      e.currentTarget.contains(e.relatedTarget as Node)
    ) {
      return;
    }
    setSurfaceDragging(false);
  }
  async function onSurfaceDrop(e: React.DragEvent) {
    setSurfaceDragging(false);
    const { filesFromDrop } = await import('../lib/uploads');
    const list = filesFromDrop(e.nativeEvent);
    if (list.length === 0) return;
    e.preventDefault();
    await ingestDroppedFiles(list);
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-qcode-selectable="true">
      <div
        className={cn(
          'relative flex min-h-0 min-w-0 flex-1 flex-col',
          // alpha.193: when empty, center BOTH the hero AND the
          // composer as one block (Codex pattern). Scroll-area is
          // sized to its natural content; composer follows below;
          // parent's justify-center centers the pair vertically.
          // When non-empty, the scroll area greedily takes flex-1
          // and the composer pins to the bottom as before.
          empty && 'justify-center',
        )}
        onDragEnter={onSurfaceDragEnter}
        onDragOver={onSurfaceDragOver}
        onDragLeave={onSurfaceDragLeave}
        onDrop={onSurfaceDrop}
      >
      {/* Surface-wide drop overlay — visible only while a drag is
       *  hovering the chat surface. Pointer-events-none so the
       *  overlay itself doesn't intercept the drop event; the
       *  parent's handler catches it. */}
      {surfaceDragging && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/60 bg-primary/[0.06] backdrop-blur-[2px]">
          <div className="rounded-md border border-primary/30 bg-background px-4 py-2 text-[13px] font-medium text-primary shadow-md">
            Drop to attach
          </div>
        </div>
      )}
      <div
        ref={scrollRef}
        className={cn(
          'relative min-h-0 min-w-0 overflow-y-auto',
          // When empty: natural height so the parent's
          // justify-center can stack hero + composer mid-viewport.
          // When non-empty: greedy flex-1 so messages scroll and
          // the composer pins to the bottom of the viewport.
          empty ? '' : 'flex-1',
        )}
      >
        <StickyActivityBar activity={stickyActivity} devUrl={detectedDevUrl} />
        {/* Session-switch fade. Keying the inner container on threadId
         *  makes motion re-mount and fade the chat in when the user
         *  switches threads. Subtle 200ms — enough to register
         *  visually as "this is a different conversation" without
         *  feeling sluggish. New chat (threadId=null) reuses the
         *  same key so the empty state also fades.
         *
         *  alpha.191: when the conversation is empty, vertically
         *  center the content in the scroll area instead of pinning
         *  to top. This is what makes the hero feel "Codex-like" —
         *  the headline + chips sit mid-viewport with the composer
         *  pinned just below, rather than the headline at top with
         *  a huge dead gap and the composer floating at the very
         *  bottom. Non-empty conversations keep the natural
         *  top-to-bottom message flow. */}
        <motion.div
          key={threadId ?? '__new__'}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className={cn(
            'mx-auto w-full max-w-[42rem] px-3 sm:px-4',
            // alpha.193: parent column now handles vertical centering
            // for the empty state (justify-center on the chat col),
            // so this container reverts to natural padding. The
            // alpha.191 min-h-full flex-center was fighting the new
            // parent layout.
            empty ? 'pb-6 pt-12' : 'py-6 sm:py-8',
          )}
        >
          {empty ? (
            // Three sub-states share the empty-blocks condition:
            //   1. threadId set + messages still loading → user
            //      deep-linked to a thread (URL nav, sidebar click,
            //      reload). Show a loading indicator so they know
            //      content is coming — NOT the "what do you want
            //      to build?" empty state which makes the surface
            //      look like a fresh chat.
            //   2. threadId set + load done + actually empty (just-
            //      created thread, no turns yet) → empty state
            //      (rare path; titled threads always have ≥1 turn).
            //   3. threadId null → real new-chat empty state.
            threadId && messagesQuery.isLoading ? (
              <ThreadLoadingState />
            ) : (
              <EmptyState
                modelLabel={m?.label ?? model}
                provider={m?.provider}
                memory={memory}
                hasWorkspace={hasWorkspace}
                workspaceName={workspaceName}
                onOpenFolder={onOpenFolder}
                onPick={(s) => setInput(s)}
              />
            )
          ) : (
            // Vertical rhythm: each row owns its top margin (no
            // parent gap-) so we can give DIFFERENT spacing within
            // a turn (text → tool → text, tight) vs across turns
            // (user_text → assistant, breathe). The turn-boundary
            // class is set per row below based on its relationship
            // to the predecessor.
            <div className="flex flex-col">
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
              {(() => {
                const groups = groupBlocks(blocks);
                const toolCostShares = computeToolCostShares(blocks);
                // Track the prior group's "side" — 'user' or
                // 'assistant'. Anything that isn't user_text reads
                // as the assistant's response stream (tool dispatch,
                // tool bundle, assistant text, subagent, finished
                // marker, error, etc. — all part of the response).
                let prevSide: 'user' | 'assistant' | null = null;
                return groups.map((group, gi) => {
                  const groupSide: 'user' | 'assistant' =
                    group.type === 'single' && group.block.type === 'user_text'
                      ? 'user'
                      : 'assistant';
                  // Turn boundaries: user_text appears, OR an
                  // assistant block follows a user_text. Between
                  // turns we breathe (mt-10 = 40px); within a turn
                  // (assistant→assistant) we keep tight (mt-3 = 12px).
                  // First row has no top margin.
                  const isTurnBoundary =
                    gi !== 0 &&
                    (groupSide !== prevSide || groupSide === 'user');
                  const marginClass =
                    gi === 0 ? '' : isTurnBoundary ? 'mt-10' : 'mt-3';
                  prevSide = groupSide;

                  if (group.type === 'tool-bundle') {
                    return (
                      <div key={`bundle-${gi}`} className={marginClass}>
                        <ToolBundle
                          tools={group.tools}
                          workspace={workspacePath ?? null}
                          toolCostShares={toolCostShares}
                        />
                      </div>
                    );
                  }
                  const b = group.block;
                  const i = group.index;
                  // Subtle entry per row: user messages slide in from
                  // the right (matching the bubble's alignment),
                  // everything else fades up. motion's `initial` only
                  // runs on first mount so existing rows don't
                  // re-animate on each text-delta.
                  const isUser = b.type === 'user_text';
                  // Contextual typing indicator. When the agent is
                  // mid-turn AND a tool is currently running, surface
                  // "Reading src/foo.ts..." instead of generic dots —
                  // the same lived-in feel Codex/Claude.ai have. Only
                  // computed for the LAST block (where TypingDots
                  // would render) to avoid useless work elsewhere.
                  const isLast = i === blocks.length - 1;
                  const activity =
                    isLast && busy ? deriveCurrentActivity(blocks) : null;
                  return (
                    <motion.div
                      key={i}
                      className={marginClass}
                      initial={{
                        opacity: 0,
                        x: isUser ? 8 : 0,
                        y: isUser ? 0 : 4,
                      }}
                      animate={{ opacity: 1, x: 0, y: 0 }}
                      transition={{
                        duration: 0.22,
                        ease: [0.32, 0.72, 0, 1],
                      }}
                    >
                      <BlockRow
                        block={b}
                        workspace={workspacePath ?? null}
                        busy={busy && isLast}
                        activity={activity}
                        toolCostShares={toolCostShares}
                        onAllow={() =>
                          b.type === 'approval' ? decide(b.id, 'allow') : undefined
                        }
                        onReject={() =>
                          b.type === 'approval' ? decide(b.id, 'reject') : undefined
                        }
                        onRetry={() => {
                          if (b.type === 'error' && b.retry) retry(b.retry);
                        }}
                        onRetryWithModel={(slug) => {
                          if (b.type === 'error' && b.retry) retry(b.retry, slug);
                        }}
                      />
                    </motion.div>
                  );
                });
              })()}
            </div>
          )}
        </motion.div>
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
        // Context usage indicator deliberately removed — see the
        // chip retirement note above the formatTokens helper.
        onSend={sendOrQueue}
        onStop={stop}
        busy={busy}
        busyCount={busyCount}
        queued={queued}
        onCancelQueue={() => setQueued(null)}
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
        empty={empty}
      />
      </div>
      {rightRailView && (
        <RightRail
          view={rightRailView}
          blocks={blocks}
          workspacePath={workspacePath}
          threadId={threadId}
          onClose={onCloseRightRail}
        />
      )}
    </div>
  );
}

// ─── Event router (mutates render blocks as the agent loop runs) ───
//
// reduceBlocks is the pure transform — given current blocks + an
// event, it returns the next blocks. Extracted from handleEvent so
// the subagent_event case can recurse on its own innerBlocks list
// without firing a second setBlocks (which would race against the
// parent's call). One pure function, two callers.

function reduceBlocks(blocks: RenderBlock[], e: AgentEvent): RenderBlock[] {
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
            agentType: e.agentType,
            agentLabel: e.agentLabel,
            status: 'running',
            summary: null,
            innerBlocks: [],
          },
        ];

      case 'subagent_event':
        // Route the child's event into the matching subagent block's
        // innerBlocks instead of mixing into the parent's blocks.
        // Without this, the subagent's tool calls render at the top
        // level, indistinguishable from the parent's — the user sees
        // tools firing but can't tell which run owns them, and the
        // Subagent header just shows "running" with no visible work.
        return blocks.map((b) => {
          if (b.type !== 'subagent' || b.parentToolUseId !== e.parentToolUseId) {
            return b;
          }
          const nextInner = reduceBlocks(b.innerBlocks, e.inner);
          return { ...b, innerBlocks: nextInner };
        });

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

      case 'checkpoint':
        return [...blocks, { type: 'checkpoint', result: e.result }];

      case 'finished':
        return blocks;

      case 'error': {
        // Engine + agent code paths fire `{ type: 'error', message }`
        // events (see claude-code.ts spawn failures, missing-workspace
        // guard in send(), runEngineClaudeCode auth/multimodal pre-
        // checks, etc). Without this branch the reducer silently
        // dropped those events and the user saw nothing — most
        // visibly: sending a chat with no workspace folder under
        // claude-code engine produced no reply, no error, just
        // silence. Convert the AgentEvent into a RenderBlock.error so
        // it surfaces as a normal error card. No retry payload —
        // these are pre-flight failures, not stream failures.
        const message = (e as { message?: unknown }).message;
        const body =
          typeof message === 'string' && message
            ? message
            : 'Something went wrong before the model could respond.';
        return [
          ...blocks,
          {
            type: 'error',
            presentation: {
              severity: 'error',
              title: 'Could not run this turn',
              body,
            },
            retry: null,
          },
        ];
      }

      default:
        return blocks;
  }
}

function handleEvent(
  e: AgentEvent,
  setBlocks: (
    next: RenderBlock[] | ((b: RenderBlock[]) => RenderBlock[]),
  ) => void,
): void {
  setBlocks((blocks) => reduceBlocks(blocks, e));
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
  /** Optional inline retry-with-different-model action. When set,
   *  the error block shows a primary button that switches the
   *  active model + re-sends the prompt. Used by plan-tier 402s
   *  with a suggestedAlternative — softens the "you're blocked"
   *  UX into "we'll use this other model for you, click to go". */
  retryWithModel?: { label: string; modelSlug: string };
  severity: 'warning' | 'error';
};

// Optional context for richer error rendering. Today: only used by
// the qcode plan-tier 402 paths (plan_limit_exceeded + plan_tier_blocked)
// to render the right limits + suggested alternative + upgrade CTA.
// Sourced from PaymentRequiredError.planContext on the throw site.
type ErrorContext = {
  plan?: {
    tier: string;
    used: number;
    limit: number;
    unit: 'messages' | 'tokens' | 'minutes';
    planTier: 'free' | 'pro' | 'power';
    suggestedAlternative?: string;
  };
};

function mapError(code: string, ctx?: ErrorContext): ErrorPresentation {
  // Cap reached — wallet top-up is the right action, not retry.
  if (code === 'cap_hit') {
    return {
      severity: 'warning',
      title: 'You hit your spend cap',
      body: 'qlaud stopped this turn before going over your set limit. Top up your wallet or raise the cap to keep going.',
      action: { label: 'Top up wallet', href: 'https://qlaud.ai/dashboard' },
    };
  }
  // qcode plan-tier limit reached. Suggest switching to a model that's
  // included in the user's tier as the "keep going" path; upgrade is
  // the secondary action. Copy distinguishes free vs pro.
  if (code === 'plan_limit_exceeded') {
    const planTier = ctx?.plan?.planTier ?? 'free';
    const tier = ctx?.plan?.tier ?? 'this';
    const used = ctx?.plan?.used ?? 0;
    const limit = ctx?.plan?.limit ?? 0;
    const unit = ctx?.plan?.unit ?? 'messages';
    const alt = ctx?.plan?.suggestedAlternative;
    const upgradeTo = planTier === 'free' ? 'Pro' : 'Power';
    const body = alt
      ? `You've used today's ${tier} quota (${used}/${limit} ${unit}). Click to retry with ${alt} (included on your plan), or upgrade to ${upgradeTo} for higher limits.`
      : `You've used today's ${tier} quota (${used}/${limit} ${unit}). Upgrade to ${upgradeTo} for higher limits, or wait for the daily reset (midnight UTC).`;
    return {
      severity: 'warning',
      title: `Daily ${tier} limit reached`,
      body,
      // Soft-fall-back: if the server suggested an alternative, the
      // primary action becomes one-click switch + retry. The user
      // never has to re-type their prompt or open the model picker.
      ...(alt
        ? {
            retryWithModel: { label: `Retry with ${alt}`, modelSlug: alt },
          }
        : {}),
      action: {
        label: `Upgrade to ${upgradeTo}`,
        href: `https://qlaud.ai/dashboard/billing?upgrade=${planTier === 'free' ? 'pro' : 'power'}`,
      },
    };
  }
  // Tier blocked entirely (e.g. Free trying to use Opus). Even more
  // direct upgrade pitch since there's no daily-reset escape hatch.
  if (code === 'plan_tier_blocked') {
    const planTier = ctx?.plan?.planTier ?? 'free';
    const tier = ctx?.plan?.tier ?? 'this';
    const alt = ctx?.plan?.suggestedAlternative;
    const upgradeTo = planTier === 'free' ? 'Pro' : 'Power';
    const body = alt
      ? `${tier} models aren't included in your ${planTier} plan. Click to retry with ${alt} (included), or upgrade to ${upgradeTo} for access.`
      : `${tier} models aren't included in your ${planTier} plan. Upgrade to ${upgradeTo} for access.`;
    return {
      severity: 'warning',
      title: `${tier} models need ${upgradeTo}`,
      body,
      ...(alt
        ? {
            retryWithModel: { label: `Retry with ${alt}`, modelSlug: alt },
          }
        : {}),
      action: {
        label: `Upgrade to ${upgradeTo}`,
        href: `https://qlaud.ai/dashboard/billing?upgrade=${planTier === 'free' ? 'pro' : 'power'}`,
      },
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
  // Stream returned 200 but produced no events — server crashed
  // mid-stream or the thread is in a bad state. Without this branch
  // the user sees their message bubble + nothing else, no signal.
  if (code === 'empty_stream') {
    return {
      severity: 'warning',
      title: 'No response from the server',
      body: 'The stream connected but closed without any content. Usually a transient hiccup — hit Retry. If it keeps happening on this thread, ⌘N for a fresh chat (the long history may be bumping a context limit).',
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

// Phase A of cost-visibility-in-flow: distribute each completed
// turn's total USD cost across its tool_use blocks so the chat
// surface can render a per-tool cost pill. Equal-split is rough but
// useful — users see "this refactor cost ~$0.04 per file edit"
// instead of just a turn-level $0.16 receipt. Returns a Map keyed
// by tool call id (stable across re-renders) → USD share.
//
// Skips:
//   - Turns whose usage block hasn't landed yet (in-flight turn)
//   - Turns with zero cost (free models, retries)
//   - todo_write tool calls (rendered separately, not user-actionable)
function computeToolCostShares(blocks: RenderBlock[]): Map<string, number> {
  const out = new Map<string, number>();
  let pendingToolIds: string[] = [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === 'user_text') {
      pendingToolIds = [];
      continue;
    }
    if (b.type === 'tool' && b.call.name !== 'todo_write') {
      pendingToolIds.push(b.call.id);
      continue;
    }
    if (b.type === 'usage' && b.costUsd != null && b.costUsd > 0 && pendingToolIds.length > 0) {
      const share = b.costUsd / pendingToolIds.length;
      for (const id of pendingToolIds) out.set(id, share);
      pendingToolIds = [];
    }
  }
  return out;
}

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
  toolCostShares,
}: {
  tools: Array<Extract<RenderBlock, { type: 'tool' }>>;
  workspace: string | null;
  toolCostShares?: Map<string, number>;
}) {
  const [open, setOpen] = useState(true);
  // One-tool bundles: skip the wrapper. Same look as before.
  if (tools.length === 1) {
    return (
      <div className="flex pl-10">
        <div className="min-w-0 flex-1">
          <ToolCallCard
            call={tools[0]!.call}
            workspace={workspace}
            costUsd={toolCostShares?.get(tools[0]!.call.id) ?? null}
          />
        </div>
      </div>
    );
  }
  const summary = bundleSummary(tools);
  const anyRunning = tools.some((t) => t.call.status === 'running');
  const anyError = tools.some((t) => t.call.status === 'error');
  return (
    <div className="flex pl-10">
      <div className="min-w-0 flex-1">
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
                    costUsd={toolCostShares?.get(t.call.id) ?? null}
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
  activity,
  toolCostShares,
  onAllow,
  onReject,
  onRetry,
  onRetryWithModel,
}: {
  block: RenderBlock;
  busy: boolean;
  workspace: string | null;
  /** Optional contextual activity string. When the agent is mid-turn
   *  and a tool is running, this carries a phrase like
   *  "Reading src/foo.ts..." or "Running `pnpm test`...". The
   *  TypingDots component renders it in place of generic dots so
   *  the user sees what's actually happening, not just "..." */
  activity?: string | null;
  /** Cost share map by tool id, computed at parent level. Forwarded
   *  to ToolCallCard so each tool renders its ~$X.XX pill. */
  toolCostShares?: Map<string, number>;
  onAllow?: () => void;
  onReject?: () => void;
  onRetry?: () => void;
  onRetryWithModel?: (slug: string) => void;
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
            // alpha.200: drop the brand-red bubble. User and assistant
            // turns now share the same colorless register — neutral
            // muted background, foreground text. The brand color
            // belonged in this seat back when chat was the centerpiece;
            // now it competes with tool cards and code blocks for
            // attention and loses the comparison. Right-alignment +
            // subtle pill is enough to disambiguate turn ownership.
            <div className="rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-sm leading-relaxed text-foreground/90">
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

    // claude-code's plan mode emits an 'ExitPlanMode' tool_call with
    // input.plan = the markdown plan. The default ToolCallCard would
    // hide it (input is invisible in the generic renderer; output is
    // empty for ExitPlanMode since it's a control-flow tool, not a
    // data-returning one). Render the plan body as proper markdown
    // so the user can actually read what claude proposes — the whole
    // point of plan mode is reviewability.
    //
    // Case-insensitive match: claude-code engine emits 'ExitPlanMode'
    // (PascalCase); the legacy engine emits 'exit_plan_mode'
    // (snake_case) and is handled separately via the ApprovalCard
    // path. This branch covers both for robustness.
    const isExitPlan =
      block.call.name === 'ExitPlanMode' ||
      block.call.name === 'exit_plan_mode';
    if (isExitPlan) {
      const planText = extractPlanFromInput(block.call.input);
      return (
        <div id={`tool-${block.call.id}`} className="flex scroll-mt-4 pl-10">
          <div className="min-w-0 flex-1">
            <PlanProposalCard plan={planText} />
          </div>
        </div>
      );
    }

    // claude-code's AskUserQuestion tool — currently disallowed in
    // the sandbox spawn (see apps/edge/src/routes/sandbox.ts) because
    // we don't have a bidirectional --resume path to feed the
    // answer back. If a future spawn path enables it, render the
    // question + a "answer in your next message" hint so the user
    // knows what to do; their next prompt becomes claude's input on
    // the resumed turn.
    const isAskUser =
      block.call.name === 'AskUserQuestion' ||
      block.call.name === 'ask_user_question';
    if (isAskUser) {
      const question = extractQuestionFromInput(block.call.input);
      return (
        <div id={`tool-${block.call.id}`} className="flex scroll-mt-4 pl-10">
          <div className="min-w-0 flex-1">
            <QuestionCard question={question} />
          </div>
        </div>
      );
    }

    return (
      <div id={`tool-${block.call.id}`} className="flex scroll-mt-4 pl-10">
        <div className="min-w-0 flex-1">
          <ToolCallCard
            call={block.call}
            workspace={workspace}
            costUsd={toolCostShares?.get(block.call.id) ?? null}
          />
        </div>
      </div>
    );
  }
  if (block.type === 'approval') {
    return (
      <div className="flex pl-10">
        <div className="min-w-0 flex-1">
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
  if (block.type === 'checkpoint') {
    return (
      <div className="flex pl-10">
        <CheckpointChip result={block.result} />
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
          {(block.retry || p.action || p.retryWithModel) && (
            <div className="flex items-center justify-end gap-2 pt-1">
              {/* Retry-with-model = primary action when present.
               *  Plan-tier 402s use this to one-click switch to a
               *  cheaper/included model and re-send. The user
               *  doesn't have to re-type their prompt. */}
              {p.retryWithModel && block.retry && (
                <button
                  onClick={() => onRetryWithModel?.(p.retryWithModel!.modelSlug)}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  <RotateCcw className="h-3 w-3" />
                  {p.retryWithModel.label}
                </button>
              )}
              {p.action && (
                <a
                  href={p.action.href}
                  target="_blank"
                  rel="noopener"
                  className={
                    'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ' +
                    (p.retryWithModel
                      ? 'border border-border bg-background text-foreground/80 hover:border-foreground/30 hover:text-foreground'
                      : 'bg-primary text-primary-foreground hover:bg-primary/90')
                  }
                >
                  {p.action.label} →
                </a>
              )}
              {/* Generic retry only when there's no model-specific
               *  retry to offer (otherwise it'd be redundant). */}
              {block.retry && !p.retryWithModel && (
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
    return <SubagentBlock block={block} workspace={workspace} />;
  }
  // assistant_text
  //
  // alpha.198: avatar removed. The red sparkle bubble next to every
  // assistant turn was visual noise that didn't add information
  // (no human-user is ambiguous about which side a message came
  // from in a 1:1 chat). AionUi/Codex/ChatGPT all drop the
  // assistant avatar; the role is conveyed by indentation +
  // typography contrast.
  if (!block.text && busy) {
    return (
      <div className="pt-0.5">
        {block.skill && <SkillAttribution skill={block.skill} model={block.resolvedModel} />}
        <TypingDots activity={activity ?? null} />
      </div>
    );
  }
  if (!block.text) return null;
  return (
    <div className="group pt-0.5">
      <div>
        {block.skill && <SkillAttribution skill={block.skill} model={block.resolvedModel} />}
        <Markdown source={block.text} streaming={busy} />
        {/* Hover-revealed message actions. Lives at the bottom of
         *  each assistant turn so it's adjacent to the content
         *  it'll act on. opacity-0 → group-hover:opacity-100 keeps
         *  the chat surface clean by default; users only see the
         *  controls when they're reaching for them. Skipped while
         *  the message is still streaming — copying mid-stream
         *  would yield partial content. */}
        {!busy && <MessageActions text={block.text} />}
      </div>
    </div>
  );
}

// Hover-revealed action bar on assistant messages. Today: copy.
// Tomorrow: regenerate with different model, fork into new thread,
// share read-only link. Pattern lifted from ChatGPT / Claude.ai —
// having the actions adjacent to the message they target reduces
// the cognitive load of "where do I click to copy this".
function MessageActions({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }
  return (
    <div className="mt-2 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
      <button
        type="button"
        onClick={copy}
        className={cn(
          'flex items-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-[11px] font-medium transition-all',
          copied
            ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
            : 'text-muted-foreground hover:border-border hover:bg-muted/60 hover:text-foreground',
        )}
        aria-label={copied ? 'Copied' : 'Copy message'}
        title={copied ? 'Copied' : 'Copy message'}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
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

// Avatar removed in alpha.198 — assistant turns no longer render a
// per-message bubble icon. See the assistant_text render block for
// rationale.

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

// ─── Contextual activity derivation ───────────────────────────────
//
// While the agent is mid-turn, peek the blocks list for the LAST
// running tool call and turn it into a human-readable phrase the
// TypingDots component can surface in place of generic dots.
// Returns null when no tool is currently running — the indicator
// then shows dots + the ambient quip rotation.
//
// Phrasing is intentionally specific ("Reading src/foo.ts" not
// "Working with files") because specific reads as competent and
// generic reads as vague. Truncation caps long inputs so a giant
// path or shell command doesn't overflow the bubble.
// Usage chip + deriveUsageStatus() retired in the credit-model
// rewrite — the title-bar SpendBar is now the single source of
// glanceable usage truth, replacing the per-tier "47/200 mid"
// chip that lived here through alpha.152-alpha.165. The composer
// stays clean of plan information; users get one bar at the top
// of the app, click for the full breakdown.

function deriveCurrentActivity(blocks: RenderBlock[]): string | null {
  // Walk from the end — the most recent running tool wins. Tools
  // can finish-then-restart in chains, so we want what's running
  // RIGHT NOW, not the first running one we find.
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (!b) continue;
    if (b.type === 'tool' && b.call.status === 'running') {
      return phraseForTool(b.call.name, b.call.input);
    }
    if (b.type === 'subagent' && b.status === 'running') {
      return `${b.agentLabel}: ${truncate(b.description, 60)}`;
    }
  }
  return null;
}

function phraseForTool(name: string, input: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  const str = (key: string): string =>
    typeof inp[key] === 'string' ? (inp[key] as string) : '';
  // claude-code emits PascalCase tool names (Read, Write, Bash,
  // ExitPlanMode, AskUserQuestion); the legacy engine emits
  // snake_case (read_file, write_file, bash, exit_plan_mode).
  // Lowercase + strip underscores once so a single switch covers
  // both engines' variants.
  const norm = name.toLowerCase().replace(/_/g, '');
  if (norm === 'exitplanmode') return 'Submitting plan for review…';
  if (norm === 'askuserquestion') return 'Asking you a question…';
  switch (name) {
    case 'read_file':
      return `Reading ${truncate(str('path'), 50) || 'file'}…`;
    case 'write_file':
      return `Writing ${truncate(str('path'), 50) || 'file'}…`;
    case 'edit_file':
      return `Editing ${truncate(str('path'), 50) || 'file'}…`;
    case 'list_files':
      return `Listing ${truncate(str('path') || str('dir'), 50) || 'workspace'}…`;
    case 'glob':
      return `Searching for ${truncate(str('pattern'), 50) || 'files'}…`;
    case 'grep':
      return `Searching for "${truncate(str('pattern'), 50) || ''}"`;
    case 'bash':
      return `Running ${truncate(formatCmd(str('command')), 60)}`;
    case 'verify':
      return 'Running verify…';
    case 'browser_navigate':
      return `Loading ${truncate(str('url'), 50) || 'page'}…`;
    case 'browser_snapshot':
      return 'Capturing page snapshot…';
    case 'browser_screenshot':
      return 'Taking screenshot…';
    case 'browser_click':
      return 'Clicking element…';
    case 'browser_type':
      return 'Typing into field…';
    case 'browser_console':
      return 'Reading console…';
    case 'task': {
      const desc = str('description');
      return desc ? `Spawning subagent: ${truncate(desc, 50)}` : 'Spawning subagent…';
    }
    case 'todo_write':
      return 'Updating tasks…';
    case 'skill':
      return `Loading skill: ${truncate(str('name'), 40)}`;
    case 'enter_plan_mode':
      return 'Entering plan mode…';
    case 'exit_plan_mode':
      return 'Submitting plan…';
    case 'qlaud_search_tools':
      return 'Searching available tools…';
    case 'qlaud_get_tool_schemas':
      return 'Loading tool schemas…';
    case 'qlaud_multi_execute':
      return 'Executing tools…';
    case 'qlaud_manage_connections':
      return 'Managing connections…';
    default:
      return `Running ${name}…`;
  }
}

/** Format a shell command for display: prefix in backticks, drop
 *  the noise of common shell prefixes that don't tell the user
 *  anything ("bash -c", piping noise). Conservative — keeps the
 *  string truthful. */
function formatCmd(command: string): string {
  if (!command) return '`bash`';
  return `\`${command}\``;
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function shuffled<T>(arr: readonly T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// ─── Dev-server URL detection ─────────────────────────────────────
//
// Watches bash tool outputs in the current conversation for the
// "Local: http://localhost:5173" / "ready on http://localhost:3000"
// startup banners every dev server prints. Returns the most recent
// match — port-agnostic, framework-agnostic. Vite, Next, Astro,
// Storybook, Remix, Nuxt, SvelteKit, Tauri's vite, all match the
// same regex. Refs the last match so the chip surfaces immediately
// after `pnpm dev` lands and stays available across follow-up turns.
const DEV_URL_RE =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d{2,5})?(?:\/[^\s'"<>)]*)?/g;
function deriveDevServerUrl(blocks: RenderBlock[]): string | null {
  // Walk newest-first so a fresh dev-server output overrides an
  // older one (npm scripts that restart on changes).
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (!b || b.type !== 'tool') continue;
    // Case-insensitive: legacy agent emits 'bash' / 'verify',
    // claude CLI engine emits 'Bash'. Without lowercasing the
    // sticky activity bar misses every engine-mode dev-server
    // banner.
    const name = b.call.name.toLowerCase();
    if (name !== 'bash' && name !== 'verify') continue;
    const out = b.call.output ?? '';
    if (!out) continue;
    const matches = Array.from(out.matchAll(DEV_URL_RE));
    if (matches.length === 0) continue;
    // Prefer the LAST match in the output (dev servers print
    // status lines repeatedly; the latest "ready" line wins).
    const last = matches[matches.length - 1]?.[0];
    if (last) return last.replace(/[.,;)]+$/, '');
  }
  return null;
}

// ─── Sticky activity bar ─────────────────────────────────────────
//
// Always-visible status surface at the top of the chat viewport.
// Shows the current tool activity (if any) AND the detected dev
// server URL (if any). Both fade in/out so the bar stays out of
// the way when nothing is happening — same posture Codex's
// "what's running now" pill takes.

function StickyActivityBar({
  activity,
  devUrl,
}: {
  activity: string | null;
  devUrl: string | null;
}) {
  const visible = !!activity || !!devUrl;
  return (
    <AnimatePresence initial={false}>
      {visible && (
        <motion.div
          key="sticky-activity"
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
          className="sticky top-2 z-20 mx-auto flex w-full max-w-[42rem] flex-wrap items-center justify-end gap-2 px-3 sm:px-4"
        >
          {activity && (
            <div className="flex items-center gap-2 rounded-full border border-border/60 bg-background/85 px-3 py-1 text-[11.5px] text-foreground/80 shadow-sm backdrop-blur-sm">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
              </span>
              <span className="max-w-[280px] truncate">{activity}</span>
            </div>
          )}
          {devUrl && (
            <button
              type="button"
              onClick={() => void openExternal(devUrl)}
              className="group inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/85 px-3 py-1 font-mono text-[11px] text-foreground/85 shadow-sm backdrop-blur-sm transition-all hover:border-primary/60 hover:bg-primary/5 hover:text-foreground"
              title={`Open ${devUrl} in your browser`}
            >
              <span className="text-muted-foreground">↗</span>
              <span className="max-w-[200px] truncate">{devUrl.replace(/^https?:\/\//, '')}</span>
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// Animated typing-dots that ALSO surface what the agent is actually
// doing. When a tool is running, we render a contextual phrase
// ("Reading src/foo.ts...", "Running `pnpm test`...") in place of
// generic dots — the lived-in feel Codex/Claude.ai have. With no
// active tool, falls back to dots + an ambient quip after 6s.
//
// The phrase fades through with motion when the activity changes
// (different tool starts running) so the indicator FEELS like it
// tracks the agent's flow rather than blinking abruptly.
function TypingDots({ activity }: { activity: string | null }) {
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
      <div className="flex min-h-[20px] items-center gap-2">
        <div className="flex h-5 items-center gap-1">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/60 [animation-delay:0ms]" />
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/60 [animation-delay:200ms]" />
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/60 [animation-delay:400ms]" />
        </div>
        {activity && (
          <motion.span
            // Re-key on activity so React re-mounts and motion runs
            // its initial → animate transition each time the agent
            // switches tools. Subtle 140ms slide-in nudges the eye.
            key={activity}
            initial={{ opacity: 0, x: -3 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.14, ease: 'easeOut' }}
            className="truncate text-[12px] text-muted-foreground"
          >
            {activity}
          </motion.span>
        )}
      </div>
      {showQuip && !activity && (
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

// ─── Plan-mode proposal card ───────────────────────────────────────
//
// Renders claude's ExitPlanMode tool call as a proper markdown card
// instead of a generic tool box. Plan mode's whole value is the
// user being able to read + judge the plan before it executes —
// the generic ToolCallCard hides input (the plan content lives
// there) so the plan was effectively invisible until this card
// existed.
//
// V1 just renders the markdown and a hint to switch to Agent mode.
// V2 will add a one-click "Approve and execute" button that flips
// the mode toggle + auto-sends an "execute the plan" follow-up turn.

function extractPlanFromInput(input: unknown): string {
  // claude-code wraps the plan as { plan: '...markdown...' } in its
  // ExitPlanMode tool input. Legacy engine uses the same shape.
  // Defensive against malformed inputs (string vs missing).
  if (!input || typeof input !== 'object') {
    return typeof input === 'string' ? input : '';
  }
  const v = (input as Record<string, unknown>).plan;
  if (typeof v === 'string') return v;
  // Fallback: stringify the whole thing so SOMETHING shows up. Better
  // than a blank card.
  try {
    return '```json\n' + JSON.stringify(input, null, 2) + '\n```';
  } catch {
    return '';
  }
}

function PlanProposalCard({ plan }: { plan: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-emerald-500/40 bg-emerald-50/40 dark:bg-emerald-950/20">
      <header className="flex items-center justify-between gap-2 border-b border-emerald-500/30 bg-emerald-100/40 px-3 py-2 dark:bg-emerald-900/30">
        <div className="flex items-center gap-2">
          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-700 dark:text-emerald-400" />
          <span className="text-[12px] font-medium text-emerald-900 dark:text-emerald-200">
            Plan ready for review
          </span>
        </div>
        <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
          Plan mode
        </span>
      </header>
      <div className="max-h-[520px] overflow-auto px-4 py-3 text-[13px] leading-relaxed">
        {plan ? (
          <Markdown source={plan} />
        ) : (
          <p className="text-muted-foreground">
            (claude submitted an empty plan — try refining the prompt)
          </p>
        )}
      </div>
      <footer className="border-t border-emerald-500/20 bg-emerald-50/30 px-3 py-2 text-[11px] text-muted-foreground dark:bg-emerald-950/20">
        Switch the mode toggle from <span className="font-medium">Plan</span> to{' '}
        <span className="font-medium">Agent</span> and ask claude to execute
        the plan.
      </footer>
    </div>
  );
}

// ─── AskUserQuestion card ─────────────────────────────────────────
//
// claude can pause execution and ask the user a clarifying question
// via the AskUserQuestion tool. Currently disallowed in the sandbox
// spawn (see apps/edge/src/routes/sandbox.ts:--disallowedTools=
// AskUserQuestion) because v1 has no bidirectional --resume path to
// deliver the answer back. If/when that lands, this card renders
// the question prominently so the user knows they need to answer
// in their next message.

function extractQuestionFromInput(input: unknown): string {
  if (!input || typeof input !== 'object') {
    return typeof input === 'string' ? input : '';
  }
  // claude-code's AskUserQuestion tool uses { question: '...' };
  // legacy snake_case variant uses { prompt: '...' }. Try both.
  const obj = input as Record<string, unknown>;
  const q = obj.question ?? obj.prompt ?? obj.text;
  return typeof q === 'string' ? q : '';
}

function QuestionCard({ question }: { question: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-amber-500/40 bg-amber-50/40 dark:bg-amber-950/20">
      <header className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-100/40 px-3 py-2 dark:bg-amber-900/30">
        <span className="text-sm" aria-hidden>
          ❔
        </span>
        <span className="text-[12px] font-medium text-amber-900 dark:text-amber-200">
          Claude has a question
        </span>
      </header>
      <div className="px-4 py-3 text-[13px] leading-relaxed text-foreground">
        {question || '(no question text)'}
      </div>
      <footer className="border-t border-amber-500/20 bg-amber-50/30 px-3 py-2 text-[11px] text-muted-foreground dark:bg-amber-950/20">
        Type your answer in the composer below — claude will pick it up on
        the next turn.
      </footer>
    </div>
  );
}

// Auto-commit checkpoint chip. Renders after the agent's turn lands
// when autoCommit is on. "Committed" state shows the short SHA and
// file count; "skipped" shows the reason on hover (so the user
// understands why a turn that wrote files didn't get a commit —
// usually pre-existing dirty tree or special git state).
function CheckpointChip({
  result,
}: {
  result:
    | { kind: 'committed'; sha: string; message: string; filesChanged: number }
    | { kind: 'skipped'; reason: string };
}) {
  if (result.kind === 'skipped') {
    return (
      <div
        className="flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-2.5 py-0.5 text-[10.5px] tabular-nums text-muted-foreground"
        title={`auto-commit skipped: ${result.reason}`}
      >
        <span className="opacity-70">no commit</span>
        <span className="opacity-50">·</span>
        <span className="truncate text-foreground/60">{result.reason}</span>
      </div>
    );
  }
  return (
    <div
      className="flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-0.5 text-[10.5px] tabular-nums text-emerald-700 dark:text-emerald-400"
      title={`auto-commit · ${result.message}`}
    >
      <span className="font-medium">commit</span>
      <span className="font-mono opacity-80">{result.sha}</span>
      <span className="opacity-50">·</span>
      <span>
        {result.filesChanged} file{result.filesChanged === 1 ? '' : 's'}
      </span>
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
  const models = useTextModels();
  const m = models.find((x) => x.slug === model);
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
  workspace,
}: {
  block: Extract<RenderBlock, { type: 'subagent' }>;
  workspace: string | null;
}) {
  // Default open while running so the user sees progress unfold; flip
  // to summary-only after the subagent completes (the inner trace is
  // still revealable via the toggle).
  const isRunning = block.status === 'running';
  const isError = block.status === 'error';
  const [open, setOpen] = useState(true);
  const summaryText = block.summary ?? '';
  const hasInner = block.innerBlocks.length > 0;
  // Auto-collapse the inner trace once the subagent finishes — the
  // summary is the answer, the trace is the receipts. User can reopen.
  useEffect(() => {
    if (!isRunning) setOpen(false);
  }, [isRunning]);
  return (
    <div className="flex pl-10">
      <div
        className={cn(
          'min-w-0 flex-1 rounded-lg border',
          isError
            ? 'border-primary/30 bg-primary/5'
            : 'border-border/60 bg-muted/30',
        )}
      >
        <div className="flex items-center gap-2 px-3 py-2">
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
            {block.agentLabel || 'Agent'}
          </span>
          <span className="min-w-0 truncate text-[12px] font-medium text-foreground">
            {block.description || '(no description)'}
          </span>
          {isRunning && hasInner && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
              {block.innerBlocks.length} step
              {block.innerBlocks.length === 1 ? '' : 's'}
            </span>
          )}
          {(hasInner || summaryText) && (
            <button
              onClick={() => setOpen((o) => !o)}
              className="ml-auto shrink-0 text-[10.5px] text-muted-foreground hover:text-foreground"
            >
              {open ? 'hide' : isRunning ? 'show progress' : 'show trace'}
            </button>
          )}
        </div>
        {open && hasInner && (
          <div className="border-t border-border/40 bg-background/40 p-2">
            <div className="flex flex-col gap-1.5">
              {block.innerBlocks.map((b, i) => (
                <SubagentInner key={i} block={b} workspace={workspace} />
              ))}
            </div>
          </div>
        )}
        {!isRunning && summaryText && (
          <div className="border-t border-border/40 px-3 py-2">
            <div className="max-h-72 overflow-auto whitespace-pre-wrap text-[11.5px] leading-relaxed text-foreground/90">
              {summaryText}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Render a single inner block from a subagent's runThreadAgent stream.
// Smaller, denser variant of the parent's BlockRow — no avatar gutter,
// no approval cards (subagent approvals bubble up to the parent UI).
function SubagentInner({
  block,
  workspace,
}: {
  block: RenderBlock;
  workspace: string | null;
}) {
  if (block.type === 'tool') {
    if (block.call.name === 'todo_write') return null;
    return <ToolCallCard call={block.call} workspace={workspace} embedded />;
  }
  if (block.type === 'assistant_text') {
    if (!block.text) return null;
    return (
      <div className="px-2 py-1 text-[12px] leading-relaxed text-foreground/85">
        <Markdown source={block.text} />
      </div>
    );
  }
  if (block.type === 'subagent') {
    // Nested subagents are blocked at depth-1 by the agent layer, but
    // render defensively just in case.
    return <SubagentBlock block={block} workspace={workspace} />;
  }
  return null;
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

// Context-usage chip retired. Claude Code and qlaud's qcode-legacy
// auto-compaction handle context internally. Our pre-compaction
// "X / Y tokens" estimate diverged from the model's actual
// effective context after engine-side pruning, so the indicator
// was misleading more often than not. Real context errors
// propagate through the dispatch path; we surface those when they
// fire. formatTokens kept — used elsewhere for usage block render.

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
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

/** Shown when the user deep-linked to a thread (URL nav, sidebar
 *  click, reload) but `useThreadMessagesQuery` hasn't returned yet.
 *  Distinguishes "thread is loading" from "fresh empty chat" — the
 *  empty-state UI looked identical pre-alpha.185, so a slow worker
 *  cold-start made the user think the surface was unresponsive. */
function ThreadLoadingState() {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 text-center">
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/40" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary/80" />
        </span>
        Loading conversation…
      </div>
      <p className="max-w-sm text-[11.5px] text-muted-foreground/70">
        Fetching your messages from the server. First-load can take a moment
        on a cold edge worker.
      </p>
    </div>
  );
}

function EmptyState({
  memory,
  hasWorkspace,
  workspaceName,
  onOpenFolder,
  onPick,
}: {
  /** alpha.188: kept on the prop type so existing callers compile,
   *  but no longer rendered. Model/provider live in the Titlebar. */
  modelLabel?: string;
  provider?: string;
  memory: ProjectMemory | null;
  hasWorkspace: boolean;
  workspaceName?: string;
  onOpenFolder: () => void | Promise<void>;
  onPick: (s: string) => void;
}) {
  // alpha.188 redesign — Apple/Codex-inspired hero empty state.
  //
  // Principles applied throughout:
  //   1. ONE focal element (the headline + a subtle suggestion row).
  //      The composer (rendered by ChatSurface a level above) is the
  //      real CTA — this empty state sits ABOVE the composer and
  //      tees it up rather than competing.
  //   2. Whitespace as the primary visual structure. No card grids,
  //      no buttons-everywhere, no onboarding chip swarm.
  //   3. ONE verb per surface ("Build something" / "Open a folder"),
  //      not four competing CTAs ("Plan / Review / Build / Draft").
  //   4. alpha.196: no ambient flourish on the empty state. The
  //      Spotlight gradient I shipped in alpha.188 read as
  //      "decoration" against AionUi's cleaner reference. Removed.
  //
  // Three branches collapse into one component:
  //   * Web, no workspace      → "What do you want to build?"
  //   * Desktop, no workspace  → "Open a folder to get started"
  //   * Has workspace          → "What should we build in <name>?"
  //
  // The suggestion chips are MUCH quieter than before: tiny pills
  // arranged horizontally, not a 4-button grid. Click fills the
  // composer; user can edit before sending.
  if (!hasWorkspace && isTauri()) {
    // Desktop without a folder yet → one verb, one button.
    return (
      <div className="relative flex flex-col items-center pt-16 text-center sm:pt-24">

        <div className="relative z-10 flex flex-col items-center">
          <QlaudMark className="h-12 w-12 rounded-2xl shadow-sm" />
          <h2 className="mt-6 text-3xl font-semibold tracking-tight sm:text-4xl">
            What can I build for you?
          </h2>
          <p className="mt-2 max-w-sm text-[13px] leading-relaxed text-muted-foreground">
            Open a folder to get started. qcode only reads what you
            point it at.
          </p>
          <button
            onClick={() => void onOpenFolder()}
            className="mt-7 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2 text-[13px] font-medium text-primary-foreground shadow-sm transition-all hover:bg-primary/90 active:scale-[0.98]"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Open folder
            <Kbd className="ml-1 border-primary-foreground/30 text-primary-foreground/70">
              ⌘O
            </Kbd>
          </button>
        </div>
      </div>
    );
  }

  // Web (no folder concept) OR desktop with a workspace open. Same
  // hero shape; the heading varies by workspace presence.
  const heading = workspaceName
    ? `What should we build in ${workspaceName}?`
    : 'What can I build for you?';
  const suggestions = !hasWorkspace
    ? WEB_SAMPLE_PROMPTS.slice(0, 3)
    : SAMPLE_PROMPTS.slice(0, 3);
  return (
    <div className="relative flex flex-col items-center pt-12 text-center sm:pt-20">
      <div className="relative z-10 flex w-full flex-col items-center">
        <QlaudMark className="h-12 w-12 rounded-2xl shadow-sm" />
        <h2 className="mt-6 max-w-2xl px-2 text-3xl font-semibold tracking-tight sm:text-4xl">
          {heading}
        </h2>
        {memory && (
          <div
            className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/70 px-2.5 py-0.5 text-[11px] text-muted-foreground"
            title={`Loaded ${memory.text.length.toLocaleString()} chars from ${memory.source}`}
          >
            <BookOpen className="h-3 w-3" />
            Using{' '}
            <span className="font-mono text-foreground/80">
              {memory.source}
            </span>
          </div>
        )}
        {/* Suggestion chips — quiet horizontal row, NOT a button grid.
         *  Three contextual prompts; click drops into the composer
         *  for the user to edit/send. Codex-style restraint: chips
         *  hint at capability, they don't dominate the canvas. */}
        <div className="mt-8 flex max-w-2xl flex-wrap items-center justify-center gap-1.5">
          {suggestions.map((s) => (
            <button
              key={s}
              onClick={() => onPick(s)}
              className="rounded-full border border-border/60 bg-background/40 px-3 py-1 text-[11.5px] text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-background hover:text-foreground"
            >
              {s.length > 56 ? s.slice(0, 53) + '…' : s}
            </button>
          ))}
        </div>
        <p className="mt-6 max-w-sm text-[11.5px] leading-relaxed text-muted-foreground/60">
          Or type anything below — describe a feature, paste an error,
          ask a question.
        </p>
      </div>
    </div>
  );
}

// OnboardingTip removed in alpha.188 — the 3-card tip grid on the
// desktop empty state was retired in favor of the single-CTA hero.

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

// ─── Usage chip ────────────────────────────────────────────────────
//
// ─── Composer ──────────────────────────────────────────────────────

function Composer({
  value,
  onChange,
  modelLabel,
  workspaceName,
  branch,
  mode,
  onSend,
  onStop,
  busy,
  busyCount,
  queued,
  onCancelQueue,
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
  empty = false,
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
  mode?: 'chat' | 'agent' | 'plan';
  onSend: (v: string, opts?: { parallel?: boolean }) => void;
  onStop: () => void;
  busy: boolean;
  /** Number of active runs on this thread. > 1 only when the user
   *  has explicitly fired parallel sends via Cmd+Enter. Surfaces
   *  as a "N running" hint near the Stop button so the user knows
   *  multiple things are in flight. */
  busyCount: number;
  /** A message the user committed (Enter) while the previous turn
   *  was still running. Renders as a chip above the textarea so the
   *  user can see what'll auto-fire when the current turn lands. */
  queued?: string | null;
  /** Drop the queued message — the × on the queued chip. */
  onCancelQueue?: () => void;
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
  /** True when the conversation has no rendered blocks yet — the
   *  parent ChatSurface uses this for layout (centered hero), and
   *  here we drop the top-divider + blurred background tint so the
   *  composer reads as part of the hero block instead of fenced
   *  off below it. */
  empty?: boolean;
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
      // Cmd/Ctrl+Enter while busy fires in PARALLEL — runs
      // alongside whatever's currently in flight rather than
      // queueing for after. Modifier-less Enter keeps the
      // existing queue-on-busy / send-when-idle behavior.
      const parallel = busy && (e.metaKey || e.ctrlKey);
      onSend(value, parallel ? { parallel: true } : undefined);
    }
  }

  return (
    <div
      className={cn(
        'px-3 py-3 sm:px-4 sm:py-4',
        // alpha.196: drop the top border + blurred background tint
        // when the conversation is empty. AionUi-side comparison
        // showed the divider+tint visually fenced the composer off
        // from the hero — they should read as a single block. When
        // a real conversation is in progress the divider stays,
        // because it separates scrolling content above from the
        // anchored composer below (genuine UX boundary).
        empty
          ? ''
          : 'border-t border-border/40 bg-background/70 backdrop-blur-md',
      )}
    >
      <div className="mx-auto max-w-[42rem]">
        {/* Busy-mode hint chip (alpha.193). Persistent affordance
         *  visible above the composer the entire time the model is
         *  generating — replaces relying on the textarea placeholder
         *  (which disappears the moment the user starts typing) as
         *  the only signal that Enter/⌘⏎ behave differently while
         *  busy.
         *
         *  Two modes today:
         *    Enter           → queue the follow-up; runs after the
         *                      current turn lands.
         *    ⌘⏎  (parallel)  → fire a parallel turn immediately;
         *                      streams concurrently with the
         *                      current one (no wait).
         *
         *  Steer (interrupt + redirect mid-turn) is on the roadmap
         *  but not implemented — keeping the chip honest until it
         *  ships. */}
        {busy && (
          <div className="mb-2 flex items-center justify-center gap-2 text-[10.5px] text-muted-foreground">
            <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/70 px-2 py-0.5">
              <Kbd className="!border-border/60 !px-1 !text-[9px]">⏎</Kbd>
              queue
            </span>
            <span className="text-muted-foreground/40" aria-hidden>·</span>
            <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/70 px-2 py-0.5">
              <Kbd className="!border-border/60 !px-1 !text-[9px]">⌘⏎</Kbd>
              run in parallel
            </span>
          </div>
        )}
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
              'relative rounded-2xl border bg-background shadow-sm transition-all',
              'focus-within:shadow-md',
              // alpha.195: replace the BorderBeam (which used an
              // opaque interior mask that overlaid the textarea
              // and blocked the user from seeing their cursor)
              // with a non-interfering busy signal: tinted border
              // + a subtle ambient ring shadow. Both are pure CSS
              // on the composer card itself — no overlay, no
              // stacking, no interference with input.
              busy && !dragging
                ? 'border-primary/40 [box-shadow:0_0_0_4px_hsl(var(--primary)/0.08)]'
                : '',
              dragging
                ? 'border-primary/40 ring-2 ring-primary/20'
                : !busy
                  ? 'border-border focus-within:border-foreground/20'
                  : '',
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
            {queued && (
              <div className="flex items-center gap-2 border-b border-border/40 bg-amber-500/5 px-3 py-1.5">
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                  Queued
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-[11.5px] text-foreground/85"
                  title={queued}
                >
                  {queued}
                </span>
                <span className="hidden text-[10.5px] text-muted-foreground sm:inline">
                  Sends when current turn lands
                </span>
                <button
                  type="button"
                  onClick={onCancelQueue}
                  className="grid h-4 w-4 place-items-center rounded text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                  aria-label="Cancel queued message"
                  title="Cancel queued message"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            )}
            <textarea
              value={value}
              onChange={onTextChange}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onFocus={onLoadFiles}
              placeholder={
                busy
                  ? 'Type a follow-up… Enter queues, ⌘⏎ runs in parallel'
                  : 'Send a message, upload files, open a folder…'
              }
              rows={3}
              // alpha.194: more generous min-height (rows=3 from 2)
              // and bigger text (15px from 14px) to match AionUI's
              // composer breath. Apple-restraint principle: ONE
              // important interactive element on the surface = give
              // it the real estate to feel important.
              //
              // text-base (16px) on mobile prevents iOS Safari from
              // auto-zooming on focus (zoom only fires when font is
              // < 16px). text-[15px] returns at sm: — slightly
              // larger than the prior 14px for breathing room.
              className="block w-full resize-none rounded-2xl bg-transparent px-5 py-4 text-base leading-7 text-foreground outline-none placeholder:text-muted-foreground/70 disabled:opacity-60 sm:text-[15px] sm:leading-6"
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
                  className="grid h-8 w-8 place-items-center rounded-full border border-border/60 bg-background text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground active:scale-95"
                  aria-label="Attach files"
                  title="Attach images, PDFs, or text files"
                >
                  <Paperclip className="h-4 w-4" />
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
                    {mode &&
                      (isTauri() ? (
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
                      ) : (
                        // Web has no plan/agent distinction — the
                        // composer pill mirrors the title-bar's "Chat"
                        // label so the surface reads consistently.
                        <span
                          className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-[10.5px] font-medium text-foreground/80"
                          title="Chat — qcode on the web"
                        >
                          Chat
                        </span>
                      ))}
                    <span
                      className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-[10.5px] font-medium text-foreground/80"
                      title="Active model — switch in the title bar"
                    >
                      {modelLabel}
                    </span>
                    {/* Plan-tier chip + context-usage chip both
                     *  retired. The title-bar SpendBar is now the
                     *  single source of usage truth (one bar, color-
                     *  state machine, click for breakdown). */}
                    <span className="hidden text-[10.5px] text-muted-foreground sm:inline">
                      ⏎ to send · @ files
                    </span>
                  </div>
                )}
              </div>
              {busy ? (
                <div className="flex items-center gap-1.5">
                  {busyCount > 1 && (
                    <span
                      className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-amber-700 dark:text-amber-400"
                      title={`${busyCount} runs in flight on this thread (parallel via ⌘⏎)`}
                    >
                      <span className="h-1 w-1 animate-pulse rounded-full bg-amber-500" />
                      {busyCount} running
                    </span>
                  )}
                  <button
                    onClick={onStop}
                    className="grid h-7 w-7 place-items-center rounded-md border border-border bg-background text-foreground/70 transition-colors hover:border-foreground/30 hover:text-foreground"
                    aria-label="Stop all runs on this thread"
                    title={
                      busyCount > 1
                        ? `Stop all ${busyCount} runs on this thread`
                        : 'Stop'
                    }
                  >
                    <Square className="h-3 w-3 fill-current" />
                  </button>
                </div>
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
                  className="grid h-8 w-8 place-items-center rounded-full bg-primary text-primary-foreground transition-all hover:bg-primary/90 active:scale-95 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
                  aria-label="Send"
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
