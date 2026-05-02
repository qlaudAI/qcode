// Renders browser_* tool output. The Playwright MCP server returns a
// mix of text + image content; runBrowser() collapses both into a
// single string, embedding any image bytes via the
// `[qcode:image:<mime>:<base64>]` sentinel. We split that out here:
// images become inline <img> tags, text wraps in a scrollable pane.
//
// browser_navigate / browser_console / browser_snapshot land here as
// text-only. browser_screenshot is the main image case. browser_click
// and browser_type return a fresh accessibility tree (text) so the
// model can re-target on the next call.

const IMAGE_RE = /\[qcode:image:([^:]+):([^\]]+)\]/g;

type Part =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mime: string; data: string };

export function BrowserView({
  output,
  isError,
}: {
  output: string;
  isError: boolean;
}) {
  const parts = parse(output);
  return (
    <div
      className={
        'flex flex-col gap-2 px-3 py-2 ' + (isError ? 'bg-primary/5' : '')
      }
    >
      {parts.map((p, i) =>
        p.kind === 'image' ? (
          <img
            key={i}
            src={`data:${p.mime};base64,${p.data}`}
            alt="browser screenshot"
            className="max-h-[420px] rounded-md border border-border/50 bg-muted/30 object-contain"
          />
        ) : (
          <pre
            key={i}
            className="m-0 max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[11.5px] leading-snug text-foreground/90"
          >
            {p.text}
          </pre>
        ),
      )}
    </div>
  );
}

function parse(output: string): Part[] {
  const parts: Part[] = [];
  let last = 0;
  IMAGE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMAGE_RE.exec(output)) !== null) {
    if (m.index > last) {
      const text = output.slice(last, m.index).trim();
      if (text) parts.push({ kind: 'text', text });
    }
    parts.push({ kind: 'image', mime: m[1] ?? 'image/png', data: m[2] ?? '' });
    last = m.index + m[0].length;
  }
  if (last < output.length) {
    const tail = output.slice(last).trim();
    if (tail) parts.push({ kind: 'text', text: tail });
  }
  return parts.length > 0 ? parts : [{ kind: 'text', text: output }];
}
