import { useState } from 'react';
import { ArrowRight, Check, Sparkles } from 'lucide-react';

import { handleTitleBarMouseDown } from '../lib/tauri';
import { QlaudMark } from './QlaudMark';

// qcode landing / sign-in gate. Marketing surface for un-authed
// visitors and the always-shown "first thing they see" for fresh
// installs. Optimized for: (1) lead with the wedge in one sentence,
// (2) make the Free-plan price the loudest fact on the page so
// users don't bounce thinking it's pay-only, (3) provide the model
// roster as proof of "every model in one place" without bullet
// fatigue.
//
// Avoid feature-dumping. Three cards only. Pricing teaser as a tail
// row. The actual product surface is one click away — no need to
// pre-explain it.

export function SignInGate({ onSignIn }: { onSignIn: () => Promise<void> | void }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    setErr(null);
    setBusy(true);
    try {
      await onSignIn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden">
      {/* Soft radial backdrop — gives the page a "we put effort into
       *  this" feel without competing with the content. The two
       *  blobs are positioned off-canvas so they only blur in from
       *  the corners; on a black/dark background they read as
       *  faint primary-tinted light, on white as a tasteful warm
       *  wash. pointer-events: none so they never block clicks. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
      >
        <div className="absolute -left-20 -top-20 h-[420px] w-[420px] rounded-full bg-primary/15 blur-3xl" />
        <div className="absolute -bottom-32 -right-20 h-[480px] w-[480px] rounded-full bg-primary/10 blur-3xl" />
      </div>

      <div
        data-tauri-drag-region
        onMouseDown={handleTitleBarMouseDown}
        className="titlebar h-11 border-b border-border/40 backdrop-blur-sm"
      />

      <div className="flex flex-1 items-center justify-center px-6 py-10">
        <div className="w-full max-w-lg">
          <div className="text-center">
            <QlaudMark className="mx-auto h-14 w-14 rounded-2xl shadow-md" />

            <h1 className="mt-6 text-balance text-4xl font-semibold tracking-tight">
              Every model. One chat.
            </h1>
            <p className="mt-3 text-balance text-sm leading-relaxed text-muted-foreground sm:text-base">
              Claude, GPT‑5, Gemini, DeepSeek, Llama, Sora — switch
              models mid-conversation. Code, chat, image, video.
              <span className="hidden sm:inline">{' '}One subscription.</span>
            </p>
          </div>

          {/* Provider strip — quiet social proof. Tells the user
           *  "yes, all the names you know are in here" without a
           *  feature list. Wraps gracefully on narrow widths. */}
          <div className="mx-auto mt-7 flex max-w-md flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
            <span>Anthropic</span>
            <span aria-hidden>·</span>
            <span>OpenAI</span>
            <span aria-hidden>·</span>
            <span>Google</span>
            <span aria-hidden>·</span>
            <span>DeepSeek</span>
            <span aria-hidden>·</span>
            <span>Meta</span>
            <span aria-hidden>·</span>
            <span>xAI</span>
            <span aria-hidden>·</span>
            <span>ElevenLabs</span>
            <span aria-hidden>·</span>
            <span>Pika</span>
          </div>

          <button
            onClick={handleClick}
            disabled={busy}
            className="no-drag mt-8 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-5 py-3 text-sm font-medium text-primary-foreground shadow-sm transition-all hover:-translate-y-0.5 hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/20 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {busy ? 'Opening browser…' : 'Sign in with qlaud'}
            {!busy && <ArrowRight className="h-4 w-4" />}
          </button>

          {err && (
            <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-left text-xs">
              <div className="font-medium text-destructive">
                Couldn&rsquo;t open the browser
              </div>
              <div className="mt-1 text-muted-foreground">{err}</div>
              <a
                href="https://qlaud.ai/cli-auth?cb=qcode%3A%2F%2Fauth&app=qcode"
                className="mt-2 inline-block text-primary hover:underline"
              >
                Open in browser manually →
              </a>
            </div>
          )}

          {/* No-card pitch right under the CTA — the whole point of
           *  the Free plan in the funnel. Loudest line below the
           *  button so it lands in the user's eye-line. */}
          <p className="mt-3 text-center text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">Free plan, no card.</span>{' '}
            New here?{' '}
            <a
              href="https://qlaud.ai/sign-up"
              className="text-primary hover:underline"
            >
              Sign up
            </a>
            .
          </p>

          {/* Three cards — what you actually get. Replaces the old
           *  "hard spend cap / any model / open source" trio that
           *  was a developer-pitch holdover. Now: Free benefits,
           *  Pro upsell, Power preview. Each card is a tier, ordered
           *  left-to-right by commitment. */}
          <div className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Tier
              badge="Free"
              price="$0"
              tagline="No card required"
              bullets={[
                'Unlimited DeepSeek, Qwen, MiniMax',
                '10 Sonnet / GPT‑5 messages a day',
                '5 image gens a day',
              ]}
            />
            <Tier
              badge="Pro"
              price="$17/mo"
              tagline="Most popular"
              bullets={[
                '200 Sonnet / GPT‑5 / day',
                '30 Opus / day',
                '5 Sora video clips, 10 min TTS',
              ]}
              accent
            />
            <Tier
              badge="Power"
              price="$87/mo"
              tagline="For builders"
              bullets={[
                '5× the Pro limits',
                '150 Opus / day',
                '30 min Sora video / mo',
              ]}
            />
          </div>

          {/* Tail line — open-source credit kept (it's a real signal,
           *  just not the headline). One row, tiny, dim. */}
          <p className="mt-8 flex items-center justify-center gap-1.5 text-center text-[10.5px] text-muted-foreground/70">
            <Sparkles className="h-3 w-3" aria-hidden />
            Built on opencode · MIT licensed · End-to-end encrypted
          </p>
        </div>
      </div>
    </div>
  );
}

function Tier({
  badge,
  price,
  tagline,
  bullets,
  accent,
}: {
  badge: string;
  price: string;
  tagline: string;
  bullets: string[];
  accent?: boolean;
}) {
  return (
    <div
      className={
        'flex flex-col rounded-lg border p-3.5 transition-colors ' +
        (accent
          ? 'border-primary/40 bg-primary/[0.04] shadow-sm shadow-primary/5'
          : 'border-border/60 bg-background/40')
      }
    >
      <div className="flex items-baseline justify-between">
        <span
          className={
            'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ' +
            (accent
              ? 'bg-primary/15 text-primary'
              : 'bg-muted text-foreground/70')
          }
        >
          {badge}
        </span>
        <span className="text-[11px] text-muted-foreground">{tagline}</span>
      </div>
      <div className="mt-2 text-lg font-semibold tracking-tight">{price}</div>
      <ul className="mt-2 space-y-1">
        {bullets.map((b) => (
          <li
            key={b}
            className="flex items-start gap-1.5 text-[11px] leading-snug text-foreground/80"
          >
            <Check className="mt-[1px] h-3 w-3 shrink-0 text-primary" />
            <span>{b}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
