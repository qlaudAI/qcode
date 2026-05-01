import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Sparkles, Square } from 'lucide-react';

import { cn } from '../lib/cn';
import { MODELS } from '../lib/models';
import { runAgent, type AgentEvent } from '../lib/agent';
import type { Message } from '../lib/qlaud-client';
import { getCurrentWorkspace } from '../lib/workspace';
import { ToolCallCard, type ToolCallView } from './ToolCallCard';

// Each "block" rendered in the chat is the smallest UI unit:
// either the full user message, an assistant text run, or a tool
// call card. The agent loop emits a stream of events that
// `handleEvent` translates into block mutations.
type RenderBlock =
  | { type: 'user_text'; text: string }
  | { type: 'assistant_text'; text: string }
  | { type: 'tool'; call: ToolCallView };

const SAMPLE_PROMPTS = [
  'List the files in this project',
  'Open the main entry point and explain what it does',
  'Find the auth flow — which files implement it?',
  'Summarize the architecture from the README and source',
];

export function ChatSurface({ model }: { model: string }) {
  const m = MODELS.find((x) => x.slug === model);
  const [history, setHistory] = useState<Message[]>([]);
  const [blocks, setBlocks] = useState<RenderBlock[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Auto-scroll to bottom on any block change.
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [blocks]);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function send(text: string) {
    const userMsg = text.trim();
    if (!userMsg || busy) return;
    setInput('');
    setError(null);

    const workspace = getCurrentWorkspace();
    const nextHistory: Message[] = [
      ...history,
      { role: 'user', content: [{ type: 'text', text: userMsg }] },
    ];

    setBlocks((b) => [...b, { type: 'user_text', text: userMsg }]);
    setBusy(true);
    abortRef.current = new AbortController();

    try {
      const finalHistory = await runAgent({
        model,
        workspace: workspace?.path ?? null,
        history: nextHistory,
        signal: abortRef.current.signal,
        onEvent: (e) => handleEvent(e, setBlocks),
      });
      setHistory(finalHistory);
    } catch (e) {
      const code = e instanceof Error ? e.message : 'unknown';
      setError(mapError(code));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
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

      case 'finished':
      case 'error':
      default:
        return blocks;
    }
  });
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

function BlockRow({ block, busy }: { block: RenderBlock; busy: boolean }) {
  if (block.type === 'user_text') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm leading-relaxed text-primary-foreground shadow-sm">
          <p className="whitespace-pre-wrap">{block.text}</p>
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
        <p className="whitespace-pre-wrap text-sm leading-relaxed">
          {block.text}
        </p>
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
}: {
  value: string;
  onChange: (v: string) => void;
  modelLabel: string;
  onSend: (v: string) => void;
  onStop: () => void;
  busy: boolean;
}) {
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend(value);
    }
  }
  return (
    <div className="border-t border-border/40 bg-background/70 px-4 py-4 backdrop-blur-md">
      <div className="mx-auto max-w-3xl">
        <div
          className={cn(
            'rounded-2xl border border-border bg-background shadow-sm transition-shadow',
            'focus-within:border-foreground/20 focus-within:shadow-md',
          )}
        >
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask qcode about your code…"
            rows={2}
            disabled={busy}
            className="block w-full resize-none rounded-2xl bg-transparent px-4 py-3 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
          />
          <div className="flex items-center justify-between border-t border-border/40 px-3 py-2">
            <span className="text-[11px] text-muted-foreground">
              {modelLabel} · ⏎ to send · ⇧⏎ for newline
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
                disabled={!value.trim()}
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
  );
}
