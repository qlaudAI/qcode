// /play — the qcode in-browser playground. Sells the wedge demo:
// "Ship a working SaaS landing page in 90 seconds. Live URL."
//
// Lifecycle:
//   1. Load — show a hero + one big "Build" button. No sandbox
//      activity yet (lazy mint = no billing for tab-and-leave).
//   2. Click — mint a session, walk through a hardcoded ~5-step
//      pipeline (copy template → start server → expose port).
//      Each step shows progress in a vertical timeline; failures
//      surface inline with a retry.
//   3. Live — once port 3000 is exposed, drop the timeline and
//      show the preview iframe full-bleed with a top-bar of meta
//      (live URL, "Open in new tab", "End session").
//
// Why this scope rather than a full chat agent: the wedge is
// "from zero to a real URL." A chat surface adds a hundred
// decisions to make. The hardcoded pipeline keeps the path
// monovariant — every visitor sees the same magic happen — and
// frees us to wire the runtime layer end-to-end before adding the
// agent loop on top.

import { useEffect, useRef, useState } from 'react';
import { getKey } from '../lib/auth';
import { getRuntime, terminateSandbox, getSandboxSessionId } from '../lib/runtime';

// ─── Pipeline definition ────────────────────────────────────────────

type StepStatus = 'pending' | 'running' | 'done' | 'error';

type Step = {
  id: string;
  label: string;
  /** Returns void on success; throws on failure. The pipeline runs
   *  steps sequentially and reports each label as it transitions
   *  pending → running → done. */
  run(ctx: PipelineCtx): Promise<void>;
};

type PipelineCtx = {
  setPreviewUrl: (url: string) => void;
};

const STEPS: Step[] = [
  {
    id: 'mint',
    label: 'Provisioning your sandbox',
    async run() {
      // First exec is lazy — the runtime will mint a session id
      // here. We run a trivial command so the container warms now
      // rather than at the slower scaffold step where the user
      // sees the spinner the longest.
      const r = await getRuntime().exec('echo ready', { cwd: '/workspace' });
      if (!r.success) throw new Error(`sandbox warm failed: ${r.stderr}`);
    },
  },
  {
    id: 'scaffold',
    label: 'Scaffolding your SaaS landing page',
    async run() {
      // The image bakes the template at /opt/playground (see
      // apps/edge/Dockerfile). Copy it into /workspace where the
      // server will read from.
      const r = await getRuntime().exec(
        'cp -r /opt/playground/* /workspace/',
        { cwd: '/workspace' },
      );
      if (!r.success) throw new Error(`scaffold failed: ${r.stderr || r.stdout}`);
    },
  },
  {
    id: 'serve',
    label: 'Starting your dev server',
    async run() {
      // Background-start the bun static server. nohup + & so the
      // process survives this exec call (which times out at 30s
      // anyway). Output gets dropped into /tmp/serve.log so a
      // crashed server's reason is recoverable for debugging.
      const cmd =
        'nohup bun run /opt/playground/serve.ts > /tmp/serve.log 2>&1 & echo started';
      const r = await getRuntime().exec(cmd, { cwd: '/workspace' });
      if (!r.success) throw new Error(`serve failed: ${r.stderr}`);
      // Give Bun.serve a beat to bind. Without this the next
      // step's exposePort can resolve before the port listens,
      // and the first iframe load 502s.
      await new Promise((res) => setTimeout(res, 1500));
    },
  },
  {
    id: 'expose',
    label: 'Generating your live URL',
    async run(ctx) {
      const preview = await getRuntime().exposePort(3000, {
        name: 'demo-server',
      });
      ctx.setPreviewUrl(preview.url);
    },
  },
];

// ─── Component ──────────────────────────────────────────────────────

