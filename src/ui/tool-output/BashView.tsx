// bash output format from runBash():
//
//   exit <N>
//   --- stdout ---
//   <stdout text>
//   --- stderr ---
//   <stderr text>
//
// We split on those headers and render two terminal-themed panes
// (or one, when only stdout is present). Exit code goes in the
// header with green/red coloring. Errors from outside bash (e.g.
// the deny-list rejection) come through with is_error=true and
// no exit/stdout/stderr structure — we render those as a plain
// red message.

const STDOUT_RE = /\n?--- stdout ---\n/;
const STDERR_RE = /\n?--- stderr ---\n/;

export function BashView({
  output,
  isError,
}: {
  output: string;
  isError: boolean;
}) {
  const parsed = parse(output);
  if (!parsed) {
    // Pre-execution rejection or unstructured error.
    return (
      <pre className="m-0 max-h-44 overflow-auto whitespace-pre-wrap bg-primary/5 px-3 py-2 font-mono text-[11.5px] leading-snug text-primary">
        {output}
      </pre>
    );
  }
  const { exitCode, stdout, stderr } = parsed;
  const ok = exitCode === 0 && !isError;
  return (
    <div className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border/40 bg-muted/30 px-3 py-1.5">
        <span
          className={
            'inline-flex h-1.5 w-1.5 rounded-full ' +
            (ok ? 'bg-emerald-500' : 'bg-rose-500')
          }
        />
        <span className="text-[11px] font-medium text-foreground">
          exit {exitCode}
        </span>
        <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
          {[stdout && 'stdout', stderr && 'stderr'].filter(Boolean).join(' + ') ||
            '(no output)'}
        </span>
      </div>
      <div className="bg-[#0a0a0a] font-mono text-[11.5px] leading-snug">
        {stdout && (
          <Pane label="stdout" text={stdout} className="text-[#d8d8d8]" />
        )}
        {stderr && (
          <Pane
            label="stderr"
            text={stderr}
            className="text-rose-300 border-t border-white/10"
          />
        )}
        {!stdout && !stderr && (
          <div className="px-3 py-2 text-white/40">(no output)</div>
        )}
      </div>
    </div>
  );
}

function Pane({
  label,
  text,
  className,
}: {
  label: string;
  text: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="px-3 pt-1.5 text-[9px] font-medium uppercase tracking-widest text-white/40">
        {label}
      </div>
      <pre className="m-0 max-h-72 overflow-auto whitespace-pre-wrap px-3 pb-2 pt-0.5">
        {text || ' '}
      </pre>
    </div>
  );
}

function parse(output: string): {
  exitCode: number;
  stdout: string;
  stderr: string;
} | null {
  const m = /^exit (\d+)/.exec(output);
  if (!m) return null;
  const exitCode = Number.parseInt(m[1] ?? '0', 10);
  const rest = output.slice(m[0].length);
  let stdout = '';
  let stderr = '';
  const stderrIdx = rest.search(STDERR_RE);
  if (stderrIdx >= 0) {
    stderr = rest.slice(stderrIdx).replace(STDERR_RE, '').trimEnd();
  }
  const beforeStderr = stderrIdx >= 0 ? rest.slice(0, stderrIdx) : rest;
  const stdoutIdx = beforeStderr.search(STDOUT_RE);
  if (stdoutIdx >= 0) {
    stdout = beforeStderr.slice(stdoutIdx).replace(STDOUT_RE, '').trimEnd();
  }
  return { exitCode, stdout, stderr };
}
