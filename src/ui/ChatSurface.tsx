import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, FileText, Sparkles, Square, X } from 'lucide-react';

import { runAgent, type AgentEvent } from '../lib/agent';
import { buildAttachmentContext } from '../lib/attachments';
import { fetchBalance } from '../lib/billing';
import { cn } from '../lib/cn';
import {
  imagesFromDrop,
  imagesFromPaste,
  readImageFile,
  type AttachedImage,
} from '../lib/images';
import { MODELS } from '../lib/models';
import type { ContentBlock, Message } from '../lib/qlaud-client';
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
  | { type: 'user_text'; text: string; images?: AttachedImage[] }
  | { type: 'assistant_text'; text: string }
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
    };

// Pending approval resolvers, keyed by tool_use id. The agent loop
// awaits one of these promises; the UI fulfills it on click.
type PendingResolver = (decision: ApprovalDecision) => void;

const SAMPLE_PROMPTS = [
  'List the files in this project',
  'Open the main entry point and explain what it does',
  'Find the auth flow — which files implement it?',
  'Summarize the architecture from the README and source',
];

export function ChatSurface({
  model,
  initialHistory = [],
  onTurnComplete,
}: {
  model: string;
  initialHistory?: Message[];
  /** Called when a turn finishes (success, abort, or error). Receives
   *  the full thread history so the parent can persist it. */
  onTurnComplete?: (history: Message[]) => void;
}) {
  const m = MODELS.find((x) => x.slug === model);
  const [history, setHistory] = useState<Message[]>(initialHistory);
  const [blocks, setBlocks] = useState<RenderBlock[]>(() =>
    historyToBlocks(initialHistory),
  );
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attached, setAttached] = useState<string[]>([]);
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [files, setFiles] = useState<string[]>([]);
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
    if (!userMsg && images.length === 0 && attached.length === 0) return;
    if (busy) return;
    setInput('');
    setError(null);

    const workspace = getCurrentWorkspace();
    let modelText = userMsg || 'Please look at the attached.';
    let displayText = userMsg;
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

    // Build the model-side content blocks: image blocks first
    // (Anthropic best practice — vision content before the text
    // referring to it), then the text. Display-side bubble gets a
    // thumbnail row + the user's prose underneath.
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
    userContent.push({ type: 'text', text: modelText });

    const nextHistory: Message[] = [
      ...history,
      { role: 'user', content: userContent },
    ];

    const sentImages = images.length > 0 ? images : undefined;
    setImages([]);

    setBlocks((b) => [
      ...b,
      { type: 'user_text', text: displayText, images: sentImages },
    ]);
    setBusy(true);
    abortRef.current = new AbortController();

    // Snapshot wallet balance + start time so we can compute the
    // exact dollar cost of this turn from the balance delta.
    const startMs = Date.now();
    const preBalance = (await fetchBalance())?.balanceUsd ?? null;
    let lastUsage: { inputTokens: number; outputTokens: number } | null = null;

    try {
      const finalHistory = await runAgent({
        model,
        workspace: workspace?.path ?? null,
        history: nextHistory,
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
      setHistory(finalHistory);
      onTurnComplete?.(finalHistory);

      // After the turn ends, fetch the new balance and append a
      // usage block. Balance delta is the authoritative cost (qlaud's
      // markup included); token counts are the granular per-stream
      // numbers. Both shown side-by-side.
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
      }
    } catch (e) {
      const code = e instanceof Error ? e.message : 'unknown';
      setError(mapError(code));
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
    <div className="flex flex-1 flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-8">
          {empty ? (
            <EmptyState
              modelLabel={m?.label ?? model}
              provider={m?.provider}
              onPick={(s) => setInput(s)}
            />
          ) : (
            <div className="flex flex-col gap-5">
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
        onAttachImage={(img) => setImages((prev) => [...prev, img])}
        onDetachImage={(id) =>
          setImages((prev) => prev.filter((x) => x.id !== id))
        }
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

      case 'finished':
      case 'error':
      default:
        return blocks;
    }
  });
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

function mapError(code: string): string {
  switch (code) {
    case 'cap_hit':
      return "You've hit your spend cap. Top up at qlaud.ai/dashboard.";
    case 'unauthorized':
      return 'Authentication failed. Sign out and back in.';
    case 'not_authed':
      return 'Not signed in.';
    default:
      return code.startsWith('upstream_')
        ? `Upstream error: ${code.replace('upstream_', '')}`
        : `Error: ${code}`;
  }
}

// ─── Render rows ───────────────────────────────────────────────────

function BlockRow({
  block,
  busy,
  onAllow,
  onReject,
}: {
  block: RenderBlock;
  busy: boolean;
  onAllow?: () => void;
  onReject?: () => void;
}) {
  if (block.type === 'user_text') {
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
  // assistant_text
  if (!block.text && busy) {
    return (
      <div className="flex gap-3">
        <Avatar />
        <div className="flex-1 pt-0.5">
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
        <Markdown source={block.text} />
      </div>
    </div>
  );
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

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function EmptyState({
  modelLabel,
  provider,
  onPick,
}: {
  modelLabel: string;
  provider?: string;
  onPick: (s: string) => void;
}) {
  return (
    <div className="flex flex-col items-center pt-12 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-2xl bg-primary/10 text-primary">
        <Sparkles className="h-5 w-5" />
      </div>
      <h2 className="mt-6 text-2xl font-semibold tracking-tight">
        What should we build?
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Connected to{' '}
        <span className="font-medium text-foreground">{modelLabel}</span>
        {provider ? ` · ${provider}` : ''}
      </p>
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
  files,
  onLoadFiles,
  onAttach,
  onDetach,
  onAttachImage,
  onDetachImage,
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
  files: string[];
  onLoadFiles: () => void;
  onAttach: (path: string) => void;
  onDetach: (path: string) => void;
  onAttachImage: (img: AttachedImage) => void;
  onDetachImage: (id: string) => void;
  onImageError: (message: string) => void;
}) {
  const [dragging, setDragging] = useState(false);

  async function ingestImageFiles(list: File[]) {
    for (const f of list) {
      const result = await readImageFile(f);
      if ('reason' in result) {
        onImageError(result.message);
        return;
      }
      onAttachImage(result);
    }
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const list = imagesFromPaste(e.nativeEvent);
    if (list.length === 0) return;
    e.preventDefault();
    void ingestImageFiles(list);
  }

  function onDrop(e: React.DragEvent) {
    setDragging(false);
    const list = imagesFromDrop(e.nativeEvent);
    if (list.length === 0) return;
    e.preventDefault();
    void ingestImageFiles(list);
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
            {(attached.length > 0 || images.length > 0) && (
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
                      onClick={() => onDetachImage(img.id)}
                      className="grid h-4 w-4 place-items-center rounded text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                      aria-label={`Remove ${img.name}`}
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
              <span className="text-[11px] text-muted-foreground">
                {dragging
                  ? 'Drop image to attach'
                  : `${modelLabel} · ⏎ to send · @ files · paste/drop images`}
              </span>
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
                    !value.trim() && attached.length === 0 && images.length === 0
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
