import { Sparkles, ArrowRight, ShieldCheck } from 'lucide-react';

export function SignInGate({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className="flex h-dvh flex-col">
      <div className="titlebar h-11 border-b border-border/60" />

      <div className="flex flex-1 items-center justify-center px-6">
        <div className="w-full max-w-md text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
            <Sparkles className="h-5 w-5" />
          </div>
          <h1 className="mt-6 text-3xl font-semibold tracking-tight">
            Welcome to qcode
          </h1>
          <p className="mt-3 text-balance text-sm leading-relaxed text-muted-foreground">
            The multi-model coding agent. Bring any model — Claude, GPT, Llama,
            DeepSeek — to your codebase. Sign in with your qlaud account to
            get started.
          </p>

          <button
            onClick={onSignIn}
            className="no-drag mt-8 inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-5 py-3 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
          >
            Sign in with qlaud
            <ArrowRight className="h-4 w-4" />
          </button>

          <p className="mt-3 text-[11px] text-muted-foreground">
            Don&rsquo;t have an account?{' '}
            <a
              href="https://qlaud.ai/sign-up"
              className="text-primary hover:underline"
            >
              Sign up
            </a>{' '}
            — $1 starter credit included.
          </p>

          <div className="mt-12 grid grid-cols-3 gap-3 text-left">
            <Bullet
              icon={<ShieldCheck className="h-3.5 w-3.5" />}
              title="Hard spend cap"
              body="Set per-session spend limits the gateway enforces."
            />
            <Bullet
              icon={<Sparkles className="h-3.5 w-3.5" />}
              title="Any model"
              body="Switch between Claude, GPT, Llama, DeepSeek with one click."
            />
            <Bullet
              icon={<ArrowRight className="h-3.5 w-3.5" />}
              title="Open source"
              body="Built on opencode. MIT licensed. Fork and customize."
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Bullet({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="grid h-6 w-6 place-items-center rounded bg-primary/10 text-primary">
        {icon}
      </div>
      <div className="mt-2 text-xs font-medium">{title}</div>
      <div className="mt-1 text-[11px] leading-snug text-muted-foreground">
        {body}
      </div>
    </div>
  );
}
