import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Sparkles } from 'lucide-react';

import { handleTitleBarMouseDown } from '../lib/tauri';
import { DiscoveryGrid } from './DiscoveryGrid';
import { QlaudMark } from './QlaudMark';

// qcode landing / sign-in gate. Marketing surface for un-authed
// visitors and the always-shown "first thing they see" for fresh
// installs. Optimized for: (1) teach the product in one motion (the
// composer at the top — "what should we build today?"), (2) make
// the Free-plan price the loudest fact below so users don't bounce
// thinking it's pay-only, (3) provide the model roster as quiet
// proof.
//
// alpha.202 — vibesdk-style chat composer ported in. When a visitor
// types a prompt and submits, we stash the text to sessionStorage
// (key: PENDING_PROMPT_KEY) and immediately trigger the OAuth
// redirect. After auth, App.tsx reads the stash, primes the real
// composer, drains the stash. The intermediate qlaud.ai redirect
// can't be relied on to preserve URL query params (the auth flow
// rewrites the URL), so sessionStorage is the persistence story —
// same origin, same tab, survives any number of in-tab redirects.

// Storage key used by both halves of the handoff: SignInGate writes,
// App.tsx reads + drains. Lives in lib/auth.ts via re-export so the
// reader and writer share one constant. Exported here too so tests
// can introspect.
export const PENDING_PROMPT_KEY = 'qcode.pending_prompt';

const MAX_PROMPT_LENGTH = 4096;

// Same trio vibesdk uses + qlaud.ai's LandingHero — keeping the
// rhythm identical across the two surfaces so visitors who saw
// the marketing landing recognize the typewriter immediately.
const PLACEHOLDER_PHRASES = [
  'todo list app',
  'F1 fantasy game',
  'personal finance tracker',
];