export function PlayPage() {
  const apiKey = getKey();
  const [running, setRunning] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, StepStatus>>(
    () => Object.fromEntries(STEPS.map((s) => [s.id, 'pending'])),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const cancelledRef = useRef(false);
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  async function start() {
    if (running) return;
    setRunning(true);
    setErrors({});
    setDone(false);
    setPreviewUrl(null);
    setStatuses(Object.fromEntries(STEPS.map((s) => [s.id, 'pending'])));

    const ctx: PipelineCtx = { setPreviewUrl };
    try {
      for (const step of STEPS) {
        if (cancelledRef.current) return;
        setStatuses((s) => ({ ...s, [step.id]: 'running' }));
        try {
          await step.run(ctx);
          setStatuses((s) => ({ ...s, [step.id]: 'done' }));
        } catch (e) {
          setStatuses((s) => ({ ...s, [step.id]: 'error' }));
          setErrors((m) => ({
            ...m,
            [step.id]: e instanceof Error ? e.message : String(e),
          }));
          throw e; // bail out of the loop — later steps would compound the failure
        }
      }
      setDone(true);
    } catch {
      // Surface lives on the per-step error chip; nothing more to do here.
    } finally {
      setRunning(false);
    }
  }

  async function reset() {
    await terminateSandbox().catch(() => {
      /* best-effort */
    });
    setStatuses(Object.fromEntries(STEPS.map((s) => [s.id, 'pending'])));
    setErrors({});
    setPreviewUrl(null);
    setDone(false);
  }

  // Sign-in gate. The sandbox endpoints require an api key — without
  // one we'd fail at mint with a 401. Better to bounce the user to
  // qlaud.ai/cli-auth from here than to let them click Build and
  // then see a confusing error.
  if (!apiKey) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-8 text-foreground">
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-semibold">Sign in to try qcode</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            The playground runs in a real Cloudflare sandbox tied to your
            account. Sign in once and pick up where you left off — same key
            works in the desktop app.
          </p>
          <a
            href="https://qlaud.ai/cli-auth"
            className="mt-6 inline-block rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Sign in with qlaud
          </a>
        </div>
      </div>
    );
  }

  // Live preview takes over the screen once we have a URL. The user
  // can still click "End session" to tear down and start fresh.
  if (previewUrl && done) {
    return (
      <PreviewView
        url={previewUrl}
        sessionId={getSandboxSessionId() ?? '—'}
        onReset={reset}
      />
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Ship a real SaaS landing page in{' '}
          <span className="bg-gradient-to-r from-violet-500 to-pink-500 bg-clip-text text-transparent">
            90 seconds
          </span>
        </h1>
        <p className="mt-4 text-base text-muted-foreground">
          A live URL. Real backend. Deploys from your browser, no install.
          We&rsquo;ll spin up an isolated sandbox, scaffold the site, and hand
          you back a URL you can share.
        </p>

        <button
          type="button"
          onClick={start}
          disabled={running}
          className="mt-8 inline-flex items-center justify-center rounded-xl bg-gradient-to-r from-violet-600 to-pink-600 px-6 py-3 text-base font-semibold text-white shadow-lg shadow-violet-600/30 transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {running ? 'Building…' : 'Build my landing page'}
        </button>

        <ol className="mt-10 space-y-3">
          {STEPS.map((step) => {
            const s = statuses[step.id] ?? 'pending';
            return (
              <li
                key={step.id}
                className="flex items-start gap-3 rounded-lg border border-border/60 bg-card/40 p-3"
              >
                <StepDot status={s} />
                <div className="flex-1">
                  <div
                    className={
                      s === 'pending'
                        ? 'text-sm text-muted-foreground'
                        : 'text-sm text-foreground'
                    }
                  >
                    {step.label}
                  </div>
                  {errors[step.id] && (
                    <div className="mt-1 break-words font-mono text-[11px] text-destructive">
                      {errors[step.id]}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        {Object.keys(errors).length > 0 && !running && (
          <button
            type="button"
            onClick={start}
            className="mt-4 text-sm text-primary underline-offset-2 hover:underline"
          >
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

function StepDot({ status }: { status: StepStatus }) {
  if (status === 'running') {
    return (
      <span className="mt-1.5 inline-block h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-violet-500" />
    );
  }
  if (status === 'done') {
    return (
      <span className="mt-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-500">
        <svg
          width="9"
          height="9"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-rose-500" />
    );
  }
  return (
    <span className="mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-muted-foreground/40" />
  );
}

function PreviewView({
  url,
  sessionId,
  onReset,
}: {
  url: string;
  sessionId: string;
  onReset: () => void;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card/60 px-4 py-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
          <span className="font-medium">Live</span>
          <span className="text-muted-foreground">·</span>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="truncate font-mono text-xs text-primary hover:underline"
          >
            {url}
          </a>
          <span className="text-muted-foreground">·</span>
          <span
            className="font-mono text-[11px] text-muted-foreground"
            title="Cloudflare Sandbox session id"
          >
            {sessionId.slice(0, 16)}…
          </span>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-border bg-background px-3 py-1.5 text-xs transition-colors hover:border-foreground/30"
          >
            Open in new tab ↗
          </a>
          <button
            type="button"
            onClick={onReset}
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/20"
          >
            End session
          </button>
        </div>
      </header>
      <iframe
        src={url}
        className="flex-1 border-0"
        title="Live preview"
        // sandbox attribute relaxed to allow scripts and same-origin —
        // the preview URL is on a CF subdomain we control, not user-
        // attacker territory. The site itself is read-only HTML
        // generated by qcode, which keeps the threat model narrow.
        sandbox="allow-scripts allow-same-origin allow-forms"
      />
    </div>
  );
}
