import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Sparkles } from 'lucide-react';

import { cn } from '../lib/cn';
import { MODELS } from '../lib/models';
import { streamMessage } from '../lib/qlaud-client';

type Msg = { role: 'user' | 'assistant'; text: string };

const SAMPLE_PROMPTS = [
  'Open the qcode repo and explain the agentic loop',
  'Refactor the auth flow into a hook',
  'Find and fix any flaky tests',
  'Run the test suite and triage failures',
];

export function ChatSurface({ model }: { model: string }) {
  const m = MODELS.find((x) => x.slug === model);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Auto-scroll on new content. Cheap because messages array is small.
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages]);

  // Cancel any in-flight request on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function send(text: string) {
    const userMsg = text.trim();
    if (!userMsg || busy) return;
    setInput('');
    setError(null);

    const next: Msg[] = [
      ...messages,
      { role: 'user', text: userMsg },
      { role: 'assistant', text: '' },
    ];
    setMessages(next);
    setBusy(true);

    abortRef.current = new AbortController();
    try {
      await streamMessage({
        model,
        history: next.filter((_, i) => i < next.length - 1), // exclude empty assistant
        signal: abortRef.current.signal,
        onDelta: (chunk) => {
          setMessages((m2) => {
            const out = [...m2];
            const last = out[out.length - 1];
            if (last?.role === 'assistant') {
              out[out.length - 1] = { ...last, text: last.text + chunk };
            }
            return out;
          });
        },
      });
    } catch (e) {
      const code = e instanceof Error ? e.message : 'unknown';
      const msg =
        code === 'cap_hit'
          ? "You've hit your spend cap. Top up at qlaud.ai/dashboard."
          : code === 'unauthorized'
            ? 'Authentication failed. Sign out and back in.'
            : code === 'not_authed'
              ? 'Not signed in.'
              : `Error: ${code}`;
      setError(msg);
      setMessages((m2) => {
        // Drop the empty assistant placeholder if we never streamed.
        const last = m2[m2.length - 1];
        if (last?.role === 'assistant' && !last.text) return m2.slice(0, -1);
        return m2;
      });
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  const empty = messages.length === 0;

  return (
    <div className="flex flex-1 flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-8">
          {empty ? (
            <EmptyState modelLabel={m?.label ?? model} provider={m?.provider} onPick={(s) => setInput(s)} />
          ) : (
            <div className="flex flex-col gap-5">
              {messages.map((msg, i) => (
                <Bubble
                  key={i}
                  role={msg.role}
                  text={msg.text}
                  busy={busy && i === messages.length - 1 && !msg.text}
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
        model={model}
        onSend={send}
        busy={busy}
      />
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
        Connected to <span className="font-medium text-foreground">{modelLabel}</span>
        {provider ? ` · ${provider}` : ''}
      </p>
      <div className="mt-10 grid w-full max-w-2xl gap-2 text-left">
        {SAMPLE_PROMPTS.map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="rounded-lg border border-border bg-background px-4 py-3 text-sm text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function Bubble({
  role,
  text,
  busy,
}: {
  role: 'user' | 'assistant';
  text: string;
  busy: boolean;
}) {
  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm leading-relaxed text-primary-foreground shadow-sm">
          <p className="whitespace-pre-wrap">{text}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-3">
      <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
        <Sparkles className="h-3.5 w-3.5" />
      </div>
      <div className="flex-1 pt-0.5">
        {busy ? (
          <TypingDots />
        ) : (
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{text}</p>
        )}
      </div>
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

function Composer({
  value,
  onChange,
  model,
  onSend,
  busy,
}: {
  value: string;
  onChange: (v: string) => void;
  model: string;
  onSend: (v: string) => void;
  busy: boolean;
}) {
  const m = MODELS.find((x) => x.slug === model);
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && (e.metaKey || e.ctrlKey || true)) {
      e.preventDefault();
      onSend(value);
    }
  }
  return (
    <div className="border-t border-border/60 px-4 py-4">
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
            placeholder="Describe what you want to build…"
            rows={2}
            disabled={busy}
            className="block w-full resize-none rounded-2xl bg-transparent px-4 py-3 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
          />
          <div className="flex items-center justify-between border-t border-border/40 px-3 py-2">
            <span className="text-[11px] text-muted-foreground">
              {m?.label ?? model} · ⏎ to send · ⇧⏎ for newline
            </span>
            <button
              onClick={() => onSend(value)}
              disabled={busy || !value.trim()}
              className="grid h-7 w-7 place-items-center rounded-md bg-primary text-primary-foreground transition-all hover:bg-primary/90 active:scale-95 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
              aria-label="Send"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