export function SignInGate({ onSignIn }: { onSignIn: () => Promise<void> | void }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Composer state. The composer is the new primary action — type +
  // hit send routes through the same sign-in handler but stashes the
  // prompt for resume on the authed side.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState('');

  // Typewriter placeholder — same machine vibesdk uses.
  const placeholders = useMemo(() => PLACEHOLDER_PHRASES, []);
  const [phraseIndex, setPhraseIndex] = useState(0);
  const [placeholderText, setPlaceholderText] = useState('');
  const [isTyping, setIsTyping] = useState(true);
  useEffect(() => {
    const phrase = placeholders[phraseIndex];
    if (isTyping) {
      if (placeholderText.length < phrase.length) {
        const t = setTimeout(() => {
          setPlaceholderText(phrase.slice(0, placeholderText.length + 1));
        }, 100);
        return () => clearTimeout(t);
      }
      const pause = setTimeout(() => setIsTyping(false), 2000);
      return () => clearTimeout(pause);
    }
    if (placeholderText.length > 0) {
      const t = setTimeout(() => {
        setPlaceholderText(placeholderText.slice(0, -1));
      }, 50);
      return () => clearTimeout(t);
    }
    setPhraseIndex((i) => (i + 1) % placeholders.length);
    setIsTyping(true);
  }, [placeholderText, phraseIndex, isTyping, placeholders]);

  // Auto-resize textarea up to 220px; matches the LandingHero feel
  // but slightly shorter since the gate has pricing cards below.
  const adjustHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 220) + 'px';
  };

  // Submit handler:
  //   1. Validate prompt length (silent truncation matches the
  //      server-side cap qcode applies).
  //   2. Stash to sessionStorage so it survives the qlaud.ai
  //      OAuth redirect.
  //   3. Fire startSignIn() — the same handler the secondary
  //      "Sign in with qlaud" button uses.
  // Empty prompt? Skip the stash and just trigger sign-in directly.
  async function submitWithPrompt() {
    setErr(null);
    const trimmed = query.trim();
    if (trimmed) {
      const capped = trimmed.slice(0, MAX_PROMPT_LENGTH);
      try {
        sessionStorage.setItem(PENDING_PROMPT_KEY, capped);
      } catch {
        // sessionStorage can fail in incognito/quota-exceeded
        // edge cases. Don't block sign-in — they can re-type the
        // prompt once they land. The OAuth roundtrip is the
        // expensive part; saving a re-type is the nice-to-have.
      }
    }
    setBusy(true);
    try {
      await onSignIn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Bare sign-in (the original button's behavior). Kept so users
  // who don't want to type a prompt can still get into the app
  // with one click. Uses the same handler but skips the stash.
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
    <div className="relative flex min-h-dvh flex-col">
      {/* Soft radial backdrop — gives the page a "we put effort into
       *  this" feel without competing with the content. The two
       *  blobs are positioned off-canvas so they only blur in from
       *  the corners. overflow-hidden is on this layer (not the
       *  outer flex container) so the page can scroll when content
       *  overflows on narrow phones. pointer-events: none so they
       *  never block clicks. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
      >
        <div className="absolute -left-20 -top-20 h-[280px] w-[280px] rounded-full bg-primary/15 blur-3xl sm:h-[420px] sm:w-[420px]" />
        <div className="absolute -bottom-32 -right-20 h-[320px] w-[320px] rounded-full bg-primary/10 blur-3xl sm:h-[480px] sm:w-[480px]" />
      </div>

      <div
        data-tauri-drag-region
        onMouseDown={handleTitleBarMouseDown}
        className="titlebar h-11 shrink-0 border-b border-border/40 backdrop-blur-sm"
      />

      {/* alpha.206: dropped `items-center` from this wrapper.
       *  Vertical centering plus min-h-dvh worked when the gate was
       *  short (composer + sign-in button + pricing tiers fit in
       *  one viewport on most screens). Adding the DiscoveryGrid
       *  pushed total content past mobile viewport heights, and the
       *  vertical-center trap meant the top half clipped off-screen
       *  with no scroll affordance. Switching to top-aligned flow
       *  (`items-start` implicit via the absence of `items-center`)
       *  lets the page grow naturally and the document scrolls when
       *  content overflows. */}
      <div className="flex flex-1 justify-center px-4 py-8 sm:px-6 sm:py-10">
        <div className="w-full max-w-2xl">
          <div className="text-center">
            <QlaudMark className="mx-auto h-12 w-12 rounded-2xl shadow-md sm:h-14 sm:w-14" />

            <h1 className="mt-5 text-balance text-3xl font-semibold tracking-tight text-primary sm:mt-6 sm:text-4xl">
              What should we build today?
            </h1>
            <p className="mt-3 text-balance text-[13px] leading-relaxed text-muted-foreground sm:text-base">
              Claude, GPT‑5, Gemini, DeepSeek, Llama, Sora — switch
              models mid-conversation. Code, chat, image, video.
            </p>
          </div>

          {/* Chat composer — the primary action. Type a prompt + hit
           *  send → we stash the prompt to sessionStorage and trigger
           *  sign-in. After OAuth, App.tsx primes the real composer
           *  with this text. Visitors who'd rather not type yet can
           *  use the secondary "Sign in with qlaud" link below. */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitWithPrompt();
            }}
            // alpha.207: clicking anywhere on the composer card
            // focuses the textarea. Without this, only the literal
            // textarea rectangle was clickable — the form's padding
            // and the action-row strip were dead zones, which read
            // as "this thing doesn't accept clicks." Skip buttons
            // and links so their click semantics survive.
            onClick={(e) => {
              const t = e.target as HTMLElement;
              if (t.closest('button, a, input, select, textarea')) return;
              textareaRef.current?.focus();
            }}
            className="mt-7 flex min-h-[160px] cursor-text flex-col rounded-[18px] border border-primary/30 bg-card/95 p-5 shadow-[0_8px_32px_rgba(0,0,0,0.06)] backdrop-blur-sm transition-all duration-200 focus-within:border-primary/60 focus-within:shadow-[0_8px_32px_rgba(0,0,0,0.10)] dark:bg-card/90"
          >
            <textarea
              ref={textareaRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                adjustHeight();
              }}
              onInput={adjustHeight}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void submitWithPrompt();
                }
              }}
              placeholder={`Create a ${placeholderText}`}
              className="w-full flex-1 resize-none border-0 bg-transparent text-[15px] leading-relaxed text-foreground outline-none ring-0 placeholder:text-foreground/40 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0"
              // rows=3 sets the initial visible height so the
              // composer reads as "this accepts a paragraph" rather
              // than "this is a single-line input." adjustHeight()
              // grows past 3 lines as the user types.
              rows={3}
              maxLength={MAX_PROMPT_LENGTH + 256}
              disabled={busy}
            />

            <div className="mt-3 flex items-center justify-between pt-1">
              <div className="text-[11px] text-muted-foreground/80">
                {busy
                  ? 'Opening browser…'
                  : query.trim()
                    ? 'Sign in and ship with one tap'
                    : 'Sign in to start'}
              </div>
              <button
                type="submit"
                disabled={busy || !query.trim()}
                aria-label="Send prompt and sign in"
                className="grid h-9 w-9 place-items-center rounded-md bg-primary text-primary-foreground transition-all duration-200 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ArrowRight className="h-5 w-5" />
              </button>
            </div>
          </form>

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

          {/* Secondary sign-in path — visitors who'd rather sign in
           *  first and type later. Quieter than the composer's send
           *  arrow so the composer reads as the primary call. */}
          <div className="mt-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center text-[12px] text-muted-foreground">
            <button
              onClick={handleClick}
              disabled={busy}
              className="no-drag font-medium text-foreground/85 underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50"
            >
              {busy ? 'Opening browser…' : 'Sign in with qlaud'}
            </button>
            <span aria-hidden className="text-muted-foreground/50">·</span>
            <span>
              <span className="font-medium text-foreground/85">Free plan, no card.</span>{' '}
              New here?{' '}
              <a
                href="https://qlaud.ai/sign-up"
                className="text-primary hover:underline"
              >
                Sign up
              </a>
              .
            </span>
          </div>

          {/* Provider strip — quiet social proof. Wraps gracefully on
           *  narrow screens; the brand mix lands the "every model"
           *  message without a bullet list. */}
          <div className="mx-auto mt-6 flex max-w-md flex-wrap items-center justify-center gap-x-2.5 gap-y-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70 sm:mt-7 sm:gap-x-3 sm:text-[11px]">
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
            <span aria-hidden className="hidden sm:inline">·</span>
            <span className="hidden sm:inline">ElevenLabs</span>
            <span aria-hidden className="hidden sm:inline">·</span>
            <span className="hidden sm:inline">Pika</span>
          </div>

          {/* Discovery grid — replaces the prior 3-tier pricing
           *  block. Showing what qlaud generates lands the value
           *  prop faster than a price list does, especially as we
           *  pivot toward motion-video generation as the headline
           *  capability. Pricing still lives on /pricing for users
           *  who go looking; the gate doesn't need it.
           *
           *  alpha.205 — same DiscoveryGrid component renders on
           *  the qlaud.ai marketing landing too, so visitors see
           *  the same "what does this thing produce" shelf
           *  regardless of which surface they hit first. */}
          <div className="mt-8 sm:mt-10">
            <div className="mb-4 flex items-baseline justify-between gap-3">
              <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
                Built with qlaud
              </h2>
              <span className="text-[11px] text-muted-foreground">
                Type a prompt to start
              </span>
            </div>
            <DiscoveryGrid />
          </div>

          {/* Tail line — open-source credit kept (it's a real signal,
           *  just not the headline). One row on desktop; on mobile
           *  the bullet list naturally wraps to keep the line height
           *  reasonable. flex-wrap so a 320px-wide screen doesn't
           *  hyphenate "End-to-end" awkwardly. */}
          <p className="mt-8 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 text-center text-[10px] text-muted-foreground/70 sm:text-[10.5px]">
            <Sparkles className="h-3 w-3" aria-hidden />
            <span>Built on opencode · MIT licensed · End-to-end encrypted</span>
          </p>
        </div>
      </div>
    </div>
  );
}

// `Tier` component removed in alpha.205 — the 3-card pricing block
// was replaced by <DiscoveryGrid /> above. Pricing remains on the
// /pricing marketing page for visitors who go looking. The gate is
// a "what can this do" surface now, not a "what does it cost" one.
