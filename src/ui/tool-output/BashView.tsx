// Compact bash output, Codex-style. No big black terminal block;
// just a "Bash" label, the `$ command` line, and the relevant
// output lines in monospace at a slightly muted color. Far less
// visual weight than the previous full-terminal pane — bash output
// no longer dominates the chat as a wall of green.
//
// Output format (from runBash):
//   exit <N>
//   --- stdout ---
//   <stdout>
//   --- stderr ---
//   <stderr>
//
// We split on those headers, drop the exit-line + section markers,
// and render stdout/stderr as plain mono. Errors keep a red tint;
// success uses muted foreground. No black background, no headers,
// no panes — keeps it readable and skimmable.

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
      <pre className="m-0 max-h-44 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-snug text-primary">
        {output}
      </pre>
    );
  }
  const { exitCode, stdout, stderr } = parsed;
  const failed = exitCode !== 0 || isError;
  const body = stdout || stderr || '';
  if (!body) {
    return (
      <div className="px-3 py-1.5 text-[11px] tabular-nums text-muted-foreground">
        exit {exitCode} · (no output)
      </div>
    );
  }
  return (
    <div>
      {/* Body — plain mono, no terminal background, no panes. Failed
       *  runs get a red tint on the whole block; successful runs use
       *  muted-foreground (less visually loud than primary). */}
      <pre
        className={
          'm-0 max-h-72 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-snug ' +
          (failed
            ? 'bg-primary/5 text-primary'
            : 'text-foreground/85')
        }
      >
        {body}
      </pre>
      {/* When stderr coexists with stdout, append it below in a
       *  muted-red row. Most successful builds emit stderr-as-info
       *  (compiler warnings, npm progress); we don't want it
       *  styled as failure when exit is 0. */}
      {stdout && stderr && !failed && (
        <pre className="m-0 max-h-32 overflow-auto whitespace-pre-wrap border-t border-border/40 px-3 py-2 font-mono text-[11px] leading-snug text-muted-foreground">
          {stderr}
        </pre>
      )}
      <div className="border-t border-border/40 px-3 py-1 text-[10.5px] tabular-nums text-muted-foreground">
        exit {exitCode}
        {stderr && stdout && ' · stdout + stderr'}
      </div>
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
